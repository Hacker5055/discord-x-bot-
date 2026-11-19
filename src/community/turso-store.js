import { randomInt } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { AppError } from '../lib/errors.js';
import { newState, restoreState, storageUnavailable } from './store.js';

const CREATE = `CREATE TABLE IF NOT EXISTS bx_community_v1 (
  guild_id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
)`;
const SEED = 'INSERT INTO bx_community_v1 (guild_id, data) VALUES (?, ?) ON CONFLICT (guild_id) DO NOTHING';
const SELECT = 'SELECT data, revision FROM bx_community_v1 WHERE guild_id = ?';
const SAVE = 'UPDATE bx_community_v1 SET data = ?, revision = revision + 1 WHERE guild_id = ? AND revision = ?';
const conflicted = Symbol('conflicted');
class TursoBusy extends Error {}

function databaseEndpoint(url) {
  try {
    if (typeof url !== 'string' || !/^(?:https|libsql|turso):\/\//i.test(url) || /[\s\\?#]/u.test(url)) throw new Error();
    const endpoint = new URL(url);
    const host = endpoint.hostname.toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+turso\.io$/.test(host)
      || endpoint.username || endpoint.password || endpoint.port || !['', '/'].includes(endpoint.pathname)) throw new Error();
    return `https://${host}/v2/pipeline`;
  } catch {
    throw new AppError('INVALID_CONFIG', 'اضبط TURSO_DATABASE_URL كرابط قاعدة بيانات Turso Cloud، بدون كلمة سر أو معاملات في الرابط.');
  }
}

const ok = (step) => ({ type: 'ok', step });
const stmt = (sql, args = [], wantRows = false) => ({ sql, want_rows: wantRows,
  args: args.map((value) => typeof value === 'string' ? { type: 'text', value } : { type: 'integer', value: String(value) }) });

async function retryContention(action) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await action();
      if (result !== conflicted) return result;
    } catch (error) {
      if (!(error instanceof TursoBusy)) throw error;
    }
    if (attempt < 3) await wait(12 * (2 ** attempt) + randomInt(10));
  }
  throw storageUnavailable();
}

export function createTursoStore({ url, authToken, guildId, fetchImpl = globalThis.fetch }) {
  const endpoint = databaseEndpoint(url);
  if (typeof authToken !== 'string' || authToken.length > 8000 || !/^[A-Za-z0-9._~+/-]+=*$/.test(authToken)) {
    throw new AppError('INVALID_CONFIG', 'اضبط TURSO_AUTH_TOKEN بتوكن كتابة خاص بقاعدة البوت.');
  }
  const lifetime = new AbortController();

  // Turso Cloud's SQL over HTTP protocol works for both libSQL and Turso Database. Use a
  // self-contained, closed write transaction for each request so reads see the writer too.
  // https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md
  async function batch(...statements) {
    lifetime.signal.throwIfAborted();
    const commit = statements.length + 1;
    const steps = [
      { stmt: stmt('BEGIN IMMEDIATE') },
      ...statements.map((statement, index) => ({ stmt: statement, condition: ok(index) })),
      { stmt: stmt('COMMIT'), condition: ok(commit - 1) },
      { stmt: stmt('ROLLBACK'), condition: { type: 'and', conds: [ok(0), { type: 'not', cond: ok(commit) }] } },
    ];
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(4000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ requests: [{ type: 'batch', batch: { steps } }, { type: 'close' }] }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw storageUnavailable();
    }
    const body = await response.json();
    const [batchReply, closeReply] = body.results ?? [];
    if (body.baton != null || batchReply?.type !== 'ok' || batchReply.response?.type !== 'batch'
      || closeReply?.type !== 'ok' || closeReply.response?.type !== 'close') throw storageUnavailable();
    const { step_results: results, step_errors: errors } = batchReply.response.result;
    if (!Array.isArray(results) || !Array.isArray(errors) || results.length !== steps.length || errors.length !== steps.length) {
      throw storageUnavailable();
    }
    const failure = errors.find(Boolean);
    if (failure) {
      // Only retry a known lock rejection when BEGIN failed or the transaction was rolled back.
      // A timeout or malformed response can hide a successful COMMIT and must not be replayed.
      if (!results[commit] && (errors[0] || results[commit + 1]) && /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(failure.code ?? '')) {
        throw new TursoBusy();
      }
      throw storageUnavailable();
    }
    if (!results.slice(0, commit + 1).every(Boolean)) throw storageUnavailable();
    return results.slice(1, commit);
  }

  let initialized;
  function initialize() {
    initialized ??= retryContention(() => batch(stmt(CREATE), stmt(SEED, [guildId, JSON.stringify(newState())])))
      .catch((error) => { initialized = undefined; throw error; });
    return initialized;
  }

  async function load() {
    const [result] = await batch(stmt(SELECT, [guildId], true));
    const [json, version] = result.rows?.[0] ?? [];
    const revision = Number(version?.value);
    if (json?.type !== 'text' || typeof json.value !== 'string' || version?.type !== 'integer' || !Number.isSafeInteger(revision)
      || revision < 0 || String(revision) !== version.value) throw storageUnavailable();
    const data = JSON.parse(json.value);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw storageUnavailable();
    return { state: restoreState(data), revision };
  }

  return {
    async read() {
      try {
        await initialize();
        return (await retryContention(load)).state;
      } catch { throw storageUnavailable(); }
    },
    async update(mutator) {
      try {
        await initialize();
        return await retryContention(async () => {
          const { state, revision } = await load();
          const before = JSON.stringify(state);
          // A revision conflict reruns this synchronous mutation on fresh state. Keep I/O outside it.
          const result = mutator(state);
          if (result && typeof result.then === 'function') {
            void Promise.resolve(result).catch(() => {});
            throw new TypeError('Storage mutators must be synchronous');
          }
          const after = JSON.stringify(state);
          if (before === after) return result;
          const [saved] = await batch(stmt(SAVE, [after, guildId, revision]));
          if (saved.affected_row_count === 1) return result;
          if (saved.affected_row_count === 0) return conflicted;
          throw storageUnavailable();
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw storageUnavailable();
      }
    },
    close: () => lifetime.abort(),
  };
}
