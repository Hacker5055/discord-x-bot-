import { announcementRoom } from '../commands/announce.js';
import { DAY, parsePartyDate } from '../community/time.js';
import { timestamp } from '../community/ui.js';
import { AppError, DiscordApiError, errorFields } from '../lib/errors.js';
import { adminOf, audit, card, denied, fixedChoice, future, idOf, limits, live, notFound, post, requestAt,
  roomRef, safeTitle, stale, TEXT_ROOMS } from './core.js';

const incidentStages = { investigating: 'بنحقق', monitoring: 'بنراقب بعد الإصلاح', resolved: 'اتحلّت' };
const incidentCard = (entry) => card(`🚧 ${entry.title}`, `**${incidentStages[entry.status]}** · ${timestamp(entry.updatedAt)}\n\n${entry.details}\n\`Incident ${entry.id}\``);
const safeWindow = 2 * 60_000;
export function incidentActions(c) {
  return {
    async open(i, { title, details }) {
      title = c.text(title, 100);
      details = c.text(details, 1000, true);
      return c.serial('incident', async () => {
        const ctx = await c.session(i, { team: 'ops', types: TEXT_ROOMS });
        if (ctx.channel.id !== ctx.a.rooms.incident) throw denied();
        c.postNeeds(ctx.w, ctx.channel);
        const latest = Object.values(ctx.a.incidents).find((r) => r.channelId === ctx.channel.id && r.status !== 'resolved');
        if (latest?.messageId) return [`فيه كارت مفتوح بالفعل: \`${latest.id}\`. حدّثه باستخدام /incident update.`];
        if (latest && c.now() - latest.at > safeWindow) {
          throw new AppError('ADMIN_INCIDENT_UNCONFIRMED', `الكارت \`${latest.id}\` نشره غير مؤكد. راجع الروم واستعمل /incident recover.`, 409);
        }
        const id = latest?.id ?? idOf(i.id);
        const incident = latest ?? await c.edit((a) => {
          for (const [key, r] of Object.entries(a.incidents)) if (r.status === 'resolved' && r.updatedAt < c.now() - 7 * DAY) delete a.incidents[key];
          limits(a.incidents, 40);
          const now = c.now();
          a.incidents[id] = { id, by: ctx.by, title, details, channelId: ctx.channel.id, at: now, updatedAt: now, status: 'investigating' };
          return a.incidents[id];
        }, ctx);
        const response = await c.api.createMessage(ctx.channel.id, post(incidentCard(incident), `incident:${id}`));
        await c.edit((a) => {
          requestAt(a.incidents, id).messageId = idOf(response?.id);
          audit(a, 'ops', 'incident_posted', ctx.by, id, c.now());
        });
        return [`اتنشر كارت العطل \`${id}\`. حدث نفس الرسالة بـ/incident update.`];
      });
    },
    async update(i, { id, status, details }) {
      fixedChoice(Object.keys(incidentStages), status);
      details = c.text(details, 1000, true);
      return c.serial('incident', async () => {
        const ctx = await c.session(i, { team: 'ops', types: TEXT_ROOMS });
        const incident = requestAt(ctx.a.incidents, id);
        if (ctx.a.rooms.incident !== ctx.channel.id || incident.channelId !== ctx.channel.id || !incident.messageId || incident.status === 'resolved') throw stale();
        c.postNeeds(ctx.w, ctx.channel);
        const update = { status, details, updatedAt: c.now() };
        await c.assertCurrent(ctx);
        await c.api.editMessage(incident.channelId, incident.messageId, post(incidentCard({ ...incident, ...update })));
        await c.edit((a) => {
          Object.assign(requestAt(a.incidents, id), update);
          audit(a, 'ops', 'incident_updated', ctx.by, id, c.now(), status);
        });
        return ['نفس كارت العطل اتحدّث. مفيش رسالة جديدة اتبعتت.'];
      });
    },
    async recover(i, { id, message }) {
      // Recovery never publishes. Bind only the original incident card, or let the owner close an unconfirmed record.
      return c.serial('incident', async () => {
        const ctx = await c.session(i, { team: 'ops', ownerOnly: true, types: TEXT_ROOMS });
        const incident = requestAt(ctx.a.incidents, id);
        if (incident.channelId !== ctx.channel.id || incident.status === 'resolved') throw stale();
        if (!message && c.now() - incident.at <= safeWindow) throw stale();
        if (incident.messageId) {
          if (message) throw stale();
          try {
            await c.api.getMessage(ctx.channel.id, incident.messageId);
            throw stale();
          } catch (error) { if (!isMissing(error)) throw error; }
        }
        const messageId = message ? idOf(message) : undefined;
        if (messageId) {
          const card = await c.api.getMessage(ctx.channel.id, messageId);
          if (card?.author?.id !== c.botId || card.channel_id !== ctx.channel.id ||
            !card.embeds?.[0]?.description?.endsWith(`\`Incident ${id}\``)) throw notFound();
        }
        await c.edit((a) => {
          const item = requestAt(a.incidents, id);
          if (messageId) item.messageId = messageId;
          else { item.status = 'resolved'; item.updatedAt = c.now(); }
          audit(a, 'ops', 'incident_recovered', ctx.by, id, c.now(), messageId ? 'linked' : 'closed_without_post');
        }, ctx);
        return [messageId ? 'الكارت الأصلي اتربط بالسجل. مفيش نشر جديد.' : 'سجل النشر غير المؤكد اتقفل. مفيش رسائل اتعدّلت.'];
      });
    },
  };
}

