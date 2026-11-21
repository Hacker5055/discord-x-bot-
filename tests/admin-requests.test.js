import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType as C, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { adminOf } from '../src/admin/core.js';
import { DiscordApiError } from '../src/lib/errors.js';
import { ANIME, DIM, REVIEWER, STRANGER, adminFixture, asText, own, user } from './fixtures/admin.js';
import { FAKE_API_SECRET, GUILD_ID, MEMBER_ID, MOD_ID, OTHER_GUILD_ID, OWNER_ID } from './fixtures/discord.js';

const snapshot = async (f) => adminOf(await f.store.read());
const scopes = (f, by = MOD_ID, channel = f.staffRoom) => f.make({ by, channel });
const MIN = 60_000;

async function supportSetup(f) {
  const category = await f.chan(C.GuildCategory, 'private-support');
  await f.room('ticket_panel', f.publicRoom);
  await f.room('ticket_category', category);
  const staff = await f.team('support');
  await f.enable();
  return { category, staff };
}

test('only the actual configured owner enables or delegates; new admin state is lazy and scoped', async () => {
  const f = await adminFixture();
  const { config, staff, ticket } = f.admin;
  await assert.rejects(ticket.open(f.make({ by: MEMBER_ID }), { type: 'site' }), { code: 'ADMIN_DISABLED' });
  await assert.rejects(config.enable(f.make({ by: MOD_ID }), { enabled: true }), { code: 'OWNER_REQUIRED' });
  const wrongGuild = f.make({ guildId: OTHER_GUILD_ID });
  await assert.rejects(config.enable(wrongGuild, { enabled: true }), { code: 'ADMIN_SCOPE' });
  const staleOwner = f.make();
  f.api.ownerId = MOD_ID;
  await assert.rejects(config.enable(staleOwner, { enabled: true }), { code: 'OWNER_REQUIRED' });
  assert.equal((await f.store.read()).admin, undefined);
  f.api.ownerId = OWNER_ID;
  const role = await f.team('support');
  await f.enable();
  assert.match(asText(await staff.inbox(scopes(f), { team: 'support' })), /0 طلب/);
  await assert.rejects(staff.inbox(scopes(f, MOD_ID, f.publicRoom), { team: 'support' }), { code: 'ADMIN_SCOPE' });
  await assert.rejects(staff.inbox(scopes(f), { team: 'content' }), { code: 'ADMIN_SCOPE' });
  await assert.rejects(staff.inbox(scopes(f, STRANGER), { team: 'support' }), { code: 'ADMIN_SCOPE' });
  f.api.members.get(MOD_ID).roles = [];
  await assert.rejects(staff.inbox(scopes(f), { team: 'support' }), { code: 'ADMIN_SCOPE' });
  f.api.members.get(MOD_ID).roles = [role.id];
  f.api.members.get(MOD_ID).communication_disabled_until = new Date(f.now() + MIN).toISOString();
  await assert.rejects(staff.inbox(scopes(f), { team: 'support' }), { code: 'ADMIN_SCOPE' });
  assert.ok(!(await f.store.read()).daily);
});

