import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { ChannelType as C, PermissionFlagsBits as P } from 'discord.js';
import { adminOf } from '../src/admin/core.js';
import { SITE_ORIGIN } from '../src/community/anime.js';
import { createHttpServer } from '../src/http/server.js';
import { readConfig } from '../src/lib/env.js';
import { DiscordApiError } from '../src/lib/errors.js';
import { createSiteBridge } from '../src/site/bridge.js';
import { SITE_PREFIX } from '../src/site/contract.js';
import { createProfileProxy, PROFILE_PROXY_PREFIX } from '../src/site/proxy.js';
import { ANIME, REVIEWER, STRANGER, adminFixture, own } from './fixtures/admin.js';
import { BOT_ID, FAKE_API_SECRET, FAKE_BOT_TOKEN, GUILD_ID, MEMBER_ID, MISSING_MEMBER_ID, MOD_ID, OWNER_ID, fixtureEnv } from './fixtures/discord.js';

const BRIDGE_SECRET = 'mock_site_only_secret_not_for_production';
const TEST_BOT_ORIGIN = 'https://bot.example.invalid';
const reason = 'المشكلة اتحلت';
const staffScope = (f) => f.make({ by: MOD_ID, channel: f.staffRoom });

async function startServer(t, f, { admin = f.admin, ...options } = {}) {
  const getHealth = () => ({ ok: true, uptime: 120, bot: { id: BOT_ID, ready: true }, guild: { id: GUILD_ID, memberCount: 23 } });
  const siteBridge = createSiteBridge({ admin, getHealth });
  const server = createHttpServer({ apiSecret: f.config.apiSecret, getHealth, roles: f.roles, anime: f.anime, log: f.log, now: f.now,
    siteBridgeSecret: f.config.siteBridgeSecret, siteBridge, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (action, data, headers = { 'X-BX-Bridge-Secret': BRIDGE_SECRET }) => fetch(`${base}${SITE_PREFIX}${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof data === 'string' ? data : JSON.stringify(data),
  });
  return { base, call };
}

async function activate(f, { staff = true } = {}) {
  const category = await f.chan(C.GuildCategory, 'ticket-category');
  await f.room('ticket_panel', f.publicRoom);
  await f.room('ticket_category', category);
  const role = await f.team('support');
  if (staff) await f.room('site_staff', f.staffRoom);
  await f.enable();
  await f.admin.config.bridge(f.make(), { enabled: true });
  return { category, role };
}

async function check(awaitResponse, status, code) {
  const response = await awaitResponse;
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  assert.equal(data.ok, status < 300);
  if (code) assert.equal(data.code, code);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.has('access-control-allow-origin'), false);
  return data;
}

function siteProxyFixture(transport) {
  const forwarded = [];
  const accounts = new Map([
    ['member', { link: MEMBER_ID }], ['staff', { link: MOD_ID, staff: true }], ['owner', { link: OWNER_ID, staff: true }],
    ['other', { link: STRANGER }], ['website-admin', { link: STRANGER, staff: true }], ['unlinked', { link: null }],
  ]);
  const proxy = createProfileProxy({ siteOrigin: SITE_ORIGIN, botOrigin: TEST_BOT_ORIGIN, secret: BRIDGE_SECRET,
    getSession: async (request) => accounts.get(request.headers.get('authorization')?.slice('Bearer '.length)),
    getVerifiedDiscordId: async (session) => session.link, isStaff: async (session) => session.staff === true,
    fetchImpl: (url, options) => {
      assert.equal(new URL(url).origin, TEST_BOT_ORIGIN);
      assert.deepEqual(options.headers, { 'Content-Type': 'application/json', 'X-BX-Bridge-Secret': BRIDGE_SECRET });
      assert.equal(options.redirect, 'error');
      forwarded.push({ path: new URL(url).pathname, ...JSON.parse(options.body) });
      return transport(url, options);
    },
  });
  return { accounts, forwarded, request: (account, action, fields = {}, origin = SITE_ORIGIN) => proxy(new Request(`${SITE_ORIGIN}${PROFILE_PROXY_PREFIX}${action}`, {
    method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', authorization: `Bearer ${account}` },
    body: JSON.stringify(fields),
  })) };
}

test('site auth is separate and default off; strict protocol validation never reaches Discord', async (t) => {
  const noSecret = await adminFixture();
  const disabled = await startServer(t, noSecret);
  await check(disabled.call('profile', { discordId: MEMBER_ID }), 404, 'NOT_FOUND');
  await assert.rejects(noSecret.admin.config.bridge(noSecret.make(), { enabled: true }), { code: 'SITE_BRIDGE_CONFIG' });
  assert.throws(() => readConfig({ ...fixtureEnv(), BX_SITE_BRIDGE_SECRET: FAKE_API_SECRET }), { code: 'INVALID_CONFIG' });
  assert.throws(() => readConfig({ ...fixtureEnv(), BX_SITE_BRIDGE_SECRET: 'short' }), { code: 'INVALID_CONFIG' });
  const f = await adminFixture({ bridgeSecret: BRIDGE_SECRET });
  const { base, call } = await startServer(t, f);
  await check(call('profile', { discordId: MEMBER_ID }), 503, 'SITE_BRIDGE_DISABLED');
  await assert.rejects(f.admin.config.bridge(f.make({ by: MOD_ID }), { enabled: true }), { code: 'OWNER_REQUIRED' });
  await f.admin.config.bridge(f.make(), { enabled: true });
  const before = f.api.operations.length;
  await check(call('profile', { discordId: MEMBER_ID }, { 'X-BX-Secret': FAKE_API_SECRET }), 401, 'UNAUTHORIZED');
  await check(call('profile', { discordId: MEMBER_ID }, { 'X-BX-Bridge-Secret': `${BRIDGE_SECRET}, ${BRIDGE_SECRET}` }), 401, 'UNAUTHORIZED');
  await check(call('profile', { discordId: Number(MEMBER_ID) }), 400, 'INVALID_SITE_BODY');
  await check(call('profile', { discordId: MEMBER_ID, guildId: GUILD_ID }), 400, 'INVALID_SITE_BODY');
  await check(call('profile', 'oops'), 400, 'INVALID_SITE_BODY');
  await check(call('profile', ' '.repeat(8193)), 400, 'INVALID_SITE_BODY');
  await check(call('tickets/open', { type: 'site', discordId: MEMBER_ID, requestId: 'invalid' }), 400, 'INVALID_SITE_BODY');
  await check(call('staff/tickets/intake', { discordId: MEMBER_ID, paused: 'false' }), 400, 'INVALID_SITE_BODY');
  await check(call('constructor', { discordId: MEMBER_ID }), 404, 'NOT_FOUND');
  await check(fetch(`${base}/health`, { headers: { 'X-BX-Bridge-Secret': BRIDGE_SECRET } }), 401, 'UNAUTHORIZED');
  await check(fetch(`${base}/health`, { headers: { 'X-BX-Secret': FAKE_API_SECRET } }), 200);
  assert.equal(f.api.operations.length, before);
  const profile = await check(call('profile', { discordId: MEMBER_ID }), 200);
  assert.equal(profile.capabilities.canUseTickets, false);
  assert.equal((await check(call('dashboard', { discordId: OWNER_ID }), 200)).adminEnabled, false);
  assert.doesNotMatch(f.logs.join('\n'), new RegExp(`${BRIDGE_SECRET}|${FAKE_API_SECRET}|${FAKE_BOT_TOKEN}|${MEMBER_ID}`));
});

test('site proxy requires origin, real session and current link; live guild membership and product roles are not cached', async (t) => {
  const f = await adminFixture({ bridgeSecret: BRIDGE_SECRET, setup: true });
  await activate(f);
  const { base } = await startServer(t, f);
  const site = siteProxyFixture((url, options) => fetch(base + new URL(url).pathname, options));
  const { request } = site;
  await check(request('owner', 'dashboard', {}, 'https://different.example'), 403, 'SITE_ORIGIN');
  await check(request('anonymous', 'profile'), 401, 'SITE_SESSION_REQUIRED');
  await check(request('unlinked', 'profile'), 409, 'SITE_DISCORD_LINK_REQUIRED');
  await check(request('member', 'dashboard'), 403, 'SITE_STAFF_REQUIRED');
  await check(request('member', 'profile', { discordId: OWNER_ID }), 400, 'INVALID_SITE_BODY');
  assert.equal(site.forwarded.length, 0);
  await f.roles.change('grant', MEMBER_ID, 'vip_basic');
  const profile = await check(request('member', 'profile'), 200);
  assert.deepEqual(profile, { ok: true, discordId: MEMBER_ID, guildId: GUILD_ID, membership: 'member', roles: ['vip_basic'],
    capabilities: { canUseTickets: true, canOpenTicket: true, canViewDashboard: false } });
  await f.roles.change('revoke', MEMBER_ID, 'vip_basic');
  assert.deepEqual((await check(request('member', 'profile'), 200)).roles, []);
  f.api.members.get(MEMBER_ID).pending = true;
  assert.equal((await check(request('member', 'profile'), 200)).membership, 'pending');
  await check(request('member', 'tickets/list'), 403, 'SITE_MEMBER_PENDING');
  site.accounts.get('member').link = MISSING_MEMBER_ID;
  assert.equal((await check(request('member', 'profile'), 200)).membership, 'not_member');
  await check(request('member', 'tickets/list'), 403, 'SITE_NOT_MEMBER');
  await check(request('website-admin', 'dashboard'), 403, 'ADMIN_SCOPE');
  f.api.members.get(STRANGER).pending = false;
  f.api.members.get(STRANGER).communication_disabled_until = new Date(f.now() + 600_000).toISOString();
  assert.equal((await check(request('other', 'profile'), 200)).capabilities.canUseTickets, false);
  await check(request('other', 'tickets/list'), 403, 'ADMIN_SCOPE');
  site.accounts.get('member').link = null;
  await check(request('member', 'profile'), 409, 'SITE_DISCORD_LINK_REQUIRED');
});

test('website and Discord share one private ticket, scoped staff state, explicit messages, and archived status', async (t) => {
  const f = await adminFixture({ bridgeSecret: BRIDGE_SECRET });
  const { category, role } = await activate(f);
  const { base } = await startServer(t, f);
  const { request } = siteProxyFixture((url, options) => fetch(base + new URL(url).pathname, options));
  const fields = { type: 'report', requestId: randomUUID() };
  const both = await Promise.all([check(request('member', 'tickets/open', fields), 200), check(request('member', 'tickets/open', fields), 200)]);
  const { id, discordUrl } = both[0].ticket;
  assert.equal(both[1].ticket.id, id);
  assert.equal(both[0].ticket.origin, 'site');
  const ch = f.api.channel(discordUrl.split('/').at(-1));
  assert.equal(ch.topic, `bx-ticket:${id}`);
  assert.equal(ch.parent_id, category.id);
  assert.deepEqual(new Set(ch.permission_overwrites.map((o) => o.id)), new Set([GUILD_ID, role.id, BOT_ID, MEMBER_ID]));
  assert.equal(ch.permission_overwrites.find(({ id }) => id === GUILD_ID).deny, String(P.ViewChannel));
  assert.equal(f.api.channels.filter((c) => c.parent_id === category.id).length, 1);
  assert.match((await f.admin.ticket.open(f.make({ by: MEMBER_ID }), { type: 'site' }))[0], new RegExp(ch.id));
  await check(request('member', 'tickets/open', { ...fields, type: 'site' }), 409, 'SITE_REQUEST_CONFLICT');
  await check(request('member', 'tickets/open', { ...fields, requestId: randomUUID() }), 409, 'ADMIN_DUPLICATE_REQUEST');
  await check(request('other', 'tickets/detail', { id }), 404, 'ADMIN_NOT_FOUND');
  await check(request('other', 'tickets/reply', { id, body: 'cannot post', requestId: randomUUID() }), 404, 'ADMIN_NOT_FOUND');
  assert.deepEqual((await check(request('other', 'tickets/list'), 200)).tickets, []);

  const shared = { id, body: 'طلب حقيقي من الموقع @everyone', requestId: randomUUID() };
  const sent = await check(request('member', 'tickets/reply', shared), 200);
  assert.equal(sent.message.delivery, 'sent');
  assert.deepEqual(f.api.messages.at(-1).data.allowed_mentions, { parse: [] });
  assert.equal(f.api.messages.at(-1).channelId, ch.id);
  assert.deepEqual((await check(request('member', 'tickets/reply', shared), 200)).message, sent.message);
  await check(request('member', 'tickets/reply', { ...shared, body: 'changed' }), 409, 'SITE_REQUEST_CONFLICT');
  await check(request('staff', 'staff/tickets/claim', { id }), 200);
  assert.match((await f.admin.staff.inbox(staffScope(f), { team: 'support' })).join(' '), new RegExp(MOD_ID));
  await f.admin.ticket.reply(staffScope(f), { id, body: 'Discord only' });
  await f.admin.ticket.reply(staffScope(f), { id, body: 'Both sides', share: true });
  const share = f.make({ by: MEMBER_ID, channel: ch, command: 'ticket', action: 'share', fields: { id, body: 'صاحب التذكرة من ديسكورد' } });
  await f.invoke(share);
  assert.match(share.replies[1][1].content, /واتشارك/);
  const detail = await check(request('member', 'tickets/detail', { id }), 200);
  assert.equal(detail.ticket.status, 'claimed');
  assert.equal(detail.ticket.firstReplyAt, f.now());
  assert.equal(Object.hasOwn(detail.ticket, 'requesterDiscordId'), false);
  assert.deepEqual(detail.messages.map((m) => [m.origin, m.side, m.body]), [['site', 'requester', shared.body],
    ['discord', 'support', 'Both sides'], ['discord', 'requester', 'صاحب التذكرة من ديسكورد']]);
  assert.equal((await check(request('staff', 'staff/tickets/detail', { id }), 200)).ticket.requesterDiscordId, MEMBER_ID);
  await check(request('staff', 'tickets/detail', { id }), 404, 'ADMIN_NOT_FOUND');
  await check(request('staff', 'staff/tickets/reply', { id, body: 'تم الحل', requestId: randomUUID() }), 200);
  await check(request('staff', 'staff/tickets/close', { id, reason }), 200);
  const archive = await check(request('member', 'tickets/detail', { id }), 200);
  assert.equal(archive.ticket.status, 'closed');
  assert.equal(archive.ticket.writable, false);
  assert.equal(archive.reason, reason);
  assert.equal(ch.permission_overwrites.find((o) => o.id === MEMBER_ID).deny, String(P.SendMessages));
  assert.equal((await check(request('member', 'tickets/open', fields), 200)).ticket.id, id);
  await check(request('member', 'tickets/reply', { ...shared, requestId: randomUUID() }), 409, 'ADMIN_STALE');
  assert.equal(f.api.operations.filter((o) => ['getMessage', 'createDm'].includes(o.operation)).length, 0);
  assert.doesNotMatch(f.logs.join('\n'), /طلب حقيقي|Discord only|Both sides/);
});

test('Discord-created tickets exist on the website, and dashboard controls intake in both directions', async (t) => {
  const f = await adminFixture({ bridgeSecret: BRIDGE_SECRET });
  const { role } = await activate(f, { staff: false });
  const { call } = await startServer(t, f);
  await f.anime.updateCatalog({ items: [{ ...ANIME, id: 'z' }, { ...ANIME, id: 'a' }] });
  const i = f.make({ by: MEMBER_ID });
  await f.admin.ticket.open(i, { type: 'site' });
  const mine = await check(call('tickets/list', { discordId: MEMBER_ID }), 200);
  assert.deepEqual(mine.tickets.map((r) => [r.id, r.origin]), [[i.id, 'discord']]);
  await check(call('dashboard', { discordId: MOD_ID }), 403, 'ADMIN_SCOPE');
  await f.room('site_staff', f.staffRoom);
  const scoped = await check(call('dashboard', { discordId: MOD_ID }), 200);
  assert.equal(scoped.tickets.canSetIntake, false);
  assert.equal(scoped.health.uptimeSeconds, 120);
  f.api.members.get(REVIEWER).roles = [role.id];
  f.api.channel(f.staffRoom.id).permission_overwrites.push(own(REVIEWER, 0n, P.ViewChannel));
  await check(call('staff/tickets/list', { discordId: REVIEWER }), 403, 'ADMIN_SCOPE');
  await check(call('staff/tickets/intake', { discordId: MOD_ID, paused: true }), 403, 'OWNER_REQUIRED');
  await check(call('staff/tickets/intake', { discordId: OWNER_ID, paused: true }), 200);
  const dashboard = await check(call('dashboard', { discordId: OWNER_ID }), 200);
  assert.equal(dashboard.tickets.paused, true);
  assert.equal(dashboard.tickets.counts.open, 1);
  assert.equal(dashboard.catalog.count, 2);
  assert.equal(dashboard.catalog.idsSha256, createHash('sha256').update('a\nz').digest('hex'));
  assert.deepEqual(dashboard.catalog.lastAccepted, { at: f.now(), batch: 2, removed: 0 });
  await check(call('tickets/open', { discordId: STRANGER, type: 'site', requestId: randomUUID() }), 409, 'ADMIN_PAUSED');
  await assert.rejects(f.admin.ticket.open(f.make({ by: STRANGER }), { type: 'site' }), { code: 'ADMIN_PAUSED' });
  await check(call('tickets/reply', { discordId: MEMBER_ID, id: i.id, body: 'still works', requestId: randomUUID() }), 200);
  await f.admin.ticket.close(staffScope(f), { id: i.id, reason });
  assert.equal((await check(call('tickets/detail', { discordId: MEMBER_ID, id: i.id }), 200)).ticket.status, 'closed');
  await f.admin.config.pause(f.make(), { module: 'tickets', paused: false });
  assert.equal((await check(call('dashboard', { discordId: OWNER_ID }), 200)).tickets.paused, false);
  await f.admin.config.unteam(f.make(), { team: 'support' });
  await check(call('staff/tickets/list', { discordId: MOD_ID }), 403, 'ADMIN_SCOPE');
  await f.admin.config.bridge(f.make(), { enabled: false });
  await check(call('tickets/list', { discordId: MEMBER_ID }), 503, 'SITE_BRIDGE_DISABLED');
});

test('tampered rooms never receive shared content, and already-stored content is withheld when room privacy changes', async (t) => {
  const f = await adminFixture({ bridgeSecret: BRIDGE_SECRET });
  await activate(f);
  const { call } = await startServer(t, f);
  const open = await check(call('tickets/open', { discordId: MEMBER_ID, type: 'site', requestId: randomUUID() }), 200);
  const { id, discordUrl } = open.ticket;
  const ch = f.api.channel(discordUrl.split('/').at(-1));
  const reply = { discordId: MEMBER_ID, id, body: 'private information', requestId: randomUUID() };
  await check(call('tickets/reply', reply), 200);
  const getChannel = f.api.getChannel.bind(f.api);
  f.api.getChannel = (id) => {
    ch.permission_overwrites.push(own(STRANGER, P.ViewChannel));
    return getChannel(id);
  };
  await check(call('tickets/reply', { ...reply, body: 'not sent', requestId: randomUUID() }), 409, 'ADMIN_TICKET_PRIVACY');
  assert.equal(f.api.messages.length, 1);
  const result = await check(call('tickets/detail', { discordId: MEMBER_ID, id }), 200);
  assert.equal(result.ticket.roomState, 'blocked');
  assert.equal(result.ticket.discordUrl, null);
  assert.equal(result.ticket.writable, false);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(adminOf(await f.store.read()).requests[id].shared.map((r) => r.body), [reply.body]);
  const writes = f.api.writes.length;
  await check(call('staff/tickets/close', { discordId: MOD_ID, id, reason }), 409, 'ADMIN_TICKET_PRIVACY');
  assert.equal(f.api.writes.length, writes);
});

test('lost Discord replies remain unconfirmed across bot restarts without duplicate posts; definite 429 can retry', async (t) => {
  const f = await adminFixture({ bridgeSecret: BRIDGE_SECRET });
  await activate(f);
  const { call } = await startServer(t, f);
  const { ticket } = await check(call('tickets/open', { discordId: MEMBER_ID, type: 'site', requestId: randomUUID() }), 200);
  const send = f.api.createMessage.bind(f.api);
  const payload = { discordId: MOD_ID, id: ticket.id, body: 'رد الدعم', requestId: randomUUID() };
  f.api.createMessage = async (channel, data, options) => {
    assert.equal(options.guarded, true);
    await send(channel, data);
    throw new DiscordApiError(502);
  };
  const first = await check(call('staff/tickets/reply', payload), 200);
  assert.equal(first.message.delivery, 'unconfirmed');
  assert.equal(first.ticket.firstReplyAt, null);
  f.clock.at += 20 * 60_000;
  const restarted = await startServer(t, f, { admin: f.restart() });
  assert.deepEqual((await check(restarted.call('staff/tickets/reply', payload), 200)).message, first.message);
  assert.equal(f.api.messages.length, 1);
  f.api.createMessage = async () => { throw new DiscordApiError(429); };
  const another = { ...payload, requestId: randomUUID(), body: 'رد مختلف' };
  await check(restarted.call('staff/tickets/reply', another), 429, 'RATE_LIMITED');
  f.api.createMessage = send;
  assert.equal((await check(restarted.call('staff/tickets/reply', another), 200)).message.delivery, 'sent');
  assert.equal(f.api.messages.length, 2);
});

test('bridge quotas are per actor and do not consume the old API budget', async (t) => {
  const f = await adminFixture({ bridgeSecret: BRIDGE_SECRET });
  await activate(f);
  const { base, call } = await startServer(t, f, { limit: 1, siteActorLimit: 1 });
  await check(call('profile', { discordId: MEMBER_ID }), 200);
  const over = await call('profile', { discordId: MEMBER_ID }, { 'X-BX-Bridge-Secret': BRIDGE_SECRET, 'X-Forwarded-For': '192.0.2.42' });
  assert.equal(over.headers.get('retry-after'), '60');
  await check(over, 429, 'RATE_LIMITED');
  await check(call('profile', { discordId: STRANGER }), 200);
  await check(fetch(`${base}/health`, { headers: { 'X-BX-Secret': FAKE_API_SECRET } }), 200);
});

test('a lost channel-create reply reuses the verified room and a lost archive write blocks new replies', async (t) => {
  const f = await adminFixture({ bridgeSecret: BRIDGE_SECRET });
  const { category } = await activate(f);
  const { call } = await startServer(t, f);
  const saveChannel = f.api.createChannel.bind(f.api);
  f.api.createChannel = async (...args) => { await saveChannel(...args); throw new DiscordApiError(502); };
  const request = { discordId: MEMBER_ID, type: 'site', requestId: randomUUID() };
  await check(call('tickets/open', request), 502, 'DISCORD_REJECTED');
  const opening = (await check(call('tickets/list', { discordId: MEMBER_ID }), 200)).tickets[0];
  assert.equal(opening.status, 'opening');
  f.api.createChannel = saveChannel;
  const detail = await check(call('tickets/open', request), 200);
  assert.equal(detail.ticket.id, opening.id);
  assert.equal(f.api.channels.filter((c) => c.parent_id === category.id).length, 1);
  const put = f.api.putOverwrite.bind(f.api);
  f.api.putOverwrite = async (...args) => { await put(...args); throw new DiscordApiError(502); };
  const close = { discordId: MOD_ID, id: opening.id, reason };
  await check(call('staff/tickets/close', close), 502, 'DISCORD_REJECTED');
  const reply = { discordId: MEMBER_ID, id: opening.id, requestId: randomUUID(), body: 'already read-only' };
  await check(call('tickets/reply', reply), 409, 'ADMIN_STALE');
  assert.equal(f.api.messages.length, 0);
  await check(call('staff/tickets/close', close), 200);
  assert.equal(f.api.writes.filter(({ operation }) => operation === 'putOverwrite').length, 1);
});

test('shared reply cleanly rejects secrets and an in-flight website disable; Discord-only support is unaffected', async (t) => {
  const f = await adminFixture({ bridgeSecret: BRIDGE_SECRET });
  await activate(f);
  const { call } = await startServer(t, f);
  const i = f.make({ by: MEMBER_ID });
  await f.admin.ticket.open(i, { type: 'report' });
  const payload = { discordId: MEMBER_ID, id: i.id, requestId: randomUUID(), body: BRIDGE_SECRET };
  await check(call('tickets/reply', payload), 400, 'ADMIN_TEXT');
  const get = f.api.getChannel.bind(f.api);
  f.api.getChannel = async (...args) => {
    await f.admin.config.bridge(f.make(), { enabled: false });
    return get(...args);
  };
  await check(call('tickets/reply', { ...payload, body: 'not shared' }), 409, 'ADMIN_STALE');
  assert.equal(f.api.messages.length, 0);
  assert.deepEqual(adminOf(await f.store.read()).requests[i.id].shared, []);
  f.api.getChannel = get;
  await f.admin.ticket.reply(staffScope(f), { id: i.id, body: 'Discord only' });
  assert.equal(f.api.messages.length, 1);
  assert.doesNotMatch(f.logs.join('\n'), new RegExp(BRIDGE_SECRET));
});
