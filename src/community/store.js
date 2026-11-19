import pg from 'pg';
import { AppError } from '../lib/errors.js';

export const newState = () => ({ catalog: {}, follows: {}, episodes: {}, parties: {}, jobs: {}, daily: null, lastDaily: null, scores: {} });
export const restoreState = (data) => ({ ...newState(), ...data });
export const storageUnavailable = () => new AppError('COMMUNITY_STORAGE_UNAVAILABLE', 'التخزين الدائم غير متاح الآن. جرّب لاحقًا.', 503);

export function requireStore(store) {
  if (!store) throw new AppError('COMMUNITY_STORAGE_REQUIRED', 'الميزة تحتاج تخزينًا دائمًا. اطلب من الإدارة ضبط TURSO_DATABASE_URL وTURSO_AUTH_TOKEN، أو DATABASE_URL لـPostgreSQL.', 503);
  return store;
}

// Same transaction contract as Postgres, without a database for tests.
export function createMemoryStore(initial = newState()) {
  let state = structuredClone(initial);
  let pending = Promise.resolve();
  return {
    async read() { await pending; return structuredClone(state); },
    update(mutator) {
      const operation = pending.then(() => {
        const draft = structuredClone(state);
        const result = mutator(draft);
        state = draft;
        return structuredClone(result);
      });
      pending = operation.catch(() => {});
      return operation;
    },
    async close() { await pending; },
  };
}

export function databaseOptions(connectionString, ca) {
  let url;
  try {
    url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error();
  } catch {
    throw new AppError('INVALID_CONFIG', 'قيمة DATABASE_URL غير صالحة في إعدادات البوت.');
  }
  // Keep TLS policy in code; pg URL options must not override it. Only loopback dev DBs can use cleartext.
  url.search = '';
  url.hash = '';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return {
    connectionString: url.href,
    ssl: local && !ca ? false : { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}) },
    max: 3, connectionTimeoutMillis: 4000, statement_timeout: 5000, query_timeout: 6500,
  };
}

export function createPostgresStore({ connectionString, ca, guildId, log, pool = new pg.Pool(databaseOptions(connectionString, ca)) }) {
  pool.on('error', () => log.warn('community_storage_connection_lost'));
  let initialized;
  async function initialize() {
    initialized ??= (async () => {
      await pool.query('CREATE TABLE IF NOT EXISTS bx_community_v1 (guild_id text PRIMARY KEY, data jsonb NOT NULL)');
      await pool.query('INSERT INTO bx_community_v1 (guild_id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [guildId, JSON.stringify(newState())]);
    })().catch((error) => { initialized = undefined; throw error; });
    await initialized;
  }
  const sql = 'SELECT data FROM bx_community_v1 WHERE guild_id = $1';
  return {
    async read() {
      try {
        await initialize();
        const { rows } = await pool.query(sql, [guildId]);
        return restoreState(rows[0].data);
      } catch { throw storageUnavailable(); }
    },
    async update(mutator) {
      let client;
      try {
        await initialize();
        client = await pool.connect();
        await client.query('BEGIN');
        const { rows } = await client.query(`${sql} FOR UPDATE`, [guildId]);
        const state = restoreState(rows[0].data);
        const before = JSON.stringify(state);
        const result = mutator(state);
        const after = JSON.stringify(state);
        if (before !== after) await client.query('UPDATE bx_community_v1 SET data = $2 WHERE guild_id = $1', [guildId, after]);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (error instanceof AppError) throw error;
        throw storageUnavailable();
      } finally {
        client?.release();
      }
    },
    close: () => pool.end(),
  };
}

export const MAX_JOBS = 2000;
export function queueJob(state, id, job) {
  if (Object.hasOwn(state.jobs, id)) return false;
  if (Object.keys(state.jobs).length >= MAX_JOBS) throw new AppError('COMMUNITY_QUEUE_FULL', 'قائمة التنبيهات ممتلئة مؤقتًا. جرّب لاحقًا.', 503);
  state.jobs[id] = { ...job, attempts: 0 };
  return true;
}
