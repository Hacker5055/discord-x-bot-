import assert from 'node:assert/strict';
import test from 'node:test';
import { hierarchy } from '../src/discord/state.js';
import { readConfig } from '../src/lib/env.js';
import { CATEGORY_NAME, ROLE_KEYS, ROLES, ROOM_KEYS, ROOMS, WEBHOOK_NAME, roleEnv, roomEnv,
  roomMarker, webhookEnv } from '../src/lib/catalog.js';
import { createProvisioner, provisionGuild } from '../src/provisioning.js';
import { BOT_ID, BOT_ROLE_ID, FAKE_WEBHOOK_TOKEN, GUILD_ID, MemoryDiscord, fixtureEnv } from './fixtures/discord.js';

const setup = (api, options = {}) => provisionGuild({ api, config: readConfig(fixtureEnv()), botId: BOT_ID, ...options });
const fromBlock = (block) => Object.fromEntries(block.split('\n').map((line) => line.split('=')));

function verifyCounts(api) {
  assert.equal(api.channels.filter(({ type }) => type === 4).length, 1);
  assert.equal(api.channels.filter(({ type }) => type === 0).length, 4);
  assert.equal(api.roles.filter(({ name }) => ROLE_KEYS.some((key) => ROLES[key].name === name)).length, 3);
  assert.equal(api.hooks.filter(({ name, type }) => type === 1 && name === WEBHOOK_NAME).length, 4);
}

