import { ChannelType as C, PermissionFlagsBits as P } from 'discord.js';
import { hasPermission } from '../discord/permissions.js';
import { isSnowflake, ROOMS, roomMarker } from '../lib/catalog.js';
import { AppError, rejectedWrite } from '../lib/errors.js';
import { acl, equal, plannedAcl, roomShape, setupRole } from './channel-plan.js';
import { roomRef, stale, TEXT_ROOMS } from './core.js';

const slots = {
  role: { label: 'رول فريق الدعم', name: 'فريق الدعم', aliases: ['Support', 'BLACK X Support', 'Support Team', 'فريق الدعم الفني'] },
  category: { label: 'كاتيجوري التذاكر', name: '🎫 التذاكر', aliases: ['Tickets', 'Support Tickets', 'تذاكر الدعم'],
    types: [C.GuildCategory], purpose: 'ticket_category' },
  panel: { label: 'روم لوحة الأعضاء', name: ROOMS.support.name, aliases: ['Support', 'BLACK X Support', 'لوحة الدعم', 'لوحة التذاكر'],
    types: TEXT_ROOMS, purpose: 'ticket_panel', marker: roomMarker('support') },
  staff: { label: 'روم فريق الدعم', name: '🔒-فريق-الدعم', aliases: ['Support Staff', 'فريق الدعم الفني', 'مراجعة الشكاوى'],
    types: [C.GuildText], purpose: 'site_staff', marker: roomMarker('support-staff') },
};
const keys = Object.keys(slots);
// Synthetic identities stay in the plan only; materialization substitutes verified Discord IDs.
const plannedId = (key) => `new:${key}`;
const normalize = (name) => (name ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]|\u0640/gu, '');
const everyoneCanView = (c, w, ch) => hasPermission(c.bits(w, ch, c.guildId, { roles: [] }), P.ViewChannel);
const glyph = (key, id) => key === 'role' ? `<@&${id}>` : roomRef(id);
const reject = (code, message) => new AppError(code, message, 409);
const reason = 'BLACK X approved support setup';
const privileged = P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageChannels | P.ManageWebhooks | P.KickMembers | P.BanMembers | P.ModerateMembers;

export function hiddenChannelShapes(i, channels) {
  const cache = i.guild?.channels?.cache;
  if (!cache || i.guild.available === false) return undefined;
  const visible = new Set(channels.map(({ id }) => id));
  // The Gateway can expose ID/type/parent for rooms the HTTP list omits. Never use cached names, topics or ACLs.
  return [...cache.values()].filter(({ id }) => isSnowflake(id) && !visible.has(id))
    .map(({ id, type, parentId }) => ({ id, type, parentId }));
}

export function checkHiddenChildren(hidden, categoryId) {
  const children = hidden?.filter(({ parentId }) => parentId === categoryId) ?? [];
  if (children.length) throw reject('SETUP_HIDDEN_CHILD',
    `${roomRef(categoryId)} فيها رومات البوت مش شايفها (${children.slice(0, 5).map(({ id }) => roomRef(id)).join('، ')}). راجعها قبل تجهيز الكاتيجوري؛ مش هنغيّر أذونات رومات مش متأكدين منها.`);
}

function boundRef(a, key, id) {
  const ids = [...new Set([id, a.complaints?.[`${key}Id`], a.server?.supportSetup?.[key]?.id].filter(Boolean))];
  if (ids.length > 1) throw reject('SETUP_CONFLICT',
    `${slots[key].label}: فيه روابط محفوظة مختلفة (${ids.join('، ')}). اختار المورد المقصود صراحةً بـ /server prepare.`);
  return ids[0];
}

