import assert from 'node:assert/strict';
import test from 'node:test';
import { adminOf, newAdmin } from '../src/admin/core.js';
import { createAnimeService } from '../src/community/anime.js';
import { createCommunityStore } from '../src/community/backend.js';
import { setDaily } from '../src/community/islamic.js';
import { createScheduler } from '../src/community/jobs.js';
import { newState, requireStore } from '../src/community/store.js';
import { createTursoStore } from '../src/community/turso-store.js';
import { readConfig } from '../src/lib/env.js';
import { AppError } from '../src/lib/errors.js';
import { createLogger } from '../src/lib/log.js';
import { configuredSecrets } from '../src/lib/redact.js';
import { GUILD_ID, MEMBER_ID, OTHER_GUILD_ID, MemoryDiscord, OWNER_ID, fixtureEnv } from './fixtures/discord.js';

const URL = 'libsql://black-x-fixture.turso.io';
const ENDPOINT = 'https://black-x-fixture.turso.io/v2/pipeline';
const TOKEN = 'mock-turso-token-not-for-production';
const DATABASE_URL = 'postgres://fake:fixture-password@db.invalid/bx';
const NOW = Date.parse('2027-01-11T10:00:00Z');
const CHANNEL = '400000000000000001';
const UNAVAILABLE = { code: 'COMMUNITY_STORAGE_UNAVAILABLE', status: 503 };
const ENTRY = { id: 'a1', title: 'Fixture', genres: ['mystery'], episodes: 12, url: 'https://black-x-anime.ai.studio/show/fixture' };
const store = (options = {}) => createTursoStore({ guildId: GUILD_ID, url: URL, authToken: TOKEN, ...options });
const empty = (count = 0) => ({ cols: [], rows: [], affected_row_count: count });

// Writer/pipeline fixture shared by independent stores. Pause SELECT replies to force both
// clients to see the same revision and verify that the guarded UPDATE, not a JS lock, arbitrates.
function writer() {
  let rows = new Map();
  let blocked;
  const operations = [];
  const failures = [];
  async function fetchImpl(endpoint, options) {
    assert.equal(endpoint, ENDPOINT);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(options.signal instanceof AbortSignal);
    const { requests } = JSON.parse(options.body);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].type, 'batch');
    assert.deepEqual(requests[1], { type: 'close' });
    const { steps } = requests[0].batch;
    assert.equal(steps[0].stmt.sql, 'BEGIN IMMEDIATE');
    const failure = failures.shift();
    if (failure instanceof Response) return failure;
    const draft = new Map(rows);
    const results = Array(steps.length).fill(null);
    const errors = Array(steps.length).fill(null);
    let selected = false;

    function matches(condition) {
      if (condition?.type === 'ok') return Boolean(results[condition.step]);
      if (condition?.type === 'not') return !matches(condition.cond);
      if (condition?.type === 'and') return condition.conds.every(matches);
      return condition == null;
    }
    for (const [index, { stmt: { sql, args }, condition }] of steps.entries()) {
      if (!matches(condition)) continue;
      if (failure?.sql === sql) { errors[index] = failure.error; continue; }
      if (sql === 'COMMIT') rows = draft;
      if (sql === 'ROLLBACK') operations.push('rollback');
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS bx_community_v1')) operations.push('schema');
      if (sql.startsWith('INSERT INTO bx_community_v1')) {
        assert.match(sql, /ON CONFLICT \(guild_id\) DO NOTHING$/);
        assert.equal(args[0].type, 'text');
        if (!draft.has(args[0].value)) draft.set(args[0].value, { data: args[1].value, revision: '0' });
        operations.push('seed');
      }
      if (sql.startsWith('SELECT data, revision')) {
        assert.match(sql, /WHERE guild_id = \?$/);
        const record = draft.get(args[0].value);
        results[index] = { ...empty(), cols: [{ name: 'data', decltype: 'TEXT' }, { name: 'revision', decltype: 'INTEGER' }],
          rows: record ? [[{ type: 'text', value: record.data }, { type: 'integer', value: record.revision }]] : [] };
        selected = true;
        continue;
      }
      if (sql.startsWith('UPDATE')) {
        assert.match(sql, /revision = revision \+ 1 WHERE guild_id = \? AND revision = \?$/);
        const [data, id, revision] = args.map(({ value }) => value);
        assert.equal(args[2].type, 'integer');
        if (draft.get(id)?.revision !== revision) { operations.push('conflict'); results[index] = empty(); continue; }
        draft.set(id, { data, revision: String(Number(revision) + 1) });
        operations.push('write');
        results[index] = empty(1);
        continue;
      }
      results[index] = empty();
    }
    if (selected && blocked) {
      const gate = blocked;
      if (--gate.remaining === 0) { blocked = undefined; gate.release(); }
      await gate.promise;
    }
    return Response.json({ baton: null, base_url: null, results: [
      { type: 'ok', response: { type: 'batch', result: { step_results: results, step_errors: errors } } },
      { type: 'ok', response: { type: 'close' } },
    ] });
  }

  return {
    operations, failures, fetchImpl,
    connect(guildId = GUILD_ID) { return store({ guildId, fetchImpl }); },
    interleaveReads(count) {
      blocked = { remaining: count };
      blocked.promise = new Promise((resolve) => { blocked.release = resolve; });
    },
  };
}

