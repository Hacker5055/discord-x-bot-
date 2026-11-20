import { once } from 'node:events';
import { Events } from 'discord.js';
import { registerCommands, runCli } from './bootstrap.js';
import { botHealth, createBot, loginBot } from './bot.js';
import { createHttpServer } from './http/server.js';
import { createSiteBridge } from './site/bridge.js';
import { createProvisioner } from './provisioning.js';
import { createRoleService } from './roles/sync.js';
import { createAnimeService } from './community/anime.js';
import { createScheduler } from './community/jobs.js';
import { createQuizService } from './community/quiz.js';
import { createCommunityStore } from './community/backend.js';
import { createAdministration } from './admin/index.js';
import { createCatalogMonitor } from './admin/catalog-status.js';
import { configuredSecrets } from './lib/redact.js';

await runCli(async (dependencies) => {
  const { api, config, log } = dependencies;
  const botUser = await registerCommands(dependencies);
  const context = { ...dependencies, botId: botUser.id };
  const roles = createRoleService(context);
  const runSetup = createProvisioner(context);
  const store = createCommunityStore({ config, log });
  const now = Date.now;
  const anime = createAnimeService({ store, secrets: configuredSecrets(config), now });
  const quiz = createQuizService({ api, store, log, now });
  const catalogMonitor = createCatalogMonitor();
  const admin = createAdministration({ ...context, store, roles, now, catalogMonitor });
  const client = createBot({ ...context, roles, runSetup, admin, community: { anime, quiz, store, now } });
  const getHealth = () => botHealth(client, botUser, config.guildId);
  const worker = createScheduler({ api, store, guildId: config.guildId, log, now, ready: () => getHealth().ok,
    maintenance: () => admin.tick(client.guilds.cache.get(config.guildId)) });
  const siteBridge = config.siteBridgeSecret ? createSiteBridge({ admin, getHealth }) : undefined;
  const server = createHttpServer({ apiSecret: config.apiSecret, roles, anime, log, getHealth, catalogMonitor,
    siteBridgeSecret: config.siteBridgeSecret, siteBridge, now });
  let stopping;

  function shutdown() {
    if (!stopping) {
      const deadline = setTimeout(() => process.exit(process.exitCode ?? 0), 8000);
      deadline.unref();
      quiz.close();
      stopping = Promise.allSettled([
        new Promise((resolve) => server.close(resolve)), client.destroy(), worker.stop(),
      ]).then(() => store?.close()).catch(() => log.warn('community_storage_close_failed')).finally(() => clearTimeout(deadline));
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
    worker.start();
  } catch (error) {
    await shutdown();
    throw error;
  }
});
