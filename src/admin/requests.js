import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { DAY } from '../community/time.js';
import { button, row, timestamp } from '../community/ui.js';
import { compareRoles, highestRole } from '../discord/permissions.js';
import { isSnowflake } from '../lib/catalog.js';
import { AppError } from '../lib/errors.js';
import { adminOf, audit, card, denied, fixedChoice, idOf, isMissing, limits, live, memberRef, notFound, post, requestAt,
  roomRef, safeTitle, stale, TEXT_ROOMS } from './core.js';

export const requestTeam = { ticket: 'support', appeal: 'moderation', idea: 'events', creator: 'content', correction: 'content' };
const labels = { ticket: 'تذكرة', appeal: 'استئناف', idea: 'اقتراح', creator: 'طلب Creator', correction: 'تصحيح كتالوج' };
const stages = { opening: 'قيد الفتح', open: 'مفتوحة', claimed: 'مستلمة', submitted: 'مستني المراجعة', review: 'قيد التصويت',
  closed: 'مقفولة', approved: 'اتقبل', rejected: 'اترَفض', implemented: 'اتنفّذ' };
const duplicate = () => new AppError('ADMIN_DUPLICATE_REQUEST', 'عندك طلب مفتوح من النوع ده بالفعل. راجع /my.', 409);
const setRecord = (a, record, { maxForMember = 1, unique } = {}) => {
  if (a.requests[record.id]) return a.requests[record.id];
  // Prune old metadata only. Archived ticket channels/messages are never auto-deleted.
  for (const [id, r] of Object.entries(a.requests)) if (r.closedAt && r.closedAt < record.at - 90 * DAY) delete a.requests[id];
  const open = Object.values(a.requests).filter((r) => r.kind === record.kind && r.by === record.by && !r.closedAt);
  if (open.length >= maxForMember || (unique && Object.values(a.requests).some(unique))) throw duplicate();
  if (Object.keys(a.requests).length >= 300) {
    // Preserve the entire support reporting window even under heavier request volume.
    const oldest = Object.values(a.requests).filter((r) => r.closedAt && r.closedAt < record.at - 7 * DAY)
      .sort((l, r) => l.closedAt - r.closedAt)[0];
    if (oldest) delete a.requests[oldest.id];
  }
  limits(a.requests, 300);
  a.requests[record.id] = record;
  audit(a, requestTeam[record.kind], `${record.kind}_opened`, record.by, record.id, record.at);
  return record;
};
const kindAt = (a, id, kind) => {
  const record = requestAt(a.requests, id);
  if (record.kind !== kind) throw notFound();
  return record;
};
export const requestLine = (r) => `• \`${r.id}\` · ${labels[r.kind]} — ${stages[r.status]}${r.assignee ? ` · ${memberRef(r.assignee)}` : ''}`;
export function detailLines(r) {
  return [requestLine(r), `مقدّم الطلب: ${memberRef(r.by)} · ${timestamp(r.at)}`,
    ...(r.channelId ? [`الروم: ${roomRef(r.channelId)}`] : []), ...(r.subject ? [safeTitle(r.subject)] : []),
    ...(r.note ? [safeTitle(r.note)] : []), ...(r.link ? [`<${r.link}>`] : []),
    ...(r.caseId ? [`رقم التنبيه: \`${r.caseId}\``] : []), ...(r.animeId ? [`معرّف الأنمي: \`${r.animeId}\``] : []),
    ...(r.reason ? [`القرار: ${safeTitle(r.reason)}`] : [])];
}

const TICKET_MARK = 'bx-ticket:';
const TICKET_ACCESS = P.ViewChannel | P.SendMessages | P.ReadMessageHistory;
const TICKET_BOT = TICKET_ACCESS | P.EmbedLinks;
const overwrite = (id, type, allow, deny = 0n) => ({ id, type, allow: String(allow), deny: String(deny) });
const ticketOverwrites = (c, r) => [overwrite(c.guildId, 0, 0n, P.ViewChannel), overwrite(r.supportRoleId, 0, TICKET_ACCESS),
  overwrite(c.botId, 1, TICKET_BOT), overwrite(r.by, 1, TICKET_ACCESS)];
