import { createHash } from 'node:crypto';
import { ChannelType, PermissionFlagsBits as P, escapeMarkdown } from 'discord.js';
import { requireOwner } from '../commands/access.js';
import { cleanText } from '../community/anime.js';
import { requireStore } from '../community/store.js';
import { DAY } from '../community/time.js';
import { mute, timestamp } from '../community/ui.js';
import { canManageRole, channelPermissions, guildPermissions, hasPermission } from '../discord/permissions.js';
import { readGuildState, resolveRoles, resolveRooms } from '../discord/state.js';
import { CATEGORY_NAME, ROOM_KEYS, ROLES, isSnowflake, roomMarker } from '../lib/catalog.js';
import { AppError, DiscordApiError, ownerRequired } from '../lib/errors.js';
import { configuredSecrets, createRedactor } from '../lib/redact.js';

export const TEAMS = ['support', 'moderation', 'events', 'content', 'ops'];
export const MODULES = ['tickets', 'suggestions', 'content', 'events', 'announcements', 'voice', 'automod'];
export const INTERESTS = { news: 'أخبار الموقع', events: 'حفلات المشاهدة', quiz: 'المسابقات' };
export const TEXT_ROOMS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
export const ROOM_TYPES = {
  ticket_panel: TEXT_ROOMS, ticket_category: [ChannelType.GuildCategory], incident: TEXT_ROOMS,
  suggestions: TEXT_ROOMS, forum: [ChannelType.GuildForum], guest: [ChannelType.GuildText],
  voice_lobby: [ChannelType.GuildVoice], voice_category: [ChannelType.GuildCategory],
};
export const newAdmin = () => ({ enabled: false, version: 0, teams: {}, rooms: {}, paused: {}, interests: {}, panels: {},
  requests: {}, warnings: {}, audit: [], tasks: {}, knowledge: {}, layout: null, incidents: {}, proposals: {},
  leases: {}, announcements: {}, calendar: {}, voices: {}, topics: {}, automod: {} });
export const adminOf = (state) => state.admin ?? newAdmin();
export const memberRef = (id) => `<@${id}>`;
export const roomRef = (id) => `<#${id}>`;
export const nonce = (key) => createHash('sha256').update(key).digest('hex').slice(0, 24);
export const notFound = () => new AppError('ADMIN_NOT_FOUND', 'السجل مش موجود أو مش متاح لك.', 404);
export const denied = () => new AppError('ADMIN_SCOPE', 'الأمر محتاج فريقًا مخوّلًا وصلاحية في الروم المقصود.', 403);
export const stale = () => new AppError('ADMIN_STALE', 'الإعداد أو الحالة اتغيّروا. افتح الأمر من جديد.', 409);
export const isMissing = (error) => error instanceof DiscordApiError && error.status === 404;
export const limits = (collection, max) => {
  if (Object.keys(collection).length >= max) throw new AppError('ADMIN_LIMIT', 'وصلت للحد الأقصى من السجلات للميزة دي.', 409);
};
export const fixedChoice = (choices, value) => {
  if (!choices.includes(value)) throw new AppError('ADMIN_CHOICE', 'اختار قيمة من القائمة.');
  return value;
};
export const idOf = (id) => {
  if (!isSnowflake(id)) throw notFound();
  return id;
};
export function requestAt(items, id) {
  const record = items[idOf(id)];
  if (!record) throw notFound();
  return record;
}
export const within = (value, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new AppError('ADMIN_RANGE', `اختار رقمًا من ${min} إلى ${max}.`);
  return value;
};
export const future = (at, now) => {
  if (!Number.isFinite(at) || at < now + 60_000 || at > now + 45 * DAY) {
    throw new AppError('ADMIN_DATE', 'اختار موعدًا بعد دقيقة على الأقل وخلال ٤٥ يوم.');
  }
  return at;
};
export function live(a, module) {
  if (!a.enabled) throw new AppError('ADMIN_DISABLED', 'الإدارة لسه ما فعّلتش أدوات تنظيم BLACK X.', 403);
  if (module && a.paused[module]) throw new AppError('ADMIN_PAUSED', 'الميزة متوقفة مؤقتًا بقرار الإدارة.', 409);
}
export function audit(a, team, action, by, target, at, outcome = 'ok') {
  a.audit.push({ team, action, by, target, at, outcome });
  if (a.audit.length > 300) a.audit.shift();
}
export const auditLine = ({ action, by, target, at, outcome }) =>
  `• ${timestamp(at)} · \`${action}\` · ${by ? memberRef(by) : 'البوت'} · \`${target}\` · ${outcome}`;
