import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { AppError, DiscordApiError } from '../src/lib/errors.js';
import { adminFixture, asText, own, REVIEWER, STRANGER, user } from './fixtures/admin.js';
import { BOT_ID, BOT_ROLE_ID, FAKE_BOT_TOKEN, MEMBER_ID, MISSING_MEMBER_ID, MOD_ID, OTHER_GUILD_ID, OWNER_ID } from './fixtures/discord.js';

const MIN = 60_000;
const flags = P.KickMembers | P.ModerateMembers;
const hits = (f) => f.api.writes.filter(({ operation }) => ['kickMember', 'setMemberTimeout'].includes(operation));
const records = async (f) => (await f.store.read()).admin.moderation?.cases ?? {};
const args = (id = MEMBER_ID, extra) => ({ user: user(id), reason: 'سبب إشراف خاص', duration: '10m', ...extra });
const staff = (f, extra) => f.make({ by: MOD_ID, channel: f.staffRoom, ...extra });
const botRole = (f) => f.api.roles.find((r) => r.id === BOT_ROLE_ID);
const activate = (f, enabled = true) => f.admin.config.moderation(f.make(), { enabled });

async function ready({ active = true, staffFlags = flags, botFlags = flags } = {}) {
  const f = await adminFixture();
  f.modRole = await f.team('moderation', { flags: staffFlags, users: [MOD_ID, REVIEWER] });
  const bot = botRole(f);
  bot.permissions = String(BigInt(bot.permissions) | botFlags);
  await f.enable();
  if (active) await activate(f);
  return f;
}

async function confirmOffer(f, { i = staff(f), target = MEMBER_ID } = {}) {
  const preview = await f.admin.memberModeration.kick(i, args(target));
  const customId = preview.components[0].components[0].custom_id;
  return [i, customId];
}

const includes = (value, text) => assert.ok(asText(value).includes(text));
const excludes = (value, text) => assert.ok(!asText(value).includes(text));

test('member enforcement is independently off by default and only the configured actual owner can opt in', async () => {
  const f = await ready({ active: false });
  await assert.rejects(f.admin.memberModeration.timeout(staff(f), args()), { code: 'MOD_DISABLED' });
  const falseOwner = f.make({ by: MOD_ID });
  falseOwner.memberPermissions = new PermissionsBitField(P.Administrator);
  await assert.rejects(f.admin.config.moderation(falseOwner, { enabled: true }), { code: 'OWNER_REQUIRED' });
  f.api.ownerId = REVIEWER;
  await assert.rejects(f.admin.config.moderation(f.make({ ownerId: OWNER_ID }), { enabled: true }), { code: 'OWNER_REQUIRED' });
  f.api.ownerId = OWNER_ID;
  assert.deepEqual(hits(f), []);
  const count = f.api.writes.length;
  await activate(f);
  assert.equal((await f.store.read()).admin.moderation.enabledBy, OWNER_ID);
  assert.equal(f.api.writes.length, count);
  const [, customId] = await confirmOffer(f);
  await activate(f, false);
  await assert.rejects(f.admin.button(staff(f, { customId })), { code: 'MOD_DISABLED' });
  await activate(f);
  await f.admin.config.enable(f.make(), { enabled: false });
  await f.enable();
  await assert.rejects(f.admin.memberModeration.timeout(staff(f), args()), { code: 'MOD_DISABLED' });
  assert.deepEqual(hits(f), []);
});

test('the configured owner can act without delegated roles, but the bot still needs the guild permission', async () => {
  const f = await adminFixture();
  await f.enable();
  await activate(f);
  const owner = f.make();
  await assert.rejects(f.admin.memberModeration.timeout(owner, args()), { code: 'ADMIN_BOT_PERMISSION' });
  const role = botRole(f);
  role.permissions = String(BigInt(role.permissions) | P.ModerateMembers);
  assert.deepEqual((await f.store.read()).admin.teams, {});
  includes(await f.admin.memberModeration.timeout(owner, args()), 'اتعمل كتم');
  assert.equal((await records(f))[owner.id].by, OWNER_ID);
  assert.equal(hits(f).length, 1);
});

