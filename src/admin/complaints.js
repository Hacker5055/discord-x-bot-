import { ChannelType as C, PermissionFlagsBits as P } from 'discord.js';
import { linkButton, row } from '../community/ui.js';
import { hasPermission } from '../discord/permissions.js';
import { isSnowflake } from '../lib/catalog.js';
import { AppError, DiscordApiError, errorFields } from '../lib/errors.js';
import { acl, equal, setupRole } from './channel-plan.js';
import { adminOf, card, idOf, post, TEXT_ROOMS } from './core.js';
import { kindAt } from './records.js';

const PAGE = 1000;
const MAX_PAGES = 10;
const MAX_STAFF = 100;
const DELIVERY_TTL = 60 * 60_000;
const QUEUE_DELAY = 8000;
const FORM_DEADLINE = 35_000;
const RETRY_DELAY = 30_000;
const DM_BUDGET = 6;
const permanent = (error) => error instanceof DiscordApiError && error.status >= 400 && error.status < 500;

export function complaintScope(c, a) {
  const scope = a.complaints;
  const team = a.teams.support;
  if (!a.enabled || !scope || scope.ownerId !== c.config.ownerId || scope.panelId !== a.rooms.ticket_panel ||
    scope.categoryId !== a.rooms.ticket_category || scope.staffId !== a.rooms.site_staff || scope.roleId !== team?.roleId ||
    !team?.rooms?.includes(scope.staffId)) return undefined;
  return scope;
}

export const COMPLAINT_CARD = '📝 شكوى من صاحب التذكرة';

// Enqueue on the same write that verifies and stores a newly created private ticket. No backfill.
export function queueComplaint(c, a, r, { fromForm = false } = {}) {
  const scope = complaintScope(c, a);
  if (r.type !== 'report' || !scope || r.notice || r.supportRoleId !== scope.roleId || r.categoryId !== scope.categoryId) return;
  r.notice = { scope, dueAt: c.now() + QUEUE_DELAY, ...(fromForm ? { bodyUntil: c.now() + FORM_DEADLINE } : {}), roster: 'pending', targets: [
    { kind: 'owner', id: scope.ownerId, state: 'queued' },
    { kind: 'inbox', id: scope.staffId, state: 'queued' },
  ] };
}

function matches(c, a, record, notice) {
  return record && !record.closedAt && record.channelId && equal(record.notice?.scope, notice.scope) && equal(complaintScope(c, a), notice.scope);
}

const rosterDue = (notice, now) => notice.roster === 'pending' && !(notice.rosterRetryAt > now);
const due = (notice, now) => notice?.dueAt <= now && !(notice.bodyUntil > now) &&
  (rosterDue(notice, now) || notice.targets.some((t) => t.state === 'queued' && !(t.retryAt > now)));

function compact(notice) {
  if (notice.roster === 'pending' || notice.targets.some((t) => t.state === 'queued') || notice.staffCounts) return;
  // After the queue is finished, keep just counts and the two fixed destinations, not a permanent member roster.
  const staff = notice.targets.filter((target) => target.kind === 'staff');
  notice.staffCounts = {};
  for (const { state } of staff) notice.staffCounts[state] = (notice.staffCounts[state] ?? 0) + 1;
  notice.targets = notice.targets.filter((target) => target.kind !== 'staff');
  delete notice.messageId;
  delete notice.bodyUntil;
}
const eligible = (c, member, id) => member?.user?.id === id && !member.user.bot && id !== c.botId && !member.pending &&
  !(Date.parse(member.communication_disabled_until) > c.now());
const scopeChannel = (c, ch, id) => id === ch?.id && (!ch.guild_id || ch.guild_id === c.guildId) && TEXT_ROOMS.includes(ch.type);

function privateStaffRoom(c, w, channel, scope) {
  if (!scopeChannel(c, channel, scope.staffId)) return false;
  // An @everyone deny alone isn't enough: another role/member overwrite can override it.
  return !hasPermission(c.bits(w, channel, c.guildId, { roles: [] }), P.ViewChannel) && acl(channel).every((o) =>
    !(BigInt(o.allow) & P.ViewChannel) || (o.type === 0 && o.id === scope.roleId) || (o.type === 1 && o.id === c.botId));
}

