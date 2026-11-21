import { CATEGORY_ENV, CATEGORY_NAME, ROLE_KEYS, ROLES, ROOM_KEYS, ROOMS, WEBHOOK_NAME, roleEnv, roomEnv,
  roomMarker, truncate, webhookEnv } from './lib/catalog.js';
import { AppError, describeError, ownerRequired, roleHierarchyError } from './lib/errors.js';
import { PERMISSION, canManageRole, hasPermission } from './discord/permissions.js';
import { MANAGED_ROLE_PERMISSIONS, planWebhooks, readGuildState, readRoleState, resolveRoles,
  resolveRooms, targetRoleOrder } from './discord/state.js';

function markedTopic(key, topic = '') {
  const marker = roomMarker(key);
  if (topic?.includes(marker)) return topic;
  const oldTopic = (topic ?? '').replace(/\[BLACK X · (updates|support|creators|offers)\]/gu, '').trim();
  return truncate(oldTopic ? `${marker}\n${oldTopic}` : marker, 1024).trimEnd();
}

function newRoomSettings(key, guildId, botId, parentId) {
  const { name, readOnly } = ROOMS[key];
  const everyone = { id: guildId, type: 0, allow: readOnly ? '1024' : '3072', deny: readOnly ? '2048' : '0' };
  return { name, topic: roomMarker(key), parent_id: parentId,
    permission_overwrites: readOnly ? [everyone, { id: botId, type: 1, allow: '3072', deny: '0' }] : [everyone] };
}

export function roleSettings(key) {
  return { ...ROLES[key], permissions: MANAGED_ROLE_PERMISSIONS, hoist: true, mentionable: false };
}

export function roleNeedsUpdate(role, settings) {
  return Object.entries(settings).some(([key, value]) =>
    (key === 'color' ? role.colors?.primary_color ?? role.color : role[key]) !== value);
}

export function formatSetupEnv(guildId, category, rooms, roles, webhookIds) {
  return [
    `DISCORD_GUILD_ID=${guildId}`,
    `${CATEGORY_ENV}=${category?.id ?? ''}`,
    ...ROOM_KEYS.map((key) => `${roomEnv(key)}=${rooms[key]?.id ?? ''}`),
    ...ROLE_KEYS.map((key) => `${roleEnv(key)}=${roles[key]?.id ?? ''}`),
    ...ROOM_KEYS.map((key) => `${webhookEnv(key)}=${webhookIds[key] ?? ''}`),
  ].join('\n');
}

