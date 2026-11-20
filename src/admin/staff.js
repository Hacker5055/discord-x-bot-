import { DAY, parsePartyDate } from '../community/time.js';
import { timestamp } from '../community/ui.js';
import { AppError } from '../lib/errors.js';
import { audit, auditLine, denied, fixedChoice, future, idOf, limits, memberRef, notFound, requestAt,
  safeTitle, stale, TEAMS } from './core.js';
import { detailLines, requestLine, requestTeam } from './records.js';

const openFor = (a, team) => Object.values(a.requests).filter((r) => requestTeam[r.kind] === team && !r.closedAt).sort((l, r) => l.at - r.at);
const taskLine = (t) => `• \`${t.id}\` · ${memberRef(t.assignee)} · ${timestamp(t.dueAt)} · ${safeTitle(t.title)}${t.doneAt ? ' · خلصت' : ''}`;
const taskList = (a, team) => Object.values(a.tasks).filter((t) => t.team === team && !t.doneAt).sort((l, r) => l.dueAt - r.dueAt);
const median = (nums) => {
  if (!nums.length) return undefined;
  const sorted = [...nums].sort((a, b) => a - b);
  return (sorted[Math.floor((nums.length - 1) / 2)] + sorted[Math.floor(nums.length / 2)]) / 2;
};

export function staffActions(c) {
  const scope = (i, team) => c.session(i, { team: fixedChoice(TEAMS, team) });
  return {
    async inbox(i, { team }) {
      const s = await scope(i, team);
      const list = openFor(s.a, team);
      return [`📋 ${team}: ${list.length} طلب مفتوح`, ...list.slice(0, 20).map(requestLine), ...(!list.length ? ['مفيش طلبات مستنية.'] : [])];
    },
    async detail(i, { team, id }) {
      const s = await scope(i, team);
      const r = requestAt(s.a.requests, id);
      if (requestTeam[r.kind] !== team) throw notFound();
      return detailLines(r);
    },
    async audit(i, { team }) {
      const s = await scope(i, team);
      const items = s.a.audit.filter((entry) => entry.team === team).slice(-20).reverse();
      return [`📋 آخر إجراءات ${team}`, ...items.map(auditLine), ...(!items.length ? ['السجل فاضي.'] : [])];
    },
    async task(i, { team, title, user, due }) {
      const s = await scope(i, team);
      const assignee = idOf(user?.id);
      const member = await c.api.getMember(c.guildId, assignee);
      if (user.bot || member.user?.bot || (assignee !== s.w.guild.owner_id && !member.roles.includes(s.a.teams[team]?.roleId))) throw denied();
      const at = c.now();
      const dueAt = future(parsePartyDate(due), at);
      const name = c.text(title, 120);
      const id = idOf(i.id);
      await c.edit((a) => {
        if (a.tasks[id]) return;
        for (const [key, t] of Object.entries(a.tasks)) if (t.doneAt && t.doneAt < at - 30 * DAY) delete a.tasks[key];
        limits(a.tasks, 100);
        a.tasks[id] = { id, by: s.by, team, title: name, assignee, dueAt, at };
        audit(a, team, 'task_assigned', s.by, id, at);
      }, s);
      return [`اتسجلت المهمة \`${id}\` لـ${memberRef(assignee)} قبل ${timestamp(dueAt)}.`];
    },
    async done(i, { team, id }) {
      const s = await scope(i, team);
      await c.edit((a) => {
        const t = requestAt(a.tasks, id);
        if (t.team !== team || (!s.owner && t.assignee !== s.by && t.by !== s.by)) throw denied();
        if (t.doneAt) return;
        t.doneAt = c.now();
        audit(a, team, 'task_completed', s.by, t.id, t.doneAt);
      }, s);
      return ['اتعلّمت المهمة كمكتملة.'];
    },
    async handoff(i, { team }) {
      const s = await scope(i, team);
      const outstanding = taskList(s.a, team);
      const ended = Object.values(s.a.tasks).filter((t) => t.team === team && t.doneAt >= c.now() - DAY).sort((l, r) => r.doneAt - l.doneAt);
      const requests = openFor(s.a, team);
      return [`🗂️ تسليم وردية ${team}`, `طلبات مستنية: ${requests.length} · مهام مفتوحة: ${outstanding.length}.`,
        ...outstanding.slice(0, 15).map(taskLine), 'المهام اللي خلصت آخر ٢٤ ساعة:', ...ended.slice(0, 10).map(taskLine),
        ...(ended.length ? [] : ['مفيش.'])];
    },
    async stats(i) {
      const s = await scope(i, 'support');
      const time = c.now() - 7 * DAY;
      const rows = Object.values(s.a.requests).filter((r) => r.kind === 'ticket');
      const opened = rows.filter((r) => r.openedAt >= time);
      const closed = rows.filter((r) => r.openedAt && r.closedAt >= time);
      const first = opened.filter((r) => r.firstReplyAt).map((r) => r.firstReplyAt - r.openedAt);
      const value = median(first);
      return ['📈 دعم BLACK X · آخر ٧ أيام', `اتفتحت: ${opened.length} · اتقفلت: ${closed.length} · لسه مفتوحة: ${rows.filter((r) => r.openedAt && !r.closedAt).length}.`,
        `وسيط وقت أول رد مُسجّل: ${value === undefined ? 'مفيش ردود مسجلة' : `${Math.round(value / 60_000)} دقيقة (${first.length} تذكرة)`}.`,
        'القياس من /ticket reply بس. البوت ما بيراقبش رسائل الشات.'];
    },
  };
}

