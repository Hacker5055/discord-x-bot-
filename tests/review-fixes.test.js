import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { adminFixture } from './fixtures/admin.js';
import { fixtureEnv, GUILD_ID, MEMBER_ID } from './fixtures/discord.js';
import { DiscordApiError } from '../src/lib/errors.js';
import { readConfig } from '../src/lib/env.js';
import { createMemoryStore } from '../src/community/store.js';
import { respondParty, scheduleParty } from '../src/community/party.js';

const load = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('runtime, lockfile and CI consistently select Node 24 and lint before testing', async () => {
  const pkg = JSON.parse(await load('package.json'));
  const lock = JSON.parse(await load('package-lock.json'));
  assert.equal(pkg.engines.node, '>=24 <25');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  assert.match(await load('Dockerfile'), /^FROM node:24-alpine/m);
  const ci = await load('.github/workflows/ci.yml');
  assert.match(ci, /node-version: '24'/);
  assert.ok(ci.indexOf('npm run lint') < ci.indexOf('npm test'));
  assert.equal(pkg.scripts.lint, 'eslint src tests eslint.config.js');
});

test('lint rejects unresolved names before code can reach production', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/eslint/bin/eslint.js', import.meta.url)),
    '--stdin', '--stdin-filename', 'src/lint-regression.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', input: 'missingReviewImport();\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no-undef/);
});

test('incident recovery closes a deleted card record after the safe recovery window', async () => {
  const f = await adminFixture();
  await f.enable();
  await f.room('incident', f.publicRoom);
  const i = f.make();
  await f.admin.incident.open(i, { title: 'Test incident', details: 'Test recovery' });
  const record = (await f.store.read()).admin.incidents[i.id];
  f.api.messages.splice(0);
  f.api.getMessage = async () => { throw new DiscordApiError(404, 10008); };
  f.clock.at += 3 * 60_000;
  await f.admin.incident.recover(f.make(), { id: i.id });
  assert.equal((await f.store.read()).admin.incidents[i.id].status, 'resolved');
  assert.equal(f.api.messages.length, 0);
  assert.ok(record.messageId);
});

test('forget rejects absent or non-failed leases with a controlled not-found error', async () => {
  const f = await adminFixture();
  await f.enable();
  const id = '100000000000000099';
  await assert.rejects(f.admin.room.forget(f.make(), { id }), { code: 'ADMIN_NOT_FOUND' });
  await f.store.update((s) => { s.admin.leases.example = { key: 'example', applyId: id, failed: false }; });
  await assert.rejects(f.admin.room.forget(f.make(), { id }), { code: 'ADMIN_NOT_FOUND' });
  await f.store.update((s) => { s.admin.leases.example.failed = true; });
  await f.admin.room.forget(f.make(), { id });
  assert.equal((await f.store.read()).admin.leases.example, undefined);
});

test('waitlist confirmation cannot create a booking while events are paused or admin is disabled', async () => {
  const store = createMemoryStore();
  const now = Date.parse('2027-01-01T10:00:00Z');
  const id = '100000000000000099';
  const channelId = '100000000000000088';
  const messageId = '100000000000000077';
  await store.update((s) => { s.admin = { enabled: true, paused: {}, calendar: {}, audit: [] }; });
  await scheduleParty(store, { id, channelId, title: 'Test party', at: now + 3_600_000,
    url: 'https://example.invalid', capacity: 1 }, now);
  await store.update((s) => { Object.assign(s.parties[id], { messageId, waitlist: [MEMBER_ID] }); });
  const args = { id, channelId, messageId, userId: MEMBER_ID, action: 'confirm', now };
  for (const settings of [{ enabled: true, paused: { events: true } }, { enabled: false, paused: {} }]) {
    await store.update((s) => { Object.assign(s.admin, settings); });
    await assert.rejects(respondParty(store, args), { code: 'ADMIN_PAUSED' });
    const party = (await store.read()).parties[id];
    assert.deepEqual(party.waitlist, [MEMBER_ID]);
    assert.deepEqual(party.rsvps, {});
  }
  await store.update((s) => { s.admin.enabled = true; });
  await respondParty(store, args);
  assert.ok((await store.read()).parties[id].rsvps[MEMBER_ID]);
});

test('API configuration rejects short, malformed, repeated and reused shared secrets safely', () => {
  const env = fixtureEnv();
  for (const secret of ['x', 'a'.repeat(64), 'change-me-'.repeat(8), '1'.repeat(129),
    'x'.repeat(44) + ',', 'x'.repeat(44) + '\n', 'x'.repeat(44) + ' ']) {
    assert.throws(() => readConfig({ ...env, BOT_API_SECRET: secret }),
      (e) => e.code === 'INVALID_CONFIG' && /BOT_API_SECRET/.test(e.message) && !e.message.includes(secret));
  }
  assert.throws(() => readConfig({ ...env, DISCORD_BOT_TOKEN: env.BOT_API_SECRET }), /BOT_API_SECRET/);
  const hex = '0123456789abcdef'.repeat(4);
  const base64url = 'Abcdefghijklmnopqrstuvwxyz_0123456789-XyZABCD';
  assert.equal(readConfig({ ...env, BOT_API_SECRET: hex }).apiSecret, hex);
  assert.equal(readConfig({ ...env, BOT_API_SECRET: base64url }).apiSecret, base64url);
});

test('AutoMod retries failed saves and merges concurrent events without recounting successful flushes', async () => {
  const f = await adminFixture({ automod: true });
  await f.enable();
  const snapshot = (await f.store.read()).admin;
  const event = { guild: { id: GUILD_ID }, channelId: f.publicRoom.id, ruleId: '100000000000000099' };
  f.admin.auto.observe(event);
  const update = f.store.update;
  f.store.update = async () => {
    f.admin.auto.observe(event);
    f.admin.auto.observe({ ...event, ruleId: '100000000000000098' });
    throw new Error('Simulated database outage');
  };
  await assert.rejects(f.admin.auto.flush(snapshot), /Simulated database outage/);
  f.store.update = update;
  await f.admin.auto.flush(snapshot);
  const counts = Object.values((await f.store.read()).admin.automod);
  assert.equal(counts.length, 2);
  assert.equal(counts.reduce((sum, value) => sum + value.count, 0), 3);
  await f.admin.auto.flush(snapshot);
  assert.deepEqual(Object.values((await f.store.read()).admin.automod), counts);
});

test('failed AutoMod batches stay bounded and preserve old keys before newer overflow', async () => {
  const f = await adminFixture({ automod: true });
  await f.enable();
  const snapshot = (await f.store.read()).admin;
  const observe = (n) => f.admin.auto.observe({ guild: { id: GUILD_ID }, channelId: f.publicRoom.id,
    ruleId: String(100000000000000000n + BigInt(n)) });
  for (let i = 0; i < 250; i += 1) observe(i);
  const update = f.store.update;
  f.store.update = async () => { for (let i = 250; i < 500; i += 1) observe(i); throw new Error('outage'); };
  await assert.rejects(f.admin.auto.flush(snapshot), /outage/);
  f.store.update = update;
  await f.admin.auto.flush(snapshot);
  const counts = Object.values((await f.store.read()).admin.automod);
  assert.equal(counts.length, 250);
  assert.ok(counts.every((value) => BigInt(value.ruleId) < 100000000000000250n));
});