export async function provisionGuild({ api, config, botId, dryRun = false }) {
  const { guildId } = config;
  const state = await readGuildState(api, guildId, botId);
  if (state.guild.owner_id !== config.ownerId) throw ownerRequired();
  const actions = [];
  const warnings = [];
  const { category: existingCategory, rooms } = resolveRooms(state.channels, config, warnings);
  let category = existingCategory;
  let roles = resolveRoles(state.allRoles, config, warnings);
  const webhookIds = {};

  async function step(label, mutate) {
    if (dryRun) {
      actions.push(label);
      return undefined;
    }
    try {
      const result = await mutate();
      actions.push(label);
      return result;
    } catch (error) {
      warnings.push(`${label}: ${describeError(error)}`);
      return undefined;
    }
  }

  if (!hasPermission(state.botPermissions, PERMISSION.ManageChannels)) warnings.push('صلاحية Manage Channels ناقصة على مستوى السيرفر.');

  if (!category) {
    category = await step('إنشاء كاتيجوري BLACK X', () => api.createChannel(guildId, { name: CATEGORY_NAME, type: 4 },
      async () => (await api.getChannels(guildId)).find(({ type, name }) => type === 4 && name === CATEGORY_NAME)));
  }

  for (const key of ROOM_KEYS) {
    const current = rooms[key];
    if (!current) {
      if (category || dryRun) {
        const created = await step(`إنشاء روم ${key}`, () => api.createChannel(guildId, { type: 0, ...newRoomSettings(key, guildId, botId, category?.id) },
          async () => resolveRooms(await api.getChannels(guildId), config).rooms[key]));
        if (created) rooms[key] = created;
      } else {
        warnings.push(`تخطّيت إنشاء ${key} لأن الكاتيجوري غير متاح.`);
      }
    } else if (!current.topic?.includes(roomMarker(key))) {
      // /server prepare and owners manage existing room ACLs, names and placement.
      await step(`إضافة علامة الربط لروم ${key}`, () => api.updateChannel(current.id, { topic: markedTopic(key, current.topic) }));
    }
  }

  const hierarchyWarning = roleHierarchyError().message;
  let roleCreated = false;
  const manageRoles = hasPermission(state.botPermissions, PERMISSION.ManageRoles);
  if (!manageRoles) warnings.push('صلاحية Manage Roles ناقصة؛ تخطّيت تعديل الرولات وترتيبها.');
  for (const key of ROLE_KEYS) {
    const current = roles[key];
    const desired = roleSettings(key);
    if (!manageRoles) continue;
    if (!current) {
      const created = await step(`إنشاء رول ${key}`, () => api.createRole(guildId, desired,
        async () => resolveRoles(await api.getRoles(guildId), config)[key]));
      if (created) {
        roles[key] = created;
        roleCreated = true;
      }
    } else if (roleNeedsUpdate(current, desired)) {
      if (canManageRole(state.botRole, current, guildId)) {
        roles[key] = await step(`تصحيح رول ${key}`, () => api.updateRole(guildId, current.id, desired)) ?? current;
      } else {
        warnings.push(`لا أستطيع تعديل رول ${key}. ${hierarchyWarning}`);
      }
    }
  }

  try {
    // Discord shifts positions when a role is created; never place roles using stale indices.
    const fresh = roleCreated ? await readRoleState(api, guildId, botId) : state;
    if (roleCreated) roles = resolveRoles(fresh.allRoles, config);
    const order = targetRoleOrder(fresh, roles, guildId);
    if (order.blocked) warnings.push(hierarchyWarning);
    if (manageRoles && dryRun && order.incomplete) actions.push('ترتيب الرولات أسفل رول البوت بعد إنشائها، إذا سمحت الهرمية.');
    if (manageRoles && order.positions.length) {
      await step('ترتيب الرولات أسفل رول البوت', async () => {
        const updated = await api.reorderRoles(guildId, order.positions);
        const allRoles = Array.isArray(updated) ? updated : await api.getRoles(guildId);
        const botRole = allRoles.find(({ id }) => id === fresh.botRole.id);
        const placed = targetRoleOrder({ allRoles, botRole }, resolveRoles(allRoles, config), guildId);
        if (placed.blocked || placed.incomplete || placed.positions.length) {
          warnings.push('ديسكورد لم يعكس الترتيب المطلوب بعد؛ راجع /status.');
        }
      });
    }
  } catch (error) {
    warnings.push(`تعذّر فحص ترتيب الرولات: ${describeError(error)}`);
  }

  for (const key of ROOM_KEYS) {
    const channel = rooms[key];
    if (!channel) {
      if (dryRun) actions.push(`إنشاء ويب هوك ${key} بعد إنشاء الروم`);
      continue;
    }
    let plan;
    try {
      plan = planWebhooks(await api.getWebhooks(channel.id), channel.id, config.webhookIds[key]);
    } catch (error) {
      warnings.push(`تعذّر فحص ويب هوك ${key}: ${describeError(error)}`);
      continue;
    }
    if (plan.stale) warnings.push(`معرّف ${webhookEnv(key)} مش موجود في الروم؛ راجع قيمة الربط.`);
    if (plan.selected) {
      webhookIds[key] = plan.selected.id;
    } else if (plan.ambiguous) {
      warnings.push(`فيه أكتر من ويب هوك باسم BLACK X Bot في ${key}. ثبّت معرّف النسخة المستخدمة في ${webhookEnv(key)}. مفيش ويب هوك اتغيّر.`);
    } else {
      const hook = await step(`إنشاء ويب هوك ${key}`, () => api.createWebhook(channel.id, { name: WEBHOOK_NAME },
        async () => {
          const recovery = planWebhooks(await api.getWebhooks(channel.id), channel.id, config.webhookIds[key]);
          if (recovery.ambiguous) throw new AppError('WEBHOOK_AMBIGUOUS', `راجع الويب هوكات في ${key} من Integrations قبل إعادة المحاولة.`);
          return recovery.selected;
        }));
      if (hook) webhookIds[key] = hook.id;
    }
  }

  return { dryRun, actions, warnings, env: formatSetupEnv(guildId, category, rooms, roles, webhookIds) };
}

export function createProvisioner(dependencies) {
  let busy = false;
  return async function runSetup(dryRun) {
    if (busy) throw new AppError('SETUP_BUSY', 'هناك تشغيل آخر لـ /setup. جرّب بعد انتهائه.', 409);
    busy = true;
    try {
      return await provisionGuild({ ...dependencies, dryRun });
    } finally {
      busy = false;
    }
  };
}
