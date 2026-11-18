import { ROLE_KEYS, ROLES, isSnowflake } from '../lib/catalog.js';
import { AppError, DiscordApiError, roleHierarchyError } from '../lib/errors.js';
import { PERMISSION, canManageRole, guildPermissions, hasPermission, highestRole, isTimedOut } from '../discord/permissions.js';
import { MANAGED_ROLE_PERMISSIONS, readRoleState, resolveRoles } from '../discord/state.js';

export function validateDiscordId(discordId) {
  if (!isSnowflake(discordId)) throw new AppError('INVALID_DISCORD_ID', 'معرّف عضو ديسكورد غير صالح.');
}

const unknownMember = (error) => error instanceof DiscordApiError && error.status === 404
  && (error.discordCode === undefined || error.discordCode === 10007);
const memberMissing = () => new AppError('MEMBER_NOT_FOUND', 'العضو غير موجود في سيرفر BLACK X.', 404);

export function createRoleService({ api, config, botId }) {
  const { guildId } = config;
  const queues = new Map();

  async function getMember(id) {
    try {
      return await api.getMember(guildId, id);
    } catch (error) {
      if (unknownMember(error)) throw memberMissing();
      throw error;
    }
  }

  async function list(discordId) {
    validateDiscordId(discordId);
    const [member, allRoles] = await Promise.all([getMember(discordId), api.getRoles(guildId)]);
    const available = resolveRoles(allRoles, config);
    const roles = ROLE_KEYS.filter((key) => available[key] && member.roles.includes(available[key].id));
    return { discordId, roles };
  }

  async function mutate(action, discordId, roleKey, actorId) {
    const [member, state, actor] = await Promise.all([
      getMember(discordId), readRoleState(api, guildId, botId), actorId ? getMember(actorId) : undefined,
    ]);
    const role = resolveRoles(state.allRoles, config)[roleKey];
    if (!role) throw new AppError('ROLE_NOT_CONFIGURED', 'رول BLACK X غير موجود. اطلب من المالك تشغيل /setup.', 502);
    if (!canManageRole(state.botRole, role, guildId)) throw roleHierarchyError();
    if (!hasPermission(state.botPermissions, PERMISSION.ManageRoles)) {
      throw new AppError('BOT_MISSING_PERMISSIONS', 'البوت يحتاج صلاحية Manage Roles.', 403);
    }
    if (actor) {
      const bits = guildPermissions(state.allRoles, guildId, actor.roles);
      if (isTimedOut(actor) || !hasPermission(bits, PERMISSION.ManageRoles)
        || !canManageRole(highestRole(state.allRoles, guildId, actor.roles), role, guildId)) {
        throw new AppError('MODERATOR_HIERARCHY', 'تحتاج Manage Roles ورولًا أعلى من الرول المطلوب.', 403);
      }
    }
    if (action === 'grant' && role.permissions !== MANAGED_ROLE_PERMISSIONS) {
      throw new AppError('UNSAFE_ROLE', 'صلاحيات الرول ليست View Channel فقط. شغّل /setup لتصحيحها أولًا.', 403);
    }

    const changed = member.roles.includes(role.id) !== (action === 'grant');
    if (changed) {
      try {
        if (action === 'grant') await api.grantRole(guildId, discordId, role.id);
        else await api.revokeRole(guildId, discordId, role.id);
      } catch (error) {
        if (unknownMember(error)) throw memberMissing();
        throw error;
      }
    }
    return { discordId, roleKey, changed };
  }

  async function change(action, discordId, roleKey, { actorId } = {}) {
    validateDiscordId(discordId);
    if (typeof roleKey !== 'string' || !Object.hasOwn(ROLES, roleKey) || !['grant', 'revoke'].includes(action)) {
      throw new AppError('INVALID_ROLE_REQUEST', 'استخدم roleKey صالحًا: vip_monarch أو vip_basic أو creator.');
    }
    // Serialize writes to the same member/role so the existence check and the mutation agree.
    const key = `${discordId}:${roleKey}`;
    const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => mutate(action, discordId, roleKey, actorId));
    queues.set(key, pending);
    try {
      return await pending;
    } finally {
      if (queues.get(key) === pending) queues.delete(key);
    }
  }

  return { list, change };
}
