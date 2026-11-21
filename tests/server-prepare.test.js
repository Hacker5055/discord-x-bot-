import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ChannelType as C, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { DiscordApiError } from '../src/lib/errors.js';
import { DiscordApi } from '../src/discord/api.js';
import { provisionGuild } from '../src/provisioning.js';
import { canManageRole, hasPermission } from '../src/discord/permissions.js';
import { adminFixture, asText, DIM, group, own, REVIEWER, STRANGER } from './fixtures/admin.js';
import { BOT_ID, BOT_ROLE_ID, FAKE_API_SECRET, GUILD_ID, MEMBER_ID, MOD_ID, OTHER_GUILD_ID, OWNER_ID } from './fixtures/discord.js';

const state = async (f) => (await f.store.read()).admin;
const approval = (preview) => preview.components?.[0]?.components?.[0]?.custom_id;
const apply = (f, preview, fields = {}) => f.admin.button(f.make({ customId: approval(preview), ...fields }));
const bind = (f, channel, profile, role) => f.admin.server.bind(f.make(), { channel, profile, role });
const access = async (f, channel, who, permission = P.ViewChannel) => hasPermission(
  f.admin.core.bits(await f.admin.core.world(), f.api.channel(channel.id), who, f.api.members.get(who)), permission,
);

async function system(options = {}) {
  const f = await adminFixture(options);
  const panel = options.setup ? f.api.channels.find((ch) => ch.topic?.endsWith('support]')) : f.publicRoom;
  const category = await f.chan(C.GuildCategory, 'tickets');
  const role = await f.role('Complaint Staff', 0n, [MOD_ID, REVIEWER, OWNER_ID]);
  const botRole = f.api.roles.find((r) => r.id === BOT_ROLE_ID);
  botRole.permissions = String(BigInt(botRole.permissions) | P.CreatePublicThreads | P.CreatePrivateThreads | P.SendMessagesInThreads |
    P.SendVoiceMessages | P.SendPolls | P.AddReactions | P.UseApplicationCommands | P.Speak);
  assert.ok(canManageRole(botRole, role, GUILD_ID));
  const refs = { panel, category, role, staff: f.staffRoom };
  const prepare = () => f.admin.server.prepare(f.make(), refs);
  const setup = async () => {
    const result = await apply(f, await prepare());
    assert.match(asText(result), /لوحة الدعم اتنشرت/);
  };
  return { ...f, panel, category, staff: f.staffRoom, supportRole: role, refs, prepare, setup };
}

async function form(f, by, details, overrides = {}) {
  const a = await state(f);
  return f.make({ by, channel: f.panel, modal: true, messageId: a.panels.ticket.messageId,
    customId: `bx:x:complaint:${a.panels.ticket.messageId}`, fields: { details }, ...overrides });
}

const messagesAt = (f, id) => f.api.messages.filter((entry) => entry.channelId === id);
const tick = async (f, elapsed = 15_000) => { f.clock.at += elapsed; await f.admin.tick(); };