test('Turso uses only the canonical Cloud HTTPS endpoint for Turso and libSQL hosts', async () => {
  const db = writer();
  for (const url of [URL, 'turso://black-x-fixture.turso.io/', 'https://black-x-fixture.turso.io']) {
    const dbStore = store({ url, fetchImpl: db.fetchImpl });
    assert.deepEqual(await dbStore.read(), newState());
    dbStore.close();
  }
  for (const url of ['http://black-x-fixture.turso.io', 'file:local.db', DATABASE_URL, 'libsql://turso.io',
    'https://black-x-fixture.turso.io.invalid', 'https://not-turso.io', `https://user:${TOKEN}@black-x-fixture.turso.io`,
    'libsql://black-x-fixture.turso.io:8080', `${URL}?tls=0`, `${URL}/v2/pipeline`]) {
    assert.throws(() => store({ url }), (error) => error.code === 'INVALID_CONFIG' && !error.message.includes(TOKEN));
  }
  for (const authToken of [undefined, '', 'Bearer token', `hello\n${TOKEN}`, 'a,b']) {
    assert.throws(() => store({ authToken }), { code: 'INVALID_CONFIG' });
  }
});

test('runtime selection keeps no-database mode and Postgres; explicit Turso never falls back', () => {
  const calls = [];
  const lines = [];
  const make = (env) => {
    const config = readConfig({ ...fixtureEnv(), ...env });
    const log = createLogger({ write: (line) => lines.push(line), secrets: configuredSecrets(config) });
    return createCommunityStore({ config, log, turso: (options) => {
      calls.push(['turso', options]);
      return createTursoStore(options);
    }, postgres: (options) => { calls.push(['postgres', options]); return { kind: 'postgres' }; } });
  };
  assert.equal(make({}), undefined);
  assert.throws(() => requireStore(undefined), /TURSO_DATABASE_URL.*TURSO_AUTH_TOKEN/);
  assert.deepEqual(make({ DATABASE_URL }), { kind: 'postgres' });
  assert.equal(calls[0][1].connectionString, DATABASE_URL);
  const configured = make({ TURSO_DATABASE_URL: ` ${URL} `, TURSO_AUTH_TOKEN: ` ${TOKEN} `, DATABASE_URL });
  assert.equal(typeof configured.read, 'function');
  assert.deepEqual(calls[1][1], { url: URL, authToken: TOKEN, guildId: GUILD_ID });
  configured.close();
  assert.equal(make({ TURSO_DATABASE_URL: URL, DATABASE_URL }), undefined);
  assert.equal(make({ TURSO_AUTH_TOKEN: TOKEN, DATABASE_URL }), undefined);
  assert.deepEqual(calls.map(([backend]) => backend), ['postgres', 'turso', 'turso', 'turso']);
  assert.ok(lines.some((line) => line.includes('community_storage_config_invalid')));
  assert.ok(lines.every((line) => !line.includes(DATABASE_URL) && !line.includes(TOKEN) && !line.includes(URL)));
});

