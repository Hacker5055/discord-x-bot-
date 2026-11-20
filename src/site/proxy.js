import { isSnowflake } from '../lib/catalog.js';
import { AppError } from '../lib/errors.js';
import { invalidSiteBody, knownSiteAction, MAX_SITE_BODY, SITE_PREFIX, staffSiteAction, validBridgeSecret, validateSiteBody } from './contract.js';

export const PROFILE_PROXY_PREFIX = '/api/profile/discord/v1/';
const MAX_REPLY_BYTES = 512 * 1024;
const json = (status, data, retry) => Response.json(data, { status, headers: {
  'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', ...(retry ? { 'retry-after': retry } : {}),
} });
const errorResponse = (status, code, message) => json(status, { ok: false, code, message });
const unavailable = () => errorResponse(503, 'SITE_BRIDGE_UNAVAILABLE', 'الاتصال ببوت BLACK X مش متاح دلوقتي.');

function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.href !== `${url.origin}/`) throw new TypeError('Expected an HTTPS origin');
  return url.origin;
}

async function boundedJson(message, limit, error) {
  if (!/^application\/json(?:\s*;|$)/i.test(message.headers.get('content-type') ?? '') ||
    !message.body || Number(message.headers.get('content-length')) > limit) {
    await message.body?.cancel().catch(() => {});
    throw error();
  }
  const reader = message.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      length += value.byteLength;
      if (length > limit) throw error();
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw error();
  } finally { reader.releaseLock(); }
}

/**
 * Integration adapter for the SITE SERVER, never for the React/browser bundle.
 * Host must supply its actual session verifier, unique active OAuth link lookup, and staff authorization.
 * No identity, user roles, headers, or URLs from the request are forwarded to the bot.
 */
export function createProfileProxy({ siteOrigin, botOrigin, secret, getSession, getVerifiedDiscordId,
  isStaff = () => false, fetchImpl = fetch, timeoutMs = 22_000 }) {
  const origin = httpsOrigin(siteOrigin);
  const bot = httpsOrigin(botOrigin);
  if (!validBridgeSecret(secret) || typeof getSession !== 'function' || typeof getVerifiedDiscordId !== 'function' ||
    typeof isStaff !== 'function') throw new TypeError('Site bridge requires its server secret and authentication callbacks');
  return async (request) => {
    const { pathname, search } = new URL(request.url);
    const action = pathname.startsWith(PROFILE_PROXY_PREFIX) && !search ? pathname.slice(PROFILE_PROXY_PREFIX.length) : '';
    if (request.method !== 'POST' || !knownSiteAction(action)) return errorResponse(404, 'NOT_FOUND', 'المسار غير موجود.');
    const fetchSite = request.headers.get('sec-fetch-site');
    if (request.headers.get('origin') !== origin || (fetchSite !== null && fetchSite !== 'same-origin')) {
      return errorResponse(403, 'SITE_ORIGIN', 'الطلب لازم ييجي من الموقع نفسه.');
    }
    try {
      const session = await getSession(request);
      if (!session) return errorResponse(401, 'SITE_SESSION_REQUIRED', 'سجّل دخولك في الموقع الأول.');
      if (staffSiteAction(action) && await isStaff(session) !== true) {
        return errorResponse(403, 'SITE_STAFF_REQUIRED', 'لوحة البوت متاحة للفريق المصرّح له بس.');
      }
      const body = validateSiteBody(action, await boundedJson(request, MAX_SITE_BODY, invalidSiteBody), { browser: true });
      const discordId = await getVerifiedDiscordId(session);
      if (!isSnowflake(discordId)) return errorResponse(409, 'SITE_DISCORD_LINK_REQUIRED', 'اربط حساب ديسكورد وتأكد من الربط الأول.');

      const upstream = await fetchImpl(`${bot}${SITE_PREFIX}${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BX-Bridge-Secret': secret },
        body: JSON.stringify({ ...body, discordId }), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
      });
      const result = await boundedJson(upstream, MAX_REPLY_BYTES, () => new Error('Unexpected bot response'));
      if (upstream.ok ? result?.ok !== true : result?.ok !== false || typeof result.code !== 'string') return unavailable();
      if ([401, 404].includes(upstream.status) && ['NOT_FOUND', 'UNAUTHORIZED'].includes(result.code)) return unavailable();
      const retry = upstream.headers.get('retry-after');
      // Do not proxy any upstream headers besides a bounded Retry-After on rate limiting.
      return json(upstream.status, result, upstream.status === 429 && /^[1-9]\d{0,3}$/u.test(retry ?? '') ? retry : undefined);
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_SITE_BODY') return errorResponse(error.status, error.code, error.message);
      return unavailable();
    }
  };
}
