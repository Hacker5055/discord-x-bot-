import { adminOf, denied, idOf, live, onboardingRoleName, TEXT_ROOMS } from '../admin/core.js';
import { AppError, DiscordApiError, ownerRequired } from '../lib/errors.js';

export const bridgeEnabled = (c, a) => Boolean(c.config.siteBridgeSecret && a.siteBridge?.enabled === true && a.siteBridge.ownerId === c.config.ownerId);
export function assertBridge(c, a) {
  if (!bridgeEnabled(c, a)) throw new AppError('SITE_BRIDGE_DISABLED', 'ربط لوحة الموقع غير مفعّل بواسطة مالك السيرفر.', 503);
}

async function memberFromDiscord(c, by) {
  try { return await c.api.getMember(c.guildId, by); }
  catch (error) {
    if (error instanceof DiscordApiError && error.status === 404 && error.discordCode === 10007) return null;
    throw error;
  }
}

export function staffAccess(c, s) {
  // The actual configured owner does not need a delegated staff room.
  if (!s.owner) {
    live(s.a);
    const role = s.w.allRoles.find(({ id }) => id === s.a.teams.support?.roleId);
    if (!role || role.managed || role.id === c.guildId || onboardingRoleName(role.name) || c.productRole(s.w, role.id)) throw denied();
  }
  const channel = !s.owner && s.w.channels.find((ch) => ch.id === s.a.rooms.site_staff &&
    (!ch.guild_id || ch.guild_id === c.guildId) && TEXT_ROOMS.includes(ch.type));
  return c.authorize(s.w, s.a, { by: s.by, member: s.member, team: 'support', channel: channel || undefined });
}

// Construct a site principal only after the separate server-to-server authentication.
// Never derive a team, guild, or destination from the request.
export async function siteSession(c, discordId, { profile = false, staff = false, open = false, overview = false, ownerOnly = false } = {}) {
  const by = idOf(discordId);
  const state = await c.read();
  const a = adminOf(state);
  assertBridge(c, a);
  if (!profile && !overview) live(a);
  const member = await memberFromDiscord(c, by);
  if (member && (member.user?.id !== by || member.user.bot || by === c.botId)) throw denied();
  const membership = !member ? 'not_member' : member.pending === true ? 'pending' : 'member';
  if (membership !== 'member') {
    if (profile) return { by, a, membership };
    if (!member) throw new AppError('SITE_NOT_MEMBER', 'انضم لسيرفر BLACK X بالحساب المربوط الأول.', 403);
    throw new AppError('SITE_MEMBER_PENDING', 'كمّل قبول القوانين والدخول في ديسكورد الأول.', 403);
  }
  const w = await c.world();
  if (w.guild.owner_id !== c.config.ownerId) throw ownerRequired();
  const owner = w.guild.owner_id === by;
  if (ownerOnly && !owner) throw ownerRequired();
  const channel = open ? c.findRoom(w, a.rooms.ticket_panel, TEXT_ROOMS) : undefined;
  const s = { owner, by, a, state, w, member, channel, membership, source: 'site' };
  if (staff) staffAccess(c, s);
  else if (!profile) c.authorize(w, a, { by, member, channel });
  return s;
}
