import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { ROLE_KEYS, ROLES } from '../lib/catalog.js';
import { AppError } from '../lib/errors.js';
import { actingAsOwner } from './access.js';

export const roleCommand = {
  data: new SlashCommandBuilder().setName('role').setDescription('إدارة رولات BLACK X')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  async run(interaction, { config, roles }) {
    const owner = actingAsOwner(interaction, config);
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
      throw new AppError('MODERATOR_REQUIRED', 'تحتاج إلى صلاحية Manage Roles.', 403);
    }
    const action = interaction.options.getSubcommand();
    const { id } = interaction.options.getUser('user', true);
    const key = interaction.options.getString('role', true);
    const { changed } = await roles.change(action, id, key, { actorId: owner ? undefined : interaction.user.id });
    const message = changed ? (action === 'grant' ? 'تم إعطاء' : 'تم سحب') : (action === 'grant' ? 'العضو لديه بالفعل' : 'العضو ليس لديه');
    return [`${message} رول ${ROLES[key].name}.`];
  },
};

for (const [action, description] of [['grant', 'إعطاء رول'], ['revoke', 'سحب رول']]) {
  roleCommand.data.addSubcommand((command) => command.setName(action).setDescription(description)
    .addUserOption((option) => option.setName('user').setDescription('عضو السيرفر').setRequired(true))
    .addStringOption((option) => option.setName('role').setDescription('رول BLACK X').setRequired(true)
      .addChoices(...ROLE_KEYS.map((value) => ({ name: value, value })))));
}
