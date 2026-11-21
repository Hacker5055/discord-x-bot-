import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { compareRoles } from '../../src/discord/permissions.js';
import { DiscordApiError } from '../../src/lib/errors.js';

export const GUILD_ID = '100000000000000000';
export const BOT_ID = '100000000000000001';
export const OWNER_ID = '100000000000000002';
export const MEMBER_ID = '100000000000000003';
export const BOT_ROLE_ID = '100000000000000004';
export const MOD_ID = '100000000000000005';
export const OTHER_GUILD_ID = '100000000000000006';
export const MISSING_MEMBER_ID = '100000000000000007';
export const FAKE_BOT_TOKEN = 'mock-bot-credential-not-for-discord';
export const FAKE_API_SECRET = 'mock-api-credential-not-for-production-0123456789';
export const FAKE_WEBHOOK_TOKEN = 'mock-webhook-credential-not-for-discord';
export const INVITE_BITS = '805391376'; // Standard BLACK X permissions plus optional Manage Webhooks.
const BASE_ID = 100000000000000100n;

export const fixtureEnv = () => ({ DISCORD_GUILD_ID: GUILD_ID, BX_OWNER_DISCORD_ID: OWNER_ID,
  DISCORD_BOT_TOKEN: FAKE_BOT_TOKEN, BOT_API_SECRET: FAKE_API_SECRET });

export class MemoryDiscord {
  sequence = BASE_ID;
  operations = [];
  roles = [
    { id: GUILD_ID, name: '@everyone', position: 0, permissions: '16384', managed: false },
    { id: BOT_ROLE_ID, name: 'BLACK X Bot', position: 2, permissions: INVITE_BITS, managed: true,
      tags: { bot_id: BOT_ID } },
    { id: '100000000000000008', name: 'An unrelated lower role', position: 1, permissions: '0', managed: false },
    { id: '100000000000000009', name: 'An unrelated higher role', position: 3, permissions: '0', managed: false },
  ];
  ownerId = OWNER_ID;
  features = [];
  onboarding = { guild_id: GUILD_ID, enabled: false, default_channel_ids: [], prompts: [], mode: 0 };
  channels = [];
  threads = [];
  channelAudits = [];
  voiceStates = new Map();
  now = Date.now;
  hooks = [];
  messages = [];
  edits = [];
  dms = new Map();
  members = new Map([[BOT_ID, { roles: [BOT_ROLE_ID] }], [OWNER_ID, { roles: [] }],
    [MEMBER_ID, { roles: [] }], [MOD_ID, { roles: [] }]]);

  nextId() { return String(this.sequence++); }
  copy(value) { return structuredClone(value); }
  add(operation, method, fields) { this.operations.push(this.copy({ operation, method, ...fields })); }
  check(guildId) { assert.equal(guildId, GUILD_ID); }
  get writes() { return this.operations.filter(({ method }) => method !== 'GET'); }

  async getCurrentUser() { this.add('getCurrentUser', 'GET'); return { id: BOT_ID, username: 'BLACK X Bot', bot: true }; }
  async getGuild(guildId) {
    this.check(guildId);
    this.add('getGuild', 'GET');
    return { id: GUILD_ID, owner_id: this.ownerId, approximate_member_count: this.members.size, features: [...this.features] };
  }

  async getOnboarding(guildId) {
    this.check(guildId);
    this.add('getOnboarding', 'GET');
    return this.copy(this.onboarding);
  }

  async getMember(guildId, userId) {
    this.check(guildId);
    this.add('getMember', 'GET', { userId });
    if (!this.members.has(userId)) throw new DiscordApiError(404, 10007);
    return this.copy(this.members.get(userId));
  }

  async listGuildMembers(guildId, { limit = 1000, after } = {}) {
    this.check(guildId);
    this.add('listGuildMembers', 'GET', { limit, after });
    return [...this.members.entries()].sort(([a], [b]) => BigInt(a) < BigInt(b) ? -1 : 1)
      .filter(([id]) => !after || BigInt(id) > BigInt(after)).slice(0, limit)
      .map(([id, member]) => this.copy({ user: { id, bot: id === BOT_ID }, ...member }));
  }

