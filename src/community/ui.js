import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { actingAsOwner } from '../commands/access.js';
import { AppError } from '../lib/errors.js';

export const NO_MENTIONS = { parse: [], repliedUser: false };
export const mute = (payload) => ({ ...payload, allowed_mentions: { parse: [] } });
export const row = (...components) => ({ type: 1, components });
export const button = (custom_id, label, style = 2, disabled = false) => ({ type: 2, label, style, custom_id, disabled });
export const linkButton = (url, label) => ({ type: 2, label, style: 5, url });
export const timestamp = (ms, format = 'f') => `<t:${Math.floor(ms / 1000)}:${format}>`;
export const textChannelTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export function requireModerator(interaction, config, permission = PermissionFlagsBits.ManageMessages) {
  if (!actingAsOwner(interaction, config) && !interaction.memberPermissions?.has(permission)) {
    throw new AppError('MODERATOR_REQUIRED', 'الأمر ده متاح للإدارة فقط، حسب صلاحيات الروم والسيرفر.', 403);
  }
}

export function requirePostChannel(channel, guildId, botPermissions) {
  if (channel?.guildId !== guildId || !textChannelTypes.includes(channel.type)) {
    throw new AppError('INVALID_COMMUNITY_CHANNEL', 'اختار رومًا نصيًا من سيرفر BLACK X.');
  }
  if (!botPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    throw new AppError('BOT_MISSING_PERMISSIONS', 'في الروم ده البوت محتاج View Channel وSend Messages وEmbed Links.', 403);
  }
}
