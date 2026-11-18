export const PERMISSION = Object.freeze({
  Administrator: 8n,
  ManageChannels: 16n,
  ManageGuild: 32n,
  ViewChannel: 1024n,
  SendMessages: 2048n,
  ManageMessages: 8192n,
  EmbedLinks: 16384n,
  ManageRoles: 268435456n,
  ManageWebhooks: 536870912n,
});

export function hasPermission(bits, flag) {
  return (bits & PERMISSION.Administrator) !== 0n || (bits & flag) === flag;
}

export function guildPermissions(roles, guildId, memberRoleIds) {
  const ids = new Set(memberRoleIds);
  ids.add(guildId); // @everyone is not included in a member's role IDs.
  return roles.reduce((bits, role) => ids.has(role.id) ? bits | BigInt(role.permissions) : bits, 0n);
}

export const isTimedOut = (member) => Date.parse(member.communication_disabled_until) > Date.now();

export function channelPermissions(bits, channel, guildId, userId, memberRoleIds) {
  if (hasPermission(bits, PERMISSION.Administrator)) return bits;
  const overwrites = channel.permission_overwrites ?? [];
  const apply = (value, allow = 0n, deny = 0n) => (value & ~BigInt(deny)) | BigInt(allow);
  const everyone = overwrites.find(({ id, type }) => type === 0 && id === guildId);
  if (everyone) bits = apply(bits, everyone.allow, everyone.deny);
  const ids = new Set(memberRoleIds);
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || overwrite.id === guildId || !ids.has(overwrite.id)) continue;
    allow |= BigInt(overwrite.allow);
    deny |= BigInt(overwrite.deny);
  }
  bits = apply(bits, allow, deny);
  const member = overwrites.find(({ id, type }) => type === 1 && id === userId);
  return member ? apply(bits, member.allow, member.deny) : bits;
}

// Positive means `a` is higher. At the same raw position, the older snowflake wins.
export function compareRoles(a, b, guildId) {
  if (a.id === b.id) return 0;
  if (a.id === guildId) return -1;
  if (b.id === guildId) return 1;
  return a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? 1 : -1);
}

export function highestRole(roles, guildId, memberRoleIds) {
  const ids = new Set(memberRoleIds);
  ids.add(guildId);
  return roles.filter((role) => ids.has(role.id)).sort((a, b) => compareRoles(b, a, guildId))[0];
}

export const canManageRole = (botRole, role, guildId) => Boolean(botRole && role && !role.managed
  && role.id !== guildId && compareRoles(botRole, role, guildId) > 0);