function stableTicket(c, w, r) {
  const matches = w.channels.filter((ch) => ch.topic === `${TICKET_MARK}${r.id}` || ch.id === r.channelId);
  if (matches.some((ch) => (ch.guild_id && ch.guild_id !== c.guildId) || ch.type !== ChannelType.GuildText ||
    ch.parent_id !== r.categoryId || ch.topic !== `${TICKET_MARK}${r.id}`)) throw stale();
  if (matches.length > 1) throw stale();
  const ch = matches[0];
  if (!ch) return undefined;
  if (r.channelId && ch.id !== r.channelId) throw stale();
  const expected = ticketOverwrites(c, r);
  const actual = ch.permission_overwrites ?? [];
  const memberReadOnly = overwrite(r.by, 1, P.ViewChannel | P.ReadMessageHistory, P.SendMessages);
  const same = (one, two) => one?.id === two.id && one.type === two.type && String(one.allow) === two.allow && String(one.deny) === two.deny;
  if (actual.length !== expected.length || !expected.every((e) => actual.some((o) => same(o, e) || (e.id === r.by && same(o, memberReadOnly))))) {
    throw new AppError('ADMIN_TICKET_PRIVACY', 'أذونات التذكرة اتغيّرت. راجع خصوصية الروم يدويًا، البوت مش هيكتب فيه.', 409);
  }
  return ch;
}

