import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createAnimeService } from '../src/community/anime.js';
import { prayerCard, ramadanCard, ramadanReminder, setDaily } from '../src/community/islamic.js';
import { createScheduler, dailyEmbed } from '../src/community/jobs.js';
import { cancelParty, respondParty, scheduleParty } from '../src/community/party.js';
import { createQuizService } from '../src/community/quiz.js';
import { createMemoryStore, databaseOptions, queueJob } from '../src/community/store.js';
import { DAY, localDateTime, parsePartyDate, prayerDay } from '../src/community/time.js';
import { AppError, DiscordApiError } from '../src/lib/errors.js';
import { createLogger } from '../src/lib/log.js';
import { createHttpServer } from '../src/http/server.js';
import { FAKE_API_SECRET, FAKE_BOT_TOKEN, GUILD_ID, MEMBER_ID, MISSING_MEMBER_ID, MOD_ID, OWNER_ID, MemoryDiscord } from './fixtures/discord.js';

const JAN = Date.parse('2027-01-11T10:00:00Z'); // Monday
const CHANNEL = '400000000000000001';
const PARTY = '400000000000000002';
const SITE = 'https://black-x-anime.ai.studio';
const watch = (id) => `${SITE}/anime/${id}`;
const entries = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id, i) => ({
  id, title: `Mystery ${i}`, url: watch(id), episodes: i === 3 ? 24 : 12,
  genres: [i === 4 ? 'drama' : 'mystery'], rating: i + 4,
}));
const episode = { animeId: 'a1', episodeId: 'ep-5', episode: '5', url: `${watch('a1')}/5` };

function fixture(time = JAN, store = createMemoryStore()) {
  const api = new MemoryDiscord();
  const logs = [];
  const log = createLogger({ write: (line) => logs.push(line), secrets: [FAKE_API_SECRET, FAKE_BOT_TOKEN] });
  let clock = time;
  const now = () => clock;
  const anime = createAnimeService({ store, secrets: [FAKE_API_SECRET, FAKE_BOT_TOKEN], now });
  const worker = () => createScheduler({ api, store, log, guildId: GUILD_ID, now });
  return { api, log, logs, anime, store, now, worker, setTime: (val) => { clock = val; } };
}

function quizClock(f) {
  const tasks = new Map();
  let nextId = 0;
  const quiz = createQuizService({ ...f, random: () => 0, questionMs: 100, revealMs: 50,
    schedule(callback, delay) { tasks.set(++nextId, { callback, at: f.now() + delay }); return nextId; },
    unschedule: (id) => tasks.delete(id) });
  return { quiz, async advance() {
    const [id, { callback, at }] = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
    tasks.delete(id);
    f.setTime(at);
    await callback();
  } };
}

test('Arena runs five timed questions, accepts one answer per player, reveals answers and records the weekly winners', async () => {
  const f = fixture();
  const { quiz, advance } = quizClock(f);
  await quiz.start({ kind: 'anime', id: PARTY, channelId: CHANNEL });
  await assert.rejects(quiz.start({ kind: 'seerah', id: PARTY, channelId: CHANNEL }), { code: 'QUIZ_BUSY' });
  const [{ id: messageId, data }] = f.api.messages;
  assert.match(data.embeds[0].title, /1\/5/);
  assert.doesNotMatch(data.embeds[0].description, /الإجابة:/);
  assert.equal(data.components[0].components.length, 4);
  const attempt = { id: PARTY, channelId: CHANNEL, messageId, userId: MEMBER_ID, index: 0, choice: 1 };
  assert.throws(() => quiz.answer({ ...attempt, messageId: CHANNEL }), { code: 'QUIZ_NOT_ACTIVE' });
  assert.match(quiz.answer(attempt), /اتسجّلت/);
  assert.throws(() => quiz.answer(attempt), { code: 'ALREADY_ANSWERED' });
  quiz.answer({ ...attempt, userId: MOD_ID, choice: 0 });
  await advance();
  assert.match(f.api.edits.at(-1).data.embeds[0].description, /مونكي دي لوفي/);
  assert.throws(() => quiz.answer(attempt), { code: 'QUIZ_NOT_ACTIVE' });
  for (const index of [1, 2, 3, 4]) {
    await advance();
    quiz.answer({ ...attempt, index, choice: [1, 0, 2, 3, 0][index] });
    await advance();
  }
  const final = f.api.edits.at(-1).data;
  assert.match(final.embeds[0].description, /500 نقطة/);
  assert.deepEqual(final.components, []);
  assert.deepEqual(final.allowed_mentions, { parse: [] });
  assert.equal((await f.store.read()).scores.anime[MEMBER_ID], 500);
  assert.equal((await f.store.read()).scores.seerah[MEMBER_ID], undefined);
  f.setTime(JAN + 7 * DAY);
  assert.match((await quiz.leaderboard('anime')).join('\n'), new RegExp(`أبطال الأسبوع.*${MEMBER_ID}`));
  quiz.close();
});

