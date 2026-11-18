import { PermissionFlagsBits } from 'discord.js';
import { ownerRequired } from '../lib/errors.js';

export function requireOwner(interaction, config) {
  if (interaction.user.id !== config.ownerId || interaction.guild?.ownerId !== interaction.user.id
    || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw ownerRequired();
  }
}

export function actingAsOwner(interaction, config) {
  if (interaction.guild?.ownerId !== interaction.user.id) return false;
  requireOwner(interaction, config);
  return true;
}
