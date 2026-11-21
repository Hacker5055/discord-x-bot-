import { SlashCommandBuilder } from 'discord.js';
import { adminUnavailable } from '../admin/index.js';
import { requireOwner } from './access.js';

export const setupCommand = {
  data: new SlashCommandBuilder()
    .setName('setup').setDescription('تجهيز دعم BLACK X أو موارد تكامل الموقع')
    .setDefaultMemberPermissions(0n)
    .addBooleanOption((option) => option.setName('dry_run').setDescription('اعرض الخطة بدون أي تعديل أو زر تطبيق'))
    .addStringOption((option) => option.setName('scope').setDescription('الدعم افتراضيًا، أو اختار تجهيز التكاملات الأصلية')
      .addChoices({ name: 'الدعم والتذاكر', value: 'support' }, { name: 'تكاملات الموقع ورولات المنتج', value: 'integrations' })),

  async run(interaction, { admin, config, runSetup, log }) {
    requireOwner(interaction, config);
    const dryRun = interaction.options.getBoolean('dry_run') ?? false;
    if (interaction.options.getString('scope') !== 'integrations') {
      if (!admin) throw adminUnavailable();
      return admin.server.setup(interaction, { dryRun });
    }
    const provision = () => runSetup(dryRun);
    const result = await (admin ? admin.core.serial('server-layout', provision) : provision());
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
