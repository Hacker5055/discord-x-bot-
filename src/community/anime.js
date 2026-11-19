import { escapeMarkdown } from 'discord.js';
import { AppError } from '../lib/errors.js';
import { createRedactor } from '../lib/redact.js';
import { DAY } from './time.js';
import { queueJob, requireStore } from './store.js';
import { linkButton, row } from './ui.js';

export const SITE_ORIGIN = 'https://black-x-anime.ai.studio';
const MAX_CATALOG = 500;
const MAX_EPISODES = 2500;
const MAX_FOLLOWS = 1000;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const validId = (id) => typeof id === 'string' && idPattern.test(id) && !Object.hasOwn(Object.prototype, id) && id !== 'prototype';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, required, optional = []) => object(value) && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const normalize = (text) => text.normalize('NFKC').toLowerCase()
  .replace(/[\u064B-\u065F\u0670ـ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').trim();
const invalid = () => new AppError('INVALID_ANIME_DATA', 'بيانات الأنمي أو الحلقة غير صالحة. راجع عقد تكامل BLACK X.');

const genres = Object.freeze({
  action: ['أكشن', /اكشن|حركه|\baction\b/u], adventure: ['مغامرة', /مغامر|\badventure\b/u], comedy: ['كوميديا', /كوميد|ضحك|\bcomedy\b/u],
  drama: ['دراما', /درام|\bdrama\b/u], fantasy: ['فانتازيا', /فانتازي|\bfantasy\b/u], mystery: ['غموض', /غموض|تحقيق|\bmystery\b/u],
  horror: ['رعب', /رعب|\bhorror\b/u], romance: ['رومانسي', /رومانسي|\bromance\b/u], sci_fi: ['خيال علمي', /خيال علمي|\bsci[- ]?fi\b/u],
  sports: ['رياضي', /رياض|\bsports\b/u], slice_of_life: ['شريحة من الحياة', /شريحه من الحياه|\bslice of life\b/u],
  supernatural: ['خارق للطبيعة', /خارق|\bsupernatural\b/u], thriller: ['إثارة', /اثار|تشويق|\bthriller\b/u],
});

export function siteUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 600 || /[\u0000-\u0020\u007F\\]/u.test(value)) throw new Error();
    const url = new URL(value);
    if (url.origin !== SITE_ORIGIN || url.username || url.password || url.href.length > 600) throw new Error();
    return url.href;
  } catch {
    throw new AppError('INVALID_SITE_URL', `استخدم رابط HTTPS صالح على ${SITE_ORIGIN} فقط.`);
  }
}

export function cleanText(value, limit, redact, error = invalid) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(value)
    || redact(value) !== value) throw error();
  return value.trim();
}

function catalogEntry(entry, redact) {
  if (!exact(entry, ['id', 'title', 'url', 'genres', 'episodes'], ['rating']) || !validId(entry.id)
    || !Array.isArray(entry.genres) || !entry.genres.length || entry.genres.length > 8
    || !entry.genres.every((genre) => typeof genre === 'string' && Object.hasOwn(genres, genre))
    || (entry.episodes !== null && (!Number.isInteger(entry.episodes) || entry.episodes < 1 || entry.episodes > 10_000))
    || (entry.rating != null && (!Number.isFinite(entry.rating) || entry.rating < 0 || entry.rating > 10))) throw invalid();
  if (typeof entry.url !== 'string' || redact(entry.url) !== entry.url) throw invalid();
  return { id: entry.id, title: cleanText(entry.title, 100, redact), url: siteUrl(entry.url), genres: [...new Set(entry.genres)],
    episodes: entry.episodes, rating: entry.rating ?? null };
}

function matches(state, query) {
  const text = normalize(query);
  return Object.values(state.catalog).filter((item) => !text || normalize(item.id).includes(text) || normalize(item.title).includes(text));
}

function findAnime(state, query) {
  if (Object.hasOwn(state.catalog, query)) return state.catalog[query];
  const found = matches(state, query);
  if (!found.length) throw new AppError('ANIME_NOT_FOUND', 'الأنمي ده مش موجود في الكتالوج المتزامن. اختار من المقترحات.', 404);
  if (found.length !== 1) {
    const exactTitle = found.filter((item) => normalize(item.title) === normalize(query));
    if (exactTitle.length === 1) return exactTitle[0];
    throw new AppError('AMBIGUOUS_ANIME', 'فيه أكتر من عمل مطابق. اختار الاسم أو المعرّف من المقترحات.');
  }
  return found[0];
}

