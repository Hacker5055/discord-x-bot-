export const CATEGORY_NAME = '🎮 BLACK X';
export const WEBHOOK_NAME = 'BLACK X Bot';

export const ROOMS = Object.freeze({
  updates: { name: '📢-تحديثات-الموقع', color: 0x3498DB, readOnly: true },
  support: { name: '🛠️-الدعم-الفني', color: 0xE67E22, readOnly: false },
  creators: { name: '🎬-صنّاع-المحتوى', color: 0x2ECC71, readOnly: false },
  offers: { name: '🎁-العروض-والخصومات', color: 0x9B59B6, readOnly: true },
});

// Insertion order is also the desired hierarchy (highest first).
export const ROLES = Object.freeze({
  vip_monarch: { name: '👑 · VIP Monarch', color: 0x9B59B6 },
  vip_basic: { name: '💠 · VIP Basic', color: 0x3498DB },
  creator: { name: '🎬 · Creator معتمد', color: 0x2ECC71 },
});

export const ROOM_KEYS = Object.keys(ROOMS);
export const ROLE_KEYS = Object.keys(ROLES);
export const CATEGORY_ENV = 'DISCORD_CHANNEL_CATEGORY';
export const roomEnv = (key) => `DISCORD_CHANNEL_${key.toUpperCase()}`;
export const roleEnv = (key) => `DISCORD_ROLE_${key.toUpperCase()}`;
export const webhookEnv = (key) => `DISCORD_WEBHOOK_${key.toUpperCase()}`;
export const roomMarker = (key) => `[BLACK X · ${key}]`;

export function isSnowflake(value) {
  return typeof value === 'string' && /^[1-9][0-9]{16,19}$/.test(value)
    && BigInt(value) <= 18446744073709551615n;
}

export function truncate(value, length) {
  // Discord's string limits are safe to enforce in UTF-16 units, without splitting an emoji.
  return value.slice(0, length).replace(/[\uD800-\uDBFF]$/u, '');
}
