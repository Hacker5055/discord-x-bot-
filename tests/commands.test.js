import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Events, MessageFlags, PermissionFlagsBits, PermissionsBitField, Status } from 'discord.js';
import { botHealth, createBot, createInteractionHandler } from '../src/bot.js';
import { registerCommands } from '../src/bootstrap.js';
import { announcementPayload } from '../src/commands/announce.js';
import { ROLES, ROOMS, roomMarker } from '../src/lib/catalog.js';
import { readConfig } from '../src/lib/env.js';
import { DiscordApiError } from '../src/lib/errors.js';
import { createLogger } from '../src/lib/log.js';
import { createProvisioner } from '../src/provisioning.js';
import { createRoleService } from '../src/roles/sync.js';
import { BOT_ID, BOT_ROLE_ID, FAKE_BOT_TOKEN, FAKE_WEBHOOK_TOKEN, GUILD_ID, MEMBER_ID, MOD_ID, MemoryDiscord,
  OTHER_GUILD_ID, OWNER_ID, fixtureEnv } from './fixtures/discord.js';

function fixture() {
  const api = new MemoryDiscord();
  const config = readConfig(fixtureEnv());
  const logs = [];
  const log = createLogger({ write: (line) => logs.push(line), secrets: [FAKE_BOT_TOKEN] });
  const dependencies = { api, config, botId: BOT_ID, log };
  const runSetup = createProvisioner(dependencies);
  const roles = createRoleService(dependencies);
  return { ...dependencies, logs, runSetup, handle: createInteractionHandler({ ...dependencies, runSetup, roles }) };
}

function interaction(commandName, { userId = OWNER_ID, ownerId = OWNER_ID, guildId = GUILD_ID, permissions = 0n, options = {} } = {}) {
  const replies = [];
  return {
    replies, id: '100000000000000099', commandName, discordId: userId, guildId, guild: { ownerId, memberCount: 124 },
    isChatInputCommand: () => true, user: { id: userId }, memberPermissions: new PermissionsBitField(permissions),
    options: { getBoolean: (key) => options[key] ?? null, getString: (key) => options[key] ?? null,
      getSubcommand: () => options.action, getUser: () => ({ id: options.memberId }) },
    async reply(payload) { this.replied = true; replies.push(['reply', payload]); },
    async deferReply(payload) { this.deferred = true; replies.push(['defer', payload]); },
    async editReply(payload) { this.replied = true; replies.push(['edit', payload]); },
    async followUp(payload) { replies.push(['followUp', payload]); },
  };
}

const contentOf = (invocation) => invocation.replies.map(([, { content }]) => content ?? '').join('\n');

test('bootstrap fetches the bot and registers all commands on the configured guild only', async () => {
  const { api, config, log } = fixture();
  assert.equal((await registerCommands({ api, config, log })).id, BOT_ID);
  const [registration] = api.writes;
  assert.equal(registration.operation, 'registerGuildCommands');
  assert.equal(registration.guildId, GUILD_ID);
  assert.equal(registration.applicationId, BOT_ID);
  assert.deepEqual(registration.commands.map(({ name }) => name), [
    'setup', 'announce', 'role', 'status', 'arena', 'party', 'follow', 'recommend', 'adhkar', 'prayer', 'daily', 'ramadan', 'seerah',
  ]);
  assert.equal(registration.commands[0].options[0].name, 'dry_run');
  assert.deepEqual(registration.commands[2].options.map(({ name }) => name), ['grant', 'revoke']);
});

