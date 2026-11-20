import { isSnowflake } from '../lib/catalog.js';
import { AppError } from '../lib/errors.js';

export const SITE_PREFIX = '/api/site/v1/';
export const MAX_SITE_BODY = 8192;
export const validBridgeSecret = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/u.test(value);
const isRequestId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const textWithin = (max) => (value) => typeof value === 'string' && value.length <= max && Boolean(value.trim());
const id = { id: isSnowflake };
const reply = { ...id, body: textWithin(1000), requestId: isRequestId };
const routes = new Map(Object.entries({
  profile: {},
  dashboard: {},
  'tickets/list': {},
  'tickets/open': { type: (value) => ['site', 'report'].includes(value), requestId: isRequestId },
  'tickets/detail': id,
  'tickets/reply': reply,
  'staff/tickets/list': {},
  'staff/tickets/detail': id,
  'staff/tickets/claim': id,
  'staff/tickets/reply': reply,
  'staff/tickets/close': { ...id, reason: textWithin(250) },
  'staff/tickets/intake': { paused: (value) => typeof value === 'boolean' },
}));

export const knownSiteAction = (action) => routes.has(action);
export const staffSiteAction = (action) => action === 'dashboard' || action.startsWith('staff/');
export const invalidSiteBody = () => new AppError('INVALID_SITE_BODY', 'بيانات ربط الموقع غير صالحة.');

// Browser bodies have the same shape *except* for discordId. Reject it there rather than overriding it silently.
export function validateSiteBody(action, value, { browser = false } = {}) {
  const schema = routes.get(action);
  if (!schema || !value || typeof value !== 'object' || Array.isArray(value)) throw invalidSiteBody();
  const keys = Object.keys(schema);
  if (Object.keys(value).length !== keys.length + (browser ? 0 : 1) ||
    !keys.every((key) => Object.hasOwn(value, key) && schema[key](value[key])) ||
    (!browser && (!Object.hasOwn(value, 'discordId') || !isSnowflake(value.discordId)))) throw invalidSiteBody();
  return Object.hasOwn(value, 'requestId') ? { ...value, requestId: value.requestId.toLowerCase() } : value;
}