test('Turso credentials are redacted in logs and rejected in user-visible catalog data', async () => {
  const config = readConfig({ ...fixtureEnv(), TURSO_DATABASE_URL: URL, TURSO_AUTH_TOKEN: TOKEN });
  const secrets = configuredSecrets(config);
  const entries = [];
  const log = createLogger({ secrets, write: (line) => entries.push(line) });
  log.error('test', { message: `${URL} ${TOKEN}`, authorization: TOKEN });
  assert.equal(JSON.parse(entries[0]).message, '**** ****');
  assert.ok(!entries[0].includes(TOKEN));
  const db = writer();
  const anime = createAnimeService({ store: db.connect(), secrets });
  await assert.rejects(anime.updateCatalog({ items: [{ ...ENTRY, title: TOKEN }] }), { code: 'INVALID_ANIME_DATA' });
  assert.deepEqual(db.operations, []); // No connection or schema change before the first storage operation.
});

test('a new Turso store reads persisted state; different guilds and no-op or failed updates are isolated', async () => {
  const db = writer();
  const first = db.connect();
  const anime = createAnimeService({ store: first });
  await anime.updateCatalog({ items: [ENTRY] });
  await anime.follow(MEMBER_ID, 'add', ENTRY.id);
  first.close();
  await assert.rejects(first.read(), UNAVAILABLE);
  const reconnected = db.connect();
  assert.deepEqual((await reconnected.read()).follows, { [MEMBER_ID]: ['a1'] });
  assert.deepEqual((await reconnected.read()).catalog.a1, { ...ENTRY, rating: null });
  assert.deepEqual(await db.connect(OTHER_GUILD_ID).read(), newState());
  const count = db.operations.filter((operation) => operation === 'write').length;
  assert.equal(await reconnected.update((state) => state.follows[MEMBER_ID].length), 1);
  await assert.rejects(reconnected.update((state) => {
    state.follows = {};
    throw new AppError('VALIDATION', 'Reject requested change');
  }), { code: 'VALIDATION' });
  await assert.rejects(reconnected.update(async (state) => { state.follows = {}; }), UNAVAILABLE);
  assert.equal(db.operations.filter((operation) => operation === 'write').length, count);
  assert.deepEqual((await reconnected.read()).follows, { [MEMBER_ID]: ['a1'] });
});

test('independent Turso writers retry revision conflicts without losing concurrent changes', async () => {
  const db = writer();
  const a = db.connect();
  const b = db.connect();
  await Promise.all([a.read(), b.read()]);
  db.interleaveReads(2);
  const count = await Promise.all([a, b].map((dbStore) => dbStore.update((state) => {
    state.scores.count = (state.scores.count ?? 0) + 1;
    return state.scores.count;
  })));
  assert.deepEqual(count.sort(), [1, 2]);
  assert.equal((await b.read()).scores.count, 2);
  assert.ok(db.operations.includes('conflict'));
});

test('two schedulers using Turso can claim the same pending job only once', async () => {
  const db = writer();
  const a = db.connect();
  const b = db.connect();
  await setDaily(a, { city: 'giza', minute: 720, mode: 'ayah', channelId: CHANNEL, version: 'v1' });
  await b.read();
  db.interleaveReads(2);
  const api = new MemoryDiscord();
  const log = createLogger({ write() {} });
  const worker = (dbStore) => createScheduler({ store: dbStore, api, guildId: GUILD_ID, log, now: () => NOW });
  await Promise.all([worker(a).tick(), worker(b).tick()]);
  assert.equal(api.messages.length, 1);
  assert.deepEqual((await b.read()).jobs, {});
  assert.ok(db.operations.includes('conflict'));
});

test('known lock errors roll back and retry; auth failures stay generic and lazy initialization can recover', async () => {
  const db = writer();
  const conn = db.connect();
  db.failures.push(new Response(`authentication error for ${TOKEN} ${URL}`, { status: 401 }));
  await assert.rejects(conn.read(), (error) => error.code === UNAVAILABLE.code && error.status === 503 && !error.message.includes(TOKEN));
  db.failures.push({ sql: 'COMMIT', error: { code: 'SQLITE_BUSY', message: 'database locked' } });
  assert.deepEqual(await conn.read(), newState());
  assert.equal(db.operations.filter((operation) => operation === 'schema').length, 2);
  assert.ok(db.operations.includes('rollback'));
});