const SEND_WINDOW = 15 * 60_000;
const statuses = { scheduled: 'مجدول', dispatching: 'قيد الإرسال', cancelled: 'اتلغى', sent: 'اتنشر', expired: 'انتهت نافذة النشر',
  review: 'راجع الروم؛ النشر غير مؤكد', failed: 'تعذّر النشر' };
export function publicationActions(c) {
  async function scope(i) {
    const by = c.assertGuild(i);
    const state = await c.read();
    const a = adminOf(state);
    live(a);
    const owner = by === c.config.ownerId && i.guild?.ownerId === by;
    if (owner) await c.owner(i);
    return { by, a, owner };
  }
  return {
    // Called only after the legacy /announce permission checks for this destination have passed.
    async queue(i, { key, roomId, owner, publishAt, embeds }) {
      const ctx = await c.session(i, { team: 'ops', types: TEXT_ROOMS, module: 'announcements' });
      const { by } = ctx;
      const room = c.findRoom(ctx.w, roomId, TEXT_ROOMS);
      if (ctx.owner !== owner) throw denied();
      c.authorize(ctx.w, ctx.a, { by, member: ctx.member, team: 'ops', channel: room });
      const at = future(parsePartyDate(publishAt), c.now());
      const id = idOf(i.id);
      const [raw] = embeds;
      const embed = { title: c.text(raw.title, 256), description: c.text(raw.description, 3800, true), color: raw.color,
        ...(raw.url ? { url: c.text(raw.url, 2048) } : {}) };
      await c.edit((a) => {
        live(a, 'announcements');
        if (a.announcements[id]) return;
        for (const [key, r] of Object.entries(a.announcements)) if (!['scheduled', 'dispatching'].includes(r.status) && r.at < c.now() - 7 * DAY) delete a.announcements[key];
        limits(a.announcements, 60);
        if (Object.values(a.announcements).filter((a) => a.status === 'scheduled').length >= 20) throw new AppError('ADMIN_ANNOUNCE_LIMIT', 'فيه ٢٠ إعلان مجدول بالفعل.');
        a.announcements[id] = { id, by, owner, at, key, roomId: idOf(roomId), sourceId: ctx.channel.id, embed, status: 'scheduled' };
        audit(a, 'ops', 'announcement_queued', by, id, c.now());
      }, ctx);
      return [`اتجدول الإعلان \`${id}\` في ${roomRef(roomId)} عند ${timestamp(at)}. الإلغاء: /schedule cancel.`];
    },
    async list(i) {
      const s = await scope(i);
      const items = Object.values(s.a.announcements).filter((a) => s.owner || a.by === s.by).sort((a, b) => b.at - a.at).slice(0, 15);
      return ['📢 الإعلانات المجدولة', ...items.map((a) => `• \`${a.id}\` · ${timestamp(a.at)} · ${statuses[a.status]} · ${safeTitle(a.embed.title)}`),
        ...(items.length ? [] : ['مفيش إعلانات عندك.'])];
    },
    async cancel(i, { id }) {
      const s = await scope(i);
      return c.serial(`announcement:${idOf(id)}`, async () => {
        await c.edit((a) => {
          const r = requestAt(a.announcements, id);
          if (!s.owner && r.by !== s.by) throw notFound();
          if (r.status !== 'scheduled') throw stale();
          r.status = 'cancelled';
          audit(a, 'ops', 'announcement_cancelled', s.by, id, c.now());
        }, s);
        return ['اتلغت الجدولة ومفيش إعلان هيتبعت منها.'];
      });
    },
  };
}

