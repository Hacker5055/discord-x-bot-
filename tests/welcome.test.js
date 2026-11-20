import assert from 'node:assert/strict';
import test from 'node:test';
import { Events, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { createBot } from '../src/bot.js';
import { SITE_ORIGIN } from '../src/community/anime.js';
import { adminFixture, own } from './fixtures/admin.js';
import { BOT_ID, FAKE_API_SECRET, GUILD_ID, MEMBER_ID, MOD_ID, OTHER_GUILD_ID, OWNER_ID } from './fixtures/discord.js';

const signature = 'مدير BLACK X';
const greeting = 'نورت مجتمعنا!\nاتفرّج على القوانين وعرّفنا على الأنمي المفضل عندك.';
const bind = (f) => f.admin.welcome.configure(f.make(), { channel: f.publicRoom, owner_name: signature, message: greeting });

function setMemberJoin(f, pending = false, id = MEMBER_ID) {
  const joinedTimestamp = f.now();
  Object.assign(f.api.members.get(id), { pending, joined_at: new Date(joinedTimestamp).toISOString() });
  return { id, guild: { id: GUILD_ID }, user: { id, bot: id === BOT_ID }, pending, joinedTimestamp };
}

test('only the actual owner configures social buttons and can preview privately without enabling or posting', async () => {
  const f = await adminFixture();
  await assert.rejects(f.admin.welcome.configure(f.make({ by: MOD_ID }), { channel: f.publicRoom, owner_name: signature, message: greeting }), { code: 'OWNER_REQUIRED' });
  await assert.rejects(f.admin.welcome.configure(f.make(), { channel: f.publicRoom, owner_name: signature, message: FAKE_API_SECRET }), { code: 'ADMIN_TEXT' });
  await bind(f);
  await assert.rejects(f.admin.welcome.enable(f.make(), { enabled: true }), { code: 'WELCOME_GATEWAY' });
  for (const url of ['https://instagram.com.example.com/bx', 'http://instagram.com/bx', 'https://instagram.com/bx?token=abc',
    'https://bx@instagram.com/name', 'https://instagram.com/name/redirect', 'https://instagram.com/name#foo']) {
    await assert.rejects(f.admin.welcome.social(f.make(), { platform: 'instagram', url }), { code: 'WELCOME_SOCIAL_URL' });
  }
  await f.admin.welcome.social(f.make(), { platform: 'instagram', url: 'https://www.instagram.com/owner.fixture' });
  await f.admin.welcome.social(f.make(), { platform: 'youtube', url: 'https://www.youtube.com/@black-x' });
  const i = f.make({ command: 'welcome', action: 'preview' });
  await f.invoke(i);
  assert.equal(i.replies[0][1].flags, MessageFlags.Ephemeral);
  const preview = i.replies.at(-1)[1];
  assert.match(preview.content, /متوقف/);
  assert.match(preview.embeds[0].footer.text, new RegExp(signature));
  assert.match(preview.embeds[0].description, new RegExp(OWNER_ID));
  assert.deepEqual(preview.components[0].components.map(({ url }) => url), [`${SITE_ORIGIN}/profile`, 'https://www.instagram.com/owner.fixture', 'https://www.youtube.com/@black-x']);
  await f.admin.welcome.social(f.make(), { platform: 'instagram' });
  assert.equal((await f.admin.welcome.preview(f.make())).components[0].components.length, 2);
  const count = f.api.writes.length;
  await f.admin.welcome.join(setMemberJoin(f));
  assert.equal(f.api.writes.length, count);
  assert.equal(f.api.messages.length, 0);
});

test('welcome follows real joins and screening within the configured guild, with no mentions, DMs, role writes, or duplicate posts', async () => {
  const f = await adminFixture({ welcome: true });
  await bind(f);
  await f.admin.welcome.enable(f.make(), { enabled: true });
  assert.equal((await f.store.read()).admin.enabled, false);
  const joining = setMemberJoin(f, true);
  await f.admin.welcome.join(joining);
  await f.admin.welcome.join({ ...joining, pending: false }); // Still pending in live REST.
  await f.admin.welcome.join({ ...joining, guild: { id: OTHER_GUILD_ID }, pending: false });
  await f.admin.welcome.join(setMemberJoin(f, false, BOT_ID));
  assert.equal(f.api.messages.length, 0);
  const passed = setMemberJoin(f);
  await Promise.all([f.admin.welcome.join(passed), f.admin.welcome.join(passed)]);
  f.clock.at += 15 * 60_000;
  await f.restart().welcome.join(passed);
  assert.equal(f.api.messages.length, 1);
  const sent = f.api.messages[0];
  assert.equal(sent.channelId, f.publicRoom.id);
  assert.match(sent.data.embeds[0].description, new RegExp(MEMBER_ID));
  assert.deepEqual(sent.data.allowed_mentions, { parse: [] });
  assert.ok(!f.api.writes.some((w) => ['createDm', 'grantRole', 'putOverwrite'].includes(w.operation)));
  f.api.channel(f.publicRoom.id).permission_overwrites.push(own(MEMBER_ID, 0n, P.ViewChannel));
  await f.admin.welcome.join(setMemberJoin(f));
  assert.equal(f.api.messages.length, 1);
  f.api.channel(f.publicRoom.id).permission_overwrites = [];
  await f.admin.welcome.join(setMemberJoin(f)); // Fresh rejoin is not the old receipt.
  assert.equal(f.api.messages.length, 2);
  f.api.ownerId = MOD_ID;
  f.clock.at += 10_000;
  await f.admin.welcome.join(setMemberJoin(f));
  assert.equal(f.api.messages.length, 2);
});

test('member gateway intent and screening listener are installed only when opted in; never request MessageContent', async () => {
  for (const active of [false, true]) {
    const f = await adminFixture({ welcome: active });
    const joins = [];
    f.admin.welcome.join = async (event) => joins.push(event);
    const client = createBot(f);
    assert.deepEqual(client.options.intents.toArray(), active ? ['Guilds', 'GuildMembers'] : ['Guilds']);
    const joining = { pending: true };
    const passed = { pending: false };
    client.emit(Events.GuildMemberAdd, joining);
    client.emit(Events.GuildMemberUpdate, passed, passed);
    client.emit(Events.GuildMemberUpdate, joining, passed);
    assert.deepEqual(joins, active ? [joining, passed] : []);
    await client.destroy();
  }
});

test('native onboarding check validates exact safe role choices and does not modify existing questions, roles or channels', async () => {
  const f = await adminFixture();
  const roles = { members: await f.role('Members'), boy: await f.role('Boy'), girl: await f.role('Girl') };
  const owner = f.make();
  const writes = f.api.writes.length;
  let check = await f.admin.welcome.onboarding(owner, roles);
  assert.match(check.join('\n'), /متوقف.*0 سؤال/);
  assert.match(check.join('\n'), /تخطّي → Members فقط/);
  f.api.onboarding.enabled = true;
  f.api.onboarding.prompts = [{ in_onboarding: true, single_select: true, required: true, options: [
    { role_ids: [roles.members.id, roles.boy.id] }, { role_ids: [roles.members.id, roles.girl.id] }, { role_ids: [roles.members.id] },
  ] }];
  check = await f.admin.welcome.onboarding(owner, roles);
  assert.match(check.join('\n'), /اختيار واحد مطابق/);
  assert.doesNotMatch(check.join('\n'), /⚠️/);
  assert.equal(f.api.writes.length, writes);
  await assert.rejects(f.admin.config.team(owner, { team: 'support', role: roles.members, channel: f.staffRoom }), { code: 'ADMIN_TEAM_ROLE' });
  await assert.rejects(f.admin.welcome.onboarding(owner, { ...roles, boy: await f.role('BLACK X') }), { code: 'ONBOARDING_ROLE' });
  f.api.roles.find(({ id }) => id === roles.girl.id).permissions = String(P.ManageRoles);
  await assert.rejects(f.admin.welcome.onboarding(owner, roles), { code: 'ADMIN_UNSAFE_ROLE' });
  f.api.roles.find(({ id }) => id === roles.girl.id).permissions = '0';
  f.api.onboarding.prompts.push({ in_onboarding: true, options: [{ role_ids: [(await f.role('VIP Basic')).id] }] });
  assert.match((await f.admin.welcome.onboarding(owner, roles)).join('\n'), /⚠️/);
});