  async getRoles(guildId) { this.check(guildId); this.add('getRoles', 'GET'); return this.copy(this.roles); }
  async createRole(guildId, data) {
    this.check(guildId);
    this.add('createRole', 'POST', { data });
    for (const role of this.roles) if (role.position > 0) role.position += 1;
    const created = { id: this.nextId(), position: 1, managed: false, ...data };
    this.roles.push(created);
    return this.copy(created);
  }

  async updateRole(guildId, roleId, data) {
    this.check(guildId);
    this.add('updateRole', 'PATCH', { roleId, data });
    return this.copy(Object.assign(this.roles.find(({ id }) => id === roleId), data));
  }

  async reorderRoles(guildId, positions) {
    this.check(guildId);
    this.add('reorderRoles', 'PATCH', { positions });
    const moved = new Set(positions.map(({ id }) => id));
    const sorted = this.roles.filter(({ id }) => !moved.has(id)).sort((a, b) => compareRoles(a, b, guildId));
    for (const { id, position } of [...positions].sort((a, b) => a.position - b.position)) {
      sorted.splice(position, 0, this.roles.find((role) => role.id === id));
    }
    sorted.forEach((role, position) => { role.position = position; });
    return this.copy(this.roles);
  }

  async grantRole(guildId, userId, roleId) {
    this.check(guildId);
    this.add('grantRole', 'PUT', { userId, roleId });
    const member = this.members.get(userId);
    if (!member.roles.includes(roleId)) member.roles.push(roleId);
  }

  async revokeRole(guildId, userId, roleId) {
    this.check(guildId);
    this.add('revokeRole', 'DELETE', { userId, roleId });
    const member = this.members.get(userId);
    member.roles = member.roles.filter((id) => id !== roleId);
  }

  async getChannels(guildId) { this.check(guildId); this.add('getChannels', 'GET'); return this.copy(this.channels); }
  async createChannel(guildId, data) {
    this.check(guildId);
    this.add('createChannel', 'POST', { data });
    const channel = { id: this.nextId(), guild_id: guildId, permission_overwrites: [], ...this.copy(data) };
    this.channels.push(channel);
    return this.copy(channel);
  }

  channel(channelId) {
    const channel = [...this.channels, ...this.threads].find(({ id }) => id === channelId);
    if (!channel) throw new DiscordApiError(404, 10003);
    return channel;
  }

  async getChannel(channelId) {
    this.add('getChannel', 'GET', { channelId });
    return this.copy(this.channel(channelId));
  }

  async updateChannel(channelId, data, options) {
    this.add('updateChannel', 'PATCH', { channelId, data });
    const channel = this.channel(channelId);
    if (channel.type === ChannelType.GuildCategory && Object.hasOwn(data, 'permission_overwrites')) {
      const canonical = (rows) => JSON.stringify(rows.map((entry) => [entry.id, entry.type, entry.allow, entry.deny]).sort());
      const before = canonical(channel.permission_overwrites);
      for (const child of this.channels.filter((ch) => ch.parent_id === channelId && canonical(ch.permission_overwrites) === before)) {
        child.permission_overwrites = this.copy(data.permission_overwrites);
      }
    }
    if (Object.hasOwn(data, 'rate_limit_per_user')) this.offsetSlowMode(channelId, data.rate_limit_per_user, BOT_ID, options?.reason);
    return this.copy(Object.assign(channel, data));
  }

  offsetSlowMode(channelId, value, actor, reason) {
    const channel = this.channel(channelId);
    const id = String((BigInt(this.now() - 1420070400000) << 22n) + BigInt(this.channelAudits.length + 1));
    this.channelAudits.push({ id, target_id: channelId, action_type: 11, user_id: actor, reason,
      changes: [{ key: 'rate_limit_per_user', old_value: channel.rate_limit_per_user ?? 0, new_value: value }] });
    channel.rate_limit_per_user = value;
  }

