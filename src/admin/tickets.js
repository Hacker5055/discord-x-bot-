import { createHash } from 'node:crypto';
import { ChannelType, LabelBuilder, ModalBuilder, PermissionFlagsBits as P, TextInputBuilder, TextInputStyle } from 'discord.js';
import { SITE_ORIGIN } from '../community/anime.js';
import { button, linkButton, row } from '../community/ui.js';
import { hasPermission } from '../discord/permissions.js';
import { isSnowflake } from '../lib/catalog.js';
import { AppError, DiscordApiError, errorFields, rejectedWrite } from '../lib/errors.js';
import { assertBridge, bridgeEnabled, siteSession } from '../site/session.js';
import { checkTicketCategory, TICKET_ACCESS, TICKET_BOT } from './channel-plan.js';
import { adminOf, audit, card, denied, fixedChoice, idOf, isMissing, live, memberRef, nonce, notFound, onboardingRoleName, post, roomRef, stale, TEXT_ROOMS } from './core.js';
import { COMPLAINT_CARD, complaintActions, complaintScope, queueComplaint } from './complaints.js';
import { detailLines, duplicate, kindAt, setRecord, stages } from './records.js';

const TICKET_MARK = 'bx-ticket:';
const PANEL_TITLE = '🎫 مركز دعم BLACK X';
const MAX_SHARED_PER_TICKET = 40;
const MAX_SHARED_BYTES = 384 * 1024;
const overwrite = (id, type, allow, deny = 0n) => ({ id, type, allow: String(allow), deny: String(deny) });
const readOnly = (id) => overwrite(id, 1, P.ViewChannel | P.ReadMessageHistory, P.SendMessages);
const ticketOverwrites = (c, r) => [overwrite(c.guildId, 0, 0n, P.ViewChannel), overwrite(r.supportRoleId, 0, TICKET_ACCESS),
  overwrite(c.botId, 1, TICKET_BOT), overwrite(r.by, 1, TICKET_ACCESS)];
const same = (one, two) => one.id === two.id && one.type === two.type && String(one.allow) === two.allow && String(one.deny) === two.deny;
const ticketPrivacy = () => new AppError('ADMIN_TICKET_PRIVACY', 'أذونات التذكرة اتغيّرت. راجع خصوصية الروم يدويًا.', 409);
const lost = () => new AppError('ADMIN_TICKET_LOST', 'روم التذكرة مش موجود. خلي الدعم يراجع سجلها.', 409);
const conflictingKey = () => new AppError('SITE_REQUEST_CONFLICT', 'معرّف الطلب اتستخدم قبل كده بمحتوى مختلف.', 409);

function stableTicket(c, w, r) {
  const matches = w.channels.filter((ch) => ch.topic === `${TICKET_MARK}${r.id}` || ch.id === r.channelId);
  if (matches.length > 1) throw stale();
  const ch = matches[0];
  if (!ch) return undefined;
  if ((ch.guild_id && ch.guild_id !== c.guildId) || ch.type !== ChannelType.GuildText ||
    ch.parent_id !== r.categoryId || ch.topic !== `${TICKET_MARK}${r.id}` || (r.channelId && ch.id !== r.channelId)) throw stale();
  const expected = ticketOverwrites(c, r);
  const actual = ch.permission_overwrites ?? [];
  const archived = actual.some((o) => same(o, readOnly(r.by)));
  // Also recognize a lost close acknowledgement. An open record with a read-only room must not receive new replies.
  if ((r.closedAt && !archived) || actual.length !== expected.length || !expected.every((e) =>
    actual.some((o) => same(o, e) || (e.id === r.by && same(o, readOnly(r.by)))))) throw ticketPrivacy();
  return { ch, archived };
}

const staffMatches = (s, r) => s.owner || (s.a.teams.support?.roleId === r.supportRoleId && s.member.roles.includes(r.supportRoleId));
const owns = (s, r, staff) => staff ? staffMatches(s, r) : r.by === s.by;
function scopedRecord(s, id, staff) {
  const r = kindAt(s.a, id, 'ticket');
  if (!owns(s, r, staff)) throw notFound();
  return r;
}

function reader(c, s, r, world = s.w) {
  const room = stableTicket(c, world, r);
  if (room && !hasPermission(c.bits(s.w, room.ch, s.by, s.member), P.ViewChannel | P.ReadMessageHistory)) throw denied();
  return room;
}

