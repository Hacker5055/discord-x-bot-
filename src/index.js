import { once } from 'node:events';
import { Events } from 'discord.js';
import { registerCommands, runCli } from './bootstrap.js';
import { botHealth, createBot, loginBot } from './bot.js';
import { createHttpServer } from './http/server.js';
import { createProvisioner } from './provisioning.js';
import { createRoleService } from './roles/sync.js';

await runCli(async (dependencies) => {
  const { config, log } = dependencies;
  const botUser = await registerCommands(dependencies);
  const context = { ...dependencies, botId: botUser.id };
  const roles = createRoleService(context);
  const runSetup = createProvisioner(context);
  const client = createBot({ ...context, roles, runSetup });
  const server = createHttpServer({ apiSecret: config.apiSecret, roles, log,
    getHealth: () => botHealth(client, botUser, config.guildId) });
  let stopping;

  function shutdown() {
    if (!stopping) {
      const deadline = setTimeout(() => process.exit(process.exitCode ?? 0), 8000);
      deadline.unref();
      stopping = Promise.allSettled([
        new Promise((resolve) => server.close(resolve)), client.destroy(),
      ]).then(() => clearTimeout(deadline));
    }
    return stopping;
  }

  try {
    server.listen(config.port, '0.0.0.0');
    await once(server, 'listening');
    server.on('error', () => log.error('http_server_error'));
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    const gatewayEnded = () => {
      if (!stopping) {
        process.exitCode = 1;
        void shutdown();
      }
    };
    client.once(Events.ShardDisconnect, gatewayEnded); // discord.js reconnects on recoverable closes.
    client.once(Events.Invalidated, gatewayEnded);
    log.info('http_listening', { port: config.port });
    await loginBot(client, config.botToken);
  } catch (error) {
    await shutdown();
    throw error;
  }
});
