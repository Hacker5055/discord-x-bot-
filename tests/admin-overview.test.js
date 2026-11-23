import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType as C, MessageFlags, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { createAdministration } from '../src/admin/index.js';
import { AppError } from '../src/lib/errors.js';
import { adminFixture, asText, group, own } from './fixtures/admin.js';
import { BOT_ID, BOT_ROLE_ID, FAKE_API_SECRET, FAKE_BOT_TOKEN, GUILD_ID, MEMBER_ID, MOD_ID } from './fixtures/discord.js';

const privateFor = [group(GUILD_ID, 0n, P.ViewChannel), own(BOT_ID, P.ViewChannel)];

test('/help is private and only links visible member destinations; paused or unconfirmed features are omitted', async () => {
  const f = await adminFixture();
  await f.enable();
  const rules = await f.chan(C.GuildText, 'rules');
  const panel = await f.chan(C.GuildText, 'support-panel');
  const ideas = await f.chan(C.GuildText, 'private-ideas', { permission_overwrites: privateFor });
  const restricted = await f.chan(C.GuildForum, 'age-gated', { nsfw: true });
  await f.admin.core.edit((a) => {
    a.server = { profiles: { [rules.id]: { profile: 'rules' } } };
    a.rooms.ticket_panel = panel.id;
    a.rooms.suggestions = ideas.id;
    a.rooms.forum = restricted.id;
    a.rooms.site_staff = f.staffRoom.id;
    a.panels.ticket = { channelId: panel.id, messageId: f.api.nextId() };
  });
  const before = f.api.writes.length;
  const i = f.make({ command: 'help', by: MEMBER_ID });
  await f.invoke(i);
  assert.equal(i.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.deepEqual(i.replies[1][1].allowedMentions.parse, []);
  for (const id of [rules.id, panel.id]) assert.ok(asText(i.replies).includes(id));
  for (const id of [ideas.id, restricted.id, f.staffRoom.id]) assert.ok(!asText(i.replies).includes(id));
  assert.match(asText(i.replies), /\/my/);
  const memberHelp = () => f.admin.overview.help(f.make({ by: MEMBER_ID }));
  await f.admin.config.pause(f.make(), { module: 'tickets', paused: true });
  assert.ok(!asText(await memberHelp()).includes(panel.id));
  await f.admin.config.pause(f.make(), { module: 'tickets', paused: false });
  await f.admin.core.edit((a) => { delete a.panels.ticket; });
  assert.ok(!asText(await memberHelp()).includes(panel.id));
  assert.equal(f.api.writes.length, before);
});

test('/admin health is owner-only and explains missing support or moderation permissions without mutating anything', async () => {
  const f = await adminFixture();
  await f.enable();
  const category = await f.chan(C.GuildCategory, 'tickets'); // incorrectly public
  const other = await f.chan(C.GuildVoice, 'wrong-type');
  const role = await f.team('support');
  await f.team('moderation', { withRole: role });
  await f.admin.core.edit((a) => {
    a.rooms.ticket_category = category.id;
    a.rooms.site_staff = other.id;
  });
  const bot = f.api.roles.find((r) => r.id === BOT_ROLE_ID);
  bot.permissions = String(BigInt(bot.permissions) & ~P.ManageChannels);
  const fakeOwner = f.make({ by: MOD_ID });
  fakeOwner.memberPermissions = new PermissionsBitField(P.Administrator);
  await assert.rejects(f.admin.config.health(fakeOwner), { code: 'OWNER_REQUIRED' });
  const before = await f.store.read();
  const writes = f.api.writes.length;
  const i = f.make({ command: 'admin', action: 'health' });
  await f.invoke(i);
  const text = asText(i.replies);
  assert.equal(i.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.match(text, /قراءة فقط/);
  assert.match(text, /ناقص KickMembers، ModerateMembers/);
  assert.match(text, /ناقص ManageChannels/);
  assert.match(text, /لوحة الأعضاء: مش مربوط/);
  assert.match(text, /كاتيجوري التذاكر: .*ظاهر لـ@everyone/);
  assert.match(text, /روم فريق الدعم: .*نوعه غلط/);
  assert.match(text, /مفيش رول إشراف مستقل صالح/);
  assert.ok(!text.includes(FAKE_API_SECRET) && !text.includes(FAKE_BOT_TOKEN));
  assert.deepEqual(await f.store.read(), before);
  assert.equal(f.api.writes.length, writes);
});

test('member guide and owner diagnostics give usable read-only output even if storage is not available', async () => {
  const f = await adminFixture();
  const before = f.api.writes.length;
  const down = { read: async () => { throw new AppError('COMMUNITY_STORAGE_UNAVAILABLE', 'storage down', 503); } };
  for (const store of [undefined, down]) {
    const admin = createAdministration({ ...f, store });
    const health = asText(await admin.config.health(f.make()));
    assert.match(health, store ? /مش متاح دلوقتي/ : /مش متضبط/);
    const help = asText(await admin.overview.help(f.make({ by: MEMBER_ID })));
    assert.match(help, /\/recommend/);
    assert.doesNotMatch(help, /\/ticket|\/my/);
  }
  assert.equal(f.api.writes.length, before);
});