test('Seerah uses its own sourced answer bank and works without permanent storage', async () => {
  const f = fixture();
  const { quiz, advance } = quizClock({ ...f, store: undefined });
  await quiz.start({ kind: 'seerah', id: PARTY, channelId: CHANNEL });
  const [{ id: messageId }] = f.api.messages;
  quiz.answer({ id: PARTY, channelId: CHANNEL, messageId, userId: MEMBER_ID, index: 0, choice: 1 });
  await advance();
  assert.match(f.api.edits.at(-1).data.embeds[0].description, /غار حراء/);
  assert.match(f.api.edits.at(-1).data.embeds[0].description, /https:\/\/sunnah.com\/bukhari:3/);
  await assert.rejects(quiz.leaderboard('seerah'), { code: 'COMMUNITY_STORAGE_REQUIRED' });
  quiz.close();
});

test('the moderator can stop an in-progress quiz during the reveal and start a fresh one', async () => {
  const f = fixture();
  const { quiz, advance } = quizClock(f);
  await quiz.start({ kind: 'anime', id: PARTY, channelId: CHANNEL });
  await advance();
  await quiz.stop('anime', CHANNEL);
  assert.match(f.api.edits.at(-1).data.embeds[0].description, /أوقفت الجولة/);
  assert.deepEqual((await f.store.read()).scores, {});
  await quiz.start({ kind: 'seerah', id: CHANNEL, channelId: CHANNEL });
  assert.equal(f.api.messages.length, 2);
  quiz.close();
});

test('features that require a database fail explicitly instead of losing a subscription or schedule', async () => {
  const anime = createAnimeService({ store: undefined });
  const noStorage = { code: 'COMMUNITY_STORAGE_REQUIRED', status: 503 };
  await assert.rejects(anime.updateCatalog({ items: entries }), noStorage);
  await assert.rejects(anime.follow(MEMBER_ID, 'add', 'a1'), noStorage);
  await assert.rejects(scheduleParty(undefined, { at: JAN + 5 * 60_000 }, JAN), noStorage);
  await assert.rejects(setDaily(undefined, null), noStorage);
  assert.equal(prayerCard('giza', JAN).embeds[0].fields.length, 5);
});

test('watch-party card publishes, records only explicit RSVP/reminder consent, and reveals its watch button at start after worker restart', async () => {
  const f = fixture();
  const at = JAN + 30 * 60_000;
  await scheduleParty(f.store, { id: PARTY, channelId: CHANNEL, title: '@everyone Anime night', url: watch('a1'), at }, JAN);
  assert.equal(f.api.messages.length, 0);
  const first = f.worker();
  await first.tick();
  await first.stop();
  const [{ id: messageId, data }] = f.api.messages;
  assert.equal(data.components[0].components.some(({ url }) => url), false);
  assert.deepEqual(data.allowed_mentions, { parse: [] });
  const respond = (userId, action) => respondParty(f.store, { id: PARTY, channelId: CHANNEL, messageId, userId, action, now: f.now() });
  await assert.rejects(respond(MEMBER_ID, 'remind'), { code: 'RSVP_REQUIRED' });
  await respond(MEMBER_ID, 'join');
  await respond(MEMBER_ID, 'remind');
  await respond(MEMBER_ID, 'remind');
  await respond(MOD_ID, 'join');
  await respond(OWNER_ID, 'join');
  await respond(OWNER_ID, 'remind');
  await respond(OWNER_ID, 'leave');
  const second = f.worker();
  f.setTime(at - 10 * 60_000);
  await second.tick();
  assert.deepEqual([...f.api.dms.keys()], [MEMBER_ID]);
  f.setTime(at);
  await second.tick();
  assert.equal(f.api.edits[0].data.components[0].components[0].url, watch('a1'));
  assert.match(f.api.edits[0].data.embeds[0].description, /الحفلة بدأت/);
  await assert.rejects(respond(MOD_ID, 'remind'), { code: 'PARTY_STARTED' });
  await second.tick();
  assert.equal(f.api.edits.length, 1);
});

