import { ROLE_KEYS, ROLES, ROOM_KEYS, ROOMS, webhookEnv } from './lib/catalog.js';
import { describeError } from './lib/errors.js';
import { PERMISSION, channelPermissions, hasPermission } from './discord/permissions.js';
import { hierarchy, planWebhooks, readGuildState, resolveRoles, resolveRooms, targetRoleOrder } from './discord/state.js';
import { roleNeedsUpdate, roleSettings } from './provisioning.js';

const missing = (bits, keys) => keys.filter((key) => !hasPermission(bits, PERMISSION[key]));
const GUILD_PERMISSIONS = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory', 'ManageChannels', 'ManageRoles'];
const CHANNEL_PERMISSIONS = ['ViewChannel', 'SendMessages', 'EmbedLinks'];

export async function guildStatus({ api, config, botId, gatewayMemberCount }) {
  const { guildId } = config;
  const state = await readGuildState(api, guildId, botId);
  const warnings = [];
  const { category, rooms } = resolveRooms(state.channels, config, warnings);
  const roles = resolveRoles(state.allRoles, config, warnings);
  const order = targetRoleOrder(state, roles, guildId);
  const rank = hierarchy(state.allRoles, guildId).findIndex(({ id }) => id === state.botRole?.id) + 1;
  const count = Number.isInteger(gatewayMemberCount) ? `${gatewayMemberCount}`
    : Number.isInteger(state.guild.approximate_member_count) ? `${state.guild.approximate_member_count} (تقريبي)` : 'غير متاح';
  const missingGuild = missing(state.botPermissions, GUILD_PERMISSIONS);

  const roomLines = await Promise.all(ROOM_KEYS.map(async (key) => {
    const room = rooms[key];
    if (!room) return `• ${ROOMS[key].name}: غير موجود؛ الويب هوك غير متاح.`;
    const perms = channelPermissions(state.botPermissions, room, guildId, botId, state.botMember.roles);
    const missingChannel = missing(perms, CHANNEL_PERMISSIONS);
    let hookStatus;
    try {
      const plan = planWebhooks(await api.getWebhooks(room.id), room.id, config.webhookIds[key]);
      hookStatus = plan.ambiguous ? `أكتر من ويب هوك؛ حدّد المعتمد في ${webhookEnv(key)}`
        : plan.selected ? 'ويب هوك موجود' : 'ويب هوك غير موجود';
      if (plan.stale) hookStatus += '؛ المعرّف المضبوط غير متاح';
    } catch (error) {
      hookStatus = `تعذّر فحص الويب هوك: ${describeError(error)}`;
    }
    return `• ${ROOMS[key].name}: موجود؛ ${hookStatus}.`
      + (missingChannel.length ? ` ناقص للبوت في الروم: ${missingChannel.join('، ')}.` : '')
      + (!hasPermission(perms, PERMISSION.ManageWebhooks) ? ' فحص الويب هوك يحتاج ManageWebhooks في الروم.' : '');
  }));

  const roleLines = ROLE_KEYS.map((key) => {
    const role = roles[key];
    if (!role) return `• ${ROLES[key].name}: غير موجود.`;
    return `• ${ROLES[key].name}: position=${role.position}؛ ${roleNeedsUpdate(role, roleSettings(key)) ? 'يحتاج تصحيحًا' : 'مضبوط'}.`;
  });
  if (state.guild.owner_id !== config.ownerId) warnings.push('BX_OWNER_DISCORD_ID لا يطابق مالك السيرفر الحالي؛ /setup محجوب.');
  if ((state.botPermissions & PERMISSION.Administrator) !== 0n) warnings.push('البوت لديه Administrator؛ أزلها واستخدم الصلاحيات المحددة في الدليل.');
  if (order.blocked) warnings.push('رول البوت منخفض. ارفعه فوق رولات BLACK X من Server Settings → Roles.');
  else if (order.incomplete || order.positions.length) warnings.push('رولات BLACK X ليست كلها بالترتيب المطلوب تحت رول البوت.');

  return [
    '**حالة BLACK X**',
    `• الأعضاء: ${count}`,
    `• أعلى رول للبوت: ${rank ? `#${rank} من الأعلى · position=${state.botRole.position} · ID: ${state.botRole.id}` : 'غير متاح'}`,
    `• الصلاحيات الناقصة على مستوى السيرفر: ${missingGuild.join('، ') || 'لا توجد'}`,
    `• الكاتيجوري: ${category ? 'موجودة' : 'غير موجودة'}`,
    '**الرومات والويب هوكات**', ...roomLines,
    '**الرولات**', ...roleLines,
    ...warnings.map((warning) => `⚠️ ${warning}`),
  ];
}
