import { PermissionFlagsBits as P } from 'discord.js';
import { timestamp } from '../community/ui.js';
import { compareRoles, highestRole } from '../discord/permissions.js';
import { AppError } from '../lib/errors.js';
import { adminOf, audit, denied, fixedChoice, idOf, limits, live, memberRef, notFound, requestAt,
  roomRef, safeTitle, stale, TEXT_ROOMS } from './core.js';

import { duplicate, kindAt, requestLine, setRecord, stages } from './records.js';

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