export const card = (title, description) => ({ embeds: [{ title, description, color: 0x9B59B6 }] });
export const post = (payload, key) => mute({ ...payload, ...(key ? { nonce: nonce(key), enforce_nonce: true } : {}) });
export const safeTitle = (text) => escapeMarkdown(text);
export function makeSerial() {
  const queues = new Map();
  return async (key, run) => {
    if (!queues.has(key) && queues.size >= 64) throw new AppError('ADMIN_BUSY', 'فيه عمليات كتير شغالة. جرّب بعد لحظة.', 429);
    const previous = queues.get(key);
    if (previous?.size >= 4) throw new AppError('ADMIN_BUSY', 'فيه عملية تانية على نفس المورد. جرّب بعد لحظة.', 429);
    const operation = (previous?.operation ?? Promise.resolve()).catch(() => {}).then(run);
    const entry = previous ?? { size: 0 };
    entry.size += 1;
    entry.operation = operation;
    queues.set(key, entry);
    try { return await operation; }
    finally {
      entry.size -= 1;
      if (entry.operation === operation) queues.delete(key);
    }
  };
}

export function createAdminCore({ api, config, botId, store, roles, log, catalogMonitor, now = Date.now }) {
  const guildId = config.guildId;
  const serial = makeSerial();
  const redact = createRedactor(configuredSecrets(config));
  const invalidText = () => new AppError('ADMIN_TEXT', 'اكتب نصًا صالحًا من غير أسرار أو روابط Webhook.');
  const text = (value, length, multiline = false) => {
    // Use the existing sensitive-text checks. Only allow CR/LF as part of an explicitly multiline field.
    if (multiline && typeof value === 'string') {
      if (value.length > length || redact(value) !== value) throw invalidText();
      const normal = value.replace(/\r\n?/g, '\n');
      cleanText(normal.replace(/\n/g, ' '), length, redact, invalidText);
      return normal.trim();
    }
    return cleanText(value, length, redact, invalidText);
  };
  const assertGuild = (interaction) => {
    if (interaction.guildId !== guildId || interaction.user?.bot) throw denied();
    return idOf(interaction.user?.id);
  };
  const read = () => requireStore(store).read();
  const edit = (fn, session) => requireStore(store).update((state) => {
    const a = state.admin ??= newAdmin();
    if (session && (a.version !== session.a.version || !a.enabled)) throw stale();
    return fn(a, state);
  });
  const assertCurrent = async ({ a }) => {
    const fresh = adminOf(await read());
    if (!fresh.enabled || fresh.version !== a.version) throw stale();
  };
  const world = async () => {
    const w = await readGuildState(api, guildId, botId);
    if (w.guild?.id !== guildId) throw denied();
    return w;
  };
  const findRoom = (w, id, types) => {
    const c = w.channels.find((channel) => channel.id === id && (!channel.guild_id || channel.guild_id === guildId));
    if (!c || (types && !types.includes(c.type))) throw new AppError('ADMIN_ROOM', 'اختار رومًا صالحًا من نفس السيرفر.');
    return c;
  };
  const bits = (w, channel, userId, member) => {
    if (w.guild.owner_id === userId) return P.Administrator;
    const base = guildPermissions(w.allRoles, guildId, member.roles);
    return channel ? channelPermissions(base, channel, guildId, userId, member.roles) : base;
  };
  const botNeeds = (w, channel, ...flags) => {
    const effective = bits(w, channel, botId, w.botMember);
    if (!flags.every((flag) => hasPermission(effective, flag))) {
      throw new AppError('ADMIN_BOT_PERMISSION', 'صلاحيات البوت ناقصة في الروم أو الكاتيجوري ده.', 403);
    }
  };
  const postNeeds = (w, c) => botNeeds(w, c, P.ViewChannel, P.SendMessages, P.EmbedLinks);
  function authorize(w, a, { by, member, team, channel, flags = [] }) {
    const owner = w.guild.owner_id === by;
    if (owner && by !== config.ownerId) throw ownerRequired();
    const effective = bits(w, channel, by, member);
    const delegation = team && a.teams[team];
    if (Date.parse(member.communication_disabled_until) > now() ||
      (team && !owner && (!delegation || !member.roles.includes(delegation.roleId) || !delegation.rooms.includes(channel?.id))) ||
      (channel && !hasPermission(effective, P.ViewChannel)) || !flags.every((f) => hasPermission(effective, f))) throw denied();
    return { owner, effective };
  }
  async function session(i, { team, roomId = i.channelId, types, flags, gated = true, module, ownerOnly = false } = {}) {
    const by = assertGuild(i);
    // Check enabled/scope before contacting Discord where no staff operations are enabled.
    const state = await read();
    const a = adminOf(state);
    if (gated) live(a, module);
    if (ownerOnly) requireOwner(i, config);
    const [w, member] = await Promise.all([world(), api.getMember(guildId, by)]);
    const channel = roomId ? findRoom(w, roomId, types) : undefined;
    const access = authorize(w, a, { by, member, team, channel, flags });
    if (ownerOnly && !access.owner) throw ownerRequired();
    return { ...access, by, member, w, a, state, channel };
  }
  async function owner(i) {
    const by = assertGuild(i);
    requireOwner(i, config);
    const guild = await api.getGuild(guildId);
    if (guild?.id !== guildId || guild.owner_id !== by) throw ownerRequired();
    return by;
  }
  function protect(w, a, c) {
    const { rooms, category } = resolveRooms(w.channels, config);
    if (category?.id === c.id || config.categoryId === c.id || c.name === CATEGORY_NAME ||
      Object.values(config.channelIds).includes(c.id) || Object.values(rooms).some(({ id }) => id === c.id) ||
      (c.parent_id && [category?.id, config.categoryId, a.rooms.ticket_category, a.rooms.voice_category].includes(c.parent_id)) ||
      ROOM_KEYS.some((key) => c.topic?.includes(roomMarker(key))) || (c.topic ?? '').startsWith('bx-ticket:')) {
      throw new AppError('ADMIN_PROTECTED_ROOM', 'الأمر مش مسموح على رومات BLACK X الأصلية أو الرومات اللي بيديرها البوت.', 403);
    }
  }
  const productRole = (w, roleId) => Object.values(config.roleIds).includes(roleId) ||
    Object.values(resolveRoles(w.allRoles, config)).some(({ id }) => id === roleId) ||
    w.allRoles.some((r) => r.id === roleId && Object.values(ROLES).some(({ name }) => name === r.name));
  function ordinaryRole(w, a, roleId) {
    const role = w.allRoles.find(({ id }) => id === roleId);
    if (!canManageRole(w.botRole, role, guildId) || BigInt(role.permissions) !== 0n ||
      productRole(w, roleId) ||
      Object.values(a.teams).some((team) => team.roleId === roleId) ||
      w.channels.some((channel) => channel.permission_overwrites?.some((o) => o.type === 0 && o.id === roleId))) {
      throw new AppError('ADMIN_UNSAFE_ROLE', 'اختار رول اهتمام عادي: بدون صلاحيات أو أذونات رومات، وتحت رول البوت.', 403);
    }
    botNeeds(w, undefined, P.ManageRoles);
    return role;
  }
  return { api, config, botId, roles, log, catalogMonitor, store, guildId, now, read, edit, text, redact, assertGuild,
    serial, assertCurrent, world, findRoom, bits, botNeeds, postNeeds, authorize, session, owner, protect, productRole, ordinaryRole };
}
