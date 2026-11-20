import { createHash } from 'node:crypto';
import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { SITE_ORIGIN } from '../community/anime.js';
import { button, linkButton, row } from '../community/ui.js';
import { hasPermission } from '../discord/permissions.js';
import { isSnowflake } from '../lib/catalog.js';
import { AppError, DiscordApiError } from '../lib/errors.js';
import { assertBridge, bridgeEnabled, siteSession } from '../site/session.js';
import { adminOf, audit, card, denied, fixedChoice, idOf, isMissing, live, nonce, notFound, onboardingRoleName, post, roomRef, stale, TEXT_ROOMS } from './core.js';
import { duplicate, kindAt, setRecord } from './records.js';

const TICKET_MARK = 'bx-ticket:';
const TICKET_ACCESS = P.ViewChannel | P.SendMessages | P.ReadMessageHistory;
const TICKET_BOT = TICKET_ACCESS | P.EmbedLinks;
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
  c.botNeeds(s.w, category, P.ViewChannel, P.ManageChannels, P.ManageRoles, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks);
  return { category, supportRoleId };
}

export function ticketActions(c) {
  async function open(by, type, getSession, { interaction, fromCard, requestId } = {}) {
    fixedChoice(['site', 'report'], type);
    return c.serial(`ticket-user:${by}`, async () => {
      const s = await getSession();
      if (s.channel?.id !== s.a.rooms.ticket_panel) throw denied();
      const panel = s.a.panels.ticket;
      if (fromCard && (!panel || panel.messageId !== interaction.message?.id || panel.channelId !== s.channel.id)) throw stale();
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
          return record;
        });
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
      if (!shared) {
        await c.assertCurrent(s);
        await c.api.createMessage(ch.id, post(card(title, body), key), { guarded: true });
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
        const fresh = await freshTicket(c, s, r);
        if (!fresh || fresh.archived || !hasPermission(c.bits(s.w, fresh.ch, s.by, s.member), P.SendMessages)) throw stale();
        c.postNeeds(s.w, fresh.ch);
        await c.assertCurrent(s);
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

  const discordStaff = (i) => () => c.session(i, { team: 'support' });
  const site = (by, options) => () => siteSession(c, by, options);
  const toResult = ({ s, r }, staff) => ({ ticket: summary(c, s, r, staff) });
  const sharedResult = ({ s, r, message }, staff) => ({ ticket: summary(c, s, r, staff), message: visibleMessage(message) });
  const deliveryLines = (message) => [message.delivery === 'sent' ? 'اترسل الرد في روم التذكرة واتشارك في الموقع.' :
    'الرد محفوظ كمشترك، لكن وصوله لديسكورد غير مؤكّد. راجع روم التذكرة قبل إعادة الإرسال.'];

  return {
    open: (i, { type }) => discordOpen(i, type), fromCard: (i, type) => discordOpen(i, type, true),
    async panel(i) {
      return c.serial('ticket-panel', async () => {
        const s = await c.session(i, { team: 'support', module: 'tickets', types: TEXT_ROOMS });
        if (s.channel.id !== s.a.rooms.ticket_panel || !s.a.rooms.ticket_category || !s.a.teams.support?.roleId) throw denied();
        c.postNeeds(s.w, s.channel);
        const bridged = bridgeEnabled(c, s.a);
        const text = 'اختار نوع الطلب. هتتفتح لك تذكرة خاصة يشوفها فريق الدعم المصرّح له.' +
          (bridged ? '\nتقدر تتابعها من حسابك المربوط على الموقع. رسائل الروم العادية مش بتتنقل للموقع.' : '');
        const payload = post({ ...card('🎫 دعم BLACK X', text),
          components: [row(button('bx:x:ticket:site', 'مشكلة في الموقع', 1), button('bx:x:ticket:report', 'بلاغ', 2),
            ...(bridged ? [linkButton(`${SITE_ORIGIN}/profile`, 'تذاكري على الموقع')] : []))] }, i.id);
        const existing = s.a.panels.ticket;
        let messageId;
        if (existing?.channelId === s.channel.id) {
          try {
            await c.api.editMessage(s.channel.id, existing.messageId, post({ embeds: payload.embeds, components: payload.components }));
            messageId = existing.messageId;
          } catch (error) { if (!isMissing(error)) throw error; }
        }
        if (!messageId) messageId = idOf((await c.api.createMessage(s.channel.id, payload))?.id);
        await c.edit((a) => {
          a.panels.ticket = { channelId: s.channel.id, messageId };
          audit(a, 'support', 'ticket_panel_published', s.by, s.channel.id, c.now());
        }, s);
        return ['لوحة الدعم اتنشرت في الروم.'];
      });
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
