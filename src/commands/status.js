import { adminUnavailable } from '../admin/index.js';
import { SlashCommandBuilder } from 'discord.js';
import { guildStatus } from '../status.js';

export const statusCommand = {
  data: new SlashCommandBuilder().setName('status').setDescription('فحص حالة BLACK X والبوت أو استقبال الكتالوج')
    .addBooleanOption((option) => option.setName('integration').setDescription('عرض آخر استقبال للكتالوج لفريق ops')),
  run(interaction, { api, config, botId, admin }) {
    if (interaction.options.getBoolean?.('integration')) {
      if (!admin) throw adminUnavailable();
      return admin.report(interaction);
    }
    return guildStatus({ api, config, botId, gatewayMemberCount: interaction.guild?.memberCount });
  },
};
