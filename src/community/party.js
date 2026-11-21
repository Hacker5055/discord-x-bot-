import { escapeMarkdown } from 'discord.js';
import { audit } from '../admin/core.js';
import { PARTY_DURATION, calendarConflict, calendarOverlap } from '../admin/calendar.js';
import { AppError } from '../lib/errors.js';
import { isSnowflake } from '../lib/catalog.js';
import { queueJob, requireStore } from './store.js';
import { DAY, REMINDER_MS } from './time.js';
import { button, linkButton, mute, row, timestamp } from './ui.js';

const missing = () => new AppError('PARTY_NOT_FOUND', 'الحفلة مش موجودة في الروم ده أو الكارت قديم.', 404);
const reminderId = (id, user) => `party-rem:${id}:${user}`;

export function partyMessage(party, now) {
  const live = !party.cancelled && now >= party.at;
  const text = party.cancelled ? 'اتلغت الحفلة.' : live ? 'الحفلة بدأت! افتح العرض من الزر تحت.' : 'سجّل حضورك، ولو حابب اطلب تذكير خاص قبل البداية.';
  const embeds = [{ title: `🍿 ${party.title}`, color: party.cancelled ? 0x777777 : 0xA256D0,
    description: `${timestamp(party.at)} · ${timestamp(party.at, 'R')}\n${text}${party.capacity && !party.cancelled ? `\nالسعة: ${party.capacity} مقعد.${live ? '' : ' لو الحجز كامل، هتدخل الانتظار. أول شخص في الطابور يقدر يؤكد المقعد لما يفضى.'}` : ''}`,
    footer: { text: `رقم الحفلة: ${party.id}` } }];
  const btn = (action, label, style) => button(`bx:p:${party.id}:${action}`, label, style);
  const components = party.cancelled ? [] : live ? [row(linkButton(party.url, 'شاهد على BLACK X'))] : [row(
    btn('join', 'هحضر', 3), btn('leave', 'إلغاء الحضور'), btn('remind', 'ذكّرني', 1), btn('mute', 'إلغاء التذكير'),
    ...(party.capacity ? [btn('confirm', 'أكد المقعد', 1)] : []),
  )];
  return mute({ embeds, components });
}

export async function scheduleParty(store, { id, channelId, title, at, url, capacity, minutes = PARTY_DURATION, force, adminVersion, by }, now) {
  if ((capacity != null && (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 200)) ||
    !Number.isSafeInteger(minutes) || minutes < 5 || minutes > 360) throw new AppError('INVALID_PARTY_CAPACITY', 'راجع السعة أو مدة الحفلة.');
  if (at < now + 60_000 || at > now + 45 * DAY) throw new AppError('INVALID_PARTY_DATE', 'اختار ميعاد بعد دقيقة على الأقل، وخلال الـ٤٥ يوم الجايين.');
  return requireStore(store).update((state) => {
    if (Object.hasOwn(state.parties, id)) return;
    if (Object.keys(state.parties).length >= 150) throw new AppError('PARTY_HISTORY_LIMIT', 'سجل الحفلات ممتلئ مؤقتًا. جرّب لاحقًا.');
    if (Object.values(state.parties).filter((party) => !party.cancelled && party.at > now).length >= 20) {
      throw new AppError('PARTY_LIMIT', 'فيه ٢٠ حفلة مجدولة بالفعل. ألغِ حفلة قديمة قبل إضافة واحدة جديدة.');
    }
    const a = state.admin;
    if (capacity != null && !a?.enabled) throw new AppError('ADMIN_DISABLED', 'فعّل أدوات الإدارة للحجز بسعة محددة.', 403);
    if (a?.enabled && a.paused.events) throw new AppError('ADMIN_PAUSED', 'الفعاليات الجديدة متوقفة مؤقتًا.', 409);
    if (adminVersion !== undefined && (!a?.enabled || a.version !== adminVersion)) throw new AppError('ADMIN_STALE', 'الإعدادات اتغيّرت. جرّب تاني.', 409);
    const calendarEnabled = a?.enabled && (adminVersion !== undefined || capacity != null || Object.keys(a.calendar).length > 0);
    if (calendarEnabled && !force && calendarOverlap(state, at, minutes)) throw calendarConflict();
    state.parties[id] = { id, channelId, title: escapeMarkdown(title), at, url, rsvps: {}, messageId: null, cancelled: false,
      ...(minutes !== PARTY_DURATION ? { minutes } : {}), ...(capacity != null ? { capacity, waitlist: [] } : {}) };
    queueJob(state, `publish:${id}`, { kind: 'party_publish', partyId: id, dueAt: now, expiresAt: at + DAY });
    queueJob(state, `patch:${id}`, { kind: 'party_patch', partyId: id, dueAt: at, expiresAt: at + DAY });
    if (adminVersion !== undefined) audit(a, 'events', 'party_scheduled', by, id, now);
  });
}