export function ticketActions(c) {
  const ticketType = (value) => fixedChoice(['site', 'report'], value);
  async function open(i, type, fromCard = false) {
    ticketType(type);
    const user = c.assertGuild(i);
    return c.serial(`ticket-user:${user}`, async () => {
      const s = await c.session(i, { module: 'tickets', types: TEXT_ROOMS });
      if (s.channel.id !== s.a.rooms.ticket_panel) throw denied();
      const panel = s.a.panels.ticket;
      if (fromCard && (!panel || panel.messageId !== i.message?.id || panel.channelId !== s.channel.id)) throw stale();
      const category = c.findRoom(s.w, s.a.rooms.ticket_category, [ChannelType.GuildCategory]);
      const supportRoleId = s.a.teams.support?.roleId;
      if (!s.w.allRoles.some((r) => r.id === supportRoleId && r.id !== c.guildId && !r.managed) || c.productRole(s.w, supportRoleId)) {
        throw new AppError('ADMIN_TICKET_CONFIG', 'اطلب من الإدارة ضبط فريق الدعم الأول.');
      }
      c.botNeeds(s.w, category, P.ViewChannel, P.ManageChannels, P.ManageRoles, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks);
      const r = await c.edit((a) => {
        live(a, 'tickets');
        const existing = Object.values(a.requests).find((r) => r.kind === 'ticket' && r.by === user && !r.closedAt);
        if (existing) return existing;
        if (Object.values(a.requests).filter((r) => r.kind === 'ticket' && !r.closedAt).length >= 35) {
          throw new AppError('ADMIN_TICKET_LIMIT', 'فيه تذاكر كتير مفتوحة حاليًا. جرّب بعد ما الدعم يقفل منها.', 409);
        }
        return setRecord(a, { id: idOf(i.id), kind: 'ticket', by: user, at: c.now(), status: 'opening', type,
          categoryId: category.id, supportRoleId });
      }, s);
      if (r.channelId) {
        if (!stableTicket(c, s.w, r)) throw new AppError('ADMIN_TICKET_LOST', 'روم التذكرة اتمسح. خلي الدعم يقفل سجلها قبل فتح واحدة جديدة.', 409);
        return [`عندك تذكرة مفتوحة بالفعل: ${roomRef(r.channelId)}.`];
      }
      if (r.categoryId !== category.id || r.supportRoleId !== supportRoleId) throw stale();
      const recover = async () => stableTicket(c, { channels: await c.api.getChannels(c.guildId) }, r);
      const room = stableTicket(c, s.w, r) ?? await c.api.createChannel(c.guildId, {
        type: ChannelType.GuildText, name: `bx-ticket-${r.id}`, parent_id: category.id,
        topic: `${TICKET_MARK}${r.id}`, permission_overwrites: ticketOverwrites(c, r),
      }, recover);
      const verified = stableTicket(c, { channels: [room] }, r);
      if (!isSnowflake(verified?.id)) throw stale();
      await c.edit((a) => {
        const current = kindAt(a, r.id, 'ticket');
        if (current.status !== 'opening') throw stale();
        current.channelId = room.id;
        current.status = 'open';
        current.openedAt = c.now();
      });
      return [`اتفتحت تذكرة \`${r.id}\`: ${roomRef(room.id)}. اكتب التفاصيل هناك، ومن غير توكنات أو أسرار.`];
    });
  }

  return {
    open: (i, { type }) => open(i, type), fromCard: (i, type) => open(i, type, true),
    async panel(i) {
      return c.serial('ticket-panel', async () => {
        const s = await c.session(i, { team: 'support', module: 'tickets', types: TEXT_ROOMS });
        if (s.channel.id !== s.a.rooms.ticket_panel || !s.a.rooms.ticket_category || !s.a.teams.support?.roleId) throw denied();
        c.postNeeds(s.w, s.channel);
        const payload = post({ ...card('🎫 دعم BLACK X', 'اختار نوع الطلب. هتتفتح لك تذكرة خاصة يشوفها فريق الدعم المصرّح له.'),
          components: [row(button('bx:x:ticket:site', 'مشكلة في الموقع', 1), button('bx:x:ticket:report', 'بلاغ', 2))] }, i.id);
        const existing = s.a.panels.ticket;
        const update = existing?.channelId === s.channel.id;
        let messageId;
        if (update) {
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
      const s = await c.session(i, { team: 'support' });
      await c.edit((a) => {
        const r = kindAt(a, id, 'ticket');
        if (!r.channelId || r.closedAt || (r.assignee && r.assignee !== s.by)) throw stale();
        if (r.assignee === s.by) return;
        Object.assign(r, { assignee: s.by, claimedAt: c.now(), status: 'claimed' });
        audit(a, 'support', 'ticket_claimed', s.by, r.id, c.now());
      }, s);
      return [`التذكرة \`${id}\` اتسجلت باسمك.`];
    },
    async reply(i, { id, body }) {
      const value = c.text(body, 1000, true);
      return c.serial(`ticket:${idOf(id)}`, async () => {
        const s = await c.session(i, { team: 'support' });
        const r = kindAt(s.a, id, 'ticket');
        if (r.closedAt || !r.channelId) throw stale();
        const ch = stableTicket(c, s.w, r);
        if (!ch) throw notFound();
        c.postNeeds(s.w, ch);
        await c.assertCurrent(s);
        await c.api.createMessage(ch.id, post(card('رد من دعم BLACK X', value), i.id));
        await c.edit((a) => {
          const current = kindAt(a, id, 'ticket');
          current.firstReplyAt ??= c.now();
          audit(a, 'support', 'ticket_replied', s.by, id, c.now());
        });
        return ['اترسل الرد جوّه التذكرة فقط.'];
      });
    },
    async close(i, { id, reason }) {
      reason = c.text(reason, 250);
      return c.serial(`ticket:${idOf(id)}`, async () => {
        const s = await c.session(i, { team: 'support' });
        const r = kindAt(s.a, id, 'ticket');
        if (r.closedAt) return ['التذكرة مقفولة بالفعل.'];
        const ch = stableTicket(c, s.w, r);
        if (ch) {
          c.botNeeds(s.w, ch, P.ViewChannel, P.ManageRoles);
          await c.assertCurrent(s);
          const { allow, deny, type } = overwrite(r.by, 1, P.ViewChannel | P.ReadMessageHistory, P.SendMessages);
          await c.api.putOverwrite(ch.id, r.by, { allow, deny, type });
        }
        await c.edit((a) => {
          const current = kindAt(a, id, 'ticket');
          Object.assign(current, { status: 'closed', reason, closedAt: c.now(), resolvedBy: s.by });
          audit(a, 'support', 'ticket_closed', s.by, id, c.now());
        });
        return ['التذكرة اتقفلت من غير حذف. لو الروم موجود، صاحب الطلب يقدر يقرأه من غير كتابة.'];
      });
    },
  };
}

export function moderationActions(c) {
  return {
    async warn(i, { user, reason }) {
      const s = await c.session(i, { team: 'moderation', flags: [P.ManageMessages] });
      const subject = idOf(user?.id);
      const target = await c.api.getMember(c.guildId, subject);
      const actorRole = highestRole(s.w.allRoles, c.guildId, s.member.roles);
      const targetRole = highestRole(s.w.allRoles, c.guildId, target.roles);
      if (subject === s.by || subject === s.w.guild.owner_id || subject === c.botId || user.bot || target.user?.bot ||
        (!s.owner && (!actorRole || !targetRole || compareRoles(actorRole, targetRole, c.guildId) <= 0))) throw denied();
      const note = c.text(reason, 300);
      const id = idOf(i.id);
      await c.edit((a) => {
        if (a.warnings[id]) return;
        limits(a.warnings, 250);
        a.warnings[id] = { id, subject, by: s.by, note, at: c.now(), status: 'active' };
        audit(a, 'moderation', 'warning_recorded', s.by, id, c.now());
      }, s);
      return [`اتسجّل التنبيه \`${id}\` من غير عقوبة أو رسالة خاصة.`];
    },
    async history(i, { user }) {
      const s = await c.session(i, { team: 'moderation', flags: [P.ManageMessages] });
      const id = idOf(user?.id);
      const rows = Object.values(s.a.warnings).filter((w) => w.subject === id).sort((a, b) => b.at - a.at).slice(0, 15);
      return [`سجل التنبيهات — ${memberRef(id)}`, ...rows.map((w) => `• \`${w.id}\` · ${timestamp(w.at)} · ${w.status === 'active' ? 'نشط' : 'اتشال بالاستئناف'} · ${safeTitle(w.note)}`),
        ...(rows.length ? [] : ['مفيش تنبيهات مسجلة.'])];
    },
    async appeal(i, { id, reason }) {
      const by = c.assertGuild(i);
      const note = c.text(reason, 300);
      const receipt = idOf(i.id);
      await c.edit((a) => {
        live(a);
        const w = requestAt(a.warnings, id);
        if (w.subject !== by || w.status !== 'active') throw notFound();
        if (w.appealId && w.appealId !== receipt) throw duplicate();
        setRecord(a, { id: receipt, by, kind: 'appeal', caseId: w.id, note, at: c.now(), status: 'submitted' },
          { maxForMember: 3 });
        w.appealId = receipt;
      });
      return [`اتسجل الاستئناف \`${receipt}\`. تقدر تتابعه من /my.`];
    },
    async review(i, { id, outcome, reason }) {
      fixedChoice(['approved', 'rejected'], outcome);
      const explanation = c.text(reason, 250);
      const s = await c.session(i, { team: 'moderation', flags: [P.ManageMessages] });
      await c.edit((a) => {
        const r = kindAt(a, id, 'appeal');
        const w = requestAt(a.warnings, r.caseId);
        if (r.closedAt || w.by === s.by || r.by === s.by) throw denied();
        if (outcome === 'approved') w.status = 'void';
        Object.assign(r, { status: outcome, closedAt: c.now(), reason: explanation, resolvedBy: s.by });
        audit(a, 'moderation', 'appeal_reviewed', s.by, id, c.now(), outcome);
      }, s);
      return ['اتسجل قرار الاستئناف. مفيش إجراء تلقائي أو DM.'];
    },
  };
}

function creatorLink(value, c) {
  try {
    const url = new URL(c.text(value, 300));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href.length > 300) throw new Error();
    return url.href;
  } catch { throw new AppError('ADMIN_CREATOR_LINK', 'ابعت رابط HTTPS للقناة من غير بيانات دخول أو معاملات.'); }
}

export function contentActions(c) {
  return {
    async apply(i, { url, type }) {
      const by = c.assertGuild(i);
      const subject = c.text(type, 100);
      const link = creatorLink(url, c);
      const id = idOf(i.id);
      await c.edit((a) => {
        live(a, 'content');
        setRecord(a, { id, kind: 'creator', by, subject, link, at: c.now(), status: 'submitted' });
      });
      return [`اتسجل طلب صنّاع المحتوى \`${id}\`. مفيش رول هيتمنح إلا بعد مراجعة.`];
    },
    async correction(i, { anime, issue, note }) {
      fixedChoice(['link', 'episodes', 'data'], issue);
      const by = c.assertGuild(i);
      const clean = c.text(note, 300);
      const id = idOf(i.id);
      await c.edit((a, state) => {
        live(a, 'content');
        if (typeof anime !== 'string' || !Object.hasOwn(state.catalog, anime)) throw new AppError('ADMIN_ANIME', 'اختار عملاً من الكتالوج المتزامن.');
        setRecord(a, { id, kind: 'correction', by, animeId: anime, subject: issue, note: clean, at: c.now(), status: 'submitted' },
          { maxForMember: 3, unique: (r) => r.kind === 'correction' && r.by === by && r.animeId === anime && r.subject === issue && !r.closedAt });
      });
      return [`اتسجل التصحيح \`${id}\` للمراجعة. الموقع نفسه ما اتغيّرش.`];
    },
    async review(i, { id, outcome, reason }) {
      fixedChoice(['approved', 'rejected'], outcome);
      const explanation = c.text(reason, 250);
      return c.serial(`content:${idOf(id)}`, async () => {
        const s = await c.session(i, { team: 'content' });
        const r = requestAt(s.a.requests, id);
        if (!['creator', 'correction'].includes(r.kind) || r.closedAt || s.by === r.by) throw denied();
        if (r.kind === 'creator' && outcome === 'approved') {
          // Keep the original product-role checks and Discord hierarchy. No direct role write here.
          if (!c.roles) throw stale();
          await c.assertCurrent(s);
          await c.roles.change('grant', r.by, 'creator', { actorId: s.owner ? undefined : s.by });
        }
        await c.edit((a) => {
          const current = requestAt(a.requests, id);
          Object.assign(current, { status: outcome, closedAt: c.now(), reason: explanation, resolvedBy: s.by });
          audit(a, 'content', `${r.kind}_reviewed`, s.by, id, c.now(), outcome);
        });
        return [r.kind === 'creator' && outcome === 'approved' ? 'اتقبل الطلب ورول Creator اتأكد على حساب العضو.' : 'اتسجل قرار فريق المحتوى.'];
      });
    },
  };
}

export function ideaActions(c) {
  async function audience(i) {
    const s = await c.session(i, { module: 'suggestions', types: TEXT_ROOMS });
    if (s.channel.id !== s.a.rooms.suggestions) throw denied();
    return s;
  }
  return {
    async add(i, { title, note }) {
      const s = await audience(i);
      const subject = c.text(title, 100);
      const details = c.text(note, 300);
      const id = idOf(i.id);
      await c.edit((a) => setRecord(a, { id, kind: 'idea', by: s.by, subject, note: details, at: c.now(), status: 'submitted', votes: {} },
        { maxForMember: 3 }), s);
      return [`اتسجل الاقتراح \`${id}\`، والتصويت يبدأ لما الإدارة تفتحه.`];
    },
    async list(i) {
      const s = await audience(i);
      const items = Object.values(s.a.requests).filter((r) => r.kind === 'idea' && ['review', 'approved', 'implemented'].includes(r.status))
        .sort((a, b) => b.at - a.at).slice(0, 15);
      return ['🗳️ اقتراحات BLACK X', ...items.map((r) => {
        const votes = Object.values(r.votes);
        return `${requestLine(r)} · ${safeTitle(r.subject)} · مؤيد ${votes.filter((v) => v === 'yes').length} / معارض ${votes.filter((v) => v === 'no').length}\n${safeTitle(r.note)}`;
      }), ...(items.length ? [] : ['لسه مفيش اقتراحات معروضة.'])];
    },
    async vote(i, { id, choice }) {
      fixedChoice(['yes', 'no'], choice);
      const s = await audience(i);
      await c.edit((a) => {
        const r = kindAt(a, id, 'idea');
        if (r.status !== 'review') throw stale();
        if (!Object.hasOwn(r.votes, s.by)) limits(r.votes, 250);
        r.votes[s.by] = choice;
      }, s);
      return ['اتسجل صوتك. لو غيّرته، الصوت القديم بيتستبدل مش بيتكرر.'];
    },
    async review(i, { id, status }) {
      fixedChoice(['review', 'approved', 'rejected', 'implemented'], status);
      const s = await c.session(i, { team: 'events' });
      await c.edit((a) => {
        const r = kindAt(a, id, 'idea');
        const transitions = { submitted: ['review', 'rejected'], review: ['approved', 'rejected'], approved: ['implemented'] };
        if (!(transitions[r.status] ?? []).includes(status)) throw stale();
        r.status = status;
        if (status === 'rejected' || status === 'implemented') r.closedAt = c.now();
        audit(a, 'events', 'idea_reviewed', s.by, r.id, c.now(), status);
      }, s);
      return [`اتحدّثت الحالة لـ«${stages[status]}».`];
    },
  };
}

export function ownRequests(c) {
  return async (i) => {
    const by = c.assertGuild(i);
    const state = await c.read();
    const a = adminOf(state);
    live(a);
    const entries = Object.values(a.requests).filter((r) => r.by === by).sort((a, b) => b.at - a.at).slice(0, 15);
    const warnings = Object.values(a.warnings).filter((r) => r.subject === by).sort((a, b) => b.at - a.at).slice(0, 8);
    const bookings = Object.values(state.parties).filter((r) => !r.cancelled && r.at > c.now())
      .filter((r) => r.rsvps[by] || r.waitlist?.includes(by)).slice(0, 10);
    return ['🧾 طلباتي', ...entries.map((r) => `${requestLine({ ...r, assignee: undefined })}${r.kind === 'ticket' && r.channelId ? ` · ${roomRef(r.channelId)}` : ''}${r.reason ? ` · ${safeTitle(r.reason)}` : ''}`),
      ...warnings.map((w) => `• تنبيه \`${w.id}\` · ${w.status === 'active' ? 'نشط' : 'اتشال'} · ${safeTitle(w.note)}`),
      ...bookings.map((p) => `• حفلة \`${p.id}\` · ${timestamp(p.at)} · ${p.rsvps[by] ? 'حجز مؤكد' : `الانتظار: ${p.waitlist.indexOf(by) + 1}${p.waitlist[0] === by && Object.keys(p.rsvps).length < p.capacity ? ' · المقعد متاح لك، أكّده من الكارت' : ''}`}`),
      ...(!entries.length && !warnings.length && !bookings.length ? ['لسه مفيش طلبات أو حجوزات ليك.'] : [])];
  };
}
