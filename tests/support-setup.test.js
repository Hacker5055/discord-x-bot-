import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType as C, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { hasPermission } from '../src/discord/permissions.js';
import { ROOMS, roomMarker } from '../src/lib/catalog.js';
import { DiscordApiError } from '../src/lib/errors.js';
import { adminFixture, asText, group, own, STRANGER } from './fixtures/admin.js';
import { BOT_ID, BOT_ROLE_ID, GUILD_ID, MEMBER_ID, MOD_ID, OWNER_ID } from './fixtures/discord.js';

const quiet = P.SendMessages | P.SendMessagesInThreads | P.AddReactions | P.CreatePublicThreads | P.CreatePrivateThreads | P.SendVoiceMessages | P.SendPolls;
const protectedText = [group(GUILD_ID, 0n, P.ViewChannel), own(BOT_ID, P.ViewChannel)];
const adminOf = async (f) => (await f.store.read()).admin;
const preview = (f, options) => f.admin.server.setup(f.make(), options);
const approval = (value) => value.components?.[0]?.components?.[0]?.custom_id;
const approve = (f, value, options) => f.admin.button(f.make({ customId: approval(value), ...options }));
const edit = (i) => i.replies.find(([mode]) => mode === 'edit')?.[1];
const permitted = async (f, id, by, flag) => hasPermission(f.admin.core.bits(
  await f.admin.core.world(), f.api.channel(id), by, f.api.members.get(by),
), flag);
const at = (f, id) => f.api.messages.filter((message) => message.channelId === id);
const omit = (f, ...ids) => {
  const all = f.api.getChannels.bind(f.api);
  f.api.getChannels = async (guildId) => (await all(guildId)).filter((ch) => !ids.includes(ch.id));
  return () => { f.api.getChannels = all; };
};

async function system(options) {
  const f = await adminFixture(options);
  const botRole = f.api.roles.find(({ id }) => id === BOT_ROLE_ID);
  botRole.permissions = String(BigInt(botRole.permissions) | quiet | P.UseApplicationCommands);
  f.api.operations = [];
  return { ...f, botRole };
}

async function installed(f) {
  const result = await approve(f, await preview(f));
  assert.match(asText(result), /لوحة الدعم اتنشرت/);
  return adminOf(f);
}

