import assert from 'node:assert/strict';
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
export const FAKE_API_SECRET = 'mock-api-credential-not-for-production';
export const FAKE_WEBHOOK_TOKEN = 'mock-webhook-credential-not-for-discord';
export const INVITE_BITS = '805309456';
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
  channels = [];
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
    return { id: GUILD_ID, owner_id: OWNER_ID, approximate_member_count: this.members.size };
  }

  async getMember(guildId, userId) {
    this.check(guildId);
    this.add('getMember', 'GET', { userId });
    if (!this.members.has(userId)) throw new DiscordApiError(404, 10007);
    return this.copy(this.members.get(userId));
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

  async updateChannel(channelId, data) {
    this.add('updateChannel', 'PATCH', { channelId, data });
    return this.copy(Object.assign(this.channels.find(({ id }) => id === channelId), data));
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

  async updateWebhook(webhookId, data) {
    this.add('updateWebhook', 'PATCH', { webhookId, data });
    return this.copy(Object.assign(this.hooks.find(({ id }) => id === webhookId), data));
  }

  async deleteWebhook(webhookId) {
    this.add('deleteWebhook', 'DELETE', { webhookId });
    this.hooks = this.hooks.filter((hook) => hook.id !== webhookId);
  }

  async createMessage(channelId, data) {
    this.add('createMessage', 'POST', { channelId });
    const message = { channelId, data, id: this.nextId() };
    this.messages.push(this.copy(message));
    return this.copy(message);
  }

  async editMessage(channelId, messageId, data) {
    this.add('editMessage', 'PATCH', { channelId, messageId });
    assert.ok(this.messages.some(({ id, channelId: channel }) => channel === channelId && id === messageId));
    this.edits.push(this.copy({ channelId, messageId, data }));
    return { id: messageId };
  }

  async createDm(userId) {
    this.add('createDm', 'POST', { userId });
    if (!this.dms.has(userId)) this.dms.set(userId, this.nextId());
    return { id: this.dms.get(userId) };
  }

  async registerGuildCommands(applicationId, guildId, commands) {
    this.check(guildId);
    this.add('registerGuildCommands', 'PUT', { applicationId, guildId, commands });
    return this.copy(commands);
  }
}