test('/kick sends a private preview then only the original actor and room can confirm it once', async () => {
  const f = await ready();
  const preview = staff(f, { command: 'kick', fields: args() });
  await f.invoke(preview);
  assert.equal(preview.replies[0][1].flags, MessageFlags.Ephemeral);
  const { components, allowedMentions } = preview.replies[1][1];
  assert.deepEqual(allowedMentions.parse, []);
  const { custom_id: customId } = components[0].components[0];
  assert.equal(customId, `bx:x:kick:${preview.id}`);
  assert.deepEqual(hits(f), []);
  assert.deepEqual(await records(f), {});
  for (const i of [staff(f, { by: REVIEWER, customId }), staff(f, { channel: f.publicRoom, customId })]) {
    await assert.rejects(f.admin.button(i), { code: 'ADMIN_STALE' });
  }
  const accept = staff(f, { customId });
  const replay = staff(f, { customId });
  await Promise.all([f.invoke(accept), f.invoke(replay)]);
  includes(accept.replies, 'اتطرد');
  assert.equal(accept.replies[0][1].flags, MessageFlags.Ephemeral);
  includes(replay.replies, 'اتغيّروا');
  assert.deepEqual(hits(f), [{ operation: 'kickMember', method: 'DELETE', userId: MEMBER_ID, reason: `BLACK X case ${preview.id} by ${MOD_ID}` }]);
  assert.equal(f.api.members.has(MEMBER_ID), false);
  assert.equal(f.api.members.has(STRANGER), true);
  const receipt = (await records(f))[preview.id];
  assert.deepEqual({ action: receipt.action, subject: receipt.subject, by: receipt.by, reason: receipt.reason, status: receipt.status },
    { action: 'kick', subject: MEMBER_ID, by: MOD_ID, reason: args().reason, status: 'applied' });
  assert.equal((await f.store.read()).admin.audit.at(-1).outcome, 'applied');
  assert.equal(f.api.dms.size, 0);
});

test('kick approvals expire and fail closed after member rejoining, a config change, or a hierarchy change', async () => {
  const f = await ready();
  let [, customId] = await confirmOffer(f);
  f.clock.at += 3 * MIN;
  await assert.rejects(f.admin.button(staff(f, { customId })), { code: 'ADMIN_STALE' });
  [, customId] = await confirmOffer(f);
  f.api.members.get(MEMBER_ID).joined_at = new Date(f.now()).toISOString();
  await assert.rejects(f.admin.button(staff(f, { customId })), { code: 'ADMIN_STALE' });
  [, customId] = await confirmOffer(f);
  await activate(f); // Config version changes; the preview is no longer current.
  await assert.rejects(f.admin.button(staff(f, { customId })), { code: 'ADMIN_STALE' });
  [, customId] = await confirmOffer(f);
  f.api.members.get(MEMBER_ID).roles.push(f.modRole.id);
  await assert.rejects(f.admin.button(staff(f, { customId })), { code: 'MOD_HIERARCHY' });
  assert.deepEqual(hits(f), []);
  assert.deepEqual(await records(f), {});
});

test('delegation, live guild-level permission, and bot permission are independent; support does not inherit them', async () => {
  const f = await ready({ staffFlags: P.ManageMessages, botFlags: P.KickMembers });
  const apiStaff = f.api.channel(f.staffRoom.id);
  apiStaff.permission_overwrites.push(own(MOD_ID, flags));
  const i = staff(f);
  i.memberPermissions = new PermissionsBitField(P.Administrator);
  await assert.rejects(f.admin.memberModeration.timeout(i, args()), { code: 'MOD_ACTOR_PERMISSION' });
  const mod = f.api.roles.find((r) => r.id === f.modRole.id);
  mod.permissions = String(flags);
  await assert.rejects(f.admin.memberModeration.timeout(i, args()), { code: 'ADMIN_BOT_PERMISSION' });
  await assert.rejects(f.admin.memberModeration.kick(staff(f, { channel: f.publicRoom }), args()), { code: 'ADMIN_SCOPE' });
  apiStaff.permission_overwrites.push(own(REVIEWER, 0n, P.ViewChannel));
  await assert.rejects(f.admin.memberModeration.kick(staff(f, { by: REVIEWER }), args()), { code: 'ADMIN_SCOPE' });
  await f.team('support', { users: [STRANGER], flags: P.Administrator });
  await assert.rejects(f.admin.memberModeration.kick(staff(f, { by: STRANGER }), args()), { code: 'ADMIN_SCOPE' });
  await f.team('support', { withRole: f.modRole });
  await assert.rejects(f.admin.memberModeration.kick(staff(f), args()), { code: 'MOD_TEAM' });
  await assert.rejects(f.admin.memberModeration.kick(staff(f, { guildId: OTHER_GUILD_ID }), args()), { code: 'ADMIN_SCOPE' });
  assert.deepEqual(hits(f), []);
});

