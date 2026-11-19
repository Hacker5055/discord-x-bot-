import { AppError, errorFields } from '../lib/errors.js';
import { createPostgresStore } from './store.js';
import { createTursoStore } from './turso-store.js';

export function createCommunityStore({ config, log, turso = createTursoStore, postgres = createPostgresStore }) {
  // Once an operator opts into Turso, don't silently write to a different database, even during setup or a Turso outage.
  const backend = config.tursoUrl || config.tursoAuthToken ? 'turso' : config.databaseUrl ? 'postgres' : undefined;
  if (!backend) return undefined;
  const { guildId } = config;
  try {
    const store = backend === 'turso'
      ? turso({ url: config.tursoUrl, authToken: config.tursoAuthToken, guildId })
      : postgres({ connectionString: config.databaseUrl, ca: config.databaseCa, guildId, log });
    log.info('community_storage_configured', { backend });
    return store;
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'INVALID_CONFIG') throw error;
    log.warn('community_storage_config_invalid', { backend, ...errorFields(error), message: error.message });
    // Community storage is optional. Keep Discord commands and the original VIP API available.
    return undefined;
  }
}