export function createAnimeService({ store, secrets, now = Date.now }) {
  const redact = createRedactor(secrets);
  return {
    async updateCatalog(data) {
      if (!exact(data, ['items'], ['remove']) || !Array.isArray(data.items) || data.items.length > 100
        || (Object.hasOwn(data, 'remove') && (!Array.isArray(data.remove) || data.remove.length > 100 || !data.remove.every(validId)))) throw invalid();
      const items = data.items.map((item) => catalogEntry(item, redact));
      const ids = new Set(items.map(({ id }) => id));
      if (ids.size !== items.length || data.remove?.some((id) => ids.has(id))) throw invalid();
      return requireStore(store).update((state) => {
        const removals = new Set(data.remove ?? []);
        for (const id of removals) delete state.catalog[id];
        for (const [id, job] of Object.entries(state.jobs)) {
          if (job.kind === 'episode' && removals.has(job.animeId)) delete state.jobs[id];
        }
        for (const [user, followed] of Object.entries(state.follows)) {
          state.follows[user] = followed.filter((id) => !removals.has(id));
          if (!state.follows[user].length) delete state.follows[user];
        }
        for (const item of items) state.catalog[item.id] = item;
        const count = Object.keys(state.catalog).length;
        if (count > MAX_CATALOG) throw new AppError('CATALOG_LIMIT', 'الحد ٥٠٠ عمل متزامن. احذف الأعمال القديمة قبل الإضافة.', 409);
        return { count };
      });
    },
    async receiveEpisode(data) {
      if (!exact(data, ['animeId', 'episodeId', 'episode', 'url']) || !validId(data.animeId) || !validId(data.episodeId)
        || typeof data.url !== 'string' || redact(data.url) !== data.url) throw invalid();
      const key = `${data.animeId}:${data.episodeId}`;
      const url = siteUrl(data.url);
      const episode = escapeMarkdown(cleanText(data.episode, 40, redact));
      const time = now();
      return requireStore(store).update((state) => {
        for (const [id, received] of Object.entries(state.episodes)) if (time - received >= 30 * DAY) delete state.episodes[id];
        if (Object.hasOwn(state.episodes, key)) return { duplicate: true, queued: 0 };
        if (!Object.hasOwn(state.catalog, data.animeId)) throw new AppError('ANIME_NOT_FOUND', 'زامن هذا العمل في الكتالوج قبل إرسال الحلقة.', 404);
        if (Object.keys(state.episodes).length >= MAX_EPISODES) throw new AppError('EPISODE_LIMIT', 'سجل أحداث الحلقات ممتلئ مؤقتًا.', 503);
        let queued = 0;
        for (const [userId, titles] of Object.entries(state.follows)) {
          if (!titles.includes(data.animeId)) continue;
          if (queueJob(state, `ep:${key}:${userId}`, { kind: 'episode', userId, animeId: data.animeId, episode, url,
            dueAt: time, expiresAt: time + DAY })) queued += 1;
        }
        state.episodes[key] = time;
        return { duplicate: false, queued };
      });
    },
    async autocomplete(userId, text, removing) {
      if (!store) return [];
      const state = await store.read();
      const followed = state.follows[userId] ?? [];
      return matches(state, text).filter(({ id }) => !removing || followed.includes(id)).slice(0, 25)
        .map(({ id, title }) => ({ name: title, value: id }));
    },
    async follow(userId, action, query) {
      const db = requireStore(store);
      if (action === 'list') {
        const state = await db.read();
        const items = (state.follows[userId] ?? []).map((id) => state.catalog[id]).filter(Boolean);
        return items.length ? ['📡 الأنميات اللي بتتابعها:', ...items.map(({ id, title }) => `• ${escapeMarkdown(title)} — \`${id}\``)]
          : ['لسه ما تابعتش أي أنمي. استخدم /follow add عشان تشترك في تنبيهات الحلقات في الخاص.'];
      }
      if (!query?.trim() || !['add', 'remove'].includes(action)) throw invalid();
      return db.update((state) => {
        const { id, title } = findAnime(state, query);
        const selected = state.follows[userId] ?? [];
        if (action === 'remove') {
          const next = selected.filter((item) => item !== id);
          if (next.length) state.follows[userId] = next;
          else delete state.follows[userId];
          for (const [key, job] of Object.entries(state.jobs)) {
            if (job.kind === 'episode' && job.userId === userId && job.animeId === id) delete state.jobs[key];
          }
          return [`تنبيهات **${escapeMarkdown(title)}** مش مفعّلة لحسابك.`];
        }
        if (!selected.includes(id)) {
          if (selected.length >= 20 || Object.values(state.follows).reduce((sum, ids) => sum + ids.length, 0) >= MAX_FOLLOWS) {
            throw new AppError('FOLLOW_LIMIT', 'وصلت للحد الأقصى للمتابعات. ألغِ متابعة قديمة أولًا.');
          }
          state.follows[userId] = [...selected, id];
        }
        return [`📡 هنبعتلك في الخاص لما حلقة جديدة من **${escapeMarkdown(title)}** تنزل. لإيقافها: /follow remove anime:${id}.`];
      });
    },
    async recommend(query) {
      const state = await requireStore(store).read();
      const text = normalize(query);
      const wanted = Object.entries(genres).filter(([, [, pattern]]) => pattern.test(text)).map(([key]) => key);
      const short = /قصير|\bshort\b/u.test(text);
      if (!Object.keys(state.catalog).length) throw new AppError('CATALOG_EMPTY', 'خادم الموقع لسه ما زامنش كتالوج BLACK X.', 503);
      const results = Object.values(state.catalog).filter((item) => (!short || (item.episodes !== null && item.episodes <= 13))
        && wanted.every((genre) => item.genres.includes(genre)))
        .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.title.localeCompare(b.title)).slice(0, 3);
      if (!results.length) return ['مفيش أعمال مطابقة في الكتالوج المتزامن حاليًا. جرّب نوع تاني أو احذف شرط «قصير».'];
      return { embeds: [{ title: '🧠 BLACK Z · ترشيحات من كتالوج BLACK X', color: 0x9B59B6,
        description: 'الترشيحات مبنية على نوع العمل وعدد الحلقات من الموقع، من غير تفاصيل تحرق القصة.',
        fields: results.map((item, i) => ({ name: `${i + 1}. ${item.title}`, value: `${(wanted.length ? wanted : item.genres).map((key) => genres[key][0]).join(' · ')}${item.episodes ? ` • ${item.episodes} حلقة` : ''}${short ? ' • عمل قصير' : ''}` })) }],
      components: [row(...results.map(({ url }, i) => linkButton(url, `شاهد ${i + 1}`)))] };
    },
  };
}
