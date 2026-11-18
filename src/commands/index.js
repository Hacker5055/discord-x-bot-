import { announceCommand } from './announce.js';
import { roleCommand } from './role.js';
import { setupCommand } from './setup.js';
import { statusCommand } from './status.js';

export const commands = new Map([setupCommand, announceCommand, roleCommand, statusCommand]
  .map((command) => [command.data.name, command]));
export const commandData = [...commands.values()].map(({ data }) => data.toJSON());