test('actor and bot hierarchy are checked independently and self, owner, bots, and administrators stay protected', async () => {
  const f = await ready();
  for (const subject of [MOD_ID, OWNER_ID, BOT_ID]) {
    await assert.rejects(f.admin.memberModeration.kick(staff(f), args(subject)), { code: 'MOD_PROTECTED_MEMBER' });
  }
  f.api.members.get(STRANGER).user.bot = true; // Trust REST, not the supplied User object.
  await assert.rejects(f.admin.memberModeration.timeout(staff(f), args(STRANGER)), { code: 'MOD_PROTECTED_MEMBER' });
  await f.role('Server administrator', P.Administrator, [STRANGER]);
  f.api.members.get(STRANGER).user.bot = false;
  for (const action of ['kick', 'timeout', 'untimeout']) {
    await assert.rejects(f.admin.memberModeration[action](f.make(), args(STRANGER)), { code: 'MOD_PROTECTED_MEMBER' });
  }
  await assert.rejects(f.admin.memberModeration.kick(staff(f), args(MISSING_MEMBER_ID)), { code: 'MOD_MEMBER_MISSING' });
  await assert.rejects(f.admin.memberModeration.kick(staff(f), args(REVIEWER)), { code: 'MOD_HIERARCHY' }); // same rank, below bot
  await f.role('Above the bot', 0n, [MEMBER_ID]);
  const target = f.api.roles.find((r) => r.id === f.api.members.get(MEMBER_ID).roles[0]);
  target.position = botRole(f).position + 1;
  await assert.rejects(f.admin.memberModeration.kick(f.make(), args()), { code: 'MOD_HIERARCHY' });
  assert.deepEqual(hits(f), []);
});

test('/timeout and /untimeout use native state, validate the duration and reason, and never replace an active timeout', async () => {
  const f = await ready();
  for (const duration of ['0m', '-5m', '29d', '40321m', '0.5h', '1w', 'forever', '', undefined]) {
    await assert.rejects(async () => f.admin.memberModeration.timeout(staff(f), args(MEMBER_ID, { duration })), { code: 'MOD_DURATION' });
  }
  await assert.rejects(async () => f.admin.memberModeration.timeout(staff(f), args(MEMBER_ID, { reason: FAKE_BOT_TOKEN })), { code: 'ADMIN_TEXT' });
  const attempt = staff(f, { command: 'timeout', fields: args(MEMBER_ID, { duration: '28d' }) });
  await f.invoke(attempt);
  includes(attempt.replies, 'اتعمل كتم');
  assert.equal(attempt.replies[0][1].flags, MessageFlags.Ephemeral);
  const until = f.now() + 28 * 1440 * MIN;
  assert.equal(f.api.members.get(MEMBER_ID).communication_disabled_until, new Date(until).toISOString());
  assert.equal((await records(f))[attempt.id].until, until);
  await assert.rejects(f.admin.memberModeration.timeout(attempt, args()), { code: 'MOD_DUPLICATE' });
  await assert.rejects(f.admin.memberModeration.timeout(staff(f), args()), { code: 'MOD_TIMEOUT_EXISTS' });
  const lift = staff(f, { command: 'untimeout', fields: args() });
  await f.invoke(lift);
  includes(lift.replies, 'اتشال الكتم');
  assert.equal(f.api.members.get(MEMBER_ID).communication_disabled_until, null);
  assert.equal((await records(f))[lift.id].status, 'applied');
  includes(await f.admin.memberModeration.untimeout(staff(f), args()), 'مفيش تغيير');
  assert.deepEqual(hits(f).map(({ until }) => until), [new Date(until).toISOString(), null]);
  assert.deepEqual(f.api.members.get(MEMBER_ID).roles, []);
});

test('member authorization and any existing timeout are rechecked after journaling, before a Discord write', async () => {
  for (const change of ['scope', 'manual-timeout']) {
    const f = await ready();
    const write = f.store.update.bind(f.store);
    const i = staff(f);
    let changed = false;
    f.store.update = async (fn) => {
      const result = await write(fn);
      if (!changed && (await records(f))[i.id]?.status === 'pending') {
        changed = true;
        if (change === 'scope') f.api.members.get(MOD_ID).roles = [];
        else f.api.members.get(MEMBER_ID).communication_disabled_until = new Date(f.now() + MIN).toISOString();
      }
      return result;
    };
    await assert.rejects(f.admin.memberModeration.timeout(i, args()), { code: change === 'scope' ? 'ADMIN_SCOPE' : 'ADMIN_STALE' });
    assert.equal((await records(f))[i.id].status, 'rejected');
    assert.deepEqual(hits(f), []);
  }
});