function ref(c, { w, a }, key, id, extraIds = []) {
  const { label, name, aliases, types, purpose, marker } = slots[key];
  const old = a.server?.supportSetup?.[key];
  const all = types ? w.channels : w.allRoles;
  const names = [name, ...aliases].map(normalize);
  const candidates = id ? all.filter((entry) => entry.id === id) : all.filter((entry) =>
    (marker && entry.topic?.includes(marker)) || extraIds.includes(entry.id) || names.includes(normalize(entry.name)));
  if (!candidates.length && id) throw reject('SETUP_BOUND_RESOURCE',
    `${label} (${id}) مربوط، لكن البوت مش لاقيه. ${types ? 'راجع View Channel، أو اختار البديل صراحةً بـ /server prepare.' : 'راجع الرول أو اختار البديل صراحةً بـ /server prepare.'} مش هنعمل نسخة بديلة.`);
  if (candidates.length > 1) throw reject('SETUP_AMBIGUOUS',
    `${label}: فيه أكتر من اختيار (${candidates.slice(0, 8).map((entry) => glyph(key, entry.id)).join('، ')}). اختار المقصود بـ /server prepare؛ ما اتعملش مورد مكرّر.`);
  const selected = candidates[0];
  if (!id && old?.pending && (!selected || normalize(selected.name) !== normalize(name) || (marker && selected.topic !== marker))) {
    throw reject('SETUP_CREATE_UNCONFIRMED',
      `${label}: نتيجة الإنشاء السابق مش مؤكدة. راجع السيرفر وصلاحية الرؤية، وبعدها اربط المورد المقصود بـ /server prepare. مش هيتعمل مرة تانية تلقائيًا.`);
  }
  if (!selected) return undefined;
  if (!isSnowflake(selected.id) || (types && (!types.includes(selected.type) || (selected.guild_id && selected.guild_id !== c.guildId)))) {
    throw reject('SETUP_WRONG_RESOURCE', `${label} (${selected.id}): النوع مش مناسب. اختار المورد الصحيح بـ /server prepare.`);
  }
  if (types) {
    c.botNeeds(w, selected, P.ViewChannel);
    if (Object.entries(a.rooms).some(([other, roomId]) => other !== purpose && roomId === selected.id) ||
      Object.entries(a.teams).some(([other, team]) => other !== 'support' && team.rooms.includes(selected.id)) ||
      ['rules', 'guide'].some((other) => a.panels[other]?.channelId === selected.id)) {
      throw reject('SETUP_BOUND_RESOURCE', `${glyph(key, selected.id)} مربوط بميزة أو فريق تاني؛ اختار روم مخصص للدعم في /server prepare.`);
    }
  } else {
    try { setupRole(c, w, a, selected.id); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'SERVER_PREPARE_ROLE') throw error;
      throw reject(error.code, `${glyph(key, selected.id)}: ${error.message}`);
    }
    if ((BigInt(selected.permissions) & privileged) || Object.entries(a.teams).some(([team, scope]) => team !== 'support' && scope.roleId === selected.id)) {
      throw reject('SERVER_PREPARE_ROLE', `${glyph(key, selected.id)} عليه صلاحيات إدارة عامة أو مربوط بفريق تاني. اختار رول دعم مستقل بـ /server prepare.`);
    }
  }
  return selected;
}

function discover(c, ctx) {
  const { w, a, hidden } = ctx;
  if (!hidden) throw reject('SETUP_CHANNEL_INVENTORY', 'قائمة رومات السيرفر من Discord لسه مش جاهزة. استنى شوية واعمل معاينة جديدة؛ البوت مش هينشئ روم قبل الفحص.');
  const team = a.teams.support;
  const panel = ref(c, ctx, 'panel', boundRef(a, 'panel', a.rooms.ticket_panel) ?? a.panels.ticket?.channelId ?? c.config.channelIds.support);
  if (panel && (panel.nsfw || !everyoneCanView(c, w, panel))) throw reject('SETUP_PRIVATE_PANEL',
    `${roomRef(panel.id)} مش لوحة عامة لكل الأعضاء. الإعداد التلقائي مش هيفتح روم خاص وتاريخه؛ راجع الروم واختار لوحة عامة في /server prepare.`);
  const category = ref(c, ctx, 'category', boundRef(a, 'category', a.rooms.ticket_category));
  if (category) checkHiddenChildren(hidden, category.id);
  const staffRef = boundRef(a, 'staff', a.rooms.site_staff);
  // A legacy support delegation in the public panel or a commands room is not a private staff destination.
  const staffIds = [];
  if (!staffRef) {
    for (const id of team?.rooms ?? []) {
      if (id === panel?.id) continue;
      const ch = w.channels.find((entry) => entry.id === id);
      if (!ch) throw reject('SETUP_BOUND_RESOURCE', `فيه روم محفوظ لفريق الدعم (${id}) البوت مش شايفه. راجع View Channel أو حدد staff في /server prepare.`);
      if (ch.type === C.GuildText && !everyoneCanView(c, w, ch) && !ch.topic?.startsWith('bx-ticket:')) staffIds.push(id);
    }
  }
  const entries = {
    role: ref(c, ctx, 'role', boundRef(a, 'role', team?.roleId)), category, panel,
    staff: ref(c, ctx, 'staff', staffRef, staffIds),
  };
  const unrelated = new Set([c.config.categoryId, ...Object.entries(c.config.channelIds).filter(([key]) => key !== 'support').map(([, id]) => id),
    ...Object.entries(a.rooms).filter(([key]) => !['ticket_category', 'ticket_panel', 'site_staff'].includes(key)).map(([, id]) => id),
    ...Object.values(a.requests).filter((r) => r.kind === 'ticket').map((r) => r.channelId)]);
  for (const key of keys.filter((key) => slots[key].types && !entries[key])) {
    const unknown = hidden.filter(({ id, type }) => !unrelated.has(id) && slots[key].types.includes(type));
    if (unknown.length) throw reject('SETUP_HIDDEN_RESOURCE',
      `${slots[key].label}: فيه رومات ممكن تكون المورد المقصود لكن بياناتها مخفية عن البوت (${unknown.slice(0, 5).map(({ id }) => roomRef(id)).join('، ')}). راجعها أو اختار المورد صراحةً بـ /server prepare. مش هنعمل نسخة جديدة قبل ما نتأكد.`);
  }
  return entries;
}