test('the store never replays an ambiguous write when the response is lost after commit', async () => {
  const db = writer();
  let lost = false;
  const conn = store({ fetchImpl: async (url, options) => {
    const response = await db.fetchImpl(url, options);
    if (!lost && JSON.parse(options.body).requests[0].batch.steps[1].stmt.sql.startsWith('UPDATE')) {
      lost = true;
      throw new Error(`disconnected before receiving the commit reply: ${TOKEN}`);
    }
    return response;
  } });
  let attempts = 0;
  await assert.rejects(conn.update((state) => {
    attempts += 1;
    state.scores.counter = (state.scores.counter ?? 0) + 1;
  }), (error) => error.code === UNAVAILABLE.code && error.status === 503 && !error.message.includes(TOKEN));
  assert.equal(attempts, 1);
  assert.equal((await conn.read()).scores.counter, 1);
});

test('Turso does not report success on a malformed transaction reply; shutdown aborts an outstanding request', async () => {
  const invalid = store({ fetchImpl: async () => Response.json({ results: [] }) });
  await assert.rejects(invalid.read(), UNAVAILABLE);
  invalid.close();
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  const conn = store({ fetchImpl: async (_url, { signal }) => {
    started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const read = assert.rejects(conn.read(), UNAVAILABLE);
  await requested;
  conn.close();
  await read;
});

test('Turso reads legacy guild state and round-trips opt-in administration, bridge, welcome and catalogue receipts in the same row', async () => {
  const db = writer();
  const a = db.connect();
  assert.equal((await a.read()).admin, undefined);
  assert.equal(adminOf(await a.read()).enabled, false);
  await a.update((s) => {
    s.admin = { ...newAdmin(), enabled: true, version: 2, paused: { tickets: true } };
    s.admin.siteBridge = { enabled: true, ownerId: OWNER_ID };
    s.admin.welcome = { enabled: true, channelId: CHANNEL, ownerId: OWNER_ID, receipts: { joinFingerprint: NOW } };
    s.admin.requests[CHANNEL] = { id: CHANNEL, kind: 'ticket', origin: 'site', status: 'open', by: MEMBER_ID,
      shared: [{ id: 'fixtureMessage', origin: 'site', side: 'requester', body: 'رسالة اختبار', delivery: 'unconfirmed', at: NOW }] };
    s.admin.tasks[CHANNEL] = { id: CHANNEL, title: 'fixture task', at: NOW, dueAt: NOW + 120_000 };
    s.admin.audit.push({ team: 'support', action: 'task_assigned', at: NOW, target: CHANNEL });
  });
  const anime = createAnimeService({ store: a, now: () => NOW });
  assert.deepEqual(await anime.updateCatalog({ items: [ENTRY] }), { count: 1 });
  a.close();
  const b = db.connect();
  const persisted = await b.read();
  assert.deepEqual(persisted.catalogMeta, { at: NOW, batch: 1, removed: 0 });
  assert.equal(persisted.admin.version, 2);
  assert.deepEqual(persisted.admin.paused, { tickets: true });
  assert.deepEqual(persisted.admin.siteBridge, { enabled: true, ownerId: OWNER_ID });
  assert.equal(persisted.admin.welcome.receipts.joinFingerprint, NOW);
  assert.deepEqual(persisted.admin.requests[CHANNEL].shared[0], {
    id: 'fixtureMessage', origin: 'site', side: 'requester', body: 'رسالة اختبار', delivery: 'unconfirmed', at: NOW,
  });
  assert.equal(persisted.admin.tasks[CHANNEL].title, 'fixture task');
  assert.deepEqual(persisted.admin.audit, [{ team: 'support', action: 'task_assigned', at: NOW, target: CHANNEL }]);
  assert.equal((await db.connect(OTHER_GUILD_ID).read()).admin, undefined);
  b.close();
});