test('ticket card makes one private numbered text room, staff inbox, replies and reasoned archive; pause blocks only new tickets', async () => {
  const f = await adminFixture();
  const { category, staff } = await supportSetup(f);
  await f.admin.ticket.panel(f.make());
  const panel = f.api.messages[0];
  const click = (by, messageId = panel.id) => f.make({ by, customId: 'bx:x:ticket:report', messageId });
  await assert.rejects(f.admin.button(click(MEMBER_ID, f.api.nextId())), { code: 'ADMIN_STALE' });
  const i = click(MEMBER_ID);
  const simultaneous = click(MEMBER_ID);
  await Promise.all([f.invoke(i), f.admin.button(simultaneous)]);
  assert.equal(i.replies[0][1].flags, MessageFlags.Ephemeral);
  const a = await snapshot(f);
  const [r] = Object.values(a.requests);
  const ch = f.api.channel(r.channelId);
  assert.equal(Object.keys(a.requests).length, 1);
  assert.ok([i.id, simultaneous.id].includes(r.id));
  assert.equal(ch.topic, `bx-ticket:${r.id}`);
  assert.equal(ch.parent_id, category.id);
  assert.equal(ch.name, `bx-ticket-${r.id}`);
  assert.equal(ch.permission_overwrites.find((o) => o.id === GUILD_ID).deny, String(P.ViewChannel));
  assert.deepEqual(new Set(ch.permission_overwrites.map((o) => o.id)), new Set([GUILD_ID, staff.id, f.botId, MEMBER_ID]));
  assert.equal(f.api.channels.filter((c) => c.parent_id === category.id).length, 1);
  await assert.rejects(f.admin.staff.detail(scopes(f, STRANGER), { team: 'support', id: r.id }), { code: 'ADMIN_SCOPE' });
  await f.admin.ticket.claim(scopes(f), { id: r.id });
  assert.match(asText(await f.admin.staff.inbox(scopes(f), { team: 'support' })), new RegExp(MOD_ID));
  f.clock.at += 5 * MIN;
  await f.admin.config.pause(f.make(), { module: 'tickets', paused: true });
  await assert.rejects(f.admin.button(click(STRANGER)), { code: 'ADMIN_PAUSED' });
  await assert.rejects(f.admin.ticket.reply(scopes(f), { id: r.id, body: FAKE_API_SECRET }), { code: 'ADMIN_TEXT' });
  await f.admin.ticket.reply(scopes(f), { id: r.id, body: 'private reply @everyone' });
  const reply = f.api.messages.at(-1);
  assert.equal(reply.channelId, ch.id);
  assert.deepEqual(reply.data.allowed_mentions, { parse: [] });
  await f.admin.ticket.close(scopes(f), { id: r.id, reason: 'حلينا المشكلة' });
  assert.equal(ch.permission_overwrites.find((o) => o.id === MEMBER_ID).deny, String(P.SendMessages));
  assert.equal(f.api.writes.filter(({ operation }) => operation === 'deleteChannel').length, 0);
  assert.equal((await snapshot(f)).requests[r.id].status, 'closed');
  assert.match(asText(await f.admin.staff.stats(scopes(f))), /اتفتحت: 1 · اتقفلت: 1 · لسه مفتوحة: 0.*5 دقيقة/);
  const saved = asText(await snapshot(f));
  assert.ok(!saved.includes('private reply'));
  assert.match(asText(await f.admin.staff.audit(scopes(f), { team: 'support' })), /ticket_(replied|closed)/);
  assert.doesNotMatch(asText(await f.admin.my.view(f.make({ by: STRANGER }))), new RegExp(r.id));
  const receipt = f.make({ command: 'my', by: MEMBER_ID });
  await f.invoke(receipt);
  assert.match(asText(receipt.replies), /حلينا المشكلة/);
  assert.equal(receipt.replies[0][1].flags, MessageFlags.Ephemeral);
});

test('ticket recovery reuses an unconfirmed room and refuses to post or close if its privacy drifted', async () => {
  const f = await adminFixture();
  await supportSetup(f);
  const create = f.api.createChannel.bind(f.api);
  f.api.createChannel = async (...args) => {
    await create(...args);
    throw new DiscordApiError(502);
  };
  const invocation = f.make({ by: MEMBER_ID });
  await assert.rejects(f.admin.ticket.open(invocation, { type: 'site' }), { status: 502 });
  assert.equal((await snapshot(f)).requests[invocation.id].status, 'opening');
  await f.restart().ticket.open(f.make({ by: MEMBER_ID }), { type: 'site' });
  const r = (await snapshot(f)).requests[invocation.id];
  assert.equal(r.status, 'open');
  assert.equal(f.api.channels.filter((ch) => ch.topic?.startsWith('bx-ticket:')).length, 1);
  const ch = f.api.channel(r.channelId);
  const messages = f.api.messages.length;
  ch.permission_overwrites.push(own(STRANGER, P.ViewChannel));
  await assert.rejects(f.admin.ticket.reply(scopes(f), { id: r.id, body: 'private' }), { code: 'ADMIN_TICKET_PRIVACY' });
  ch.topic = 'no-longer-a-ticket';
  await assert.rejects(f.admin.ticket.close(scopes(f), { id: r.id, reason: 'resolved' }), { code: 'ADMIN_STALE' });
  assert.equal(f.api.messages.length, messages);
  assert.equal(f.api.writes.filter(({ operation }) => operation === 'putOverwrite').length, 0);
});

