import { CATEGORY_ENV, ROLE_KEYS, ROOM_KEYS, isSnowflake, roleEnv, roomEnv, webhookEnv } from './catalog.js';
import { AppError } from './errors.js';

function invalid(key) {
  return new AppError('INVALID_CONFIG', `قيمة ${key} ناقصة أو غير صالحة في إعدادات البيئة.`);
}

function readId(value, key) {
  if (!isSnowflake(value)) throw invalid(key);
  return value;
}

function parseWebhookRef(value, key) {
  if (isSnowflake(value)) return value;
  // Never retain or use a webhook credential. A URL is an optional reference to its ID only.
  const match = /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord\.com|discordapp\.com)\/api\/(?:v\d+\/)?webhooks\/([0-9]+)\/[A-Za-z0-9_.-]+$/.exec(value);
  if (!match || !isSnowflake(match[1])) throw invalid(key);
  return match[1];
}

function optionalRefs(env, keys, envKey, parse = readId) {
  const entries = [];
  const used = new Set();
  for (const key of keys) {
    const name = envKey(key);
    const value = env[name]?.trim();
    if (!value) continue;
    const id = parse(value, name);
    if (used.has(id)) throw invalid(name);
    used.add(id);
    entries.push([key, id]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function readConfig(env = process.env) {
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  const apiSecret = env.BOT_API_SECRET;
  if (!botToken || /[^!-~]/.test(botToken)) throw invalid('DISCORD_BOT_TOKEN');
  if (!apiSecret || /[^!-~]|,/.test(apiSecret)) throw invalid('BOT_API_SECRET');
  const guildId = readId(env.DISCORD_GUILD_ID?.trim() || env.ALLOWED_GUILD_ID?.trim(), 'DISCORD_GUILD_ID');
  if (env.ALLOWED_GUILD_ID?.trim() && env.ALLOWED_GUILD_ID.trim() !== guildId) throw invalid('ALLOWED_GUILD_ID');
  const ownerId = readId(env.BX_OWNER_DISCORD_ID?.trim(), 'BX_OWNER_DISCORD_ID');
  const portText = env.PORT?.trim() || '8080';
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) throw invalid('PORT');

  const categoryRef = env[CATEGORY_ENV]?.trim();
  const categoryId = categoryRef ? readId(categoryRef, CATEGORY_ENV) : undefined;
  const channelIds = optionalRefs(env, ROOM_KEYS, roomEnv);
  if (categoryId && Object.values(channelIds).includes(categoryId)) throw invalid(CATEGORY_ENV);

  return Object.freeze({
    botToken, apiSecret, guildId, ownerId, port, categoryId, channelIds,
    adminVoice: env.BX_ADMIN_VOICE === '1', adminAutoMod: env.BX_ADMIN_AUTOMOD === '1',
    databaseUrl: env.DATABASE_URL?.trim() || undefined, databaseCa: env.BX_DATABASE_CA?.trim() || undefined,
    tursoUrl: env.TURSO_DATABASE_URL?.trim() || undefined, tursoAuthToken: env.TURSO_AUTH_TOKEN?.trim() || undefined,
    roleIds: optionalRefs(env, ROLE_KEYS, roleEnv),
    webhookIds: optionalRefs(env, ROOM_KEYS, webhookEnv, parseWebhookRef),
  });
}

export function loadConfig() {
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if (error.code !== 'ENOENT') throw invalid('.env');
  }
  return readConfig();
}