test('a missing journal prevents the write; an ambiguous Discord result is not replayed after restart', async () => {
  const f = await ready();
  const write = f.store.update.bind(f.store);
  f.store.update = async () => { throw new AppError('COMMUNITY_STORAGE_UNAVAILABLE', 'storage down', 503); };
  await assert.rejects(f.admin.memberModeration.timeout(staff(f), args()), { code: 'COMMUNITY_STORAGE_UNAVAILABLE' });
  assert.deepEqual(hits(f), []);
  f.store.update = write;
  const set = f.api.setMemberTimeout.bind(f.api);
  f.api.setMemberTimeout = async (...data) => { await set(...data); throw new DiscordApiError(502); };
  const i = staff(f);
  await assert.rejects(f.admin.memberModeration.timeout(i, args()), { code: 'MOD_ACTION_UNCONFIRMED' });
  assert.equal((await records(f))[i.id].status, 'uncertain');
  const restarted = f.restart();
  await assert.rejects(restarted.memberModeration.untimeout(staff(f), args()), { code: 'MOD_ACTION_UNCONFIRMED' });
  const health = await restarted.config.health(f.make());
  includes(health, i.id);
  excludes(health, args().reason);
  const review = { id: i.id, confirm: true };
  await assert.rejects(restarted.config.moderation_review(staff(f), review), { code: 'OWNER_REQUIRED' });
  await assert.rejects(restarted.config.moderation_review(f.make(), { ...review, confirm: false }), { code: 'MOD_REVIEW_CONFIRM' });
  f.api.setMemberTimeout = set;
  await restarted.config.moderation_review(f.make(), review);
  assert.equal((await records(f))[i.id].status, 'reviewed');
  assert.equal(hits(f).length, 1);
  await restarted.memberModeration.untimeout(staff(f), args());
  assert.equal(hits(f).length, 2);
});

test('a confirmed Discord rejection is marked rejected; an accepted write with a lost receipt is not claimed recorded', async () => {
  const f = await ready();
  const i = staff(f);
  const set = f.api.setMemberTimeout.bind(f.api);
  f.api.setMemberTimeout = async () => { throw new DiscordApiError(403, 50013); };
  await assert.rejects(f.admin.memberModeration.timeout(i, args()), { status: 403 });
  assert.equal((await records(f))[i.id].status, 'rejected');
  const write = f.store.update.bind(f.store);
  f.api.setMemberTimeout = async (...data) => {
    await set(...data);
    f.store.update = async () => { throw new AppError('COMMUNITY_STORAGE_UNAVAILABLE', 'storage down', 503); };
  };
  const next = staff(f);
  await assert.rejects(f.admin.memberModeration.timeout(next, args()), { code: 'MOD_RECEIPT_UNCONFIRMED' });
  f.store.update = write;
  assert.equal((await records(f))[next.id].status, 'pending');
  await assert.rejects(f.admin.config.moderation_review(f.make(), { id: next.id, confirm: true }), { code: 'ADMIN_STALE' });
  f.clock.at += 5 * MIN;
  await f.restart().config.moderation_review(f.make(), { id: next.id, confirm: true });
  assert.equal((await records(f))[next.id].status, 'reviewed');
  assert.equal(hits(f).length, 1);
});

test('private case history is scoped to moderators; /my only shows the caller’s confirmed actions without private reasons', async () => {
  const f = await ready();
  const one = staff(f);
  const two = staff(f);
  await f.admin.memberModeration.timeout(one, args());
  await f.admin.memberModeration.timeout(two, args(STRANGER, { reason: 'سبب خاص بعضو مختلف' }));
  const before = f.api.writes.length;
  const list = staff(f, { command: 'mod', action: 'cases', fields: { user: user(MEMBER_ID) } });
  await f.invoke(list);
  assert.equal(list.replies[0][1].flags, MessageFlags.Ephemeral);
  includes(list.replies, one.id);
  includes(list.replies, args().reason);
  excludes(list.replies, two.id);
  await assert.rejects(f.admin.mod.cases(f.make({ by: MEMBER_ID }), {}), { code: 'ADMIN_SCOPE' });
  const self = await f.admin.my.view(f.make({ by: MEMBER_ID }));
  includes(self, one.id);
  excludes(self, two.id);
  excludes(self, MOD_ID);
  excludes(self, args().reason);
  await activate(f, false);
  includes(await f.admin.mod.cases(f.make(), {}), two.id);
  assert.equal(f.api.writes.length, before);
});