test('support category must be empty and cannot be changed around active tickets', async () => {
  const f = await adminFixture({ setup: true });
  await supportSetup(f);
  const category = await f.chan(C.GuildCategory, 'fixed');
  await f.chan(C.GuildText, 'fixed-room', { parent_id: category.id });
  await assert.rejects(f.room('ticket_category', category), { code: 'ADMIN_CATEGORY' });
  await f.admin.ticket.open(f.make({ by: MEMBER_ID }), { type: 'site' });
  const other = await f.chan(C.GuildCategory, 'other-empty');
  await assert.rejects(f.room('ticket_category', other), { code: 'ADMIN_ACTIVE_TICKETS' });
  const role = await f.role('other support');
  await assert.rejects(f.team('support', { withRole: role }), { code: 'ADMIN_ACTIVE_TICKETS' });
});

test('manual warning is recorded privately and only another moderator can decide its appeal', async () => {
  const f = await adminFixture();
  const role = await f.team('moderation', { flags: P.ManageMessages, users: [MOD_ID, REVIEWER] });
  await f.enable();
  const warn = scopes(f);
  const baseline = f.api.writes.length;
  await f.admin.mod.warn(warn, { user: user(MEMBER_ID), reason: 'السبب التجريبي' });
  await assert.rejects(f.admin.mod.warn(scopes(f), { user: user(REVIEWER), reason: 'peer' }), { code: 'ADMIN_SCOPE' });
  assert.match(asText(await f.admin.mod.history(scopes(f), { user: user(MEMBER_ID) })), new RegExp(warn.id));
  await assert.rejects(f.admin.mod.appeal(f.make({ by: DIM }), { id: warn.id, reason: 'not mine' }), { code: 'ADMIN_NOT_FOUND' });
  const appeal = f.make({ by: MEMBER_ID });
  await f.admin.mod.appeal(appeal, { id: warn.id, reason: 'راجعوا الحالة' });
  const decision = { id: appeal.id, outcome: 'approved', reason: 'اتراجع' };
  await assert.rejects(f.admin.mod.review(scopes(f), decision), { code: 'ADMIN_SCOPE' });
  f.api.roles.find((r) => r.id === role.id).permissions = '0';
  await assert.rejects(f.admin.mod.review(scopes(f, REVIEWER), decision), { code: 'ADMIN_SCOPE' });
  f.api.roles.find((r) => r.id === role.id).permissions = String(P.ManageMessages);
  await f.admin.mod.review(scopes(f, REVIEWER), decision);
  assert.equal((await snapshot(f)).warnings[warn.id].status, 'void');
  assert.equal((await snapshot(f)).requests[appeal.id].resolvedBy, REVIEWER);
  assert.equal(f.api.writes.length, baseline);
  assert.equal(f.api.dms.size, 0);
});

test('staff task handover, a reviewed knowledge base, and interactive training do not publish or edit real resources', async () => {
  const f = await adminFixture();
  await f.team('support', { users: [MOD_ID, REVIEWER] });
  await f.enable();
  const baseline = f.api.writes.length;
  const i = scopes(f);
  await f.admin.staff.task(i, { team: 'support', title: 'تابع مشكلة الربط', user: user(REVIEWER), due: '2027-01-02T13:00+02:00' });
  assert.match(asText(await f.admin.staff.handoff(scopes(f), { team: 'support' })), /تابع مشكلة الربط/);
  await f.admin.staff.done(scopes(f, REVIEWER), { team: 'support', id: i.id });
  assert.match(asText(await f.admin.staff.handoff(scopes(f), { team: 'support' })), /مهام مفتوحة: 0/);
  await f.admin.kb.set(scopes(f), { key: 'link', title: 'طريقة الربط', body: 'افتح إعدادات حسابك.\nثم اختار ربط.' });
  assert.match(asText(await f.admin.kb.search(scopes(f), { query: 'link' })), /مفيش/);
  assert.match(asText(await f.admin.kb.draft(scopes(f), { key: 'link' })), /افتح إعدادات حسابك/);
  await f.admin.kb.approve(scopes(f, REVIEWER), { key: 'link' });
  assert.match(asText(await f.admin.kb.search(scopes(f), { query: 'الربط' })), /افتح إعدادات حسابك/);
  await assert.rejects(f.admin.kb.search(scopes(f, MEMBER_ID), { query: 'link' }), { code: 'ADMIN_SCOPE' });
  const before = await f.store.read();
  let training = await f.admin.staff.practice(scopes(f), { team: 'support', scenario: 'ticket' });
  assert.match(asText(training), /T-01/);
  const firstId = training.components[0].components[0].custom_id;
  await assert.rejects(f.admin.button(f.make({ channel: f.staffRoom, by: REVIEWER, customId: firstId })), { code: 'ADMIN_STALE' });
  const step = f.make({ channel: f.staffRoom, by: MOD_ID, customId: firstId });
  await f.invoke(step);
  assert.equal(step.replies[0][0], 'update');
  training = step.replies.at(-1)[1];
  for (let index = 0; index < 2; index++) {
    const customId = training.components[0].components[0].custom_id;
    training = await f.admin.button(f.make({ channel: f.staffRoom, by: MOD_ID, customId }));
  }
  assert.deepEqual(training.components, []);
  assert.deepEqual(await f.store.read(), before);
  assert.equal(f.api.writes.length, baseline);
});