test('preparation is owner-only with a read-only preview and applies approved rules, support and synced category scopes', async () => {
  const f = await system({ setup: true });
  const rules = await f.chan(C.GuildText, 'rules');
  const role = await f.role('Ops', 0n, [DIM]);
  const management = await f.chan(C.GuildCategory, 'administration');
  const hidden = await f.chan(C.GuildText, 'staff-chat', { parent_id: management.id });
  const voice = await f.chan(C.GuildVoice, 'staff-voice', { parent_id: management.id });
  const different = await f.chan(C.GuildText, 'independent-audience', { parent_id: management.id, permission_overwrites: [own(MEMBER_ID, P.ViewChannel)] });
  const oldStaffOther = await f.role('unrelated', 0n, [STRANGER]);
  // Existing support setup was in a public channel. Prepare must move the scope and close unrelated overrides.
  await f.team('support', { channel: f.panel, withRole: f.supportRole });
  f.api.channel(f.staff.id).permission_overwrites = [own(STRANGER, P.ViewChannel), group(oldStaffOther.id, P.ViewChannel | P.ManageMessages)];
  const before = f.api.writes.length;
  const integrations = asText(f.api.hooks);
  const contents = await f.admin.rules.preview(f.make());
  assert.match(asText(contents), /احترم كل الأعضاء/);
  await bind(f, rules, 'rules');
  await bind(f, management, 'staff', role);
  await assert.rejects(f.admin.server.prepare(f.make({ by: MOD_ID }), f.refs), { code: 'OWNER_REQUIRED' });
  await assert.rejects(f.admin.server.bind(f.make({ guildId: OTHER_GUILD_ID }), { channel: rules, profile: 'rules' }), { code: 'ADMIN_SCOPE' });
  const preview = await f.prepare();
  assert.equal(f.api.writes.length, before);
  assert.match(asText(preview.embeds), /متزامنين/);
  assert.match(preview.files[0].attachment.toString(), new RegExp(hidden.id));
  assert.doesNotMatch(preview.files[0].attachment.toString(), new RegExp(different.id));
  await assert.rejects(apply(f, preview, { by: MOD_ID }), { code: 'OWNER_REQUIRED' });
  assert.match(asText(await apply(f, preview)), /لوحة الدعم اتنشرت/);
  assert.equal(asText(f.api.hooks), integrations);
  for (const ch of [management, hidden, voice, f.staff]) assert.equal(await access(f, ch, MEMBER_ID), false);
  assert.equal(await access(f, f.staff, STRANGER), false);
  assert.equal(await access(f, f.staff, MOD_ID, P.ViewChannel | P.SendMessages), true);
  assert.equal(await access(f, hidden, DIM, P.ViewChannel | P.SendMessages), true);
  assert.equal(await access(f, voice, DIM, P.ViewChannel | P.Connect), true);
  assert.equal(await access(f, different, MEMBER_ID), true);
  assert.equal(await access(f, f.panel, MEMBER_ID, P.ViewChannel | P.UseApplicationCommands), true);
  for (const ch of [rules, f.panel]) {
    assert.equal(await access(f, ch, MEMBER_ID, P.SendMessages), false);
    assert.equal(await access(f, ch, MEMBER_ID, P.SendMessagesInThreads), false);
  }
  const a = await state(f);
  assert.deepEqual(a.teams.support, { roleId: f.supportRole.id, rooms: [f.staff.id] });
  assert.equal(a.rooms.site_staff, f.staff.id);
  assert.equal(a.enabled, true);
  assert.equal(a.siteBridge, undefined);
  assert.ok(messagesAt(f, rules.id).some(({ data }) => /قوانين BLACK X/.test(data.embeds?.[0]?.title)));
  assert.ok(messagesAt(f, f.panel.id).some(({ data }) => asText(data).includes('bx:x:complaint:open')));
  await assert.rejects(apply(f, preview), { code: 'ADMIN_STALE' });
  await f.setup();
  assert.equal(messagesAt(f, rules.id).length, 1);
  assert.equal(messagesAt(f, f.panel.id).length, 1);
  const stable = structuredClone(f.api.channels);
  f.api.operations = [];
  await provisionGuild(f);
  assert.deepEqual(f.api.channels, stable); // Legacy setup must not reopen the prepared panel to chat.
  assert.equal(asText(f.api.hooks), integrations);
  assert.deepEqual(f.api.writes, []);
});

