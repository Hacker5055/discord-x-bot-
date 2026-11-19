import { AppError } from '../lib/errors.js';
import { ADHKAR } from './data/islamic.js';
import { queueJob, requireStore } from './store.js';
import { button, linkButton, row, timestamp } from './ui.js';
import { cityFor, cityTime, DAY, PRAYERS, prayerDay, REMINDER_MS } from './time.js';

export function adhkarPage(period, page, userId) {
  if (!Object.hasOwn(ADHKAR, period)) throw new AppError('UNKNOWN_ADHKAR', 'اختار أذكار الصباح أو المساء.');
  const items = ADHKAR[period];
  if (!Number.isInteger(page) || page < 0 || page >= items.length) throw new AppError('UNKNOWN_ADHKAR_PAGE', 'صفحة الأذكار غير موجودة.');
  const item = items[page];
  const key = (n) => `bx:a:${period}:${n}:${userId}`;
  return { embeds: [{ title: `📿 ${period === 'morning' ? 'أذكار الصباح' : 'أذكار المساء'} · ${item.title}`,
    description: item.text, color: 0x17866D, fields: [{ name: 'التكرار', value: item.count },
      { name: 'المصدر', value: `[${item.reference}](${item.source}) · ${item.grade}` }], footer: { text: `${page + 1} / ${items.length}` } }],
  components: [row(button(key(Math.max(0, page - 1)), 'السابق', 2, page === 0),
    button(key(Math.min(items.length - 1, page + 1)), 'التالي', 1, page === items.length - 1),
    ...(item.quran ? [linkButton(item.quran, 'عرض السورة')] : []))] };
}

const estimate = (city) => `حساب تقريبي بطريقة ${city.label} · ${city.zone} · راجع تقويم مدينتك الرسمي.`;

export function prayerCard(key, now) {
  const { city, date, times, next } = prayerDay(key, now);
  return { embeds: [{ title: `🕌 مواقيت الصلاة · ${city.name}`, description: `${date}\nالصلاة القادمة: **${next.name}** ${timestamp(next.at, 'R')}.`,
    color: 0x17866D, fields: Object.entries(PRAYERS).map(([name, label]) => ({ name: label, value: cityTime(times[name], city.zone), inline: true })),
    footer: { text: estimate(city) } }] };
}

export function ramadanCard(key, userId, now, hasStore) {
  const { city, date, times, maghrib } = prayerDay(key, now);
  const btn = (action, label, style) => button(`bx:r:${action}:${key}:${maghrib}:${userId}`, label, style);
  return { embeds: [{ title: `🌙 وضع رمضان · ${city.name}`, description: `${date}\nالمغرب القادم ${timestamp(maghrib, 'R')} (${timestamp(maghrib)}).\nالعدّاد للمغرب، مش إعلانًا لثبوت رمضان.`,
    color: 0x17866D, fields: [{ name: 'فجر اليوم', value: cityTime(times.fajr, city.zone), inline: true },
      { name: 'مغرب اليوم', value: cityTime(times.maghrib, city.zone), inline: true }], footer: { text: estimate(city) } }],
    ...(!hasStore ? { content: 'التذكير يحتاج تفعيل التخزين الدائم من الإدارة.' } : {}),
    components: hasStore ? [row(btn('add', 'ذكّرني قبل المغرب', 3), btn('remove', 'إلغاء التذكير', 2))] : [] };
}

export async function ramadanReminder(store, { userId, city, maghrib, action, now }) {
  cityFor(city);
  const db = requireStore(store);
  const key = `ramadan:${userId}`;
  if (action === 'remove') {
    await db.update((state) => { if (!state.jobs[key]?.done) delete state.jobs[key]; });
    return 'اتلغى تذكير المغرب لحسابك.';
  }
  if (maghrib !== prayerDay(city, now).maghrib || maghrib - now > 2 * DAY) {
    throw new AppError('OLD_RAMADAN_CARD', 'الكارت ده قديم. افتح /ramadan تاني للميعاد الجديد.');
  }
  await db.update((state) => {
    const pending = state.jobs[key];
    if (pending?.done && pending.maghrib === maghrib && pending.city === city) {
      throw new AppError('REMINDER_ALREADY_PROCESSED', 'التذكير للميعاد ده اتعالج بالفعل.');
    }
    if (pending?.maghrib === maghrib && pending.city === city) return;
    if (pending?.leaseUntil > now) throw new AppError('REMINDER_IN_PROGRESS', 'التذكير السابق بيتبعت دلوقتي، جرّب بعد لحظات.');
    delete state.jobs[key];
    queueJob(state, key, { kind: 'ramadan', userId, city, maghrib, dueAt: Math.max(now, maghrib - REMINDER_MS), expiresAt: maghrib });
  });
  return 'اتسجّل تذكير خاص مرة واحدة قبل المغرب بـ١٠ دقايق (أو في أقرب وقت لو الميعاد قرب). فعّل استقبال الرسائل الخاصة من السيرفر.';
}

export async function setDaily(store, settings) {
  await requireStore(store).update((state) => {
    state.daily = settings;
    for (const [id, job] of Object.entries(state.jobs)) if (job.kind === 'daily') delete state.jobs[id];
  });
}