export async function deliverAnnouncements(c, snapshot) {
  const due = Object.values(snapshot.announcements).filter((r) =>
    (r.status === 'dispatching' && r.dispatchUntil <= c.now()) || (r.status === 'scheduled' && r.at <= c.now() &&
      ((snapshot.enabled && !snapshot.paused.announcements && !(r.retryAt > c.now())) || r.at + SEND_WINDOW <= c.now()))).slice(0, 4);
  for (const item of due) await c.serial(`announcement:${item.id}`, async () => {
    const a = adminOf(await c.read());
    const current = a.announcements[item.id];
    if (!current || !['scheduled', 'dispatching'].includes(current.status)) return;
    const finish = async (status, messageId) => c.edit((a) => {
      const r = a.announcements[item.id];
      if (!r || !['scheduled', 'dispatching'].includes(r.status)) return;
      r.status = status;
      if (messageId) r.messageId = messageId;
      audit(a, 'ops', 'announcement_finished', r.by, r.id, c.now(), status);
    });
    // An interrupted POST can have succeeded. Never replay it automatically after a restart.
    if (current.status === 'dispatching') { if (current.dispatchUntil <= c.now()) await finish('review'); return; }
    if (current.at + SEND_WINDOW <= c.now()) { await finish('expired'); return; }
    if (!a.enabled || a.paused.announcements || current.retryAt > c.now()) return;
    let started = false;
    try {
      const [state, actor] = await Promise.all([c.world(), c.api.getMember(c.guildId, current.by)]);
      const room = announcementRoom({ state, config: c.config, botId: c.botId, actor, owner: current.owner, by: current.by, key: current.key });
      if (room.id !== current.roomId) throw stale();
      c.authorize(state, a, { by: current.by, member: actor, team: 'ops', channel: room });
      c.authorize(state, a, { by: current.by, member: actor, team: 'ops', channel: c.findRoom(state, current.sourceId, TEXT_ROOMS) });
      started = await c.edit((draft) => {
        const row = draft.announcements[item.id];
        if (!draft.enabled || draft.version !== a.version || draft.paused.announcements || row?.status !== 'scheduled' || c.now() >= row.at + SEND_WINDOW) return false;
        row.status = 'dispatching';
        row.dispatchUntil = c.now() + 2 * 60_000;
        return true;
      });
      if (!started) return;
      const message = await c.api.createMessage(room.id, post({ embeds: [current.embed] }, `announcement:${item.id}`), { guarded: true });
      await finish('sent', idOf(message?.id));
    } catch (error) {
      c.log.warn('admin_announcement_failed', errorFields(error));
      const explicitReject = error instanceof DiscordApiError && error.status >= 400 && error.status < 500;
      if (started && explicitReject && error.status === 429 && c.now() < current.at + SEND_WINDOW) {
        await c.edit((a) => {
          const r = a.announcements[item.id];
          if (r?.status !== 'dispatching') return;
          r.status = 'scheduled';
          r.retryAt = c.now() + 60_000;
          delete r.dispatchUntil;
        });
        return;
      }
      await finish(started && !explicitReject ? 'review' : 'failed');
    }
  });
}
