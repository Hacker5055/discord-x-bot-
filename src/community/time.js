import { CalculationMethod, Coordinates, PrayerTimes } from 'adhan';
import { AppError } from '../lib/errors.js';

const egypt = (name, lat, lon) => ({ name, lat, lon, zone: 'Africa/Cairo', method: 'Egyptian', label: 'الهيئة المصرية العامة للمساحة' });
export const CITIES = Object.freeze({
  giza: egypt('الجيزة', 30.0131, 31.2089), cairo: egypt('القاهرة', 30.0444, 31.2357),
  alexandria: egypt('الإسكندرية', 31.2001, 29.9187), mansoura: egypt('المنصورة', 31.0409, 31.3785),
  tanta: egypt('طنطا', 30.7865, 31.0004), port_said: egypt('بورسعيد', 31.2653, 32.3019),
  suez: egypt('السويس', 29.9668, 32.5498), ismailia: egypt('الإسماعيلية', 30.5965, 32.2715),
  minya: egypt('المنيا', 28.1099, 30.7503), asyut: egypt('أسيوط', 27.1783, 31.1859),
  luxor: egypt('الأقصر', 25.6872, 32.6396), aswan: egypt('أسوان', 24.0889, 32.8998),
  hurghada: egypt('الغردقة', 27.2579, 33.8116),
  mecca: { name: 'مكة', lat: 21.4225, lon: 39.8262, zone: 'Asia/Riyadh', method: 'UmmAlQura', label: 'أم القرى' },
  riyadh: { name: 'الرياض', lat: 24.7136, lon: 46.6753, zone: 'Asia/Riyadh', method: 'UmmAlQura', label: 'أم القرى' },
});
export const CITY_CHOICES = Object.entries(CITIES).map(([value, { name }]) => ({ name, value }));
export const PRAYERS = { fajr: 'الفجر', dhuhr: 'الظهر', asr: 'العصر', maghrib: 'المغرب', isha: 'العشاء' };
const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const REMINDER_MS = 10 * MINUTE;

export function cityFor(key) {
  if (!Object.hasOwn(CITIES, key)) throw new AppError('UNKNOWN_CITY', 'اختار مدينة من القائمة.');
  return CITIES[key];
}

export function localDateTime(now, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function clockMinutes(text) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text ?? '')) throw new AppError('INVALID_TIME', 'اكتب الميعاد بصيغة HH:MM، مثال 09:30.');
  const [h, m] = text.split(':').map(Number);
  return h * 60 + m;
}

// The explicit offset avoids silently using the dyno's timezone or accepting an impossible date.
export function parsePartyDate(value) {
  const match = /^(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value ?? '');
  const core = match && `${match[1]}:${match[2] ?? '00'}`;
  const utc = core ? Date.parse(`${core}Z`) : NaN;
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 19) !== core
    || /^[+-]14:(?!00)/.test(match[3])) {
    throw new AppError('INVALID_PARTY_DATE', 'اكتب تاريخًا ووقتًا ومعه فرق التوقيت، مثال 2027-02-01T21:30+02:00.');
  }
  return Date.parse(`${core}${match[3]}`);
}

function dailyTimes(city, y, m, d) {
  // Adhan takes the local calendar components, then returns absolute Date instants (UTC).
  const result = new PrayerTimes(new Coordinates(city.lat, city.lon), new Date(y, m - 1, d, 12), CalculationMethod[city.method]());
  return Object.fromEntries(Object.keys(PRAYERS).map((key) => [key, +result[key]]));
}

export function prayerDay(cityKey, now = Date.now()) {
  const city = cityFor(cityKey);
  const { date } = localDateTime(now, city.zone);
  const [y, m, d] = date.split('-').map(Number);
  const times = dailyTimes(city, y, m, d);
  const tomorrow = dailyTimes(city, y, m, d + 1);
  const next = Object.keys(PRAYERS).find((key) => times[key] > now);
  return { city, date, times, next: next ? { name: PRAYERS[next], at: times[next] } : { name: PRAYERS.fajr, at: tomorrow.fajr },
    maghrib: times.maghrib > now ? times.maghrib : tomorrow.maghrib };
}

export function cityTime(ms, zone) {
  return new Intl.DateTimeFormat('ar-EG', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(ms);
}
