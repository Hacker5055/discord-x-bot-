import { SlashCommandBuilder } from 'discord.js';
import { guildStatus } from '../status.js';

export const statusCommand = {
  data: new SlashCommandBuilder().setName('status').setDescription('فحص حالة رومات ورولات BLACK X والبوت'),
  run: (interaction, { api, config, botId }) => guildStatus({ api, config, botId, gatewayMemberCount: interaction.guild?.memberCount }),
};