export async function cancelParty(store, { id, channelId, now, adminVersion, by }) {
  if (!isSnowflake(id)) throw missing();
  await requireStore(store).update((state) => {
    const party = state.parties[id];
    if (!party || party.channelId !== channelId) throw missing();
    if (party.cancelled) return;
    if (now >= party.at) throw new AppError('PARTY_STARTED', 'ما ينفعش تلغي ميعاد حفلة بدأت بالفعل.');
    if (adminVersion !== undefined && (!state.admin?.enabled || state.admin.version !== adminVersion)) throw new AppError('ADMIN_STALE', 'الإعدادات اتغيّرت. جرّب تاني.', 409);
    if (adminVersion !== undefined) audit(state.admin, 'events', 'party_cancelled', by, id, now);
    party.cancelled = true;
    party.cancelledAt = now;
    party.rsvps = {};
    if (party.capacity) party.waitlist = [];
    for (const [key, job] of Object.entries(state.jobs)) if (job.partyId === id && job.kind === 'party_reminder') delete state.jobs[key];
    const patch = state.jobs[`patch:${id}`];
    if (patch) patch.dueAt = now;
    else queueJob(state, `patch:${id}`, { kind: 'party_patch', partyId: id, dueAt: now, expiresAt: party.at + DAY });
  });
}

export async function respondParty(store, { id, channelId, messageId, userId, action, now }) {
  if (![id, messageId, userId].every(isSnowflake) || !['join', 'leave', 'remind', 'mute', 'confirm'].includes(action)) throw missing();
  return requireStore(store).update((state) => {
    const party = state.parties[id];
    if (!party || party.channelId !== channelId || party.messageId !== messageId || party.cancelled) throw missing();
    if (now >= party.at) throw new AppError('PARTY_STARTED', 'الحفلة بدأت بالفعل.');
    const key = reminderId(id, userId);
    const rsvp = party.rsvps[userId];
    if (action === 'confirm') {
      if (!party.capacity) throw missing();
      if (rsvp) return 'مقعدك متأكد بالفعل.';
      if (!state.admin?.enabled || state.admin.paused.events) throw new AppError('ADMIN_PAUSED', 'الحجوزات الجديدة متوقفة مؤقتًا.', 409);
      if (party.waitlist[0] !== userId || Object.keys(party.rsvps).length >= party.capacity) {
        throw new AppError('PARTY_WAITLIST', 'لسه مفيش مقعد متاح لدورك. تابع ترتيبك من /my.', 409);
      }
      party.waitlist.shift();
      party.rsvps[userId] = { remind: false };
      return 'اتأكد مقعدك. التذكير اختياري من الزر على الكارت.';
    }
    if (action === 'join') {
      if (rsvp) return 'اتسجّل حضورك. التذكير اختياري من الزر على الكارت.';
      const booked = Object.keys(party.rsvps).length;
      if (party.capacity) {
        if (!state.admin?.enabled || state.admin.paused.events) throw new AppError('ADMIN_PAUSED', 'الحجوزات الجديدة متوقفة مؤقتًا.', 409);
        if (booked >= party.capacity || party.waitlist.length) {
          if (!party.waitlist.includes(userId)) {
            if (party.waitlist.length >= 150) throw new AppError('PARTY_FULL', 'قائمة الانتظار مكتملة حاليًا.');
            party.waitlist.push(userId);
          }
          const place = party.waitlist.indexOf(userId) + 1;
          return `ترتيبك في الانتظار: ${place}.${place === 1 && booked < party.capacity ? ' فيه مقعد فاضي لك؛ اضغط «أكد المقعد».' : ' لو دورك جه، استخدم «أكد المقعد».'}`;
        }
      } else if (booked >= 200) throw new AppError('PARTY_FULL', 'التسجيل للحفلة وصل للحد الأقصى.');
      party.rsvps[userId] ??= { remind: false };
      return 'اتسجّل حضورك. التذكير اختياري من الزر على الكارت.';
    }
    if (action === 'leave') {
      delete party.rsvps[userId]; delete state.jobs[key];
      if (party.capacity) party.waitlist = party.waitlist.filter((id) => id !== userId);
      return 'اتلغى تسجيل حضورك وأي تذكير للحفلة.';
    }
    if (action === 'mute') {
      if (rsvp) rsvp.remind = false;
      delete state.jobs[key];
      return 'اتلغى تذكير الحفلة. حضورك ما اتغيّرش.';
    }
    if (!rsvp) throw new AppError('RSVP_REQUIRED', 'اضغط «هحضر» قبل ما تطلب التذكير.');
    if (!rsvp.remind) {
      queueJob(state, key, { kind: 'party_reminder', userId, partyId: id, dueAt: Math.max(now, party.at - REMINDER_MS), expiresAt: party.at });
      rsvp.remind = true;
    }
    return 'التذكير شغّال للحفلة دي. فعّل استقبال الرسائل الخاصة من السيرفر عشان يوصلك.';
  });
            }
