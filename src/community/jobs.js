import { createHash, randomUUID } from 'node:crypto';
import { AppError, DiscordApiError, errorFields } from '../lib/errors.js';
import { isSnowflake } from '../lib/catalog.js';
import { HADITHS, VERSES } from './data/islamic.js';
import { DAY, cityFor, localDateTime } from './time.js';
import { linkButton, mute, row, timestamp } from './ui.js';
import { partyMessage } from './party.js';
import { MAX_JOBS, queueJob } from './store.js';

const MAX_ATTEMPTS = 5;
const nonceFor = (id) => createHash('sha256').update(id).digest('hex').slice(0, 24);

export function dailyEmbed(mode, date) {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY);
  const useHadith = mode === 'hadith' || (mode === 'alternate' && day % 2 === 1);
  const texts = useHadith ? HADITHS : VERSES;
  const index = (mode === 'alternate' ? Math.floor(day / 2) : day) % texts.length;
  const item = texts[index];
  return {
    title: useHadith ? '📖 حديث اليوم' : '📖 آية اليوم', description: item.text, color: 0x17866D,
    fields: [{ name: 'المصدر', value: `[${item.title}](${item.source})` }],
    ...(item.grade ? { footer: { text: `الدرجة: ${item.grade}` } } : {}),
  };
}

function maintain(state, now) {
  for (const [id, job] of Object.entries(state.jobs)) if (job.expiresAt <= now || (!job.done && job.attempts >= MAX_ATTEMPTS && job.lease && job.leaseUntil <= now)) delete state.jobs[id];
  for (const [id, party] of Object.entries(state.parties)) if ((party.cancelledAt ?? party.at) + 2 * DAY <= now) delete state.parties[id];
  if (!state.daily || Object.keys(state.jobs).length >= MAX_JOBS) return;
  const { date, minute } = localDateTime(now, cityFor(state.daily.city).zone);
  const diff = minute - state.daily.minute;
  if (state.lastDaily === date || diff < 0 || diff >= 120) return;
  queueJob(state, `daily:${date}`, { kind: 'daily', schedule: state.daily.version, date, dueAt: now, expiresAt: now + (120 - diff) * 60_000 });
  state.lastDaily = date;
}

