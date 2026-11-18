import { Client, Events, GatewayIntentBits, MessageFlags, Status } from 'discord.js';
import { commands } from './commands/index.js';
import { truncate } from './lib/catalog.js';
import { AppError, describeError, errorFields } from './lib/errors.js';

const NO_MENTIONS = { parse: [], repliedUser: false };
const EPHEMERAL = MessageFlags.Ephemeral;
const replyBody = (content) => ({ content, allowedMentions: NO_MENTIONS });

function chunks(lines) {
  const result = [];
  let current = '';
  for (const text of lines) {
    const line = truncate(text, 1900);
    if (current && current.length + line.length + 1 > 1900) {
      result.push(current);
      current = '';
    }
    current += current ? `\n${line}` : line;
  }
  if (current) result.push(current);
  return result;
}

export function createInteractionHandler(dependencies) {
  const { config, log } = dependencies;
  return async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = commands.get(interaction.commandName);
    try {
      if (interaction.guildId !== config.guildId) {
        throw new AppError('GUILD_NOT_ALLOWED', 'البوت مخصص لسيرفر BLACK X الرسمي فقط.', 403);
      }
      if (!command) throw new AppError('UNKNOWN_COMMAND', 'الأمر غير معروف. أعد تسجيل أوامر السيرفر.');
      await interaction.deferReply({ flags: EPHEMERAL });
      const [first, ...rest] = chunks(await command.run(interaction, dependencies));
      await interaction.editReply(replyBody(first));
      for (const part of rest) await interaction.followUp({ ...replyBody(part), flags: EPHEMERAL });
    } catch (error) {
      log.warn('command_failed', { command: command?.data.name ?? 'unknown', ...errorFields(error) });
      const response = replyBody(describeError(error));
      try {
        if (interaction.replied) await interaction.followUp({ ...response, flags: EPHEMERAL });
        else if (interaction.deferred) await interaction.editReply(response);
        else await interaction.reply({ ...response, flags: EPHEMERAL });
      } catch {
        log.warn('interaction_reply_failed');
      }
    }
  };
}

export function createBot(dependencies) {
  const { config, log } = dependencies;
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: NO_MENTIONS });
  const handleInteraction = createInteractionHandler(dependencies);

  async function enforceGuild(guild) {
    if (guild.id === config.guildId) return;
    try {
      await guild.leave();
      log.info('left_unapproved_guild');
    } catch {
      log.warn('could_not_leave_unapproved_guild');
    }
  }

  client.on(Events.GuildCreate, enforceGuild);
  client.on(Events.ClientReady, (ready) => {
    log.info('gateway_ready', { guildAvailable: Boolean(ready.guilds.cache.get(config.guildId)?.available) });
    for (const guild of ready.guilds.cache.values()) void enforceGuild(guild);
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction).catch(() => log.warn('interaction_handler_failed'));
  });
  client.on(Events.Error, () => log.warn('gateway_error'));
  client.on(Events.ShardError, () => log.warn('gateway_shard_error'));
  client.on(Events.ShardDisconnect, ({ code }, shardId) => log.warn('gateway_disconnected', { code, shardId }));
  client.on(Events.Warn, () => log.warn('gateway_warning'));
  client.on(Events.Invalidated, () => log.error('gateway_invalidated'));
  return client;
}

export async function loginBot(client, token) {
  try {
    await client.login(token);
  } catch (error) {
    if (error?.code === 'TokenInvalid' || error?.code === 4004 || /invalid token/i.test(error?.message ?? '')) {
      throw new AppError('GATEWAY_AUTH_FAILED', 'تعذّرت مصادقة Gateway. راجع DISCORD_BOT_TOKEN محليًا.');
    }
    if (error?.code === 4014 || /disallowed intents/i.test(error?.message ?? '')) {
      throw new AppError('GATEWAY_INTENTS', 'Discord رفض الـ intents. البوت يحتاج Guilds فقط، دون Privileged Intents.');
    }
    throw new AppError('GATEWAY_LOGIN_FAILED', 'تعذّر تسجيل الدخول إلى Discord Gateway. راجع الاتصال وإعداد البوت.');
  }
}

export function botHealth(client, botUser, guildId) {
  const guild = client.guilds.cache.get(guildId);
  const ready = client.isReady() && (!guild || guild.shard?.status === Status.Ready);
  const tag = botUser.discriminator && botUser.discriminator !== '0'
    ? `${botUser.username}#${botUser.discriminator}` : botUser.username;
  return {
    ok: ready && Boolean(guild?.available), uptime: Math.floor(process.uptime()),
    bot: { id: botUser.id, tag, ready },
    guild: { id: guildId, memberCount: guild?.available ? guild.memberCount ?? null : null },
  };
}