test('bot uses Guilds intent only and refuses other guilds', async () => {
  const { api, config, log, handle } = fixture();
  const client = createBot({ api, config, botId: BOT_ID, log });
  assert.deepEqual(client.options.intents.toArray(), ['Guilds']);
  const left = [];
  const join = (id) => client.emit(Events.GuildCreate, { id, leave: async () => { left.push(id); } });
  join(GUILD_ID);
  join(OTHER_GUILD_ID);
  assert.deepEqual(left, [OTHER_GUILD_ID]);
  await client.destroy();
  const foreign = interaction('setup', { guildId: OTHER_GUILD_ID, permissions: PermissionFlagsBits.ManageGuild });
  await handle(foreign);
  assert.equal(api.operations.length, 0);
  assert.equal(foreign.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.match(contentOf(foreign), /السيرفر|الرسمي/);
});

test('/setup requires the configured, actual Discord owner and its permissions; replies are private', async () => {
  const { api, handle } = fixture();
  for (const invocation of [
    interaction('setup', { userId: MOD_ID, permissions: PermissionFlagsBits.Administrator }),
    interaction('setup', { ownerId: MOD_ID, permissions: PermissionFlagsBits.Administrator }),
    interaction('setup', { userId: MOD_ID, ownerId: MOD_ID, permissions: PermissionFlagsBits.ManageGuild }),
    interaction('setup'),
  ]) {
    await handle(invocation);
    assert.match(contentOf(invocation), /BX_OWNER_DISCORD_ID/);
    assert.equal(invocation.replies[0][1].flags, MessageFlags.Ephemeral);
  }
  assert.equal(api.operations.length, 0);
  const request = interaction('setup', { permissions: PermissionFlagsBits.ManageGuild, options: { dry_run: true } });
  await handle(request);
  assert.match(contentOf(request), /لم أكتب أي تغيير/);
  assert.match(contentOf(request), /```dotenv\nDISCORD_GUILD_ID/);
  assert.deepEqual(api.writes, []);
  assert.ok(!contentOf(request).includes(FAKE_BOT_TOKEN));
});

test('/announce sends a bounded embed and disables every mention even with hostile text', async () => {
  const { api, runSetup, handle } = fixture();
  await runSetup(false);
  const invocation = interaction('announce', { permissions: PermissionFlagsBits.ManageGuild,
    options: { room: 'updates', title: '@everyone <@&100000000000000001>', body: '⚠'.repeat(3799) + '😀'.repeat(200), url: 'https://example.com/test' } });
  await handle(invocation);
  const [message] = api.messages;
  assert.equal(message.channelId, api.channels.find(({ topic }) => topic === roomMarker('updates')).id);
  assert.deepEqual(message.data.allowed_mentions, { parse: [] });
  assert.ok(message.data.embeds[0].description.length <= 3800);
  assert.ok(!/[\uD800-\uDBFF]$/u.test(message.data.embeds[0].description));
  assert.equal(message.data.embeds[0].color, ROOMS.updates.color);
  assert.equal(message.data.embeds[0].url, 'https://example.com/test');
  assert.equal(message.data.enforce_nonce, true);
  assert.equal(invocation.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.match(contentOf(invocation), /نُشر/);
  assert.throws(() => announcementPayload({ room: 'updates', title: 'Test', body: 'Hey', url: 'javascript:void(0)' }), { code: 'INVALID_URL' });
});

test('/announce only allows a non-owner if Discord gives Manage Messages in the destination', async () => {
  const { api, runSetup, handle } = fixture();
  await runSetup(false);
  const options = { room: 'offers', title: 'Test', body: 'announcement' };
  const denied = interaction('announce', { userId: MOD_ID, permissions: PermissionFlagsBits.ManageMessages, options });
  await handle(denied);
  assert.match(contentOf(denied), /Manage Messages/);
  assert.equal(api.messages.length, 0);
  const role = await api.createRole(GUILD_ID, { name: 'Moderator', permissions: '8192' });
  api.members.get(MOD_ID).roles.push(role.id);
  const allowed = interaction('announce', { userId: MOD_ID, permissions: PermissionFlagsBits.ManageMessages, options });
  await handle(allowed);
  assert.equal(api.messages.length, 1);
});

test('/role enforces the Discord moderator’s own hierarchy as well as the bot’s', async () => {
  const { api, runSetup, handle } = fixture();
  await runSetup(false);
  const role = await api.createRole(GUILD_ID, { name: 'Moderator', permissions: String(PermissionFlagsBits.ManageRoles) });
  api.members.get(MOD_ID).roles.push(role.id);
  const options = { action: 'grant', memberId: MEMBER_ID, role: 'vip_monarch' };
  const permissions = PermissionFlagsBits.ManageRoles;
  const denied = interaction('role', { userId: MOD_ID, permissions, options });
  await handle(denied);
  assert.match(contentOf(denied), /رولًا أعلى/);
  assert.deepEqual(api.members.get(MEMBER_ID).roles, []);
  api.roles.find(({ id }) => id === role.id).position = 50;
  await handle(interaction('role', { userId: MOD_ID, permissions, options }));
  assert.deepEqual(api.members.get(MEMBER_ID).roles, [api.roles.find(({ name }) => name === ROLES.vip_monarch.name).id]);
});

test('/status shows actual member count, hierarchy and permission failures without disclosing credentials', async () => {
  const { api, runSetup, handle, logs } = fixture();
  await runSetup(false);
  const updates = api.channels.find(({ topic }) => topic === roomMarker('updates'));
  const botRole = api.roles.find(({ id }) => id === BOT_ROLE_ID);
  botRole.permissions = String(BigInt(botRole.permissions) & ~PermissionFlagsBits.ManageWebhooks);
  api.roles.find(({ name }) => name === ROLES.vip_monarch.name).position = 50;
  const getWebhooks = api.getWebhooks.bind(api);
  api.getWebhooks = async (id) => {
    if (id === updates.id) throw new DiscordApiError(403, 50013);
    return getWebhooks(id);
  };
  const invocation = interaction('status');
  await handle(invocation);
  const content = contentOf(invocation);
  assert.match(content, /الأعضاء: 124/);
  assert.match(content, /أعلى رول للبوت: #\d/);
  assert.match(content, /ManageWebhooks/);
  assert.match(content, /403/);
  assert.match(content, /Server Settings → Roles/);
  assert.ok(!content.includes(FAKE_WEBHOOK_TOKEN));
  api.getGuild = async () => { throw new Error(`never show this ${FAKE_BOT_TOKEN}`); };
  const failure = interaction('status');
  await handle(failure);
  assert.match(contentOf(failure), /خطأ غير متوقّع/);
  assert.ok(!`${contentOf(failure)} ${logs.join('\n')}`.includes(FAKE_BOT_TOKEN));
});

test('health depends on both Gateway readiness and the availability of the one configured guild', () => {
  const guild = { available: true, memberCount: 55, shard: { status: Status.Ready } };
  const guilds = { cache: new Map([[GUILD_ID, guild]]) };
  const client = { guilds, isReady: () => true };
  const bot = { id: BOT_ID, username: 'BLACK X Bot', discriminator: '0012' };
  assert.deepEqual(botHealth(client, bot, GUILD_ID).bot, { id: BOT_ID, tag: 'BLACK X Bot#0012', ready: true });
  assert.equal(botHealth(client, bot, GUILD_ID).guild.memberCount, 55);
  assert.equal(botHealth(client, bot, GUILD_ID).ok, true);
  assert.equal(botHealth(client, bot, OTHER_GUILD_ID).ok, false);
  assert.equal(botHealth({ ...client, isReady: () => false }, bot, GUILD_ID).ok, false);
  guild.shard.status = Status.Connecting;
  assert.equal(botHealth(client, bot, GUILD_ID).bot.ready, false);
});

test('a former owner cannot provision when the fresh Discord snapshot shows a transfer', async () => {
  const { api, handle } = fixture();
  api.getGuild = async () => ({ id: GUILD_ID, owner_id: MOD_ID });
  const invocation = interaction('setup', { permissions: PermissionFlagsBits.ManageGuild });
  await handle(invocation);
  assert.match(contentOf(invocation), /BX_OWNER_DISCORD_ID/);
  assert.deepEqual(api.writes, []);
});

test('/announce refuses accidentally pasted credentials without echoing them', async () => {
  const { api, handle, logs } = fixture();
  for (const body of [FAKE_BOT_TOKEN, `https://discord.com/api/webhooks/${GUILD_ID}/${FAKE_WEBHOOK_TOKEN}`]) {
    const invocation = interaction('announce', { permissions: PermissionFlagsBits.ManageGuild,
      options: { room: 'updates', title: 'Test', body } });
    await handle(invocation);
    assert.match(contentOf(invocation), /احذف التوكنات/);
    assert.ok(!`${contentOf(invocation)} ${logs.join('\n')}`.includes(body));
  }
  assert.deepEqual(api.writes, []);
});