async function freshTicket(c, s, r) {
  try {
    return reader(c, s, r, { channels: [await c.api.getChannel(r.channelId)] });
  } catch (error) {
    if (isMissing(error) && error.discordCode === 10003) return undefined;
    throw error;
  }
}

function roomInfo(c, s, r) {
  try {
    const room = reader(c, s, r);
    if (r.channelId && room) return { roomState: 'available', discordUrl: `https://discord.com/channels/${c.guildId}/${room.ch.id}`,
      writable: !r.closedAt && !room.archived && hasPermission(c.bits(s.w, room.ch, s.by, s.member), P.SendMessages) };
    return { roomState: r.status === 'opening' ? 'opening' : 'missing', discordUrl: null, writable: false };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { roomState: 'blocked', discordUrl: null, writable: false };
  }
}

function summary(c, s, r, staff) {
  const visibility = roomInfo(c, s, r);
  return { id: r.id, type: r.type, origin: r.origin ?? 'discord', status: r.status, createdAt: r.at,
    openedAt: r.openedAt ?? null, claimedAt: r.claimedAt ?? null, closedAt: r.closedAt ?? null, firstReplyAt: r.firstReplyAt ?? null,
    ...visibility, ...(staff ? { requesterDiscordId: visibility.roomState === 'available' ? r.by : null,
      assigneeDiscordId: visibility.roomState === 'available' ? r.assignee ?? null : null } : {}) };
}
const visibleMessage = ({ id, body, side, origin, at, delivery }) => ({ id, body, side, origin, at, delivery });
const ticketRows = (s, staff) => Object.values(s.a.requests).filter((r) => r.kind === 'ticket' && owns(s, r, staff));

function siteTicketId(c, by, requestId) {
  // Preserve opaque decimal IDs for Discord slash commands. Use the high-bit range, outside current Discord-generated snowflakes.
  const hash = createHash('sha256').update(`${c.guildId}:${by}:${requestId}`).digest().readBigUInt64BE();
  return String(hash | (1n << 63n));
}

function openSettings(c, s) {
  const category = c.findRoom(s.w, s.a.rooms.ticket_category, [ChannelType.GuildCategory]);
  const supportRoleId = s.a.teams.support?.roleId;
  const supportRole = s.w.allRoles.find((role) => role.id === supportRoleId && role.id !== c.guildId && !role.managed);
  if (!supportRole || c.productRole(s.w, supportRoleId) || onboardingRoleName(supportRole.name)) {
    throw new AppError('ADMIN_TICKET_CONFIG', 'اطلب من الإدارة ضبط رول مستقل لفريق الدعم الأول.');
  }
  checkTicketCategory(c, s.w, category);
  return { category, supportRoleId };
}

const caseButtonId = (action, id) => `bx:x:case:${action}:${id}`;
const caseTypes = { site: 'مشكلة في الموقع', report: 'بلاغ أو شكوى' };
const caseColors = { opening: 0x9B59B6, open: 0x9B59B6, claimed: 0x3498DB, closed: 0x7F8C8D };
const caseEmbed = (r) => ({ title: '🎫 تذكرة BLACK X', color: caseColors[r.status],
  fields: [{ name: 'رقم التذكرة', value: `\`${r.id}\`` }, { name: 'النوع', value: caseTypes[r.type], inline: true },
    { name: 'الحالة', value: stages[r.status], inline: true }], timestamp: new Date(r.openedAt ?? r.at).toISOString() });

function intakeCard(r) {
  const description = r.closedAt ? 'التذكرة اتقفلت من غير حذف. تقدر ترجع للرسائل هنا.' : [
    r.type === 'site' ? 'اكتب اسم الصفحة والمشكلة اللي ظهرت، وإيه الخطوات اللي حصلت قبلها.' : 'لو التفاصيل مش مكتوبة تحت البطاقة، اكتبها هنا في الروم الخاص.',
    'تابع رد فريق الدعم هنا، ومتكتبش كلمة سر أو توكن.',
  ].join('\n');
  return { embeds: [{ ...caseEmbed(r), description }] };
}

function ticketForm(customId, title, field, label, description, maxLength, style = TextInputStyle.Paragraph) {
  return new ModalBuilder().setTitle(title).setCustomId(customId)
    .addLabelComponents(new LabelBuilder().setLabel(label).setDescription(description)
      .setTextInputComponent(new TextInputBuilder().setCustomId(field).setStyle(style).setMaxLength(maxLength).setRequired(true)));
}

