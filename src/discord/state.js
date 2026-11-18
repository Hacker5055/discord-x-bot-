import { CATEGORY_NAME, ROLE_KEYS, ROLES, ROOM_KEYS, WEBHOOK_NAME, roomMarker } from '../lib/catalog.js';
import { PERMISSION, canManageRole, compareRoles, guildPermissions, highestRole } from './permissions.js';

const byId = (a, b) => a.id === b.id ? 0 : BigInt(a.id) < BigInt(b.id) ? -1 : 1;

function pickResources(keys, resources, refs, matches, label, warnings) {
  const selected = {};
  const reserved = new Set();
  // Reserve explicit IDs before marker/name-based matching can claim them.
  for (const key of keys) {
    if (!refs[key]) continue;
    const found = resources.find(({ id }) => id === refs[key]);
    if (found) {
      selected[key] = found;
      reserved.add(found.id);
    } else {
      warnings.push(`المعرّف المضبوط لـ ${label} ${key} غير موجود أو من نوع غير مناسب في السيرفر.`);
    }
  }
  for (const key of keys) {
    if (selected[key]) continue;
    const candidates = resources.filter((item) => !reserved.has(item.id) && matches(item, key)).sort(byId);
    if (candidates.length > 1) warnings.push(`وجدت أكثر من مورد لـ ${label} ${key}؛ اخترت الأقدم دون حذف البقية.`);
    if (candidates.length) {
      selected[key] = candidates[0];
      reserved.add(candidates[0].id);
    }
  }
  return selected;
}

export function resolveRooms(channels, config, warnings = []) {
  const categories = channels.filter(({ type }) => type === 4);
  const { category } = pickResources(['category'], categories, { category: config.categoryId },
    (channel) => channel.name === CATEGORY_NAME, 'كاتيجوري', warnings);
  const rooms = pickResources(ROOM_KEYS, channels.filter(({ type }) => type === 0), config.channelIds,
    (channel, key) => channel.topic?.includes(roomMarker(key)), 'روم', warnings);
  return { category, rooms };
}

export function resolveRoles(roles, config, warnings = []) {
  return pickResources(ROLE_KEYS, roles.filter((role) => role.id !== config.guildId && !role.managed), config.roleIds,
    (role, key) => role.name === ROLES[key].name, 'رول', warnings);
}

export async function readRoleState(api, guildId, botId) {
  const [allRoles, botMember] = await Promise.all([api.getRoles(guildId), api.getMember(guildId, botId)]);
  return {
    allRoles, botMember,
    botRole: highestRole(allRoles, guildId, botMember.roles),
    botPermissions: guildPermissions(allRoles, guildId, botMember.roles),
  };
}

export async function readGuildState(api, guildId, botId) {
  const [guild, channels, roleState] = await Promise.all([
    api.getGuild(guildId), api.getChannels(guildId), readRoleState(api, guildId, botId),
  ]);
  return { guild, channels, ...roleState };
}

export function hierarchy(roles, guildId) {
  return [...roles].sort((a, b) => compareRoles(b, a, guildId));
}

export function targetRoleOrder({ allRoles, botRole }, resolved, guildId) {
  const targets = ROLE_KEYS.map((key) => resolved[key]);
  if (!botRole || botRole.id === guildId || targets.some((role) => role && !canManageRole(botRole, role, guildId))) {
    return { blocked: true, positions: [] };
  }
  if (targets.some((role) => !role)) return { incomplete: true, positions: [] };

  const ordered = hierarchy(allRoles, guildId);
  const below = ordered.findIndex(({ id }) => id === botRole.id) + 1;
  if (targets.every((role, index) => ordered[below + index]?.id === role.id)) return { positions: [] };
  // Only product roles are sent, never the bot's own role or any unrelated role.
  if (botRole.position <= targets.length) return { blocked: true, positions: [] };
  return { positions: targets.map(({ id }, index) => ({ id, position: botRole.position - index - 1 })) };
}

export function planWebhooks(hooks, channelId, configuredId) {
  const incoming = hooks.filter((hook) => hook.type === 1 && hook.channel_id === channelId);
  const keep = incoming.find(({ id }) => id === configuredId);
  const named = incoming.filter(({ name }) => name === WEBHOOK_NAME);
  return {
    keep, named, remove: named.filter(({ id }) => id !== keep?.id),
    stale: Boolean(configuredId && !keep),
  };
}

export const MANAGED_ROLE_PERMISSIONS = String(PERMISSION.ViewChannel);
