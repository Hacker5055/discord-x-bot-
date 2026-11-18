import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createHttpServer } from '../src/http/server.js';
import { ROLES } from '../src/lib/catalog.js';
import { readConfig } from '../src/lib/env.js';
import { DiscordApiError } from '../src/lib/errors.js';
import { createLogger } from '../src/lib/log.js';
import { provisionGuild } from '../src/provisioning.js';
import { createRoleService } from '../src/roles/sync.js';
import { BOT_ID, FAKE_API_SECRET, FAKE_BOT_TOKEN, FAKE_WEBHOOK_TOKEN, GUILD_ID, MEMBER_ID, MemoryDiscord,
  MISSING_MEMBER_ID, fixtureEnv } from './fixtures/discord.js';

async function makeServer(t, options = {}) {
  const api = new MemoryDiscord();
  const config = readConfig(fixtureEnv());
  await provisionGuild({ api, config, botId: BOT_ID });
  const roles = createRoleService({ api, config, botId: BOT_ID });
  const lines = [];
  const log = createLogger({ write: (line) => lines.push(line), secrets: [FAKE_API_SECRET, FAKE_BOT_TOKEN] });
  const getHealth = () => ({ ok: true, uptime: 1, bot: { id: BOT_ID, tag: 'BLACK X Bot', ready: true },
    guild: { id: GUILD_ID, memberCount: 4 } });
  const server = createHttpServer({ apiSecret: config.apiSecret, roles, getHealth, log, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  function request(path, { secret = FAKE_API_SECRET, raw, data, headers = {} } = {}) {
    const body = raw ?? (data === undefined ? undefined : JSON.stringify(data));
    return fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', body,
      headers: { ...(secret ? { 'X-BX-Secret': secret } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } });
  }
  return { api, request, lines, getHealth };
}

const grant = '/api/roles/grant';
const revoke = '/api/roles/revoke';
const memberRoles = `/api/roles/${MEMBER_ID}`;
const grantData = { discordId: MEMBER_ID, roleKey: 'vip_basic' };

async function check(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  if (code) assert.equal(body.code, code);
  return body;
}

test('HTTP role API authenticates, validates, enforces hierarchy, syncs membership, and logs every call', async (t) => {
  const { api, request, lines } = await makeServer(t);
  await check(await request(grant, { secret: null, data: grantData }), 401, 'UNAUTHORIZED');
  await check(await request(grant, { secret: 'wrong', data: grantData }), 401, 'UNAUTHORIZED');
  await check(await request(grant, { data: { discordId: MEMBER_ID } }), 400, 'INVALID_BODY');
  await check(await request(grant, { raw: '{' }), 400, 'INVALID_BODY');
  await check(await request(grant, { raw: 'x'.repeat(8193) }), 400, 'INVALID_BODY');
  await check(await request(grant, { data: { ...grantData, token: FAKE_BOT_TOKEN } }), 400, 'INVALID_BODY');
  await check(await request(grant, { data: { ...grantData, discordId: 'non-id' } }), 400, 'INVALID_DISCORD_ID');
  await check(await request(grant, { data: { ...grantData, roleKey: '__proto__' } }), 400, 'INVALID_ROLE_REQUEST');
  await check(await request(grant, { data: { ...grantData, discordId: MISSING_MEMBER_ID } }), 404, 'MEMBER_NOT_FOUND');
  await check(await request(`/api/roles/${MISSING_MEMBER_ID}`), 404, 'MEMBER_NOT_FOUND');
  const basic = api.roles.find(({ name }) => name === ROLES.vip_basic.name);
  const original = basic.position;
  basic.position = 100;
  const blocked = await check(await request(grant, { data: grantData }), 403, 'ROLE_HIERARCHY');
  assert.match(blocked.message, /Server Settings → Roles/);
  basic.position = original;
  basic.permissions = '8';
  await check(await request(grant, { data: grantData }), 403, 'UNSAFE_ROLE');
  basic.permissions = '1024';
  assert.deepEqual(await check(await request(grant, { data: grantData }), 200), { ok: true, ...grantData, changed: true });
  assert.equal((await check(await request(grant, { data: grantData }), 200)).changed, false);
  assert.deepEqual(await check(await request(memberRoles), 200), { ok: true, discordId: MEMBER_ID, roles: ['vip_basic'] });
  assert.equal((await check(await request(revoke, { data: grantData }), 200)).changed, true);
  assert.deepEqual((await check(await request(memberRoles), 200)).roles, []);
  assert.equal(api.writes.filter(({ operation }) => operation === 'grantRole').length, 1);

  api.grantRole = async () => { throw new DiscordApiError(403, 50013); };
  await check(await request(grant, { data: grantData }), 502, 'DISCORD_REJECTED');
  api.grantRole = async () => { throw new Error(`discard ${FAKE_API_SECRET} ${FAKE_WEBHOOK_TOKEN}`); };
  const error = await check(await request(grant, { data: grantData }), 502, 'DISCORD_REJECTED');
  const logEntries = lines.map((line) => JSON.parse(line));
  assert.equal(logEntries.length, 19);
  assert.ok(logEntries.every(({ event, status }) => event === 'http_request' && Number.isInteger(status)));
  assert.ok(logEntries.some(({ discordCode, discordStatus }) => discordCode === 50013 && discordStatus === 403));
  for (const secret of [FAKE_API_SECRET, FAKE_WEBHOOK_TOKEN, FAKE_BOT_TOKEN]) {
    assert.ok(!`${JSON.stringify(error)} ${lines.join('\n')}`.includes(secret));
  }
});

test('health requires the secret and returns the documented shape; it responds 503 when not ready', async (t) => {
  let ready = true;
  const { request } = await makeServer(t, { getHealth: () => ({ ok: ready, uptime: 1,
    bot: { id: BOT_ID, tag: 'BLACK X Bot', ready }, guild: { id: GUILD_ID, memberCount: ready ? 4 : null } }) });
  await check(await request('/health', { secret: null }), 401, 'UNAUTHORIZED');
  const result = await check(await request('/health'), 200);
  assert.deepEqual(result, { ok: true, uptime: 1, bot: { id: BOT_ID, tag: 'BLACK X Bot', ready: true },
    guild: { id: GUILD_ID, memberCount: 4 } });
  ready = false;
  assert.equal((await check(await request('/health'), 503)).bot.ready, false);
});

test('HTTP per-IP limit returns 429 and Retry-After and ignores spoofable forwarding headers', async (t) => {
  let clock = 10;
  const { request } = await makeServer(t, { limit: 2, windowMs: 60_000, now: () => clock });
  await check(await request('/health'), 200);
  await check(await request('/health', { secret: null }), 401);
  const over = await request('/health', { headers: { 'X-Forwarded-For': '192.0.2.20' } });
  assert.equal(over.headers.get('retry-after'), '60');
  await check(over, 429, 'RATE_LIMITED');
  clock += 60_000;
  await check(await request('/health'), 200);
});