test('/setup previews first; only confirmed owner approval creates the four resources with their final ACLs', async () => {
  const f = await system();
  const before = await f.store.read();
  const members = structuredClone(f.api.members);
  const dryRun = f.make({ command: 'setup', fields: { dry_run: true } });
  await f.invoke(dryRun);
  assert.equal(dryRun.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.equal(edit(dryRun)?.components, undefined);
  assert.equal((asText(edit(dryRun)).match(/: إنشاء \*\*/g) ?? []).length, 4);
  const request = f.make({ command: 'setup' });
  await f.invoke(request);
  assert.equal(request.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.match(asText(edit(request)), /معاينة إعداد دعم BLACK X/);
  assert.match(approval(edit(request)), /^bx:x:server:/);
  assert.deepEqual(f.api.writes, []);
  assert.deepEqual(await f.store.read(), before);
  const confirmation = f.make({ customId: approval(edit(request)) });
  await f.invoke(confirmation);
  assert.equal(confirmation.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.match(asText(edit(confirmation)), /اتعمل 4 مورد ناقص/);
  const a = await adminOf(f);
  const { ticket_panel: panel, ticket_category: category, site_staff: staff } = a.rooms;
  const { roleId } = a.teams.support;
  assert.deepEqual(a.teams.support.rooms, [staff]);
  assert.deepEqual(a.complaints, { ownerId: OWNER_ID, panelId: panel, categoryId: category, staffId: staff, roleId });
  assert.equal(a.enabled, true);
  assert.equal(a.siteBridge, undefined);
  assert.equal(a.server.supportSetup, undefined);
  assert.deepEqual(f.api.members, members);
  assert.equal(f.api.roles.find(({ id }) => id === roleId).permissions, '0');
  assert.equal(f.api.channel(category).type, C.GuildCategory);
  assert.equal(f.api.channel(staff).type, C.GuildText);
  assert.notEqual(f.api.channel(staff).parent_id, category);
  assert.match(asText(at(f, panel)), /bx:x:complaint:open/);
  assert.match(asText(at(f, panel)), /bx:x:ticket:site/);
  assert.equal(await permitted(f, panel, MEMBER_ID, P.ViewChannel | P.ReadMessageHistory), true);
  for (const flag of Object.values(P).filter((bit) => quiet & bit)) assert.equal(await permitted(f, panel, MEMBER_ID, flag), false);
  for (const id of [category, staff]) {
    assert.equal(await permitted(f, id, MEMBER_ID, P.ViewChannel), false);
    assert.equal(await permitted(f, id, BOT_ID, P.ViewChannel | P.SendMessages | P.EmbedLinks), true);
  }
  assert.deepEqual(f.api.writes.map(({ operation }) => operation), ['createRole', 'createChannel', 'createChannel', 'createChannel', 'createMessage']);
  const createdChannelWrites = f.api.writes.filter(({ operation }) => operation === 'createChannel');
  assert.ok(createdChannelWrites.every(({ data }) => data.permission_overwrites.every(({ id }) => /^\d{17,20}$/.test(id))));
  assert.ok(createdChannelWrites.every(({ data }) => data.permission_overwrites.every(({ allow, deny }) => !((BigInt(allow) | BigInt(deny)) & P.ManageRoles))));
});

test('/setup reuses a legacy support room, existing role and private delegation; only creates the missing category', async () => {
  const f = await system({ setup: true });
  const panel = f.api.channels.find((ch) => ch.topic === roomMarker('support'));
  const staff = f.api.channel(f.staffRoom.id);
  staff.permission_overwrites = [...protectedText, own(STRANGER, P.ViewChannel)];
  const role = await f.role('Legacy Delegate', 0n, [MOD_ID]);
  await f.team('support', { withRole: role, channel: staff });
  const rules = await f.chan(C.GuildText, 'my rules');
  await f.admin.server.bind(f.make(), { channel: rules, profile: 'rules' });
  const hooks = structuredClone(f.api.hooks);
  const unaffected = structuredClone(f.api.channels.filter(({ id }) => ![panel.id, staff.id].includes(id)));
  f.api.operations = [];
  const plan = await preview(f);
  assert.equal((asText(plan.embeds).match(/استخدام الموجود/g) ?? []).length, 3);
  assert.equal((asText(plan.embeds).match(/: إنشاء \*\*/g) ?? []).length, 1);
  assert.match(String(plan.files[0].attachment), /قبل:.*\nبعد:/);
  assert.deepEqual(f.api.writes, []);
  assert.match(asText(await approve(f, plan)), /اتعمل 1 مورد ناقص/);
  const a = await adminOf(f);
  assert.equal(a.teams.support.roleId, role.id);
  assert.equal(a.rooms.ticket_panel, panel.id);
  assert.equal(a.rooms.site_staff, staff.id);
  assert.deepEqual(f.api.hooks, hooks);
  assert.equal(f.api.channel(panel.id).parent_id, panel.parent_id);
  assert.equal(f.api.channel(panel.id).topic, panel.topic);
  assert.deepEqual(f.api.channels.filter(({ id }) => unaffected.some((ch) => id === ch.id)), unaffected);
  assert.equal(await permitted(f, staff.id, STRANGER, P.ViewChannel), false);
  assert.equal(await permitted(f, staff.id, MOD_ID, P.ViewChannel | P.SendMessages | P.UseApplicationCommands), true);
  assert.ok(!f.api.writes.some(({ operation }) => /Webhook|grantRole|reorderRoles/.test(operation)));
  assert.equal(f.api.writes.filter(({ operation }) => operation === 'createChannel').length, 1);
});

test('a new zero-permission role is substituted into the approved patches for reused rooms', async () => {
  const f = await system();
  const category = await f.chan(C.GuildCategory, '🎟 ـ التذاكر');
  const panel = await f.chan(C.GuildText, '✨-لوحة-الدعم');
  const staff = await f.chan(C.GuildText, '🔐-support-staff', { permission_overwrites: protectedText });
  f.api.operations = [];
  const a = await installed(f);
  assert.deepEqual(a.rooms, { ticket_panel: panel.id, ticket_category: category.id, site_staff: staff.id });
  assert.ok(f.api.channel(staff.id).permission_overwrites.some(({ id, type }) => id === a.teams.support.roleId && type === 0));
  assert.ok(f.api.channel(category.id).permission_overwrites.some(({ id, type }) => id === a.teams.support.roleId && type === 0));
  assert.deepEqual(f.api.writes.map(({ operation }) => operation), ['createRole', 'updateChannel', 'updateChannel', 'updateChannel', 'createMessage']);
  await f.admin.core.edit((state) => {
    for (const change of state.server.undo.changes) for (const key of ['before', 'after']) {
      change[key] = change[key].map((row) => Object.fromEntries(Object.entries(row).reverse()));
    }
  });
  assert.match(asText(await approve(f, await f.admin.server.undo(f.make()))), /التراجع خلص/);
  assert.equal((await adminOf(f)).paused.tickets, true);
  assert.deepEqual(f.api.channel(staff.id).permission_overwrites, staff.permission_overwrites);
  assert.equal(f.api.writes.filter(({ method }) => method === 'DELETE').length, 0);
});

test('repeat setup preserves the panel ID, private cases, and ticket pause while keeping legacy integration setup available', async () => {
  const f = await system();
  const initial = await installed(f);
  const panel = f.api.channel(initial.rooms.ticket_panel);
  const { messageId } = initial.panels.ticket;
  const integrations = f.make({ command: 'setup', fields: { scope: 'integrations' } });
  await f.invoke(integrations);
  assert.match(asText(edit(integrations)), /DISCORD_WEBHOOK_SUPPORT=/);
  assert.equal(f.api.channels.filter(({ topic }) => topic === roomMarker('support')).length, 1);
  const hooks = structuredClone(f.api.hooks);
  const details = 'شكوى تجريبية خاصة';
  const submit = f.make({ by: MEMBER_ID, channel: panel, modal: true, customId: `bx:x:complaint:${messageId}`, fields: { details } });
  await f.invoke(submit);
  const ticket = (await adminOf(f)).requests[submit.id];
  assert.ok(ticket.channelId);
  const saved = structuredClone(f.api.channel(ticket.channelId));
  assert.equal(await permitted(f, ticket.channelId, MEMBER_ID, P.ViewChannel), true);
  assert.equal(await permitted(f, ticket.channelId, STRANGER, P.ViewChannel), false);
  assert.doesNotMatch(asText(at(f, panel.id)), new RegExp(details));
  // PostgreSQL JSONB can return the same bindings with a different object-key order.
  await f.admin.core.edit((a) => {
    const { rooms, roleId } = a.teams.support;
    a.teams.support = { rooms, roleId };
    a.complaints = Object.fromEntries(Object.entries(a.complaints).reverse());
  });
  f.api.operations = [];
  const repeated = await installed(f);
  assert.equal(repeated.panels.ticket.messageId, messageId);
  assert.equal(repeated.version, initial.version);
  assert.equal(at(f, panel.id).length, 1);
  assert.deepEqual(f.api.writes.map(({ operation }) => operation), ['editMessage']);
  await f.admin.config.pause(f.make(), { module: 'tickets', paused: true });
  f.api.operations = [];
  assert.match(asText(await approve(f, await preview(f))), /لسه متوقف/);
  assert.deepEqual(f.api.writes, []);
  const paused = await adminOf(f);
  assert.equal(paused.paused.tickets, true);
  assert.equal(paused.panels.ticket.messageId, messageId);
  assert.deepEqual(paused.requests[submit.id], ticket);
  assert.deepEqual(f.api.channel(ticket.channelId), saved);
  assert.deepEqual(f.api.hooks, hooks);
});

test('only the live configured owner can approve from the preview room before the offer expires', async () => {
  const f = await system();
  const denied = f.make({ command: 'setup', by: MOD_ID });
  await f.invoke(denied);
  assert.match(asText(edit(denied)), /BX_OWNER_DISCORD_ID/);
  const offer = await preview(f);
  await assert.rejects(approve(f, offer, { by: MOD_ID }), { code: 'OWNER_REQUIRED' });
  await assert.rejects(approve(f, offer, { channel: f.staffRoom }), { code: 'ADMIN_STALE' });
  f.api.ownerId = MOD_ID;
  await assert.rejects(approve(f, offer, { ownerId: OWNER_ID }), { code: 'OWNER_REQUIRED' });
  f.api.ownerId = OWNER_ID;
  f.clock.at += 5 * 60_000;
  await assert.rejects(approve(f, offer), { code: 'ADMIN_STALE' });
  assert.deepEqual(f.api.writes, []);
});

test('fresh approval refuses an intervening resource or version change, and two concurrent offers cannot duplicate resources', async () => {
  const f = await system();
  const first = await preview(f);
  await f.chan(C.GuildText, ROOMS.support.name);
  f.api.operations = [];
  await assert.rejects(approve(f, first), { code: 'ADMIN_STALE' });
  assert.deepEqual(f.api.writes, []);
  const old = await preview(f);
  await f.enable();
  await assert.rejects(approve(f, old), { code: 'ADMIN_STALE' });
  assert.deepEqual(f.api.writes, []);
  const a = await preview(f);
  const b = await preview(f);
  const results = await Promise.allSettled([approve(f, a), approve(f, b)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'ADMIN_STALE');
  await assert.rejects(approve(f, a), { code: 'ADMIN_STALE' });
  assert.equal(f.api.writes.filter(({ operation }) => operation === 'createRole').length, 1);
  assert.equal(f.api.writes.filter(({ operation }) => operation === 'createChannel').length, 2);
  assert.equal(f.api.writes.filter(({ operation }) => operation === 'createMessage').length, 1);
});

test('an unbound hidden staff candidate, then a hidden/stale explicit binding, each stop setup before writes', async () => {
  const f = await system();
  const staff = await f.chan(C.GuildText, '🔒-فريق-الدعم', { permission_overwrites: protectedText });
  const panel = await f.chan(C.GuildText, ROOMS.support.name);
  const restore = omit(f, staff.id);
  f.api.operations = [];
  await assert.rejects(preview(f), { code: 'SETUP_HIDDEN_RESOURCE', message: new RegExp(staff.id) });
  assert.deepEqual(f.api.writes, []);
  restore();
  await f.room('site_staff', staff);
  const restoreAgain = omit(f, staff.id);
  await assert.rejects(preview(f), { code: 'SETUP_BOUND_RESOURCE', message: new RegExp(staff.id) });
  restoreAgain();
  f.api.channels = f.api.channels.filter(({ id }) => id !== staff.id);
  await assert.rejects(preview(f), { code: 'SETUP_BOUND_RESOURCE', message: new RegExp(staff.id) });
  assert.equal(f.api.channel(panel.id).name, ROOMS.support.name);
  assert.deepEqual(f.api.writes, []);
});

test('ambiguous names, wrong types, conflicting saved targets, and private panel history fail closed', async () => {
  const f = await system();
  const staff = await f.chan(C.GuildText, '🔒-فريق-الدعم');
  const decoy = await f.chan(C.GuildText, 'support-staff');
  await assert.rejects(preview(f), { code: 'SETUP_AMBIGUOUS' });
  f.api.channel(decoy.id).name = 'unrelated';
  const invalid = await f.chan(C.GuildVoice, 'Tickets');
  await assert.rejects(preview(f), { code: 'SETUP_WRONG_RESOURCE', message: new RegExp(invalid.id) });
  f.api.channel(invalid.id).name = 'voice-chat';
  await f.room('site_staff', staff);
  await f.admin.core.edit((a) => { a.server = { profiles: {}, supportSetup: { staff: { id: decoy.id } } }; });
  await assert.rejects(preview(f), { code: 'SETUP_CONFLICT', message: new RegExp(staff.id) });
  await f.admin.core.edit((a) => { delete a.server.supportSetup; });
  const panel = await f.chan(C.GuildText, ROOMS.support.name, { permission_overwrites: protectedText });
  f.api.operations = [];
  await assert.rejects(preview(f), { code: 'SETUP_PRIVATE_PANEL', message: new RegExp(panel.id) });
  assert.deepEqual(f.api.writes, []);
});

test('categories with hidden children and rooms bound to other purposes are never repurposed', async () => {
  const f = await system();
  const category = await f.chan(C.GuildCategory, 'Tickets');
  const hidden = await f.chan(C.GuildText, 'not-a-ticket', { parent_id: category.id, permission_overwrites: protectedText });
  const restore = omit(f, hidden.id);
  f.api.operations = [];
  await assert.rejects(preview(f), { code: 'SETUP_HIDDEN_CHILD', message: new RegExp(hidden.id) });
  restore();
  await assert.rejects(preview(f), { code: 'SERVER_PREPARE_ROOM' });
  assert.deepEqual(f.api.writes, []);
  f.api.channels = f.api.channels.filter(({ id }) => id !== hidden.id);
  await f.room('voice_category', category);
  await assert.rejects(preview(f), { code: 'SETUP_BOUND_RESOURCE', message: new RegExp(category.id) });
  assert.deepEqual(f.api.writes, []);
});

test('preflight requires guild create permissions, not channel-only permissions, and rejects unsafe support roles', async () => {
  const f = await system();
  const plan = await preview(f);
  f.botRole.permissions = String(BigInt(f.botRole.permissions) & ~P.SendPolls);
  f.api.channel(f.publicRoom.id).permission_overwrites.push(own(BOT_ID, P.SendPolls));
  await assert.rejects(approve(f, plan), { code: 'ADMIN_BOT_PERMISSION', message: /SendPolls/ });
  await assert.rejects(preview(f), { code: 'ADMIN_BOT_PERMISSION', message: /SendPolls/ });
  assert.deepEqual(f.api.writes, []);
  f.botRole.permissions = String(BigInt(f.botRole.permissions) | P.SendPolls);
  const role = await f.role('Support', P.ManageRoles);
  f.api.operations = [];
  await assert.rejects(preview(f), { code: 'SERVER_PREPARE_ROLE' });
  f.api.roles.find(({ id }) => id === role.id).permissions = '0';
  f.api.features = ['COMMUNITY'];
  f.api.onboarding.prompts = [{ options: [{ role_ids: [role.id] }] }];
  await assert.rejects(preview(f), { code: 'SERVER_ONBOARDING_ROLE' });
  assert.deepEqual(f.api.writes, []);
});

test('partial create results survive restart; a known failure resumes from saved IDs, without deleting or replacing a resource', async () => {
  const f = await system();
  const original = f.api.createChannel.bind(f.api);
  f.api.createChannel = async (guildId, data, recover, opts) => {
    assert.equal(opts?.guarded, true);
    if (data.type === C.GuildText) throw new DiscordApiError(403, 50013);
    return original(guildId, data, recover, opts);
  };
  const response = await approve(f, await preview(f));
  assert.match(asText(response), /إعداد الدعم وقف/);
  assert.match(asText(response), /الموارد اللي اتأكد إنشاؤها/);
  const partial = await adminOf(f);
  assert.equal(partial.enabled, false);
  assert.deepEqual(partial.rooms, {});
  const journal = partial.server.supportSetup;
  assert.ok(journal.role.id && journal.category.id);
  assert.equal(journal.panel, undefined);
  assert.equal(f.api.messages.length, 0);
  // Saved IDs win even if the owner renamed the partial output between attempts.
  f.api.channel(journal.category.id).name = 'my saved ticket category';
  f.api.createChannel = original;
  const restarted = { ...f, admin: f.restart() };
  f.api.operations = [];
  const a = await installed(restarted);
  assert.equal(a.rooms.ticket_category, journal.category.id);
  assert.equal(a.teams.support.roleId, journal.role.id);
  assert.deepEqual(f.api.writes.map(({ operation }) => operation), ['createChannel', 'createChannel', 'createMessage']);
});

test('a lost create acknowledgement never replays a blind POST; a visible unique match is reusable after fresh approval', async () => {
  const f = await system();
  const original = f.api.createChannel.bind(f.api);
  let createdId;
  f.api.createChannel = async (guildId, data, recover, opts) => {
    const ch = await original(guildId, data, recover, opts);
    createdId = ch.id;
    throw new DiscordApiError(502);
  };
  assert.match(asText(await approve(f, await preview(f))), /إعداد الدعم وقف/);
  assert.ok((await adminOf(f)).server.supportSetup.category.pending);
  assert.equal(f.api.messages.length, 0);
  const restore = omit(f, createdId);
  const restarted = { ...f, admin: f.restart() };
  f.api.operations = [];
  await assert.rejects(preview(restarted), { code: 'SETUP_CREATE_UNCONFIRMED' });
  assert.deepEqual(f.api.writes, []);
  restore();
  f.api.createChannel = original;
  const a = await installed(restarted);
  assert.equal(a.rooms.ticket_category, createdId);
  assert.equal(f.api.channels.filter((ch) => ch.type === C.GuildCategory).length, 1);
});

test('an unconfirmed panel post is never repeated by setup and the owner can relink the verified existing message', async () => {
  const f = await system();
  const create = f.api.createMessage.bind(f.api);
  f.api.createMessage = async (...args) => {
    await create(...args);
    throw new DiscordApiError(502);
  };
  const outcome = await approve(f, await preview(f));
  assert.match(asText(outcome), /لوحة الدعم: النشر مش مؤكد/);
  const a = await adminOf(f);
  const panel = f.api.channel(a.rooms.ticket_panel);
  const [message] = at(f, panel.id);
  assert.equal(a.panels.ticket, undefined);
  assert.equal(a.panels.ticketPending.channelId, panel.id);
  f.api.createMessage = create;
  f.api.operations = [];
  const restarted = { ...f, admin: f.restart() };
  const repeat = await approve(restarted, await preview(restarted));
  assert.match(asText(repeat), /نشر اللوحة السابق مش مؤكّد/);
  assert.deepEqual(f.api.writes, []);
  const unrelated = await create(panel.id, { content: 'not a panel' });
  await assert.rejects(f.admin.ticket.panel(f.make({ channel: panel }), { message_id: unrelated.id }), { code: 'TICKET_PANEL_MESSAGE' });
  const recover = f.make({ command: 'ticket', action: 'panel', channel: panel, fields: { message_id: message.id } });
  await f.invoke(recover);
  assert.match(asText(edit(recover)), /لوحة الدعم اتنشرت/);
  assert.equal((await adminOf(f)).panels.ticket.messageId, message.id);
  assert.equal((await adminOf(f)).panels.ticketPending, undefined);
  assert.equal(at(f, panel.id).length, 2); // Original panel and unrelated test message, with no duplicate panel.
});
