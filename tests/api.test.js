import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordApi } from '../src/discord/api.js';
import { DiscordApiError } from '../src/lib/errors.js';
import { FAKE_BOT_TOKEN, FAKE_WEBHOOK_TOKEN, GUILD_ID } from './fixtures/discord.js';

const jsonResponse = (status, json, headers) => new Response(JSON.stringify(json), { status, headers });
function stub(...responses) {
  const calls = [];
  const waits = [];
  let clock = 0;
  const api = new DiscordApi({ token: FAKE_BOT_TOKEN, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const next = responses[calls.length - 1];
      if (!next) assert.fail('Unexpected REST request');
      if (next instanceof Error) throw next;
      return next;
    } });
  return { api, calls, waits };
}

test('REST v10 respects Discord retry_after in seconds (429 followed by success)', async () => {
  const { api, calls, waits } = stub(jsonResponse(429, { retry_after: 0.025 }), jsonResponse(200, { id: GUILD_ID }));
  assert.deepEqual(await api.getGuild(GUILD_ID), { id: GUILD_ID });
  assert.deepEqual(waits, [25]);
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.equal(url, `https://discord.com/api/v10/guilds/${GUILD_ID}?with_counts=true`);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.authorization, `Bot ${FAKE_BOT_TOKEN}`);
    assert.equal(options.redirect, 'error');
  }
});

test('REST uses Retry-After headers if a 429 has no JSON', async () => {
  const { api, waits } = stub(new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.012' } }),
    jsonResponse(200, []));
  assert.deepEqual(await api.getRoles(GUILD_ID), []);
  assert.deepEqual(waits, [12]);
});

test('5xx retries use exponential backoff with no more than three retries', async () => {
  const { api, calls, waits } = stub(jsonResponse(500, {}), jsonResponse(502, {}), jsonResponse(503, {}), jsonResponse(200, []));
  assert.deepEqual(await api.getChannels(GUILD_ID), []);
  assert.deepEqual(waits, [250, 500, 1000]);
  assert.equal(calls.length, 4);
  const failed = stub(...Array.from({ length: 4 }, () => jsonResponse(503, {})));
  await assert.rejects(failed.api.getChannels(GUILD_ID), { status: 503 });
  assert.equal(failed.calls.length, 4);
});

test('a non-429 4xx stops immediately and discards the raw Discord error and token', async () => {
  const { api, calls, waits } = stub(jsonResponse(403, { code: 50013, message: `Oops ${FAKE_BOT_TOKEN}` }));
  await assert.rejects(api.getCurrentUser(), (error) => {
    assert.ok(error instanceof DiscordApiError);
    assert.equal(error.discordCode, 50013);
    assert.equal(error.status, 403);
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(FAKE_BOT_TOKEN));
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('a possibly successful POST reconciles its resource identity before sending another POST', async () => {
  const created = { id: GUILD_ID };
  const { api, calls, waits } = stub(jsonResponse(502, {}), jsonResponse(200, [created]));
  const role = await api.createRole(GUILD_ID, { name: 'A role' }, async () => (await api.getRoles(GUILD_ID))[0]);
  assert.deepEqual(role, created);
  assert.deepEqual(calls.map(({ options }) => options.method), ['POST', 'GET']);
  assert.deepEqual(waits, [250]);
});

test('network errors are retried and do not keep an unsafe cause', async () => {
  const { api, waits } = stub(...Array.from({ length: 4 }, () => new Error(`network error: ${FAKE_BOT_TOKEN}`)));
  await assert.rejects(api.getCurrentUser(), (error) => error.status === 502 && !error.cause && !error.stack.includes(FAKE_BOT_TOKEN));
  assert.deepEqual(waits, [250, 500, 1000]);
});

test('global Discord 429 delays subsequent requests without sleeping twice', async () => {
  const { api, waits } = stub(jsonResponse(429, { global: true, retry_after: 0.020 }), jsonResponse(200, []));
  assert.deepEqual(await api.getRoles(GUILD_ID), []);
  assert.deepEqual(waits, [20]);
});

test('the production adapter drops webhook credentials when reading or creating hooks', async () => {
  const hook = { id: '100000000000000055', name: 'BLACK X Bot', channel_id: GUILD_ID, type: 1 };
  const wire = { ...hook, token: FAKE_WEBHOOK_TOKEN };
  const { api } = stub(jsonResponse(200, [wire]), jsonResponse(200, wire));
  assert.deepEqual(await api.getWebhooks(GUILD_ID), [hook]);
  assert.deepEqual(await api.createWebhook(GUILD_ID, { name: hook.name }), hook);
});

test('guarded Discord writes include a narrow audit reason and never replay a potentially stale observation', async () => {
  const channelId = '100000000000000099';
  const result = stub(jsonResponse(502, {}), jsonResponse(200, { audit_log_entries: [] }));
  await assert.rejects(result.api.updateChannel(channelId, { rate_limit_per_user: 10 }, { reason: 'BLACK X test', guarded: true }), { status: 502 });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].options.headers['x-audit-log-reason'], 'BLACK%20X%20test');
  assert.deepEqual(JSON.parse(result.calls[0].options.body), { rate_limit_per_user: 10 });
  assert.deepEqual(await result.api.getChannelAudits(GUILD_ID, '0'), { audit_log_entries: [] });
  assert.match(result.calls[1].url, /\/audit-logs\?action_type=11&limit=100&after=0$/);
  assert.deepEqual(result.waits, []);
  const limited = stub(jsonResponse(429, { retry_after: 10, global: true }));
  await assert.rejects(limited.api.deleteChannel(channelId), { status: 429 });
  await assert.rejects(limited.api.deleteChannel(channelId), { status: 429 });
  assert.equal(limited.calls.length, 1);
  assert.deepEqual(limited.waits, []);
});

test('guarded setup role and channel creates do not replay a POST after an ambiguous result', async () => {
  const opts = { guarded: true, reason: 'BLACK X approved support setup' };
  for (const [operation, suffix] of [['createRole', 'roles'], ['createChannel', 'channels']]) {
    const { api, calls, waits } = stub(jsonResponse(502, {}));
    await assert.rejects(api[operation](GUILD_ID, { name: 'BLACK X Support' }, undefined, opts), { status: 502 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://discord.com/api/v10/guilds/${GUILD_ID}/${suffix}`);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['x-audit-log-reason'], 'BLACK%20X%20approved%20support%20setup');
    assert.deepEqual(waits, []);
  }
});
