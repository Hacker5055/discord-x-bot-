import { ChannelType as C, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { canManageRole, hasPermission } from '../discord/permissions.js';
import { resolveRooms } from '../discord/state.js';
import { isSnowflake } from '../lib/catalog.js';
import { AppError } from '../lib/errors.js';
import { roomRef, TEXT_ROOMS } from './core.js';

export const PROFILES = ['rules', 'read_only', 'open', 'restricted', 'staff', 'staff_log', 'owner_only'];
export const SETUP_TYPES = [...TEXT_ROOMS, C.GuildCategory, C.GuildForum, C.GuildVoice, C.GuildStageVoice, C.GuildMedia];
const TYPED_TEXT = [...TEXT_ROOMS, C.GuildForum, C.GuildMedia, C.GuildCategory];
const TYPED_VOICE = [C.GuildVoice, C.GuildStageVoice, C.GuildCategory];
const READ = P.ViewChannel | P.ReadMessageHistory;
const CHAT = P.SendMessages | P.SendMessagesInThreads;
const QUIET = CHAT | P.CreatePublicThreads | P.CreatePrivateThreads | P.AddReactions | P.SendVoiceMessages | P.SendPolls;
const VOICE = P.Connect | P.Speak;
const COMMANDS = P.UseApplicationCommands;
const EDIT = P.ViewChannel | P.ManageChannels | P.ManageRoles;
export const TICKET_ACCESS = P.ViewChannel | P.SendMessages | P.ReadMessageHistory;
export const TICKET_BOT = TICKET_ACCESS | P.EmbedLinks;
export function checkTicketCategory(c, w, category) {
  // Creating a guild channel checks guild permissions. The private child is unsynced: closing it
  // needs Manage Roles from the bot's guild role, not a category-only overwrite.
  c.botNeeds(w, undefined, EDIT | TICKET_BOT);
  c.botNeeds(w, category, EDIT | TICKET_BOT);
}
export const roomError = (ch, message, code = 'SERVER_PREPARE_ROOM') => new AppError(code, `${roomRef(ch.id)}: ${message}`, 409);
const tuple = ({ id, type, allow, deny }) => ({ id, type, allow: String(allow), deny: String(deny) });
export const acl = (ch) => (ch.permission_overwrites ?? []).map(tuple).sort((a, b) => a.type - b.type || a.id.localeCompare(b.id));
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const roomShape = (ch) => [ch.id, ch.type, ch.parent_id ?? null];

export function setupRole(c, w, a, roleId, staff = true, { manageable = true } = {}) {
  const role = w.allRoles.find((candidate) => candidate.id === roleId && candidate.id !== c.guildId && !candidate.managed);
  const ordinary = String(role?.name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (!role || (manageable && !canManageRole(w.botRole, role, c.guildId)) ||
    /^(?:everyone|here|members?|boy|girl)$/u.test(ordinary) || Object.values(a.interests).includes(roleId) ||
    (staff && c.productRole(w, roleId))) {
    throw new AppError('SERVER_PREPARE_ROLE', 'اختار رول مناسب ومخصص وتحت رول البوت، مش Members/Boy/Girl أو رول اهتمام؛ رولات VIP وCreator مش لفريق الإدارة.', 409);
  }
  return role;
}

export function protectedRoom(c, w, a, ch, special) {
  const { category, rooms } = resolveRooms(w.channels, c.config);
  const provisioned = ch.id === category?.id || ch.id === c.config.categoryId ||
    Object.values(c.config.channelIds).includes(ch.id) || Object.values(rooms).some((r) => r.id === ch.id);
  const dynamic = (ch.parent_id && [a.rooms.ticket_category, a.rooms.voice_category].includes(ch.parent_id)) ||
    a.rooms.voice_category === ch.id || (a.rooms.ticket_category === ch.id && special !== 'ticket_category') ||
    (ch.topic ?? '').startsWith('bx-ticket:') || Boolean(a.voices[ch.id]) ||
    Object.values(a.requests).some((r) => r.kind === 'ticket' && r.channelId === ch.id);
  if (dynamic || (provisioned && !(special === 'ticket_panel' && rooms.support?.id === ch.id)) ||
    Object.values(a.leases).some((l) => l.channelId === ch.id) ||
    Object.values(a.proposals).some((p) => p.channelId === ch.id && ['pending', 'applying'].includes(p.status))) {
    throw roomError(ch, 'الروم تابع لإعداد قائم أو عليه إذن مؤقت. مش هيتغيّر من التجهيز.', 'ADMIN_PROTECTED_ROOM');
  }
}

export function checkProfile(c, w, a, ch, spec) {
  protectedRoom(c, w, a, ch, spec.profile);
  if ((['rules', 'ticket_panel', 'support_staff', 'staff_log'].includes(spec.profile) && !TEXT_ROOMS.includes(ch.type)) ||
    (spec.profile === 'ticket_category' && ch.type !== C.GuildCategory) || (spec.profile === 'read_only' && !TYPED_TEXT.includes(ch.type))) {
    throw roomError(ch, 'نوع الروم مش مناسب للغرض ده.');
  }
  if (['restricted', 'staff', 'staff_log', 'support_staff', 'ticket_category'].includes(spec.profile)) {
    setupRole(c, w, a, spec.roleId, spec.profile !== 'restricted');
  } else if (spec.roleId) throw roomError(ch, 'الغرض ده مش محتاج اختيار رول.');
}

const upsert = (rows, id, type, allow, deny) => {
  const index = rows.findIndex((entry) => entry.id === id && entry.type === type);
  const prior = rows[index];
  const next = tuple({ id, type, allow: BigInt(prior?.allow ?? 0) | allow, deny: BigInt(prior?.deny ?? 0) | deny });
  if (prior) rows[index] = next;
  else rows.push(next);
};

export function plannedAcl(c, ch, { profile, roleId }) {
  const publiclyVisible = ['rules', 'read_only', 'open', 'ticket_panel'].includes(profile);
  const readOnly = ['rules', 'read_only', 'ticket_panel', 'staff_log'].includes(profile);
  const text = TYPED_TEXT.includes(ch.type);
  const voice = TYPED_VOICE.includes(ch.type);
  const operational = ['rules', 'ticket_panel', 'support_staff', 'ticket_category'].includes(profile);
  const ordinaryCommands = !readOnly || profile === 'ticket_panel';
  const write = (text ? CHAT : 0n) | (voice ? VOICE : 0n);
  const quiet = (text ? QUIET : 0n) | (voice ? VOICE : 0n);
  const mask = READ | COMMANDS | (readOnly ? quiet : write) | (operational ? P.EmbedLinks : 0n);
  const rows = acl(ch).map(({ id, type, allow, deny }) => tuple({ id, type, allow: BigInt(allow) & ~mask, deny: BigInt(deny) & ~mask }));
  const audience = publiclyVisible ? READ | (readOnly ? 0n : write) | (ordinaryCommands ? COMMANDS : 0n) : 0n;
  const deny = (publiclyVisible ? 0n : P.ViewChannel) | (readOnly ? quiet | (ordinaryCommands ? 0n : COMMANDS) : 0n);
  upsert(rows, c.guildId, 0, audience, deny);
  if (roleId) upsert(rows, roleId, 0, READ | (readOnly || profile === 'ticket_category' ? 0n : write | COMMANDS), 0n);
  // Retain the bot's access without granting Server Administrator or modifying any guild role.
  const bot = acl(ch).find((row) => row.id === c.botId && row.type === 1);
  upsert(rows, c.botId, 1, READ | (operational ? P.SendMessages | P.EmbedLinks : 0n) | (BigInt(bot?.allow ?? 0) & mask), 0n);
  // Keep zero-mask rows that pre-existed. Removing an unrelated row would change sync rules.
  return acl({ permission_overwrites: rows });
}

export const syncedChildren = (channels, ch) => ch.type !== C.GuildCategory ? [] : channels
  .filter((row) => row.parent_id === ch.id && equal(acl(row), acl(ch))).map((row) => row.id).sort();

export function checkAclWrite(c, w, ch, before, after) {
  c.botNeeds(w, ch, EDIT);
  const botOverwrites = before.filter((o) => (o.type === 1 && o.id === c.botId) ||
    (o.type === 0 && w.botMember.roles.includes(o.id)));
  if (botOverwrites.some((o) => BigInt(o.allow) & P.ManageRoles)) return;
  const parent = w.channels.find((parent) => parent.id === ch.parent_id);
  const available = c.bits(w, undefined, c.botId, w.botMember) | (parent ? c.bits(w, parent, c.botId, w.botMember) : 0n);
  const aclKey = (o) => `${o.type}:${o.id}`;
  const old = new Map(before.map((o) => [aclKey(o), o]));
  const touched = after.reduce((bits, row) => {
    const prior = old.get(aclKey(row));
    return bits | (BigInt(row.allow) ^ BigInt(prior?.allow ?? 0)) | (BigInt(row.deny) ^ BigInt(prior?.deny ?? 0));
  }, 0n);
  if (!hasPermission(available, touched)) {
    const flags = new PermissionsBitField(touched & ~available).toArray().join(', ');
    throw roomError(ch, `البوت مش مسموح له يضبط أذونات ${flags}. راجع أذوناته في الكاتيجوري أو Manage Roles في الروم.`, 'ADMIN_BOT_PERMISSION');
  }
}

export function planChannels(c, w, a, specs) {
  const byId = new Map(w.channels.map((ch) => [ch.id, ch]));
  const inherited = new Set();
  const changes = [];
  const sorted = Object.entries(specs).sort(([aId], [bId]) =>
    Number(byId.get(bId)?.type === C.GuildCategory) - Number(byId.get(aId)?.type === C.GuildCategory) || aId.localeCompare(bId));
  for (const [id, spec] of sorted) {
    const ch = byId.get(id);
    if (!ch || (ch.guild_id && ch.guild_id !== c.guildId) || !SETUP_TYPES.includes(ch.type)) {
      throw new AppError('ADMIN_ROOM', `الربط المحفوظ للروم (${id}) مش صالح أو البوت مش شايفه. راجع View Channel؛ لو الروم اتحذف، شيل الربط بـ /server unbind channel_id:${id}.`);
    }
    checkProfile(c, w, a, ch, spec);
    if (inherited.has(id)) continue;
    const before = acl(ch);
    const after = plannedAcl(c, ch, spec);
    const updated = { ...ch, permission_overwrites: after };
    const children = syncedChildren(w.channels, ch);
    if (['rules', 'ticket_panel', 'support_staff'].includes(spec.profile)) c.postNeeds(w, updated);
    if (spec.profile === 'ticket_category') checkTicketCategory(c, w, updated);
    if (equal(before, after)) continue;
    checkAclWrite(c, w, ch, before, after);
    c.botNeeds(w, updated, EDIT);
    const childShapes = [];
    for (const id of children) {
      const child = byId.get(id);
      protectedRoom(c, w, a, child, specs[id]?.profile);
      // Inheritance is explicit in the plan; don't overwrite a child's different policy.
      if (!SETUP_TYPES.includes(child.type) || (specs[id] && !equal(specs[id], spec)) || spec.profile === 'ticket_category') {
        throw roomError(child, 'الروم متزامن مع الكاتيجوري وسياساته مختلفة. راجع المزامنة قبل تطبيق التجهيز.');
      }
      // A category cannot silently apply to an unrelated child which isn't represented in the selected policy.
      if (!isSnowflake(child.id) || child.guild_id && child.guild_id !== c.guildId) throw roomError(ch, 'تعذّر التحقق من الرومات المتزامنة.');
      inherited.add(id);
      childShapes.push(roomShape(child));
    }
    if (ch.type === C.GuildCategory && w.channels.some((child) => child.parent_id === id && !children.includes(child.id) && equal(acl(child), after))) {
      throw roomError(ch, 'فيه روم مستقل هيبقى مطابق لأذونات الكاتيجوري الجديدة. راجع ارتباطه قبل التجهيز عشان يبقى التراجع آمن.');
    }
    if (after.length > 100) throw roomError(ch, 'وصل لحد Discord لعدد أذونات الروم.');
    changes.push({ shape: roomShape(ch), before, after, children: childShapes, profile: spec.profile });
  }
  if (changes.length > 80 || Buffer.byteLength(JSON.stringify(changes)) > 256 * 1024) {
    throw new AppError('SERVER_PREPARE_LIMIT', 'الخطة كبيرة جدًا على تطبيق واحد آمن. قسّم التجهيز على دفعات أصغر.', 409);
  }
  return changes;
}

export function observedChange(c, channels, change, expected) {
  const [id] = change.shape;
  const ch = channels.find((ch) => ch.id === id);
  if (!ch || ch.guild_id && ch.guild_id !== c.guildId || !equal(roomShape(ch), change.shape) || !equal(acl(ch), expected)) return false;
  if (!equal(syncedChildren(channels, ch), change.children.map(([key]) => key))) return false;
  return change.children.every((shape) => channels.some((child) => equal(roomShape(child), shape) && equal(acl(child), expected)));
}