test('first provisioning creates the complete guild and an ID-only env block', async () => {
  const api = new MemoryDiscord();
  const result = await setup(api);
  assert.deepEqual(result.warnings, []);
  verifyCounts(api);
  const env = fromBlock(result.env);
  assert.equal(Object.keys(env).length, 13);
  assert.equal(env.DISCORD_GUILD_ID, GUILD_ID);
  const category = api.channels.find(({ type }) => type === 4);
  assert.equal(category.name, CATEGORY_NAME);
  assert.equal(env.DISCORD_CHANNEL_CATEGORY, category.id);
  for (const key of ROOM_KEYS) {
    const room = api.channels.find(({ topic }) => topic === roomMarker(key));
    assert.equal(room.name, ROOMS[key].name);
    assert.equal(room.parent_id, category.id);
    assert.equal(env[roomEnv(key)], room.id);
    assert.equal(env[webhookEnv(key)], api.hooks.find((hook) => hook.channel_id === room.id).id);
  }
  for (const key of ROLE_KEYS) assert.equal(env[roleEnv(key)], api.roles.find(({ name }) => name === ROLES[key].name).id);
  assert.ok(!JSON.stringify(result).includes(FAKE_WEBHOOK_TOKEN));
  assert.doesNotMatch(result.env, /DISCORD_BOT_TOKEN|https:\/\//);
});

test('second provisioning creates no duplicate and rotates only unpinned BX incoming webhooks', async () => {
  const api = new MemoryDiscord();
  const first = fromBlock((await setup(api)).env);
  const originalRoom = first.DISCORD_CHANNEL_UPDATES;
  const duplicate = await api.createWebhook(originalRoom, { name: WEBHOOK_NAME });
  const unrelated = await api.createWebhook(originalRoom, { name: 'An unrelated integration' });
  const follower = { id: api.nextId(), type: 2, name: WEBHOOK_NAME, channel_id: originalRoom };
  api.hooks.push(follower);
  api.operations = [];

  const second = fromBlock((await setup(api)).env);
  verifyCounts(api);
  assert.ok(api.hooks.some(({ id }) => id === unrelated.id));
  assert.ok(api.hooks.some(({ id }) => id === follower.id));
  assert.ok(!api.hooks.some(({ id }) => id === duplicate.id));
  assert.ok(api.writes.every(({ operation }) => ['deleteWebhook', 'createWebhook'].includes(operation)));
  for (const [key, value] of Object.entries(first)) {
    if (key.startsWith('DISCORD_WEBHOOK_')) assert.notEqual(second[key], value);
    else assert.equal(second[key], value);
  }
});

test('configured webhook references are reused and a pinned repeated setup is write-free', async () => {
  const api = new MemoryDiscord();
  const env = fromBlock((await setup(api)).env);
  const current = api.hooks.find(({ id }) => id === env.DISCORD_WEBHOOK_UPDATES);
  current.name = 'Custom name';
  const duplicate = await api.createWebhook(env.DISCORD_CHANNEL_UPDATES, { name: WEBHOOK_NAME });
  const config = readConfig({ ...fixtureEnv(), ...env,
    DISCORD_WEBHOOK_UPDATES: `https://discord.com/api/webhooks/${current.id}/${FAKE_WEBHOOK_TOKEN}` });
  api.operations = [];
  assert.deepEqual(fromBlock((await setup(api, { config })).env), env);
  assert.equal(current.name, WEBHOOK_NAME);
  assert.ok(!api.hooks.some(({ id }) => id === duplicate.id));
  assert.deepEqual(api.writes.map(({ operation }) => operation), ['deleteWebhook', 'updateWebhook']);
  api.operations = [];
  assert.deepEqual(fromBlock((await setup(api, { config })).env), env);
  assert.deepEqual(api.writes, []);
});

test('read-only rooms deny Send Messages to everyone but allow the bot; open rooms allow sending', async () => {
  const api = new MemoryDiscord();
  await setup(api);
  for (const key of ['updates', 'offers']) {
    const room = api.channels.find(({ topic }) => topic === roomMarker(key));
    assert.deepEqual(room.permission_overwrites, [
      { id: GUILD_ID, type: 0, allow: '1024', deny: '2048' }, { id: BOT_ID, type: 1, allow: '3072', deny: '0' },
    ]);
  }
  for (const key of ['support', 'creators']) {
    const room = api.channels.find(({ topic }) => topic === roomMarker(key));
    assert.deepEqual(room.permission_overwrites, [{ id: GUILD_ID, type: 0, allow: '3072', deny: '0' }]);
  }
});

test('product roles have View Channel only and match the exact colors and flags', async () => {
  const api = new MemoryDiscord();
  await setup(api);
  for (const { name, color } of Object.values(ROLES)) {
    const role = api.roles.find((candidate) => candidate.name === name);
    assert.equal(role.permissions, '1024');
    assert.equal(role.color, color);
    assert.equal(role.hoist, true);
    assert.equal(role.mentionable, false);
  }
});

test('the three roles are adjacent to and immediately below the bot role, without moving the bot itself', async () => {
  const api = new MemoryDiscord();
  await setup(api);
  const roles = hierarchy(api.roles, GUILD_ID);
  const index = roles.findIndex(({ id }) => id === BOT_ROLE_ID);
  const expected = ROLE_KEYS.map((key) => ROLES[key].name);
  assert.deepEqual(roles.slice(index + 1, index + 4).map(({ name }) => name), expected);
  const [{ positions }] = api.writes.filter(({ operation }) => operation === 'reorderRoles');
  assert.deepEqual(positions.map(({ id }) => api.roles.find((role) => role.id === id).name), expected);
  assert.ok(positions.every(({ position }) => position < roles[index].position));
});

test('a low bot role warns and skips reordering instead of halting independent setup tasks', async () => {
  const api = new MemoryDiscord();
  api.roles.push({ id: api.nextId(), name: ROLES.vip_monarch.name, color: 0, position: 10, permissions: '0', managed: false });
  const result = await setup(api);
  assert.match(result.warnings.join('\n'), /Server Settings → Roles/);
  assert.ok(!api.writes.some(({ operation }) => ['reorderRoles', 'updateRole'].includes(operation)));
  verifyCounts(api);
});

test('dry_run plans both a fresh setup and reconciliation with zero mutations', async () => {
  const api = new MemoryDiscord();
  const preview = await setup(api, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.ok(preview.actions.length >= 12);
  assert.deepEqual(api.writes, []);
  assert.equal(api.channels.length, 0);
  await setup(api);
  api.operations = [];
  const second = await setup(api, { dryRun: true });
  assert.match(second.actions.join('\n'), /حذف ويب هوك/);
  assert.deepEqual(api.writes, []);
  verifyCounts(api);
});

test('a room is matched by its topic marker, not by the display name', async () => {
  const api = new MemoryDiscord();
  const decoy = await api.createChannel(GUILD_ID, { type: 0, name: ROOMS.updates.name, topic: ' unrelated ' });
  const correct = await api.createChannel(GUILD_ID, { type: 0, name: 'renamed', topic: `A description\n${roomMarker('updates')}` });
  const env = fromBlock((await setup(api)).env);
  assert.equal(env.DISCORD_CHANNEL_UPDATES, correct.id);
  assert.equal(api.channels.find(({ id }) => id === decoy.id).topic, ' unrelated ');
  assert.equal(api.channels.find(({ id }) => id === correct.id).topic, `${roomMarker('updates')}\nA description`);
  assert.equal(api.channels.find(({ id }) => id === correct.id).name, ROOMS.updates.name);
});

test('configured channel and role IDs take precedence and are repaired in place', async () => {
  const api = new MemoryDiscord();
  const room = await api.createChannel(GUILD_ID, { type: 0, name: 'existing', topic: 'A description' });
  const role = await api.createRole(GUILD_ID, { name: 'my VIP', permissions: '8', color: 0, hoist: false, mentionable: true });
  const config = readConfig({ ...fixtureEnv(), DISCORD_CHANNEL_OFFERS: room.id, DISCORD_ROLE_VIP_BASIC: role.id });
  const env = fromBlock((await setup(api, { config })).env);
  assert.equal(env.DISCORD_CHANNEL_OFFERS, room.id);
  assert.equal(env.DISCORD_ROLE_VIP_BASIC, role.id);
  assert.equal(api.roles.find(({ id }) => id === role.id).permissions, '1024');
  verifyCounts(api);
});

test('a second concurrent setup is rejected rather than creating duplicate resources', async () => {
  const api = new MemoryDiscord();
  const runSetup = createProvisioner({ api, config: readConfig(fixtureEnv()), botId: BOT_ID });
  const first = runSetup(false);
  await assert.rejects(runSetup(false), { code: 'SETUP_BUSY' });
  await first;
  verifyCounts(api);
});