test('cancelling a party rejects a foreign room, updates the card and cancels pending DMs', async () => {
  const f = fixture();
  const at = JAN + 30 * 60_000;
  await scheduleParty(f.store, { id: PARTY, channelId: CHANNEL, title: 'Anime night', url: watch('a1'), at }, JAN);
  const worker = f.worker();
  await worker.tick();
  const [{ id: messageId }] = f.api.messages;
  const args = { id: PARTY, channelId: CHANNEL, messageId, userId: MEMBER_ID, now: JAN };
  await respondParty(f.store, { ...args, action: 'join' });
  await respondParty(f.store, { ...args, action: 'remind' });
  await assert.rejects(cancelParty(f.store, { id: PARTY, channelId: PARTY, now: JAN }), { code: 'PARTY_NOT_FOUND' });
  await cancelParty(f.store, args);
  await worker.tick();
  assert.match(f.api.edits[0].data.embeds[0].description, /اتلغت/);
  assert.deepEqual(f.api.edits[0].data.components, []);
  f.setTime(at);
  await worker.tick();
  assert.equal(f.api.dms.size, 0);
});

test('catalog recommendations return up to three real matches without spoilers or made-up URLs', async () => {
  const { anime } = fixture();
  await assert.rejects(anime.recommend('غموض'), { code: 'CATALOG_EMPTY' });
  assert.deepEqual(await anime.updateCatalog({ items: entries }), { count: 5 });
  const card = await anime.recommend('عايز أنمي غموض قصير ومفيهوش حرق');
  assert.equal(card.embeds[0].fields.length, 3);
  assert.ok(card.embeds[0].fields.every(({ value }) => /غموض.*12 حلقة.*عمل قصير/.test(value)));
  assert.deepEqual(card.components[0].components.map(({ url }) => url), ['a3', 'a2', 'a1'].map(watch));
  assert.match((await anime.recommend('رياضة'))[0], /مفيش أعمال/);
});

test('episode ingestion is idempotent, honours opt-out before delivery, and skips former members', async () => {
  const f = fixture();
  await f.anime.updateCatalog({ items: entries });
  const [suggestion] = await f.anime.autocomplete(MEMBER_ID, 'Mystery 0', false);
  assert.deepEqual(suggestion, { name: 'Mystery 0', value: 'a1' });
  await Promise.all([MEMBER_ID, MOD_ID, MISSING_MEMBER_ID].map((id) => f.anime.follow(id, 'add', 'a1')));
  assert.match((await f.anime.follow(MEMBER_ID, 'list')).join('\n'), /Mystery 0/);
  const changes = await Promise.all([f.anime.receiveEpisode(episode), f.anime.receiveEpisode(episode)]);
  assert.deepEqual(changes, [{ duplicate: false, queued: 3 }, { duplicate: true, queued: 0 }]);
  await f.anime.follow(MOD_ID, 'remove', 'a1');
  await f.anime.follow(MOD_ID, 'add', 'a1'); // Resubscribing must not revive a previously cancelled delivery.
  const worker = f.worker();
  await worker.tick();
  await worker.tick();
  assert.deepEqual([...f.api.dms.keys()], [MEMBER_ID]);
  assert.equal(f.api.messages.length, 1);
  assert.equal(f.api.messages[0].data.components[0].components[0].url, episode.url);
  assert.equal(Object.keys((await f.store.read()).jobs).length, 0);
  assert.ok(f.logs.some((line) => line.includes('community_delivery_failed')));
});