async function discover(c, scope, requester) {
  const ids = [];
  let after;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const members = await c.api.listGuildMembers(c.guildId, { limit: PAGE, after });
    if (members.some((member) => !isSnowflake(member.user?.id))) throw new DiscordApiError(502);
    const ordered = [...members].sort((a, b) => BigInt(a.user.id) < BigInt(b.user.id) ? -1 : 1);
    for (const member of ordered) {
      const id = member.user?.id;
      if (after && BigInt(id) <= BigInt(after)) throw new DiscordApiError(502);
      after = id;
      if (id === scope.ownerId || id === requester || !eligible(c, member, id) || !member.roles?.includes(scope.roleId)) continue;
      if (ids.length === MAX_STAFF) return { ids, roster: 'limited' };
      ids.push(id);
    }
    if (members.length < PAGE) return { ids, roster: 'listed' };
  }
  return { ids, roster: 'limited' };
}

export function complaintActions(c, verifiedRoom) {
  const stop = (id) => c.edit((a) => {
    const notice = a.requests[id]?.notice;
    if (!notice) return;
    if (notice.roster === 'pending') notice.roster = 'cancelled';
    for (const target of notice.targets) if (target.state === 'queued') target.state = 'skipped';
    compact(notice);
  });

  async function send(w, record, target, notice) {
    const { scope } = notice;
    let dm;
    const current = async () => {
      const [state, guild, room, channel, member] = await Promise.all([
        c.read(), c.api.getGuild(c.guildId), c.api.getChannel(record.channelId), c.api.getChannel(scope.staffId),
        target.kind === 'inbox' ? undefined : c.api.getMember(c.guildId, target.id),
      ]);
      const a = adminOf(state);
      const r = a.requests[record.id];
      if (guild?.id !== c.guildId || guild.owner_id !== scope.ownerId || !matches(c, a, r, notice) ||
        !verifiedRoom({ channels: [room] }, r) || !scopeChannel(c, channel, scope.staffId)) return false;
      if (target.kind === 'inbox') {
        if (!privateStaffRoom(c, w, channel, scope)) return false;
        c.postNeeds(w, channel);
        return true;
      }
      if (!eligible(c, member, target.id)) return false;
      if (target.kind === 'owner') return target.id === guild.owner_id;
      c.authorize(w, a, { by: target.id, member, team: 'support', channel });
      return hasPermission(c.bits(w, room, target.id, member), P.ViewChannel | P.ReadMessageHistory);
    };
    // Re-check the live role and ticket after creating the DM channel, not just when enumerating recipients.
    if (!await current()) return 'skipped';
    let details;
    if (target.kind === 'owner' && notice.messageId) {
      try {
        const message = await c.api.getMessage(record.channelId, notice.messageId);
        const embed = message?.embeds?.[0];
        if (message?.id === notice.messageId && message.channel_id === record.channelId && message.author?.id === c.botId &&
          embed?.title === COMPLAINT_CARD && typeof embed.description === 'string' && embed.description.length <= 2000) {
          details = c.redact(embed.description);
        }
      } catch (error) { c.log.warn('complaint_excerpt_unavailable', errorFields(error)); }
    }
    if (target.kind !== 'inbox') {
      dm = await c.api.createDm(target.id, { guarded: true });
      if (!isSnowflake(dm?.id) || (dm.type !== undefined && dm.type !== C.DM) ||
        (dm.recipients !== undefined && !(Array.isArray(dm.recipients) && dm.recipients.length === 1 && dm.recipients[0]?.id === target.id))) return 'failed';
      if (!await current()) return 'skipped';
    }
    const url = `https://discord.com/channels/${c.guildId}/${record.channelId}`;
    const text = `رقم الشكوى: \`${record.id}\`. افتح التذكرة الخاصة لمتابعة البلاغ والرد عليه.` + (details ? `\n\n**نص الشكوى من النموذج:**\n${details}` : '');
    const payload = post({ ...card('📩 شكوى جديدة في BLACK X', text),
      components: [row(linkButton(url, 'عرض الشكوى الخاصة'))] }, `complaint-notify:${record.id}:${target.kind}:${target.id}`);
    const destination = target.kind === 'inbox' ? scope.staffId : dm.id;
    const message = await c.api.createMessage(destination, payload, { guarded: true });
    return isSnowflake(message?.id) && (!message.channel_id || message.channel_id === destination) ? 'sent' : 'unknown';
  }

  async function advance(w, id) {
    const a = adminOf(await c.read());
    const record = a.requests[id];
    const notice = record?.notice;
    if (!due(notice, c.now())) return;
    if (!matches(c, a, record, notice) || w.guild.owner_id !== notice.scope.ownerId || notice.dueAt + DELIVERY_TTL <= c.now()) {
      await stop(id);
      return;
    }
    try { setupRole(c, w, a, notice.scope.roleId, true, { manageable: false }); }
    catch (error) { if (!(error instanceof AppError)) throw error; await stop(id); return; }
    const next = notice.targets.find((target) => target.state === 'queued' && !(target.retryAt > c.now()));
    if (!next && rosterDue(notice, c.now())) {
      let result;
      try { result = await discover(c, notice.scope, record.by); }
      catch (error) {
        c.log.warn('complaint_roster_failed', errorFields(error));
        const retry = error instanceof DiscordApiError && (error.status === 429 || error.status >= 500) && (notice.rosterAttempts ?? 0) < 2;
        result = { ids: [], roster: retry ? 'pending' : 'unavailable' };
      }
      await c.edit((a) => {
        const r = a.requests[id];
        if (!matches(c, a, r, notice) || !rosterDue(r.notice, c.now())) return;
        r.notice.roster = result.roster;
        if (result.roster === 'pending') {
          r.notice.rosterAttempts = (r.notice.rosterAttempts ?? 0) + 1;
          r.notice.rosterRetryAt = c.now() + RETRY_DELAY * r.notice.rosterAttempts;
          return;
        }
        delete r.notice.rosterRetryAt;
        r.notice.targets.push(...result.ids.map((id) => ({ kind: 'staff', id, state: 'queued' })));
        compact(r.notice);
      });
      return;
    }
    if (!next) return;
    const reserved = await c.edit((a) => {
      const r = a.requests[id];
      if (!matches(c, a, r, notice)) return false;
      const target = r.notice.targets.find((t) => t.id === next.id && t.kind === next.kind);
      if (target?.state !== 'queued' || target.retryAt > c.now()) return false;
      target.attempts = (target.attempts ?? 0) + 1;
      target.state = 'unknown'; // Persist before sending. A crash/timeout may have delivered; never replay blindly.
      return target.attempts;
    });
    if (!reserved) return;
    let outcome;
    try { outcome = await send(w, record, next, notice); }
    catch (error) {
      // Explicit 429 is a known rejection, not ambiguous delivery. Retry with a fresh access check.
      outcome = error instanceof DiscordApiError && error.status === 429 && reserved < 3 ? 'retry' :
        permanent(error) ? 'failed' : error instanceof AppError ? 'skipped' : 'unknown';
      c.log.warn('complaint_notice_failed', { target: next.kind, ...errorFields(error) });
    }
    await c.edit((a) => {
      const current = a.requests[id]?.notice;
      const target = current?.targets.find((t) => t.id === next.id && t.kind === next.kind);
      if (target?.state !== 'unknown') return;
      target.state = outcome === 'retry' ? 'queued' : outcome;
      if (outcome === 'retry') target.retryAt = c.now() + RETRY_DELAY * reserved;
      else delete target.retryAt;
      compact(current);
    });
  }

  return {
    async tick(a) {
      const queue = Object.values(a.requests).filter((r) => due(r.notice, c.now()))
        .sort((l, r) => l.notice.dueAt - r.notice.dueAt);
      if (!queue.length) return;
      const w = await c.world();
      for (let i = 0; i < DM_BUDGET; i += 1) await advance(w, queue[i % queue.length].id);
    },
    async status(i, { id }) {
      await c.owner(i);
      const notice = kindAt(adminOf(await c.read()), idOf(id), 'ticket').notice;
      if (!notice) return ['مفيش تنبيهات خاصة اتسجلت للتذكرة دي.'];
      const labels = { sent: 'وصل', queued: 'في الانتظار', failed: 'اترفض', skipped: 'اتخطّى', unknown: 'غير مؤكد' };
      const count = (key) => notice.staffCounts?.[key] ?? notice.targets.filter((t) => t.kind === 'staff' && t.state === key).length;
      const statistics = Object.keys(labels).map((key) => `${labels[key]}: ${count(key)}`);
      const display = (kind) => labels[notice.targets.find((t) => t.kind === kind)?.state] ?? '—';
      return [`المالك: ${display('owner')} · روم الفريق: ${display('inbox')}.`, `الخاص لفريق الدعم: ${statistics.join('، ')}.`,
        ...(notice.roster === 'pending' ? ['حصر أعضاء الرول لسه في الانتظار.'] : []),
        ...(notice.roster === 'unavailable' ? ['تعذّر حصر الرول. راجع Server Members Intent وصندوق الفريق.'] : []),
        ...(notice.roster === 'limited' ? ['وصلنا لحد حصر الأعضاء. باقي الفريق يتابع صندوق التذاكر الخاص.'] : []),
        ...(notice.roster === 'cancelled' ? ['التنبيهات الباقية اتلغت بسبب الإغلاق أو تغيّر الإعداد أو انتهاء المهلة.'] : [])];
    },
  };
}
