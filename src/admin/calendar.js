import { PermissionFlagsBits as P } from 'discord.js';
import { DAY, parsePartyDate } from '../community/time.js';
import { timestamp } from '../community/ui.js';
import { hasPermission } from '../discord/permissions.js';
import { AppError } from '../lib/errors.js';
import { audit, fixedChoice, future, idOf, limits, requestAt, safeTitle, TEXT_ROOMS, within } from './core.js';

const kinds = { maintenance: 'صيانة', quiz: 'مسابقة', event: 'فعالية' };
export const PARTY_DURATION = 90;
export const calendarOverlap = (state, at, minutes, ignore) =>
  [...Object.values(state.admin?.calendar ?? {}), ...Object.values(state.parties)].some((e) => e.id !== ignore && !e.cancelled &&
    e.at < at + minutes * 60_000 && at < e.at + (e.minutes ?? PARTY_DURATION) * 60_000);
export const calendarConflict = () => new AppError('ADMIN_CALENDAR_CONFLICT', 'الميعاد متعارض مع حدث موجود. اختار وقت تاني أو أكّد force لو التعارض مقصود.', 409);

export function calendarActions(c) {
  return {
    async add(i, { kind, title, starts_at, minutes, force }) {
      const s = await c.session(i, { team: 'events', module: 'events', types: TEXT_ROOMS });
      fixedChoice(Object.keys(kinds), kind);
      const name = c.text(title, 100);
      const at = future(parsePartyDate(starts_at), c.now());
      within(minutes, 5, 360);
      const id = idOf(i.id);
      await c.edit((a, state) => {
        if (a.calendar[id]) return;
        for (const [key, e] of Object.entries(a.calendar)) if (e.at < c.now() - 2 * DAY) delete a.calendar[key];
        if (!force && calendarOverlap(state, at, minutes)) throw calendarConflict();
        limits(a.calendar, 80);
        a.calendar[id] = { id, kind, title: name, at, minutes, channelId: s.channel.id, by: s.by };
        audit(a, 'events', 'calendar_added', s.by, id, c.now());
      }, s);
      return [`اتضاف ${kinds[kind]} \`${id}\` في ${timestamp(at)} لمدة ${minutes} دقيقة. مفيش إعلان اتبعت.`];
    },
    async cancel(i, { id }) {
      const s = await c.session(i, { team: 'events' });
      await c.edit((a) => {
        const e = requestAt(a.calendar, id);
        if (e.channelId !== s.channel.id) throw new AppError('ADMIN_ROOM', 'ألغِ الميعاد من نفس الروم اللي اتسجل فيه.');
        if (e.cancelled) return;
        e.cancelled = true;
        audit(a, 'events', 'calendar_cancelled', s.by, id, c.now());
      }, s);
      return ['اتلغى الميعاد من الأجندة.'];
    },
    async week(i) {
      const s = await c.session(i, { roomId: null });
      const begin = c.now();
      const items = [...Object.values(s.a.calendar).map((e) => ({ ...e, title: safeTitle(e.title), label: kinds[e.kind] })),
        ...Object.values(s.state.parties).map((p) => ({ ...p, label: 'حفلة مشاهدة' }))]
        .filter((e) => !e.cancelled && e.at >= begin && e.at < begin + 7 * DAY)
        .sort((a, b) => a.at - b.at).filter((e) => {
          const ch = s.w.channels.find(({ id }) => id === e.channelId);
          return ch && hasPermission(c.bits(s.w, ch, s.by, s.member), P.ViewChannel);
        }).slice(0, 20);
      return ['🗓️ أجندة الأسبوع الجاي', ...items.map((e) => `• ${timestamp(e.at)} · ${e.label}: ${e.title} · \`${e.id}\``),
        ...(items.length ? [] : ['مفيش مواعيد قدّامك في الأجندة.'])];
    },
  };
}
