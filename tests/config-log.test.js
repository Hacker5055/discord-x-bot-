import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/lib/env.js';
import { createLogger } from '../src/lib/log.js';
import { FAKE_BOT_TOKEN, FAKE_API_SECRET, FAKE_WEBHOOK_TOKEN, GUILD_ID, OTHER_GUILD_ID, fixtureEnv } from './fixtures/discord.js';

test('env validates single-guild configuration and retains only IDs from webhook URLs', () => {
  const env = fixtureEnv();
  const config = readConfig({ ...env, DISCORD_WEBHOOK_UPDATES: `https://discord.com/api/webhooks/${GUILD_ID}/${FAKE_WEBHOOK_TOKEN}` });
  assert.equal(config.port, 8080);
  assert.equal(config.webhookIds.updates, GUILD_ID);
  assert.ok(!JSON.stringify(config).includes(FAKE_WEBHOOK_TOKEN));
  assert.equal(readConfig({ ...env, DISCORD_GUILD_ID: '', ALLOWED_GUILD_ID: GUILD_ID }).guildId, GUILD_ID);
  assert.throws(() => readConfig({ ...env, ALLOWED_GUILD_ID: OTHER_GUILD_ID }), /ALLOWED_GUILD_ID/);
  assert.throws(() => readConfig({ ...env, PORT: '65536' }), /PORT/);
  assert.throws(() => readConfig({ ...env, DISCORD_CHANNEL_UPDATES: GUILD_ID, DISCORD_CHANNEL_SUPPORT: GUILD_ID }), /DISCORD_CHANNEL_SUPPORT/);
  assert.throws(() => readConfig({ ...env, DISCORD_WEBHOOK_UPDATES: `https://example.com/${FAKE_WEBHOOK_TOKEN}` }),
    (error) => /DISCORD_WEBHOOK_UPDATES/.test(error.message) && !error.message.includes(FAKE_WEBHOOK_TOKEN));
});

test('logger masks known secrets and Discord webhook URLs, and never serializes Error or header objects', () => {
  const logs = [];
  const log = createLogger({ write: (line) => logs.push(line), secrets: [FAKE_BOT_TOKEN, FAKE_API_SECRET] });
  log.error('test_log', {
    message: `${FAKE_BOT_TOKEN} ${FAKE_API_SECRET} https://discord.com/api/webhooks/${GUILD_ID}/${FAKE_WEBHOOK_TOKEN}`,
    headers: { authorization: FAKE_BOT_TOKEN }, error: new Error(FAKE_BOT_TOKEN), status: 502,
  });
  assert.deepEqual(Object.keys(JSON.parse(logs[0])).sort(), ['event', 'level', 'message', 'status', 'timestamp']);
  for (const marker of [FAKE_BOT_TOKEN, FAKE_API_SECRET, FAKE_WEBHOOK_TOKEN]) assert.ok(!logs[0].includes(marker));
});

test('invalid startup configuration exits with safe JSON, never credentials or a stack trace', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'bx-config-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const child = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8',
    env: { DISCORD_BOT_TOKEN: FAKE_BOT_TOKEN, BOT_API_SECRET: FAKE_API_SECRET, DISCORD_GUILD_ID: FAKE_WEBHOOK_TOKEN }, timeout: 5000 });
  assert.equal(child.status, 1);
  assert.equal(child.stderr, '');
  const record = JSON.parse(child.stdout);
  assert.equal(record.code, 'INVALID_CONFIG');
  assert.match(record.message, /DISCORD_GUILD_ID/);
  for (const marker of [FAKE_BOT_TOKEN, FAKE_API_SECRET, FAKE_WEBHOOK_TOKEN]) assert.ok(!child.stdout.includes(marker));
});