export function ticketActions(c) {
  const complaints = complaintActions(c, (w, r) => {
    const room = stableTicket(c, w, r);
    return room && !room.archived;
  });
  async function syncCard(s, r, { first = false } = {}) {
    if (!r.channelId || (!first && !r.cardMessageId)) return;
    try {
      const fresh = await freshTicket(c, s, r);
      if (!fresh || fresh.archived !== Boolean(r.closedAt)) return;
      c.postNeeds(s.w, fresh.ch);
      await c.assertCurrent(s);
      if (!first) {
        await c.api.editMessage(r.channelId, r.cardMessageId, post(intakeCard(r)), { guarded: true });
        return;
      }
      // The opening record is already saved. Never re-post a card after a lost acknowledgement.
      const message = await c.api.createMessage(r.channelId, post(intakeCard(r), `ticket-header:${r.id}`), { guarded: true });
      if (!isSnowflake(message?.id) || (message.channel_id && message.channel_id !== r.channelId)) throw stale();
      await c.edit((a) => { kindAt(a, r.id, 'ticket').cardMessageId = message.id; }, s);
    } catch (error) {
      // A missing header isn't a failed open/claim/close. Staff detail still reads the current record.
      c.log.warn('ticket_card_not_updated', errorFields(error));
    }
  }

  async function open(by, type, getSession, { interaction, fromCard, complaintPanel, requestId } = {}) {
    fixedChoice(['site', 'report'], type);
    return c.serial(`ticket-user:${by}`, async () => {
      const s = await getSession();
      if (s.channel?.id !== s.a.rooms.ticket_panel || s.member.pending === true) throw denied();
      const panel = s.a.panels.ticket;
      const panelId = complaintPanel ?? (fromCard ? interaction.message?.id : undefined);
      if ((fromCard || complaintPanel) && (!panel || panel.messageId !== panelId || panel.channelId !== s.channel.id)) throw stale();
      if (complaintPanel && (!complaintScope(c, s.a) || s.w.guild.owner_id !== c.config.ownerId)) throw stale();
      const isSite = s.source === 'site';
      const id = isSite ? siteTicketId(c, by, requestId) : idOf(interaction.id);
      const r = await c.edit((a) => {
        if (isSite) assertBridge(c, a);
        const prior = a.requests[id];
        if (prior) {
          if (prior.by !== by || prior.kind !== 'ticket' || prior.type !== type || (isSite && prior.openRequestId !== requestId)) {
            throw conflictingKey();
          }
          return prior;
        }
        live(a, 'tickets');
        if (isSite && s.w.channels.some((ch) => ch.topic === `${TICKET_MARK}${id}`)) {
          throw new AppError('SITE_REQUEST_EXPIRED', 'الطلب القديم اتشال من السجل. افتح طلبًا جديدًا بدل إعادة المحاولة بنفس المعرّف.', 409);
        }
        const existing = Object.values(a.requests).find((item) => item.kind === 'ticket' && item.by === by && !item.closedAt);
        if (existing) {
          if (isSite) throw duplicate();
          return existing;
        }
        if (Object.values(a.requests).filter((item) => item.kind === 'ticket' && !item.closedAt).length >= 35) {
          throw new AppError('ADMIN_TICKET_LIMIT', 'فيه تذاكر كتير مفتوحة حاليًا. جرّب بعد ما الدعم يقفل منها.', 409);
        }
        const { category, supportRoleId } = openSettings(c, s);
        return setRecord(a, { id, kind: 'ticket', by, at: c.now(), status: 'opening', type, categoryId: category.id, supportRoleId,
          ...(isSite ? { origin: 'site', openRequestId: requestId } : {}) });
      }, s);
      if (r.closedAt || r.channelId) {
        if (!isSite && r.channelId && !reader(c, s, r)) throw lost();
        return { s, r, existing: true };
      }
      return c.serial(`ticket:${r.id}`, async () => {
        const current = kindAt(adminOf(await c.read()), r.id, 'ticket');
        if (current.closedAt) return { s, r: current, existing: true };
        const a = s.a;
        live(a, 'tickets');
        if (r.categoryId !== a.rooms.ticket_category || r.supportRoleId !== a.teams.support?.roleId) throw stale();
        const { category } = openSettings(c, s);
        const recover = async () => stableTicket(c, { channels: await c.api.getChannels(c.guildId) }, r)?.ch;
        await c.assertCurrent(s);
        const room = stableTicket(c, s.w, r)?.ch ?? await c.api.createChannel(c.guildId, {
          type: ChannelType.GuildText, name: `bx-ticket-${r.id}`, parent_id: category.id,
          topic: `${TICKET_MARK}${r.id}`, permission_overwrites: ticketOverwrites(c, r),
        }, recover);
        const verified = stableTicket(c, { channels: [room] }, r);
        if (!isSnowflake(verified?.ch.id) || verified.archived) throw stale();
        const saved = await c.edit((admin) => {
          const record = kindAt(admin, r.id, 'ticket');
          if (record.status !== 'opening') throw stale();
          Object.assign(record, { channelId: room.id, status: 'open', openedAt: c.now() });
          queueComplaint(c, admin, record, { fromForm: Boolean(complaintPanel) });
          return record;
        });
        await syncCard(s, saved, { first: true });
        return { s: { ...s, w: { ...s.w, channels: [...s.w.channels.filter((ch) => ch.id !== room.id), room] } }, r: saved };
      });
    });
  }

  async function discordOpen(i, type, fromCard = false) {
    const { s, r, existing } = await open(c.assertGuild(i), type, () => c.session(i, { module: 'tickets', types: TEXT_ROOMS }), { interaction: i, fromCard });
    if (r.closedAt) return ['التذكرة مقفولة بالفعل.'];
    if (existing) return [`عندك تذكرة مفتوحة بالفعل: ${roomRef(r.channelId)}.`];
    return [`اتفتحت تذكرة \`${r.id}\`: ${roomRef(r.channelId)}. اكتب التفاصيل هناك، ومن غير توكنات أو أسرار.`,
      ...(bridgeEnabled(c, s.a) ? ['لو عايز تبعت رسالة مشتركة مع الموقع، استخدم /ticket share من جوّه التذكرة.'] : [])];
  }

  async function claim(id, getSession) {
    return c.serial(`ticket:${idOf(id)}`, async () => {
      const s = await getSession();
      const r = scopedRecord(s, id, true);
      const room = reader(c, s, r);
      if (r.closedAt || !r.channelId || !room || room.archived) throw stale();
      const record = await c.edit((a) => {
        const current = kindAt(a, id, 'ticket');
        if (current.closedAt || (current.assignee && current.assignee !== s.by)) throw stale();
        if (current.assignee !== s.by) {
          Object.assign(current, { assignee: s.by, claimedAt: c.now(), status: 'claimed' });
          audit(a, 'support', 'ticket_claimed', s.by, id, c.now());
        }
        return current;
      }, s);
      if (record.status !== r.status) await syncCard(s, record);
      return { s, r: record };
    });
  }

  async function close(id, reason, getSession) {
    reason = c.text(reason, 250);
    return c.serial(`ticket:${idOf(id)}`, async () => {
      const s = await getSession();
      const r = scopedRecord(s, id, true);
      if (r.closedAt) {
        await c.assertCurrent(s);
        return { s, r, alreadyClosed: true };
      }
      const observed = reader(c, s, r);
      const room = observed && r.channelId ? await freshTicket(c, s, r) : observed;
      const mayArchive = room && !room.archived;
      if (mayArchive) {
        c.botNeeds(s.w, room.ch, P.ViewChannel, P.ManageRoles);
        await c.assertCurrent(s);
        const { allow, deny, type } = readOnly(r.by);
        await c.api.putOverwrite(room.ch.id, r.by, { allow, deny, type });
        room.ch.permission_overwrites = room.ch.permission_overwrites.map((o) => o.id === r.by ? readOnly(r.by) : o);
      }
      const record = await c.edit((a) => {
        const current = kindAt(a, id, 'ticket');
        Object.assign(current, { status: 'closed', reason, closedAt: c.now(), resolvedBy: s.by });
        audit(a, 'support', 'ticket_closed', s.by, id, c.now());
        return current;
      }, mayArchive ? undefined : s);
      if (room) await syncCard(s, record);
      const channels = s.w.channels.filter((ch) => ch.id !== r.channelId && ch.id !== observed?.ch.id);
      if (room) channels.push(room.ch);
      return { s: { ...s, w: { ...s.w, channels } }, r: record };
    });
  }

  async function replyTo(id, body, key, getSession, { staff, shared, inRoom } = {}) {
    body = c.text(body, 1000, true);
    return c.serial(`ticket:${idOf(id)}`, async () => {
      const s = await getSession();
      const r = scopedRecord(s, id, staff);
      if (inRoom && (r.channelId !== s.channel?.id || s.member.pending === true)) throw notFound();
      const room = reader(c, s, r);
      if (!r.channelId || !room) throw lost();
      const { ch } = room;
      const origin = s.source === 'site' ? 'site' : 'discord';
      const side = staff ? 'support' : 'requester';
      const messageId = nonce(`ticket:${id}:${s.by}:${origin}:${side}:${key}`);
      if (shared) {
        assertBridge(c, s.a);
        const prior = r.shared?.find((entry) => entry.id === messageId);
        if (prior) {
          if (prior.body !== body) throw conflictingKey();
          await c.assertCurrent(s);
          return { s, r, message: prior };
        }
      }
      if (r.closedAt || room.archived) throw stale();
      if (!hasPermission(c.bits(s.w, ch, s.by, s.member), P.SendMessages)) throw denied();
      c.postNeeds(s.w, ch);
      const title = staff ? 'رد من دعم BLACK X' : 'رسالة صاحب التذكرة';
      async function recheckDestination() {
        const fresh = await freshTicket(c, s, r);
        if (!fresh || fresh.archived || !hasPermission(c.bits(s.w, fresh.ch, s.by, s.member), P.SendMessages)) throw stale();
        c.postNeeds(s.w, fresh.ch);
        await c.assertCurrent(s);
      }
      if (!shared) {
        await recheckDestination();
        await c.api.createMessage(ch.id, post(card(title, safeTicketText(body)), key), { guarded: true });
        await c.edit((a) => {
          kindAt(a, id, 'ticket').firstReplyAt ??= c.now();
          audit(a, 'support', 'ticket_replied', s.by, id, c.now());
        });
        return { s, r };
      }

      // Persist the explicitly shared message before the side-effect. If a response is lost, a replay can read it,
      // but cannot post it a second time after Discord's short nonce-deduplication window or a bot restart.
      const entry = { id: messageId, body, side, origin, at: c.now(), delivery: 'unconfirmed' };
      const reservation = await c.edit((a) => {
        assertBridge(c, a);
        const current = kindAt(a, id, 'ticket');
        if (current.closedAt || current.channelId !== ch.id) throw stale();
        const history = current.shared ??= [];
        const replay = history.find((other) => other.id === messageId);
        if (replay) {
          if (replay.body !== body) throw conflictingKey();
          return { r: current, message: replay };
        }
        const bytes = Object.values(a.requests).reduce((total, item) => total + (item.shared ? Buffer.byteLength(JSON.stringify(item.shared)) : 0), 0);
        if (history.length >= MAX_SHARED_PER_TICKET || bytes + Buffer.byteLength(JSON.stringify(entry)) + 32 > MAX_SHARED_BYTES) {
          throw new AppError('ADMIN_TICKET_HISTORY_LIMIT', 'سجل المشاركة ممتلئ. كمّل في روم التذكرة على ديسكورد بدون مشاركة.', 409);
        }
        history.push(entry);
        audit(a, 'support', 'ticket_reply_shared', s.by, id, c.now());
        return null;
      }, s);
      if (reservation) return { s, ...reservation };
      let attempted = false;
      try {
        // Refresh the destination right before posting user text. Do not read any Discord messages.
        await recheckDestination();
        attempted = true;
        const sent = await c.api.createMessage(ch.id, post(card(`${title} · مشترك مع الموقع`, safeTicketText(body)), messageId), { guarded: true });
        if (!isSnowflake(sent?.id) || (sent.channel_id && sent.channel_id !== ch.id)) throw new DiscordApiError(502);
      } catch (error) {
        // A definite rejection (or a cancelled preflight) permits manual retry with the same key.
        if (!attempted || (error instanceof DiscordApiError && [400, 401, 403, 404, 429].includes(error.status))) {
          await c.edit((a) => {
            const current = kindAt(a, id, 'ticket');
            current.shared = current.shared.filter((other) => other.id !== messageId);
            audit(a, 'support', 'ticket_reply_not_delivered', s.by, id, c.now(), 'rejected');
          });
          throw error;
        }
        c.log.warn('ticket_shared_delivery_unconfirmed');
        return { s, r, message: entry };
      }
      const confirmed = await c.edit((a) => {
        const current = kindAt(a, id, 'ticket');
        const message = current.shared.find((other) => other.id === messageId);
        message.delivery = 'sent';
        if (staff) current.firstReplyAt ??= c.now();
        audit(a, 'support', 'ticket_reply_delivered', s.by, id, c.now());
        return { r: current, message };
      });
      return { s, ...confirmed };
    });
  }

  const discordStaff = (i) => async () => {
    const s = await c.session(i, { team: 'support' });
    if (s.member.pending === true) throw denied();
    return s;
  };
  const site = (by, options) => () => siteSession(c, by, options);
  const toResult = ({ s, r }, staff) => ({ ticket: summary(c, s, r, staff) });
  const sharedResult = ({ s, r, message }, staff) => ({ ticket: summary(c, s, r, staff), message: visibleMessage(message) });
  const deliveryLines = (message) => [message.delivery === 'sent' ? 'اترسل الرد في روم التذكرة واتشارك في الموقع.' :
    'الرد محفوظ كمشترك، لكن وصوله لديسكورد غير مؤكّد. راجع روم التذكرة قبل إعادة الإرسال.'];

  async function publishPanel(i, roomId, version, { message_id, retry_unconfirmed } = {}) {
    return c.serial('ticket-panel', async () => {
      const s = await c.session(i, { team: 'support', module: 'tickets', types: TEXT_ROOMS,
        ...(roomId ? { roomId } : {}), ownerOnly: Boolean(roomId || message_id || retry_unconfirmed) });
      if (version !== undefined && s.a.version !== version) throw stale();
      if (s.channel.id !== s.a.rooms.ticket_panel || !s.a.rooms.ticket_category || !s.a.teams.support?.roleId) throw denied();
      openSettings(c, s);
      c.postNeeds(s.w, s.channel);
      const bridged = bridgeEnabled(c, s.a);
      const complaint = complaintScope(c, s.a);
      const text = 'اختار المسار المناسب. هتتفتح لك تذكرة خاصة لفريق الدعم المخوّل؛ اكتب التفاصيل هناك، مش في روم عام.\n' +
        '**تذكرة واحدة مفتوحة لكل عضو.** لو عندك واحدة، كمّل فيها.' +
        (bridged ? '\nتقدر تتابعها من حسابك المربوط؛ الشات العادي مش بيتنقل للموقع.' : '');
      const embed = { ...card(PANEL_TITLE, text).embeds[0], fields: [
        { name: '🛠️ مشكلة في الموقع', value: 'لو حاجة مش شغّالة في صفحة أو حساب أو حلقة.' },
        { name: complaint ? '📝 قدّم شكوى' : '📝 بلاغ', value: complaint
          ? 'اكتب في النموذج الخاص. البوت يحاول يوصل نصه للمالك على الخاص ورابط التذكرة لفريق الدعم.'
          : 'افتح تذكرة خاصة لبلاغ عن مشكلة في السيرفر.' },
      ], footer: { text: 'ما تبعتش كلمة سر أو توكن.' } };
      const payload = post({ embeds: [embed], components: [row(button('bx:x:ticket:site', 'مشكلة في الموقع', 1),
        complaint ? button('bx:x:complaint:open', 'قدّم شكوى', 2) : button('bx:x:ticket:report', 'بلاغ', 2),
        ...(bridged ? [linkButton(`${SITE_ORIGIN}/profile`, 'تذاكري على الموقع')] : []))] }, i.id);
      const channelId = s.channel.id;
      const existing = s.a.panels.ticket;
      const pending = s.a.panels.ticketPending;
      const recovering = message_id && idOf(message_id);
      const edit = (id) => c.api.editMessage(channelId, id, post({ embeds: payload.embeds, components: payload.components }), { guarded: true });
      let messageId;
      let attemptId;
      await c.assertCurrent(s);
      if (existing?.channelId === channelId) {
        try {
          if (recovering && recovering !== existing.messageId) {
            await c.api.getMessage(channelId, existing.messageId);
            throw new AppError('TICKET_PANEL_TRACKED', 'فيه لوحة مسجّلة وموجودة أصلًا في الروم. استخدم /ticket panel عشان تحدّثها.');
          }
          await edit(existing.messageId);
          messageId = existing.messageId;
        } catch (error) { if (!isMissing(error) || error.discordCode !== 10008) throw error; }
      }
      if (!messageId && recovering) {
        const message = await c.api.getMessage(channelId, recovering);
        const buttons = message?.components?.flatMap((row) => row.components ?? []).map(({ custom_id }) => custom_id) ?? [];
        if (message?.id !== recovering || message.channel_id !== channelId || message.author?.id !== c.botId ||
          message.embeds?.[0]?.title !== PANEL_TITLE || !buttons.includes('bx:x:ticket:site') ||
          !buttons.some((id) => ['bx:x:ticket:report', 'bx:x:complaint:open'].includes(id))) {
          throw new AppError('TICKET_PANEL_MESSAGE', 'اختار معرّف لوحة الدعم القديمة اللي البوت نشرها في نفس الروم.');
        }
        await c.assertCurrent(s);
        await edit(recovering);
        messageId = recovering;
      }
      if (!messageId) {
        if (pending?.channelId === channelId && !retry_unconfirmed) throw new AppError('TICKET_PANEL_UNCONFIRMED',
          'نشر اللوحة السابق مش مؤكّد. راجع الروم: لو لقيتها استخدم /ticket panel message_id:معرّفها؛ لو اتأكدت إنها مش موجودة استخدم /ticket panel retry_unconfirmed:true.');
        attemptId = idOf(i.id);
        const unchanged = (a) => a.panels.ticketPending?.attemptId === pending?.attemptId && a.panels.ticketPending?.channelId === pending?.channelId;
        await c.edit((a) => {
          if (!unchanged(a)) throw stale();
          a.panels.ticketPending = { channelId, attemptId };
        }, s);
        try { messageId = idOf((await c.api.createMessage(channelId, payload, { guarded: true }))?.id); }
        catch (error) {
          if (rejectedWrite(error)) await c.edit((a) => {
            if (a.panels.ticketPending?.attemptId === attemptId) delete a.panels.ticketPending;
          });
          throw error;
        }
      }
      await c.edit((a) => {
        if (attemptId && a.panels.ticketPending?.attemptId !== attemptId) throw stale();
        a.panels.ticket = { channelId, messageId };
        if (a.panels.ticketPending?.channelId === channelId) delete a.panels.ticketPending;
        audit(a, 'support', 'ticket_panel_published', s.by, channelId, c.now());
      }, s);
      return [`لوحة الدعم اتنشرت في ${roomRef(s.channel.id)}.`];
    });
  }

  return {
    open: (i, { type }) => discordOpen(i, type), fromCard: (i, type) => discordOpen(i, type, true),
    panel: (i, options) => publishPanel(i, undefined, undefined, options), publishForOwner: publishPanel, complaints,
    complaintForm(i) {
      c.assertGuild(i);
      const id = idOf(i.message?.id);
      return ticketForm(`bx:x:complaint:${id}`, 'شكوى خاصة · BLACK X', 'details', 'تفاصيل الشكوى',
        'النص بيتحفظ في التذكرة الخاصة ويوصل للمالك في الخاص. ما تكتبش أسرار أو كلمات سر.', 1000);
    },
    staffForm(i, action, id) {
      c.assertGuild(i);
      // Initial acknowledgement is a blank modal. All case access is checked live when it is submitted.
      const customId = caseButtonId(action, idOf(id));
      if (action === 'reply') return ticketForm(customId, 'رد خاص على التذكرة', 'body', 'الرد', 'هيتبعت في روم التذكرة فقط؛ مش هيُشارك على الموقع.', 1000);
      return ticketForm(customId, 'تأكيد إغلاق التذكرة', 'reason', 'سبب القفل', 'التذكرة هتتقفل للكتابة لصاحبها من غير حذف الروم.', 250, TextInputStyle.Short);
    },
    async staffDetail(i, { id }) {
      const s = await discordStaff(i)();
      const r = scopedRecord(s, id, true);
      const room = reader(c, s, r);
      await c.assertCurrent(s);
      const description = room ? [...detailLines(r).slice(1), ...(r.assignee ? [`مسؤول التذكرة: ${memberRef(r.assignee)}`] : [])].join('\n')
        : 'روم التذكرة مش متاح حاليًا. مفيش إجراء سريع للروم ده.';
      const controls = room && r.channelId && !r.closedAt && !room.archived ? [row(
        button(caseButtonId('claim', id), 'استلم', 1, Boolean(r.assignee)), button(caseButtonId('reply', id), 'ردّ في الروم'),
        button(caseButtonId('close', id), 'اقفل التذكرة', 4),
      )] : [];
      return { embeds: [{ ...caseEmbed(r), description }], components: controls };
    },
    async complain(i, panelId, details) {
      const by = c.assertGuild(i);
      const body = c.text(details, 1000, true);
      if (i.message && i.message.id !== panelId) throw stale();
      const { s, r, existing } = await open(by, 'report', () => c.session(i, { module: 'tickets', types: TEXT_ROOMS }), { interaction: i, complaintPanel: idOf(panelId) });
      if (r.closedAt) return ['التذكرة دي كانت اتقفلت بالفعل.'];
      const room = roomRef(r.channelId);
      if (existing) return [`عندك تذكرة مفتوحة بالفعل: ${room}. ما كررناش الإرسال. كمّل في نفس التذكرة.`];
      try {
        await c.serial(`ticket:${r.id}`, async () => {
          const current = kindAt(adminOf(await c.read()), r.id, 'ticket');
          const verified = await freshTicket(c, s, current);
          if (current.closedAt || !verified || verified.archived) throw stale();
          c.postNeeds(s.w, verified.ch);
          await c.assertCurrent(s);
          const message = await c.api.createMessage(r.channelId, post(card(COMPLAINT_CARD, safeTicketText(body)), `complaint-body:${r.id}`), { guarded: true });
          if (!isSnowflake(message?.id) || (message.channel_id && message.channel_id !== r.channelId)) throw stale();
          // Remember only the pointer for the owner's copy. The body lives in the verified Discord room.
          await c.edit((a) => {
            const current = kindAt(a, r.id, 'ticket');
            if (!current.notice || current.closedAt || current.channelId !== r.channelId) return;
            current.notice.messageId = message.id;
            delete current.notice.bodyUntil;
          });
        });
      } catch {
        c.log.warn('complaint_body_unconfirmed');
        return [`اتفتحت التذكرة ${room}، لكن وصول نص الشكوى مش مؤكد. راجع الروم الخاص؛ لو النص مش موجود اكتبه هناك.`];
      }
      return [`اتسجّلت شكواك في التذكرة الخاصة ${room}. تابع الرد هناك. هنحاول نبعت نص النموذج للمالك في الخاص، وتنبيه برابط التذكرة لفريق الدعم.`];
    },
    async claim(i, { id }) {
      await claim(id, discordStaff(i));
      return [`التذكرة \`${id}\` اتسجلت باسمك.`];
    },
    async reply(i, { id, body, share }) {
      const result = await replyTo(id, body, idOf(i.id), discordStaff(i), { staff: true, shared: share === true });
      return result.message ? deliveryLines(result.message) : ['اترسل الرد جوّه التذكرة فقط.'];
    },
    async share(i, { id, body }) {
      const result = await replyTo(id, body, idOf(i.id), () => c.session(i, { types: TEXT_ROOMS }), { shared: true, inRoom: true });
      return deliveryLines(result.message);
    },
    async close(i, { id, reason }) {
      const result = await close(id, reason, discordStaff(i));
      return [result.alreadyClosed ? 'التذكرة مقفولة بالفعل.' : 'التذكرة اتقفلت من غير حذف. لو الروم موجود، صاحب الطلب يقدر يقرأه من غير كتابة.'];
    },
    site: {
      async open({ discordId, type, requestId }) {
        return toResult(await open(discordId, type, site(discordId, { open: true }), { requestId }), false);
      },
      async list({ discordId }, staff) {
        const s = await siteSession(c, discordId, { staff });
        await c.assertCurrent(s);
        return { tickets: ticketRows(s, staff).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).map((r) => summary(c, s, r, staff)) };
      },
      async detail({ discordId, id }, staff) {
        const s = await siteSession(c, discordId, { staff });
        const r = scopedRecord(s, id, staff);
        const ticket = summary(c, s, r, staff);
        await c.assertCurrent(s);
        const visible = ticket.roomState === 'available';
        return { ticket, reason: visible ? r.reason ?? null : null, messages: visible ? (r.shared ?? []).map(visibleMessage) : [] };
      },
      async claim({ discordId, id }) { return toResult(await claim(id, site(discordId, { staff: true })), true); },
      async reply({ discordId, id, body, requestId }, staff) {
        return sharedResult(await replyTo(id, body, requestId, site(discordId, { staff }), { staff, shared: true }), staff);
      },
      async close({ discordId, id, reason }) { return toResult(await close(id, reason, site(discordId, { staff: true })), true); },
      intakeStatus(s) {
        let configured = false;
        try {
          c.findRoom(s.w, s.a.rooms.ticket_panel, TEXT_ROOMS);
          openSettings(c, s);
          configured = true;
        } catch (error) { if (!(error instanceof AppError)) throw error; }
        return { configured, paused: Boolean(s.a.paused.tickets) };
      },
      counts(s) {
        const counts = { opening: 0, open: 0, claimed: 0, closed: 0 };
        for (const r of ticketRows(s, true)) counts[r.status] += 1;
        return counts;
      },
    },
  };
}

// Display bridge messages as text, not masked links, mentions, or other rich formatting.
const safeTicketText = (text) => text.replace(/[\\*_~`|<>\[\]()#]/gu, '\\$&');