test('jobs retry transient delivery failures, not blocked DMs, and keep a stable delivery nonce', async () => {
  const f = fixture();
  await f.anime.updateCatalog({ items: entries });
  await f.anime.follow(MEMBER_ID, 'add', 'a1');
  await f.anime.follow(MOD_ID, 'add', 'a1');
  await f.anime.receiveEpisode(episode);
  const create = f.api.createMessage.bind(f.api);
  const tokens = [];
  f.api.createMessage = async (channel, payload) => {
    if (channel === f.api.dms.get(MOD_ID)) throw new DiscordApiError(403, 50007);
    tokens.push(payload.nonce);
    if (tokens.length === 1) throw new DiscordApiError(502);
    return create(channel, payload);
  };
  const worker = f.worker();
  await worker.tick();
  assert.equal(f.api.messages.length, 0);
  assert.equal(Object.keys((await f.store.read()).jobs).length, 1);
  f.setTime(JAN + 16_000);
  await worker.tick();
  assert.equal(f.api.messages.length, 1);
  assert.equal(tokens[0], tokens[1]);
  assert.equal(Object.keys((await f.store.read()).jobs).length, 0);
});

test('scheduler leases work across ticks, only when the allowed guild is available', async () => {
  const f = fixture();
  await setDaily(f.store, { city: 'giza', minute: 720, mode: 'ayah', channelId: CHANNEL, version: PARTY });
  const offline = createScheduler({ ...f, guildId: GUILD_ID, ready: () => false });
  await offline.tick();
  assert.equal(f.api.messages.length, 0);
  // Two workers with the same durable state compete for the same day.
  await Promise.all([f.worker().tick(), f.worker().tick()]);
  assert.equal(f.api.messages.length, 1);
  assert.match(f.api.messages[0].data.embeds[0].fields[0].value, /https:\/\/quran.com/);
  f.setTime(JAN + DAY);
  await setDaily(f.store, { city: 'giza', minute: 720, mode: 'hadith', channelId: CHANNEL, version: 'new' });
  await f.worker().tick();
  assert.equal(f.api.messages.length, 2);
  assert.match(f.api.messages[1].data.embeds[0].footer.text, /صحيح/);
  assert.match(dailyEmbed('hadith', '2027-01-11').fields[0].value, /sunnah.com/);
  await setDaily(f.store, null);
  f.setTime(JAN + 2 * DAY);
  await f.worker().tick();
  assert.equal(f.api.messages.length, 2);
});

test('city-local dates handle Cairo DST and show the next Fajr after Isha; schedule rejects missing offsets and rollover dates', () => {
  const time = Date.parse('2026-07-02T21:30:00Z');
  const { date, minute } = localDateTime(time, 'Africa/Cairo');
  assert.equal(date, '2026-07-03');
  assert.equal(minute, 30);
  const day = prayerDay('giza', time);
  assert.equal(day.next.name, 'الفجر');
  assert.ok(day.times.fajr < day.times.dhuhr && day.times.asr < day.times.maghrib && day.times.maghrib < day.times.isha);
  const night = prayerDay('giza', day.times.isha + 60_000);
  assert.equal(night.next.name, 'الفجر');
  assert.ok(night.next.at > night.times.isha);
  assert.ok(night.maghrib > night.times.maghrib);
  assert.equal(prayerCard('giza', time).embeds[0].fields.length, 5);
  assert.throws(() => prayerDay('__proto__', time), { code: 'UNKNOWN_CITY' });
  assert.equal(parsePartyDate('2027-01-11T12:00+02:00'), JAN);
  for (const bad of ['2027-02-30T12:00Z', '2027-01-11T12:00', '2027-01-11T24:00Z', '2027-01-11T12:00+14:05']) {
    assert.throws(() => parsePartyDate(bad), { code: 'INVALID_PARTY_DATE' });
  }
});