export function createScheduler({ store, api, guildId, log, ready = () => true, now = Date.now, intervalMs = 15_000 }) {
  let timer;
  let running;
  let stopped = false;

  async function dm(id, userId, payload) {
    // Consent is checked again in deliver; don't DM people who left the official guild.
    await api.getMember(guildId, userId);
    const channel = await api.createDm(userId);
    if (!isSnowflake(channel?.id)) throw new AppError('INVALID_DM_CHANNEL', 'تعذّر فتح الرسالة الخاصة.', 502);
    await api.createMessage(channel.id, mute({ ...payload, nonce: nonceFor(id), enforce_nonce: true }));
  }

  async function deliver(id, job) {
    const state = await store.read();
    if (state.jobs[id]?.lease !== job.lease || job.expiresAt <= now()) return;
    if (job.kind === 'daily') {
      if (state.daily?.version !== job.schedule) return;
      await api.createMessage(state.daily.channelId, mute({ embeds: [dailyEmbed(state.daily.mode, job.date)], nonce: nonceFor(id), enforce_nonce: true }));
    } else if (job.kind === 'party_publish') {
      const party = state.parties[job.partyId];
      if (!party || party.cancelled || party.messageId) return;
      const message = await api.createMessage(party.channelId, { ...partyMessage(party, now()), nonce: nonceFor(id), enforce_nonce: true });
      if (!isSnowflake(message?.id)) throw new AppError('INVALID_PARTY_MESSAGE', 'تعذّر تأكيد نشر الكارت.', 502);
      await store.update((draft) => {
        const current = draft.parties[party.id];
        if (current) {
          current.messageId = message.id;
          if (current.cancelled) {
            const patchId = `patch:${party.id}`;
            queueJob(draft, patchId, { kind: 'party_patch', partyId: party.id, dueAt: now(), expiresAt: party.at + DAY });
          }
        }
      });
    } else if (job.kind === 'party_patch') {
      const party = state.parties[job.partyId];
      if (!party) return;
      if (!party.messageId) {
        if (!Object.hasOwn(state.jobs, `publish:${job.partyId}`)) return;
        throw new AppError('PARTY_NOT_POSTED', 'كارت الحفلة لسه بيتنشر.', 503);
      }
      await api.editMessage(party.channelId, party.messageId, partyMessage(party, now()));
    } else if (job.kind === 'party_reminder') {
      const party = state.parties[job.partyId];
      if (!party || party.cancelled || !party.rsvps[job.userId]?.remind || now() >= party.at) return;
      await dm(id, job.userId, { embeds: [{ title: '🍿 تذكير حفلة BLACK X',
        description: `**${party.title}** تبدأ ${timestamp(party.at, 'R')}.`, color: 0xA256D0 }] });
    } else if (job.kind === 'episode') {
      if (!state.follows[job.userId]?.includes(job.animeId) || !Object.hasOwn(state.catalog, job.animeId)) return;
      const anime = state.catalog[job.animeId];
      await dm(id, job.userId, { embeds: [{ title: `📡 حلقة جديدة · ${anime.title}`, description: `الحلقة **${job.episode}** متاحة على BLACK X.`, color: 0x3498DB }],
        components: [row(linkButton(job.url, 'شاهد الحلقة'))] });
    } else if (job.kind === 'ramadan') {
      await dm(`${id}:${job.city}:${job.maghrib}`, job.userId, { embeds: [{ title: `🌙 تذكير المغرب · ${cityFor(job.city).name}`,
        description: `موعد المغرب حسب الحساب ${timestamp(job.maghrib)} (${timestamp(job.maghrib, 'R')}). راجع تقويم مدينتك الرسمي.`, color: 0x17866D }] });
    }
  }

  async function processJobs() {
    if (!store || stopped || !ready()) return;
    for (let i = 0; i < 12 && !stopped && ready(); i += 1) {
      const time = now();
      const entry = await store.update((state) => {
        if (!i) maintain(state, time);
        const next = Object.entries(state.jobs).filter(([, job]) => !job.done && job.dueAt <= time && job.expiresAt > time && !(job.leaseUntil > time))
          .sort(([, a], [, b]) => a.dueAt - b.dueAt)[0];
        if (!next) return undefined;
        const [, job] = next;
        job.lease = randomUUID();
        job.leaseUntil = time + 5 * 60_000;
        job.attempts += 1;
        return next;
      });
      if (!entry) return;
      const [id, job] = entry;
      let retry = false;
      try { await deliver(id, job); }
      catch (error) {
        const permanent = error instanceof DiscordApiError && [400, 401, 403, 404].includes(error.status);
        retry = !permanent && job.attempts < MAX_ATTEMPTS;
        log.warn('community_delivery_failed', { kind: job.kind, attempt: job.attempts, retry, ...errorFields(error) });
      }
      await store.update((state) => {
        const current = state.jobs[id];
        if (current?.lease !== job.lease) return;
        const next = now() + (15_000 * 2 ** (job.attempts - 1));
        if (!retry || next >= current.expiresAt) {
          if (current.kind !== 'ramadan') { delete state.jobs[id]; return; }
          current.done = true; // Retain until Maghrib so an old card can't requeue it.
        } else current.dueAt = next;
        delete current.lease;
        delete current.leaseUntil;
      });
    }
  }

  function tick() {
    running ??= processJobs().catch((error) => log.warn('community_worker_failed', errorFields(error))).finally(() => { running = undefined; });
    return running;
  }

  return {
    tick,
    start() {
      if (!store || timer || stopped) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
      void tick();
    },
    async stop() { stopped = true; clearInterval(timer); await running; },
  };
}
