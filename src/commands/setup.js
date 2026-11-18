import { SlashCommandBuilder } from 'discord.js';
import { requireOwner } from './access.js';

export const setupCommand = {
  data: new SlashCommandBuilder()
    .setName('setup').setDescription('إنشاء موارد BLACK X أو تصحيحها')
    .setDefaultMemberPermissions(0n)
    .addBooleanOption((option) => option.setName('dry_run').setDescription('اعرض الخطة بدون أي تعديل')),

  async run(interaction, { config, runSetup, log }) {
    requireOwner(interaction, config);
    const result = await runSetup(interaction.options.getBoolean('dry_run') ?? false);
    log.info('setup_finished', { dryRun: result.dryRun, actions: result.actions.length, warnings: result.warnings.length });
    const headline = result.dryRun ? '**خطة الإعداد — لم أكتب أي تغيير.**'
      : result.warnings.length ? '**انتهى الإعداد مع تحذيرات.**' : '**اكتمل إعداد BLACK X.**';
    const actions = result.actions.map((action) => `• ${action}`);
    return [headline, ...(actions.length ? actions : ['لا تغييرات مطلوبة.']),
      ...result.warnings.map((warning) => `⚠️ ${warning}`),
      result.dryRun ? 'معرّفات الموارد الحالية فقط؛ لا تستبدل بها إعداداتك من المعاينة.'
        : 'انسخ المعرّفات المتاحة إلى .env. لنسخ رابط ويب هوك، افتح Integrations في الروم؛ لا تشاركه.',
      `\`\`\`dotenv\n${result.env}\n\`\`\``,
    ];
  },
};
