import { SlashCommandBuilder } from 'discord.js';
import { ROOM_KEYS, ROOMS, truncate } from '../lib/catalog.js';
import { AppError, ownerRequired } from '../lib/errors.js';
import { PERMISSION, channelPermissions, guildPermissions, hasPermission, isTimedOut } from '../discord/permissions.js';
import { readGuildState, resolveRooms } from '../discord/state.js';
import { actingAsOwner } from './access.js';
import { createRedactor } from '../lib/redact.js';

export function announcementPayload({ room, title, body, url, nonce, secrets }) {
  if (!Object.hasOwn(ROOMS, room) || !title?.trim() || !body?.trim()) {
    throw new AppError('INVALID_ANNOUNCEMENT', 'اختر رومًا واكتب عنوانًا ونصًا للإعلان.');
  }
  const redact = createRedactor(secrets);
  if ([title, body, url].some((text) => text && redact(text) !== text)) {
    throw new AppError('SENSITIVE_ANNOUNCEMENT', 'احذف التوكنات وروابط الويب هوك من الإعلان قبل نشره.');
  }
  const embed = { title: truncate(title.trim(), 256), description: truncate(body.trim(), 3800), color: ROOMS[room].color };
  if (url !== null && url !== undefined) {
    try {
      const link = new URL(url);
      if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password || link.href.length > 2048) throw new Error();
      embed.url = link.href;
    } catch {
      throw new AppError('INVALID_URL', 'الرابط لازم يبدأ بـ https:// أو http:// ويكون صالحًا (حتى 2048 حرفًا).');
    }
  }
  return { embeds: [embed], allowed_mentions: { parse: [] }, ...(nonce ? { nonce, enforce_nonce: true } : {}) };
}

export const announceCommand = {
  data: new SlashCommandBuilder().setName('announce').setDescription('نشر إعلان بدون أي تنبيه بالمنشن')
    .addStringOption((option) => option.setName('room').setDescription('الروم').setRequired(true)
      .addChoices(...ROOM_KEYS.map((value) => ({ name: value, value }))))
    .addStringOption((option) => option.setName('title').setDescription('العنوان').setRequired(true).setMaxLength(256))
    .addStringOption((option) => option.setName('body').setDescription('النص').setRequired(true).setMaxLength(3800))
    .addStringOption((option) => option.setName('url').setDescription('رابط اختياري').setMaxLength(2048)),

  async run(interaction, { api, config, botId }) {
    const owner = actingAsOwner(interaction, config);
    const key = interaction.options.getString('room', true);
    const payload = announcementPayload({
      room: key, title: interaction.options.getString('title', true), body: interaction.options.getString('body', true),
      url: interaction.options.getString('url'), nonce: interaction.id, secrets: [config.botToken, config.apiSecret, config.databaseUrl],
    });
    const { guildId } = config;
    const [state, actor] = await Promise.all([
      readGuildState(api, guildId, botId), owner ? undefined : api.getMember(guildId, interaction.user.id),
    ]);
    if (owner && state.guild.owner_id !== config.ownerId) throw ownerRequired();
    const { rooms } = resolveRooms(state.channels, config);
    const room = rooms[key];
    if (!room) throw new AppError('ROOM_NOT_CONFIGURED', 'الروم غير موجود. اطلب من المالك تشغيل /setup.', 404);
    if (actor) {
      const bits = guildPermissions(state.allRoles, guildId, actor.roles);
      const effective = channelPermissions(bits, room, guildId, interaction.user.id, actor.roles);
      if (isTimedOut(actor) || !hasPermission(effective, PERMISSION.ViewChannel)
        || !hasPermission(effective, PERMISSION.ManageMessages)) {
        throw new AppError('MODERATOR_REQUIRED', 'تحتاج إلى Manage Messages في الروم المقصود.', 403);
      }
    }
    const bits = channelPermissions(state.botPermissions, room, guildId, botId, state.botMember.roles);
    const required = ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter((permission) => !hasPermission(bits, PERMISSION[permission]));
    if (required.length) throw new AppError('BOT_MISSING_PERMISSIONS', `صلاحيات البوت الناقصة في الروم: ${required.join('، ')}.`, 403);
    await api.createMessage(room.id, payload);
    return [`نُشر الإعلان في ${ROOMS[key].name} بدون تنبيهات.`];
  },
};