test('approval uses live overwrites and refuses synced conflicts, unsafe roles and non-ticket categories', async () => {
  const f = await system();
  const preview = await f.prepare();
  f.api.channel(f.staff.id).permission_overwrites.push(own(MEMBER_ID, P.ViewChannel));
  const before = f.api.writes.length;
  await assert.rejects(apply(f, preview), { code: 'ADMIN_STALE' });
  assert.equal(f.api.writes.length, before);
  const staffRole = await f.role('• Members');
  await assert.rejects(f.admin.server.prepare(f.make(), { ...f.refs, role: staffRole }), { code: 'SERVER_PREPARE_ROLE' });
  const nonempty = await f.chan(C.GuildCategory, 'mixed');
  const child = await f.chan(C.GuildText, 'general', { parent_id: nonempty.id });
  await assert.rejects(f.admin.server.prepare(f.make(), { ...f.refs, category: nonempty }), { code: 'SERVER_PREPARE_ROOM' });
  await bind(f, nonempty, 'staff', f.supportRole);
  await bind(f, child, 'open');
  await assert.rejects(f.prepare(), { code: 'SERVER_PREPARE_ROOM' });
  const invocation = f.make({ command: 'server', action: 'prepare', fields: f.refs });
  await f.invoke(invocation);
  assert.equal(invocation.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.match(asText(invocation.replies), /متزامن/);
});

test('rollback restores only attempted ACLs, requires a fresh confirmation and never deletes messages or tickets', async () => {
  const f = await system();
  const archived = await f.chan(C.GuildText, 'archive');
  await bind(f, archived, 'owner_only');
  const original = structuredClone(f.api.channels);
  await f.setup();
  const request = await form(f, MEMBER_ID, 'مشكلة في السيرفر');
  await f.invoke(request);
  const ticket = (await state(f)).requests[request.id];
  const beforeTicket = structuredClone(f.api.channel(ticket.channelId));
  const preview = await f.admin.server.undo(f.make());
  assert.match(asText(preview.embeds), /هيتوقفوا/);
  const changed = f.api.channel(archived.id);
  const prepared = structuredClone(changed.permission_overwrites);
  changed.permission_overwrites.push(own(MEMBER_ID, P.ViewChannel));
  await assert.rejects(apply(f, preview), { code: 'ADMIN_STALE' });
  changed.permission_overwrites = prepared;
  const restored = await apply(f, await f.admin.server.undo(f.make()));
  assert.match(asText(restored), /التراجع خلص/);
  assert.deepEqual(f.api.channels.filter((ch) => ch.id !== ticket.channelId), original);
  assert.deepEqual(f.api.channel(ticket.channelId), beforeTicket);
  assert.equal((await state(f)).paused.tickets, true);
  assert.equal((await state(f)).complaints, undefined);
  assert.equal(f.api.writes.filter((op) => op.method === 'DELETE').length, 0);
  await assert.rejects(f.admin.server.undo(f.make()), { code: 'SERVER_UNDO_EMPTY' });
});

test('partial permission writes are reported accurately and keep a restart-safe undo journal', async () => {
  const f = await system();
  const snapshots = structuredClone(f.api.channels);
  const update = f.api.updateChannel.bind(f.api);
  const preview = await f.prepare();
  f.api.updateChannel = async (id, data, opts) => {
    const channel = await update(id, data, opts);
    if (id === f.panel.id) throw new DiscordApiError(502); // Mutation accepted; response lost.
    return channel;
  };
  const result = await apply(f, preview);
  assert.match(asText(result), /التنفيذ وقف/);
  assert.equal(f.api.messages.length, 0);
  assert.equal((await state(f)).enabled, false);
  assert.ok((await state(f)).server.undo.attempted.includes(f.panel.id));
  f.api.updateChannel = update;
  const restarted = f.restart();
  const before = await restarted.server.undo(f.make());
  const undo = await restarted.button(f.make({ customId: approval(before) }));
  assert.match(asText(undo), /التراجع خلص/);
  assert.deepEqual(f.api.channels, snapshots);
});

test('rules can be edited by the owner, are previewed privately, and edit the same posted rules card', async () => {
  const f = await system();
  const rules = await f.chan(C.GuildText, 'rules');
  await bind(f, rules, 'rules');
  await f.setup();
  const original = (await state(f)).panels.rules.messageId;
  await assert.rejects(f.admin.rules.edit(f.make({ by: STRANGER }), { text: 'Bad' }), { code: 'OWNER_REQUIRED' });
  await assert.rejects(f.admin.rules.edit(f.make(), { text: FAKE_API_SECRET }), { code: 'ADMIN_TEXT' });
  const edit = await f.admin.rules.edit(f.make(), { text: 'النص الأول.\nالنص الثاني. @everyone' });
  assert.match(asText(edit), /النص الثاني/);
  assert.equal(f.api.edits.length, 0);
  await f.admin.rules.publish(f.make());
  assert.equal(messagesAt(f, rules.id).length, 1);
  assert.equal(f.api.edits.at(-1).messageId, original);
  assert.deepEqual(f.api.edits.at(-1).data.allowed_mentions, { parse: [] });
  assert.match(f.api.edits.at(-1).data.embeds[0].description, /النص الأول\.\nالنص الثاني/);
});

test('the private complaint form stores one ticket and the owner gets the form text; every authorized admin gets only a link', async () => {
  const f = await system();
  const broad = await f.role('Unrelated Moderator', P.ManageGuild, [STRANGER]);
  assert.ok(broad);
  await f.setup();
  const panel = (await state(f)).panels.ticket;
  const press = f.make({ by: MEMBER_ID, channel: f.panel, messageId: panel.messageId, customId: 'bx:x:complaint:open' });
  await f.invoke(press);
  assert.equal(press.replies.length, 1);
  assert.equal(press.replies[0][0], 'modal');
  assert.match(asText(press.replies[0]), /يوصل للمالك في الخاص/);
  const body = 'تفاصيل سرية للاختبار.\nمن غير منشن @everyone';
  const msg = await form(f, MEMBER_ID, body);
  await f.invoke(msg);
  assert.equal(msg.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.match(asText(msg.replies), /اتسجّلت شكواك/);
  assert.ok(!asText(msg.replies).includes(body));
  const r = (await state(f)).requests[msg.id];
  assert.equal(r.type, 'report');
  assert.equal(messagesAt(f, r.channelId).length, 2); // One case header and one private form.
  const complaint = messagesAt(f, r.channelId).find(({ data }) => data.embeds[0].title === '📝 شكوى من صاحب التذكرة');
  assert.match(complaint.data.embeds[0].description, /تفاصيل سرية/);
  assert.equal(await access(f, f.api.channel(r.channelId), STRANGER), false);
  assert.ok(!JSON.stringify(await f.store.read()).includes('تفاصيل سرية'));
  assert.equal(f.api.dms.size, 0);
  // Persist through a worker restart; duplicate submissions never post or alert again.
  const restart = f.restart();
  f.clock.at += 15_000;
  await restart.tick();
  await restart.tick();
  assert.deepEqual([...f.api.dms.keys()].sort(), [OWNER_ID, MOD_ID, REVIEWER].sort());
  const ownerDm = messagesAt(f, f.api.dms.get(OWNER_ID));
  assert.equal(ownerDm.length, 1);
  assert.match(ownerDm[0].data.embeds[0].description, /تفاصيل سرية/);
  for (const destination of [f.staff.id, f.api.dms.get(MOD_ID), f.api.dms.get(REVIEWER)]) {
    const notices = messagesAt(f, destination);
    assert.equal(notices.length, 1);
    assert.match(asText(notices), new RegExp(r.channelId));
    assert.doesNotMatch(asText(notices), /تفاصيل سرية/);
  }
  const double = await form(f, MEMBER_ID, 'not posted');
  await f.invoke(double);
  assert.match(asText(double.replies), /ما كررناش/);
  assert.equal(Object.keys((await state(f)).requests).length, 1);
  assert.equal(messagesAt(f, r.channelId).length, 2);
  assert.equal(messagesAt(f, f.panel.id).length, 1);
  assert.doesNotMatch(f.logs.join(''), /تفاصيل سرية/);
  assert.equal(ownerDm[0].data.allowed_mentions.parse.length, 0);
  const alerts = await f.admin.ticket.alerts(f.make(), { id: r.id });
  assert.match(asText(alerts), /المالك: وصل/);
  assert.match(asText(alerts), /وصل: 2/);
});

test('a closed DM, a revoked role, and unavailable roster never fall back to the public panel or retry ambiguous messages', async () => {
  const f = await system();
  await f.setup();
  const dm = f.api.createDm.bind(f.api);
  f.api.createDm = async (recipient, opts) => {
    if (recipient === OWNER_ID) throw new DiscordApiError(403, 50007);
    if (recipient === REVIEWER) f.api.members.get(REVIEWER).roles = [];
    return dm(recipient, opts);
  };
  const create = f.api.createMessage.bind(f.api);
  f.api.createMessage = async (channel, data, options) => {
    const message = await create(channel, data, options);
    if (channel === f.api.dms.get(MOD_ID)) throw new DiscordApiError(502); // Ambiguous acknowledgment, actually delivered.
    return message;
  };
  const first = await form(f, MEMBER_ID, 'متابعة البلاغ');
  await f.invoke(first);
  await tick(f);
  await tick(f);
  assert.equal(messagesAt(f, f.api.dms.get(MOD_ID)).length, 1);
  assert.equal(messagesAt(f, f.api.dms.get(REVIEWER)).length, 0);
  assert.equal(messagesAt(f, f.staff.id).length, 1);
  assert.equal(messagesAt(f, f.panel.id).length, 1);
  let report = await f.admin.ticket.alerts(f.make(), { id: first.id });
  assert.match(asText(report), /المالك: اترفض/);
  assert.match(asText(report), /غير مؤكد: 1/);
  assert.match(asText(report), /اتخطّى: 1/);

  f.api.listGuildMembers = async () => { throw new DiscordApiError(403, 50001); };
  const preview = await f.prepare();
  assert.match(asText(preview.embeds), /Server Members Intent/);
  const second = await form(f, STRANGER, 'بلاغ تاني');
  await f.invoke(second);
  await tick(f);
  report = await f.admin.ticket.alerts(f.make(), { id: second.id });
  assert.match(asText(report), /تعذّر حصر الرول/);
  assert.equal(messagesAt(f, f.staff.id).length, 2);
});

test('forged forms, pending members, and leaked ticket ACLs cannot inject complaints or trigger DMs', async () => {
  const f = await system();
  await f.setup();
  const stale = await form(f, MEMBER_ID, 'old button', { messageId: f.api.nextId() });
  await f.invoke(stale);
  assert.match(asText(stale.replies), /اتغيّر/);
  const pending = await form(f, MEMBER_ID, 'not screened');
  f.api.members.get(MEMBER_ID).pending = true;
  await f.invoke(pending);
  assert.match(asText(pending.replies), /مخو/);
  assert.deepEqual((await state(f)).requests, {});
  f.api.members.get(MEMBER_ID).pending = false;
  const outcome = await form(f, MEMBER_ID, 'never deliver after an ACL leak');
  await f.invoke(outcome);
  const ticket = (await state(f)).requests[outcome.id];
  f.api.channel(ticket.channelId).permission_overwrites.push(group(GUILD_ID, P.ViewChannel));
  await tick(f);
  assert.equal(f.api.dms.size, 0);
  assert.equal(messagesAt(f, f.staff.id).length, 0);
});

test('report tickets from the site use the same one-time queue and do not mirror subsequent text into owner DMs', async () => {
  const f = await system({ bridgeSecret: 'an-unrelated-random-looking-bridge-secret-0001' });
  await f.setup();
  await f.admin.config.bridge(f.make(), { enabled: true });
  const input = { discordId: MEMBER_ID, type: 'report', requestId: randomUUID() };
  const opened = await f.admin.ticket.site.open(input);
  assert.deepEqual(await f.admin.ticket.site.open(input), opened);
  await f.admin.ticket.site.reply({ discordId: MEMBER_ID, id: opened.ticket.id, body: 'shared but not forwarded', requestId: randomUUID() }, false);
  await tick(f);
  const dm = messagesAt(f, f.api.dms.get(OWNER_ID));
  assert.equal(dm.length, 1);
  assert.doesNotMatch(asText(dm), /shared but not forwarded/);
  assert.match(asText(dm), new RegExp(opened.ticket.id));
});

test('the guild member listing REST helper only queries the authorized shape, validates its cursor and returns just routing fields', async () => {
  const calls = [];
  const client = new DiscordApi({ token: 'local', fetchImpl: async (url, req) => {
    calls.push({ url, method: req.method });
    return Response.json([{ user: { id: MOD_ID, bot: false, username: 'not retained' }, roles: [], pending: false }]);
  } });
  await assert.rejects(client.listGuildMembers(GUILD_ID, { after: '../channels' }), { status: 400 });
  await assert.rejects(client.listGuildMembers(GUILD_ID, { limit: 1001 }), { status: 400 });
  const result = await client.listGuildMembers(GUILD_ID, { limit: 1, after: OWNER_ID });
  assert.deepEqual(result[0].user, { id: MOD_ID, bot: false });
  assert.deepEqual(calls, [{ url: `https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1&after=${OWNER_ID}`, method: 'GET' }]);
});

test('the owner can prepare just rules; paused ticket intake is never resumed implicitly', async () => {
  const f = await system();
  const rules = await f.chan(C.GuildText, 'rules');
  await bind(f, rules, 'rules');
  const result = await apply(f, await f.admin.server.prepare(f.make(), {}));
  assert.match(asText(result), /القوانين منشورة/);
  assert.equal((await state(f)).enabled, false);
  await f.enable();
  await f.admin.config.pause(f.make(), { module: 'tickets', paused: true });
  const prepared = await apply(f, await f.prepare());
  assert.match(asText(prepared), /لسه متوقف/);
  assert.equal((await state(f)).paused.tickets, true);
  assert.equal(messagesAt(f, f.panel.id).length, 0);

  await f.admin.config.pause(f.make(), { module: 'tickets', paused: false });
  await f.setup();
  assert.equal(messagesAt(f, f.panel.id).length, 1);
});

test('preflight blocks missing overwrite permissions and a Community role offered for self-assignment', async () => {
  const f = await system();
  const config = f.api.roles.find((role) => role.id === BOT_ROLE_ID);
  const full = config.permissions;
  config.permissions = String(BigInt(full) & ~P.SendPolls);
  const baseline = f.api.writes.length;
  await assert.rejects(f.prepare(), { code: 'ADMIN_BOT_PERMISSION' });
  assert.equal(f.api.writes.length, baseline);
  config.permissions = full;
  const initial = await f.prepare();
  const getGuild = f.api.getGuild.bind(f.api);
  f.api.getGuild = async (...args) => ({ ...await getGuild(...args), features: ['COMMUNITY'] });
  f.api.onboarding.prompts = [{ options: [{ role_ids: [f.supportRole.id] }] }];
  await assert.rejects(apply(f, initial), { code: 'SERVER_ONBOARDING_ROLE' });
  assert.equal(f.api.writes.length, baseline);
});

test('a form post with a lost acknowledgement leaves one private ticket and sends only a verified link', async () => {
  const f = await system();
  await f.setup();
  const create = f.api.createMessage.bind(f.api);
  f.api.createMessage = async (id, data, opts) => {
    const message = await create(id, data, opts);
    if (data.embeds?.[0]?.title === '📝 شكوى من صاحب التذكرة') throw new DiscordApiError(502);
    return message;
  };
  const first = await form(f, MEMBER_ID, 'بيانات النموذج');
  await f.invoke(first);
  assert.match(asText(first.replies), /وصول نص الشكوى مش مؤكد/);
  const ticket = (await state(f)).requests[first.id];
  assert.equal(messagesAt(f, ticket.channelId).length, 2);
  await tick(f, 40_000);
  assert.match(asText(messagesAt(f, f.api.dms.get(OWNER_ID))), new RegExp(ticket.channelId));
  assert.doesNotMatch(asText(messagesAt(f, f.api.dms.get(OWNER_ID))), /بيانات النموذج/);
});

test('closing the owner DM does not open any fallback to a compromised staff room, and proven rate-limit rejections retry', async () => {
  const f = await system();
  await f.setup();
  const first = await form(f, MEMBER_ID, 'خاص');
  await f.invoke(first);
  f.api.channel(f.staff.id).permission_overwrites.push(own(STRANGER, P.ViewChannel));
  const dm = f.api.createDm.bind(f.api);
  let limitOnce = true;
  f.api.createDm = async (id, opts) => {
    if (id === OWNER_ID) throw new DiscordApiError(403, 50007);
    if (id === MOD_ID && limitOnce) { limitOnce = false; throw new DiscordApiError(429); }
    return dm(id, opts);
  };
  await tick(f);
  assert.equal(messagesAt(f, f.staff.id).length, 0);
  assert.equal(f.api.dms.has(STRANGER), false);
  assert.equal(f.api.dms.has(MOD_ID), false);
  await tick(f, 30_000);
  assert.equal(messagesAt(f, f.api.dms.get(MOD_ID)).length, 1);
  assert.equal(messagesAt(f, f.api.dms.get(REVIEWER)).length, 1);
  assert.match(asText(await f.admin.ticket.alerts(f.make(), { id: first.id })), /روم الفريق: اتخطّى/);
});


test('prepare identifies bad picker fields, saved targets and obsolete explicit bindings independently', async () => {
  const f = await system();
  await assert.rejects(f.admin.server.prepare(f.make(), { panel: f.panel }),
    { code: 'SERVER_PREPARE_SUPPORT', message: /category.*staff.*role/ });
  await assert.rejects(f.admin.server.prepare(f.make(), { ...f.refs, category: f.panel }),
    { code: 'ADMIN_ROOM', message: /category: الاختيار الحالي.*كاتيجوري/ });
  const writes = f.api.writes.length;
  await f.room('ticket_category', f.category);
  await f.room('site_staff', f.staff);
  await f.room('ticket_panel', f.panel);
  await f.team('support', { withRole: f.supportRole });
  const extra = await f.chan(C.GuildText, 'obsolete');
  await bind(f, extra, 'read_only');
  f.api.channels = f.api.channels.filter(({ id }) => id !== f.staff.id && id !== extra.id);
  await assert.rejects(f.admin.server.prepare(f.make(), {}), { code: 'ADMIN_ROOM', message: /staff: الربط المحفوظ.*View Channel/ });
  const replacement = await f.chan(C.GuildText, 'new-staff');
  await assert.rejects(f.admin.server.prepare(f.make(), { staff: replacement }),
    { code: 'ADMIN_ROOM', message: new RegExp(`/server unbind channel_id:${extra.id}`) });
  await f.admin.server.unbind(f.make(), { channel_id: extra.id });
  assert.ok(approval(await f.admin.server.prepare(f.make(), { staff: replacement })));
  assert.equal(f.api.writes.length, writes + 2); // Only the two test channels were created.
});

test('private read-only logs give only the dedicated role access and never produce a new log feed', async () => {
  const f = await system();
  const mod = await f.role('Moderation Logs', 0n, [DIM]);
  const logs = await f.chan(C.GuildText, 'moderator-log', { permission_overwrites: [own(STRANGER, P.ViewChannel | P.SendMessagesInThreads)] });
  await bind(f, logs, 'staff_log', mod);
  await assert.rejects(bind(f, f.category, 'staff_log', mod), { code: 'SERVER_PREPARE_ROOM' });
  f.api.features = ['COMMUNITY'];
  f.api.onboarding.prompts = [{ options: [{ role_ids: [mod.id] }] }];
  await assert.rejects(f.prepare(), { code: 'SERVER_ONBOARDING_ROLE' });
  f.api.onboarding.prompts = [];
  await apply(f, await f.prepare());
  assert.equal(await access(f, logs, DIM, P.ViewChannel | P.ReadMessageHistory), true);
  for (const bit of [P.SendMessages, P.SendMessagesInThreads, P.CreatePrivateThreads, P.AddReactions, P.UseApplicationCommands]) {
    assert.equal(await access(f, logs, DIM, bit), false);
  }
  for (const by of [MEMBER_ID, STRANGER, MOD_ID]) assert.equal(await access(f, logs, by), false);
  assert.equal(messagesAt(f, logs.id).length, 0);
});

test('ticket preflight requires guild-level overwrite and closing permissions, not just category allowances', async () => {
  const f = await system();
  const role = f.api.roles.find((r) => r.id === BOT_ROLE_ID);
  const full = BigInt(role.permissions);
  f.api.channel(f.category.id).permission_overwrites = [own(BOT_ID, P.EmbedLinks | P.ManageRoles)];
  for (const key of ['EmbedLinks', 'ManageRoles']) {
    role.permissions = String(full & ~P[key]);
    await assert.rejects(f.prepare(), { code: 'ADMIN_BOT_PERMISSION', message: new RegExp(`رول البوت.*${key}`) });
  }
  await f.room('ticket_panel', f.panel);
  await f.room('ticket_category', f.category);
  await f.team('support', { withRole: f.supportRole });
  await f.enable();
  const baseline = f.api.writes.length;
  await assert.rejects(f.admin.ticket.open(f.make({ by: MEMBER_ID }), { type: 'site' }), { code: 'ADMIN_BOT_PERMISSION' });
  assert.deepEqual((await state(f)).requests, {});
  assert.equal(f.api.writes.length, baseline);
});
