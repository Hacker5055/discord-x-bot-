import { commandData } from './commands/index.js';
import { DiscordApi } from './discord/api.js';
import { loadConfig } from './lib/env.js';
import { AppError, describeError, errorFields } from './lib/errors.js';
import { createLogger } from './lib/log.js';

export async function registerCommands({ api, config, log }) {
  const bot = await api.getCurrentUser();
  if (!bot.bot) throw new AppError('BOT_REQUIRED', 'استخدم توكن الـ Bot، وليس اعتماد حساب مستخدم.');
  const guild = await api.getGuild(config.guildId);
  if (guild.id !== config.guildId) throw new AppError('GUILD_NOT_ALLOWED', 'لم أجد سيرفر BLACK X المحدد.');
  if (guild.owner_id !== config.ownerId) log.warn('owner_id_mismatch');
  // The Discord application's ID is the same as its bot user's ID.
  await api.registerGuildCommands(bot.id, config.guildId, commandData);
  log.info('guild_commands_registered', { count: commandData.length });
  return bot;
}

export async function runCli(run) {
  let log = createLogger();
  try {
    const config = loadConfig();
    log = createLogger({ secrets: [config.botToken, config.apiSecret] });
    await run({ api: new DiscordApi({ token: config.botToken }), config, log });
  } catch (error) {
    log.error('startup_failed', { ...errorFields(error), message: describeError(error) });
    process.exitCode = 1;
  }
}