  async getChannelAudits(guildId, after) {
    this.check(guildId);
    this.add('getChannelAudits', 'GET', { after });
    return { audit_log_entries: this.copy(this.channelAudits.filter(({ id }) => BigInt(id) > BigInt(after)).slice(0, 100)) };
  }

  async deleteChannel(channelId) {
    this.add('deleteChannel', 'DELETE', { channelId });
    const channel = this.channel(channelId);
    this.channels = this.channels.filter(({ id }) => id !== channelId);
    return this.copy(channel);
  }

  async putOverwrite(channelId, userId, data) {
    this.add('putOverwrite', 'PUT', { channelId, userId, data });
    const overwrites = this.channel(channelId).permission_overwrites;
    const index = overwrites.findIndex(({ id }) => id === userId);
    if (index < 0) overwrites.push(this.copy({ id: userId, ...data }));
    else overwrites[index] = this.copy({ id: userId, ...data });
  }

  async deleteOverwrite(channelId, userId) {
    this.add('deleteOverwrite', 'DELETE', { channelId, userId });
    const channel = this.channel(channelId);
    channel.permission_overwrites = channel.permission_overwrites.filter(({ id }) => id !== userId);
  }

  async moveMember(guildId, userId, channelId) {
    this.check(guildId);
    this.add('moveMember', 'PATCH', { userId, channelId });
    this.voiceStates.set(userId, { channelId });
  }

  async getActiveThreads(guildId) {
    this.check(guildId);
    this.add('getActiveThreads', 'GET');
    return { threads: this.copy(this.threads.filter((t) => !t.thread_metadata?.archived)) };
  }

  async createForumPost(channelId, data) {
    this.add('createForumPost', 'POST', { channelId, data });
    const thread = { id: this.nextId(), guild_id: GUILD_ID, owner_id: BOT_ID, parent_id: channelId, type: ChannelType.PublicThread, ...this.copy(data) };
    this.threads.push(thread);
    return this.copy(thread);
  }

  async getWebhooks(channelId) {
    this.add('getWebhooks', 'GET', { channelId });
    return this.copy(this.hooks.filter((hook) => hook.channel_id === channelId));
  }

  async createWebhook(channelId, { name }) {
    this.add('createWebhook', 'POST', { channelId, name });
    const hook = { id: this.nextId(), type: 1, channel_id: channelId, name, token: FAKE_WEBHOOK_TOKEN };
    this.hooks.push(hook);
    return this.copy(hook);
  }

  async createMessage(channelId, data) {
    this.add('createMessage', 'POST', { channelId });
    const existing = data.enforce_nonce && this.messages.find((entry) => entry.channelId === channelId && entry.data.nonce === data.nonce);
    if (existing) return this.copy(existing);
    const message = { channelId, data, id: this.nextId() };
    this.messages.push(this.copy(message));
    return this.copy(message);
  }

  async getMessage(channelId, messageId) {
    this.add('getMessage', 'GET', { channelId, messageId });
    const original = this.messages.find(({ id, channelId: channel }) => channel === channelId && id === messageId);
    if (!original) throw new DiscordApiError(404, 10008);
    const edit = this.edits.findLast((entry) => entry.channelId === channelId && entry.messageId === messageId);
    return this.copy({ ...original.data, ...edit?.data, id: messageId, channel_id: channelId, author: { id: BOT_ID } });
  }

  async editMessage(channelId, messageId, data) {
    this.add('editMessage', 'PATCH', { channelId, messageId });
    if (!this.messages.some(({ id, channelId: channel }) => channel === channelId && id === messageId)) throw new DiscordApiError(404, 10008);
    this.edits.push(this.copy({ channelId, messageId, data }));
    return { id: messageId };
  }

  async createDm(userId) {
    this.add('createDm', 'POST', { userId });
    if (!this.dms.has(userId)) this.dms.set(userId, this.nextId());
    return { id: this.dms.get(userId), type: ChannelType.DM, recipients: [{ id: userId }] };
  }

  async registerGuildCommands(applicationId, guildId, commands) {
    this.check(guildId);
    this.add('registerGuildCommands', 'PUT', { applicationId, guildId, commands });
    return this.copy(commands);
  }
  }