function stamp(key, entry) {
  if (!entry) return null;
  if (key === 'role') return { id: entry.id, name: entry.name, permissions: String(entry.permissions), managed: Boolean(entry.managed) };
  return { id: entry.id, name: entry.name, shape: roomShape(entry), topic: entry.topic ?? null, nsfw: Boolean(entry.nsfw), acl: acl(entry) };
}
const inventory = (entries) => Object.fromEntries(keys.map((key) => [key, stamp(key, entries[key])]));
const roleSettings = { name: slots.role.name, permissions: '0', hoist: false, mentionable: false };
const profile = { category: 'ticket_category', panel: 'ticket_panel', staff: 'support_staff' };

function channelSettings(c, key, roleId) {
  const { name, marker } = slots[key];
  const type = key === 'category' ? C.GuildCategory : C.GuildText;
  const permission_overwrites = plannedAcl(c, { type }, { profile: profile[key], roleId: key === 'panel' ? undefined : roleId });
  return { name, type, ...(marker ? { topic: marker } : {}), permission_overwrites };
}

function checkCreateChannel(c, w, data) {
  // Discord checks all bits in overwrites against the bot's guild permissions on channel creation.
  const bits = data.permission_overwrites.reduce((mask, row) => mask | BigInt(row.allow) | BigInt(row.deny), P.ManageChannels);
  c.botNeeds(w, undefined, bits);
}

export function planSupportSetup(c, ctx) {
  const entries = discover(c, ctx);
  const observed = inventory(entries);
  const refs = Object.fromEntries(keys.map((key) => [key, observed[key]?.id ?? plannedId(key)]));
  const w = { ...ctx.w, channels: [...ctx.w.channels], allRoles: [...ctx.w.allRoles] };
  if (!entries.role) {
    c.botNeeds(w, undefined, P.ManageRoles);
    // Preview a bottom role; the real role's hierarchy is rechecked after the POST.
    w.allRoles.push({ ...roleSettings, id: refs.role, position: -1, managed: false });
  }
  for (const key of keys.slice(1).filter((key) => !entries[key])) {
    const settings = channelSettings(c, key, refs.role);
    checkCreateChannel(c, w, settings);
    w.channels.push({ ...settings, id: refs[key], guild_id: c.guildId });
  }
  return { observed, refs, virtual: { ...ctx, w } };
}

export const describeSupportSetup = (observed) => keys.map((key) => {
  const seen = observed[key];
  return seen ? `• ${slots[key].label}: استخدام الموجود ${glyph(key, seen.id)}.` : `• ${slots[key].label}: إنشاء **${slots[key].name}**.`;
});

// Compare against the reviewed changes for existing ACLs; new rooms already get the approved ACL on POST.
export function approvedSetupChanges(changes, roleId) {
  return changes.map((change) => ({ ...change, after: acl({ permission_overwrites: change.after.map((row) =>
    row.id === plannedId('role') ? { ...row, id: roleId } : row) }) }));
}

export async function materializeSupportSetup(c, snapshot, approved, version, attemptId, created) {
  const expected = { ...approved.observed };
  for (const key of keys.filter((key) => !expected[key])) {
    const ctx = await snapshot();
    if (ctx.a.version !== version || !equal(inventory(discover(c, ctx)), expected)) throw stale();
    const data = key === 'role' ? roleSettings : channelSettings(c, key, expected.role.id);
    if (key === 'role') c.botNeeds(ctx.w, undefined, P.ManageRoles);
    else checkCreateChannel(c, ctx.w, data);
    const prior = ctx.a.server?.supportSetup?.[key];
    const remember = (before, receipt, reserve = false) => c.edit((a) => {
      if (reserve && a.version !== version) throw stale();
      const journal = (a.server ??= { profiles: {} }).supportSetup ??= {};
      if (journal[key]?.id !== before?.id || journal[key]?.pending !== before?.pending) throw stale();
      if (receipt) journal[key] = receipt;
      else delete journal[key];
    });
    // Reserve durably before the non-idempotent POST. A timeout must not trigger another blind POST.
    const reserved = { pending: attemptId };
    await remember(prior, reserved, true);
    let entry;
    try {
      const opts = { guarded: true, reason };
      entry = key === 'role' ? await c.api.createRole(c.guildId, data, undefined, opts) : await c.api.createChannel(c.guildId, data, undefined, opts);
    } catch (error) {
      if (rejectedWrite(error)) await remember(reserved, null);
      throw error;
    }
    if (!isSnowflake(entry?.id)) throw stale();
    await remember(reserved, { id: entry.id });
    created.push(`${slots[key].label} ${glyph(key, entry.id)}`);
    if (key === 'role' ? (entry.name !== data.name || entry.managed || entry.hoist || entry.mentionable || String(entry.permissions) !== '0') :
      (entry.type !== data.type || (entry.guild_id && entry.guild_id !== c.guildId) || entry.parent_id != null ||
        (data.topic && entry.topic !== data.topic) || !equal(acl(entry), acl(data)))) throw stale();
    expected[key] = stamp(key, entry);
  }
  const ctx = await snapshot();
  if (ctx.a.version !== version || !equal(inventory(discover(c, ctx)), expected)) throw stale();
  return { ctx, refs: Object.fromEntries(keys.map((key) => [key, expected[key].id])) };
}