test('Ramadan is a city-local countdown with optional cancellable one-shot reminders', async () => {
  const f = fixture();
  const { maghrib } = prayerDay('giza', JAN);
  const card = ramadanCard('giza', MEMBER_ID, JAN, true);
  assert.match(card.embeds[0].description, /المغرب القادم/);
  assert.match(card.components[0].components[0].custom_id, new RegExp(`${maghrib}:${MEMBER_ID}$`));
  assert.deepEqual(ramadanCard('giza', MEMBER_ID, JAN, false).components, []);
  const args = { userId: MEMBER_ID, city: 'giza', maghrib, action: 'add', now: JAN };
  await assert.rejects(ramadanReminder(f.store, { ...args, maghrib: JAN }), { code: 'OLD_RAMADAN_CARD' });
  await ramadanReminder(f.store, args);
  await ramadanReminder(f.store, { ...args, userId: MOD_ID });
  await ramadanReminder(f.store, { ...args, userId: MOD_ID, action: 'remove' });
  const worker = f.worker();
  await worker.tick();
  assert.equal(f.api.messages.length, 0);
  f.setTime(maghrib - 600_000);
  await worker.tick();
  await worker.tick();
  assert.deepEqual([...f.api.dms.keys()], [MEMBER_ID]);
  assert.equal(f.api.messages.length, 1);
  await assert.rejects(ramadanReminder(f.store, { ...args, now: f.now() }), { code: 'REMINDER_ALREADY_PROCESSED' });
  f.setTime(maghrib);
  await worker.tick();
  assert.equal(Object.keys((await f.store.read()).jobs).length, 0);
});

test('memory transactions roll back on validation errors; remote DB defaults to verified TLS without echoing credentials', async () => {
  const store = createMemoryStore();
  await assert.rejects(store.update((state) => {
    queueJob(state, 'test', { kind: 'test' });
    throw new AppError('FAKE', 'Failed');
  }), { code: 'FAKE' });
  assert.deepEqual((await store.read()).jobs, {});
  const options = databaseOptions('postgres://bx:example@db.invalid/app?sslmode=disable', 'public test CA');
  assert.deepEqual(options.ssl, { ca: 'public test CA', minVersion: 'TLSv1.2', rejectUnauthorized: true });
  assert.doesNotMatch(options.connectionString, /sslmode/);
  assert.equal(databaseOptions('postgres://localhost/app').ssl, false);
  assert.throws(() => databaseOptions(`https://${FAKE_API_SECRET}.invalid/app`),
    (error) => error.code === 'INVALID_CONFIG' && !error.message.includes(FAKE_API_SECRET));
});

test('anime HTTP API verifies secret and validates catalog, link origin, keys and body, then queues an event exactly once', async (t) => {
  const f = fixture();
  const server = createHttpServer({ apiSecret: FAKE_API_SECRET, anime: f.anime, log: f.log });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const post = async (path, data, secret = FAKE_API_SECRET) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/anime/${path}`, {
      method: 'POST', headers: { 'X-BX-Secret': secret, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    return [res.status, await res.json()];
  };
  assert.equal((await post('catalog', { items: entries }, 'not-the-secret'))[0], 401);
  for (const item of [
    { ...entries[0], id: 'constructor' }, { ...entries[0], genres: ['bogus'] },
    { ...entries[0], url: 'https://black-x-anime.ai.studio.example.org/' },
    { ...entries[0], url: 'https://evil@black-x-anime.ai.studio/' },
    { ...entries[0], title: FAKE_BOT_TOKEN }, { ...entries[0], title: 'x'.repeat(128 * 1024) },
  ]) assert.equal((await post('catalog', { items: [item] }))[0], 400);
  assert.equal((await post('episodes', { ...episode, token: FAKE_BOT_TOKEN }))[0], 400);
  assert.equal((await post('episodes', episode))[0], 404);
  assert.deepEqual(await post('catalog', { items: entries }), [200, { ok: true, count: 5 }]);
  await f.anime.follow(MEMBER_ID, 'add', 'a1');
  assert.deepEqual(await post('episodes', episode), [202, { ok: true, duplicate: false, queued: 1 }]);
  assert.deepEqual(await post('episodes', episode), [200, { ok: true, duplicate: true, queued: 0 }]);
  assert.equal(f.api.messages.length, 0);
  assert.ok(f.logs.every((line) => !line.includes(FAKE_API_SECRET) && !line.includes(FAKE_BOT_TOKEN) && !line.includes(SITE)));
});