test('suggestions allow one editable vote per member, with explicit staff state transitions', async () => {
  const f = await adminFixture();
  await f.room('suggestions', f.publicRoom);
  await f.team('events');
  await f.enable();
  const idea = f.make({ by: MEMBER_ID });
  await f.admin.idea.add(idea, { title: 'حفلة غموض', note: 'اختاروا عملًا قصيرًا' });
  const vote = (by, choice) => f.admin.idea.vote(f.make({ by }), { id: idea.id, choice });
  await assert.rejects(vote(STRANGER, 'yes'), { code: 'ADMIN_STALE' });
  await f.admin.idea.review(scopes(f), { id: idea.id, status: 'review' });
  await vote(STRANGER, 'yes');
  await vote(STRANGER, 'no');
  await vote(MEMBER_ID, 'yes');
  assert.match(asText(await f.admin.idea.list(idea)), /مؤيد 1 \/ معارض 1/);
  await assert.rejects(f.admin.idea.review(scopes(f), { id: idea.id, status: 'implemented' }), { code: 'ADMIN_STALE' });
  await f.admin.idea.review(scopes(f), { id: idea.id, status: 'approved' });
  await f.admin.idea.review(scopes(f), { id: idea.id, status: 'implemented' });
  await assert.rejects(vote(STRANGER, 'yes'), { code: 'ADMIN_STALE' });
  assert.match(asText(await f.admin.idea.list(idea)), /اتنفّذ/);
});

test('Creator approvals use the original hierarchy and corrections only affect review records, never the catalogue', async () => {
  const f = await adminFixture({ setup: true });
  const role = await f.team('content', { flags: P.ManageRoles });
  await f.enable();
  await f.anime.updateCatalog({ items: [ANIME] });
  const { content } = f.admin;
  const bad = f.make({ by: MEMBER_ID });
  await assert.rejects(content.apply(bad, { url: 'https://example.com/channel?secret=value', type: 'reviews' }), { code: 'ADMIN_CREATOR_LINK' });
  const applicant = f.make({ by: MEMBER_ID });
  await content.apply(applicant, { url: 'https://example.com/channel', type: 'reviews' });
  assert.deepEqual(await f.roles.list(MEMBER_ID), { discordId: MEMBER_ID, roles: [] });
  const decision = { id: applicant.id, outcome: 'approved', reason: 'تمت المراجعة' };
  await assert.rejects(content.review(scopes(f), decision), { code: 'MODERATOR_HIERARCHY' });
  f.api.roles.find((r) => r.id === role.id).position = 200;
  await content.review(scopes(f), decision);
  assert.deepEqual(await f.roles.list(MEMBER_ID), { discordId: MEMBER_ID, roles: ['creator'] });
  const correction = f.make({ by: STRANGER });
  const before = (await f.store.read()).catalog;
  await content.correction(correction, { anime: ANIME.id, issue: 'episodes', note: 'عدد الحلقات يحتاج مراجعة' });
  assert.match(asText(await f.admin.staff.inbox(scopes(f), { team: 'content' })), new RegExp(correction.id));
  await content.review(scopes(f), { id: correction.id, outcome: 'approved', reason: 'اتراجع' });
  assert.deepEqual((await f.store.read()).catalog, before);
  const my = asText(await f.admin.my.view(correction));
  assert.match(my, new RegExp(correction.id));
  assert.doesNotMatch(my, new RegExp(applicant.id));
  assert.equal(f.api.writes.filter(({ operation }) => operation === 'grantRole').length, 1);
});
