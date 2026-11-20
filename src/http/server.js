import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { AppError, describeError, errorFields } from '../lib/errors.js';

const MAX_BODY = 8192;
const MAX_ANIME_BODY = 128 * 1024;
const hash = (value) => createHash('sha256').update(value).digest();

function createLimiter(limit, windowMs, now, maxIPs = 10_000) {
  let expires = now() + windowMs;
  const counts = new Map();
  return (ip) => {
    const time = now();
    if (time >= expires) {
      counts.clear();
      expires = time + windowMs;
    }
    const count = counts.get(ip) ?? 0;
    if (count >= limit || (!counts.has(ip) && counts.size >= maxIPs)) return Math.max(1, Math.ceil((expires - time) / 1000));
    counts.set(ip, count + 1);
    return 0;
  };
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}

const invalidBody = () => new AppError('INVALID_BODY', 'أرسل JSON فيه discordId وroleKey فقط.');

const invalidAnimeBody = () => new AppError('INVALID_ANIME_DATA', 'أرسل بيانات التكامل بصيغة JSON صالحة.');

async function readJsonBody(req, invalid, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')
    || Number(req.headers['content-length']) > maxBytes) throw invalid();

  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      length += chunk.length;
      if (length > maxBytes) throw invalid();
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw invalid();
  }
}

async function readRoleBody(req) {
  const data = await readJsonBody(req, invalidBody, MAX_BODY);
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).length !== 2
    || !Object.hasOwn(data, 'discordId') || !Object.hasOwn(data, 'roleKey')) throw invalidBody();
  return data;
}

export function createHttpServer({ apiSecret, roles, anime, getHealth, log, catalogMonitor, limit = 60, windowMs = 60_000, now = Date.now }) {
  const expected = hash(apiSecret);
  const rateLimit = createLimiter(limit, windowMs, now);

  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (req, res) => {
    const started = now();
    const method = ['GET', 'POST'].includes(req.method) ? req.method : 'OTHER';
    const path = (req.url ?? '').split('?', 1)[0];
    const rolePath = /^\/api\/roles\/([^/]+)$/.exec(path);
    const action = method === 'POST' && rolePath && ['grant', 'revoke'].includes(rolePath[1]) ? rolePath[1] : undefined;
    const route = method === 'GET' && path === '/health' ? 'health' : action
      ?? (method === 'GET' && rolePath ? 'list_roles'
        : method === 'POST' && path === '/api/anime/catalog' ? 'anime_catalog'
          : method === 'POST' && path === '/api/anime/episodes' ? 'anime_episode' : 'unknown');
    let status = 500;
    let failure = {};
    let authenticated = false;
    try {
      // Do not trust client-provided forwarding headers.
      const retry = rateLimit(req.socket.remoteAddress ?? 'unknown');
      if (retry) {
        res.setHeader('Retry-After', retry);
        throw new AppError('RATE_LIMITED', 'طلبات كثيرة؛ جرّب بعد قليل.', 429);
      }
      const supplied = req.headersDistinct['x-bx-secret'];
      if (supplied?.length !== 1 || !timingSafeEqual(hash(supplied[0]), expected)) {
        throw new AppError('UNAUTHORIZED', 'ترويسة X-BX-Secret ناقصة أو غير صحيحة.', 401);
      }

      authenticated = true;
      let result;
      if (route === 'health') {
        result = await getHealth();
        status = result.ok ? 200 : 503;
      } else if (action) {
        const { discordId, roleKey } = await readRoleBody(req);
        result = { ok: true, ...await roles.change(action, discordId, roleKey) };
        status = 200;
      } else if (route === 'list_roles') {
        result = { ok: true, ...await roles.list(rolePath[1]) };
        status = 200;
      } else if (route === 'anime_catalog' || route === 'anime_episode') {
        if (!anime) throw new AppError('COMMUNITY_STORAGE_REQUIRED', 'تكامل الأنمي غير جاهز.', 503);
        const data = await readJsonBody(req, invalidAnimeBody, route === 'anime_catalog' ? MAX_ANIME_BODY : MAX_BODY);
        const update = route === 'anime_catalog' ? await anime.updateCatalog(data) : await anime.receiveEpisode(data);
        result = { ok: true, ...update };
        status = route === 'anime_episode' && !update.duplicate ? 202 : 200;
      } else {
        throw new AppError('NOT_FOUND', 'المسار غير موجود.', 404);
      }
      send(res, status, result);
    } catch (error) {
      const mapped = errorFields(error);
      status = error instanceof AppError ? error.status : 502;
      const code = error instanceof AppError ? error.code : 'DISCORD_REJECTED';
      failure = { ...mapped, code };
      if (authenticated && route === 'anime_catalog') catalogMonitor?.reject({ at: now(), status, code });
      if (!req.complete && !req.destroyed) {
        res.setHeader('Connection', 'close');
        req.resume();
      }
      if (!res.destroyed) send(res, status, { ok: false, code, message: describeError(error) });
    } finally {
      log.info('http_request', { method, route, status, durationMs: now() - started, ...failure });
    }
  });
}