const knowledgeKey = (key) => {
  if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,23}$/.test(key) || Object.hasOwn(Object.prototype, key) || key === 'prototype') {
    throw new AppError('ADMIN_KB_KEY', 'استخدم مفتاحًا مختصرًا بحروف إنجليزية وأرقام، مثل discord-link.');
  }
  return key;
};
export function knowledgeActions(c) {
  const access = (i) => c.session(i, { team: 'support' });
  return {
    async set(i, { key, title, body }) {
      const s = await access(i);
      key = knowledgeKey(key);
      const heading = c.text(title, 100);
      const value = c.text(body, 900, true);
      await c.edit((a) => {
        if (!Object.hasOwn(a.knowledge, key)) limits(a.knowledge, 60);
        a.knowledge[key] = { title: heading, body: value, at: c.now(), by: s.by, approved: false };
        audit(a, 'support', 'kb_saved', s.by, key, c.now());
      }, s);
      return [`الرد \`${key}\` اتحفظ كمسودة خاصة. راجعه بـ/kb draft ثم /kb approve.`];
    },
    async draft(i, { key }) {
      const s = await access(i);
      const doc = s.a.knowledge[knowledgeKey(key)];
      if (!doc) throw notFound();
      return [`${doc.approved ? 'رد معتمد' : 'مسودة للمراجعة'} · **${safeTitle(doc.title)}**`, doc.body];
    },
    async approve(i, { key }) {
      const s = await access(i);
      key = knowledgeKey(key);
      await c.edit((a) => {
        const doc = a.knowledge[key];
        if (!doc) throw notFound();
        if (doc.at !== s.a.knowledge[key]?.at || doc.body !== s.a.knowledge[key]?.body) throw stale();
        if (doc.approved) return;
        doc.approved = true;
        audit(a, 'support', 'kb_approved', s.by, key, c.now());
      }, s);
      return [`الرد \`${key}\` بقى ظاهر لفريق الدعم في /kb search. مفيش رسالة اتنشرت.`];
    },
    async search(i, { query }) {
      const s = await access(i);
      const term = c.text(query, 100).toLowerCase();
      const items = Object.entries(s.a.knowledge).filter(([key, { title, approved }]) => approved && `${key} ${title}`.toLowerCase().includes(term)).slice(0, 5);
      return ['📚 راجع الرد قبل نشره:', ...items.map(([key, doc]) => `**${safeTitle(doc.title)}** (\`${key}\`)\n${doc.body}`),
        ...(!items.length ? ['مفيش رد مطابق.'] : [])];
    },
    async remove(i, { key }) {
      const s = await access(i);
      key = knowledgeKey(key);
      await c.edit((a) => {
        if (!Object.hasOwn(a.knowledge, key)) throw notFound();
        delete a.knowledge[key];
        audit(a, 'support', 'kb_removed', s.by, key, c.now());
      }, s);
      return ['الرد اتشال من المكتبة.'];
    },
  };
}
