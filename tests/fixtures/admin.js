import { ChannelType as C, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { createAdministration } from '../../src/admin/index.js';
import { createCatalogMonitor } from '../../src/admin/catalog-status.js';
import { createInteractionHandler } from '../../src/bot.js';
import { createAnimeService, SITE_ORIGIN } from '../../src/community/anime.js';
import { createMemoryStore } from '../../src/community/store.js';
import { readConfig } from '../../src/lib/env.js';
import { createLogger } from '../../src/lib/log.js';
import { provisionGuild } from '../../src/provisioning.js';
import { createRoleService } from '../../src/roles/sync.js';
import { BOT_ID, BOT_ROLE_ID, GUILD_ID, MOD_ID, MemoryDiscord, OWNER_ID, fixtureEnv } from './discord.js';

export const REVIEWER = '100000000000000011';
export const STRANGER = '100000000000000012';
export const DIM = '100000000000000013';
export const ANIME = { id: 'demo-1', title: 'Demo Anime', url: `${SITE_ORIGIN}/anime/demo`, episodes: 12, genres: ['mystery'] };

export async function adminFixture({ voice = false, automod = false, setup = false } = {}) {
  const api = new MemoryDiscord();
  const store = createMemoryStore();
  const config = readConfig({ ...fixtureEnv(), ...(voice ? { BX_ADMIN_VOICE: '1' } : {}), ...(automod ? { BX_ADMIN_AUTOMOD: '1' } : {}) });
  const logs = [];
  const log = createLogger({ write: (value) => logs.push(value) });
  const clock = { at: Date.parse('2027-01-01T10:00:00Z') };
  const now = () => clock.at;
  api.now = now;
  const context = { api, store, config, log, botId: BOT_ID, now };
  const catalogMonitor = createCatalogMonitor();
  const roles = createRoleService(context);
  const anime = createAnimeService({ store, secrets: [config.botToken, config.apiSecret], now });
  const restart = () => createAdministration({ ...context, roles, catalogMonitor });
  const admin = restart();
  const invoke = createInteractionHandler({ ...context, roles, admin, community: { store, anime, now } });
  const everyone = api.roles[0];
  everyone.permissions = String(P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.Connect | P.UseApplicationCommands);
  const botRole = api.roles.find((r) => r.id === BOT_ROLE_ID);
  botRole.permissions = String(BigInt(botRole.permissions) | P.EmbedLinks | P.ReadMessageHistory | P.ViewAuditLog | P.MoveMembers | P.Connect | P.ManageGuild);
  for (const [id, member] of api.members) Object.assign(member, { user: { id, bot: id === BOT_ID } });
  for (const id of [REVIEWER, STRANGER, DIM]) api.members.set(id, { roles: [], user: { id, bot: false } });
  if (setup) await provisionGuild(context);
  const chan = (type, name, options = {}) => api.createChannel(GUILD_ID, { type, name, ...options });
  const publicRoom = await chan(C.GuildText, 'bot-actions');
  const staffRoom = await chan(C.GuildText, 'staff');
  const role = async (name, permissions = 0n, users = []) => {
    const role = await api.createRole(GUILD_ID, { name, permissions: String(permissions) });
    for (const id of users) api.members.get(id).roles.push(role.id);
    return role;
  };
  const make = ({ by = OWNER_ID, channel = publicRoom, command, action, fields = {}, customId, messageId, ownerId = api.ownerId, guildId = GUILD_ID } = {}) => {
    const replies = [];
    const value = (k) => fields[k] ?? null;
    return {
      replies, id: api.nextId(), guildId, user: { id: by, bot: by === BOT_ID }, guild: { ownerId }, channelId: channel?.id,
      channel: { guildId, type: channel?.type, id: channel?.id }, appPermissions: new PermissionsBitField(BigInt(botRole.permissions)),
      memberPermissions: new PermissionsBitField(by === OWNER_ID ? P.ManageGuild : 0n),
      isChatInputCommand: () => !customId, isButton: () => Boolean(customId), customId, message: messageId && { id: messageId },
      commandName: command, options: { getSubcommand: () => action, getString: value, getChannel: value,
        getBoolean: value, getRole: value, getUser: value, getInteger: value, getFocused: () => fields.focused },
      async deferReply(payload) { this.deferred = true; replies.push(['defer', payload]); },
      async deferUpdate() { this.deferred = true; replies.push(['update']); },
      async reply(payload) { this.replied = true; replies.push(['reply', payload]); },
      async editReply(payload) { this.replied = true; replies.push(['edit', payload]); },
      async followUp(payload) { replies.push(['followUp', payload]); },
    };
  };
  const enable = () => admin.config.enable(make(), { enabled: true });
  const room = (purpose, channel) => admin.config.room(make(), { purpose, channel });
  const team = async (team, { channel = staffRoom, users = [MOD_ID], flags = 0n, withRole } = {}) => {
    const teamRole = withRole ?? await role(team, flags, users);
    await admin.config.team(make(), { team, role: teamRole, channel });
    return teamRole;
  };
  return { ...context, clock, logs, roles, anime, catalogMonitor, admin, restart, invoke, publicRoom, staffRoom, chan, role, make, enable, room, team };
}

export const user = (id) => ({ id, bot: false });
export const asText = (value) => JSON.stringify(value);
export const own = (id, include = 0n, exclude = 0n) => ({ id, type: 1, allow: String(include), deny: String(exclude) });
export const group = (id, include = 0n, exclude = 0n) => ({ ...own(id, include, exclude), type: 0 });
