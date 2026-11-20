import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType as C, Events, MessageFlags, PermissionFlagsBits as P, Status } from 'discord.js';
import { adminOf } from '../src/admin/core.js';
import { createBot } from '../src/bot.js';
import { createScheduler } from '../src/community/jobs.js';
import { cancelParty, respondParty, scheduleParty } from '../src/community/party.js';
import { DiscordApiError } from '../src/lib/errors.js';
import { roomMarker } from '../src/lib/catalog.js';
import { ANIME, DIM, REVIEWER, STRANGER, adminFixture, asText, group, own } from './fixtures/admin.js';
import { GUILD_ID, MEMBER_ID, MOD_ID, OTHER_GUILD_ID, OWNER_ID } from './fixtures/discord.js';

const MIN = 60_000;
const snap = async (f) => adminOf(await f.store.read());
const writes = (f, operation) => f.api.writes.filter((row) => row.operation === operation);

const startWorker = (f) => {
  let ready = true;
  const worker = createScheduler({ ...f, guildId: GUILD_ID, ready: () => ready, maintenance: () => f.admin.tick() });
  return { worker, setReady: (value) => { ready = value; } };
};

test('incident updates edit one card and an uncertain initial post can be linked without reposting', async () => {
  const f = await adminFixture();
  await f.enable();
  await f.room('incident', f.publicRoom);
  const params = { title: 'عطل الموقع', details: 'بنراجع الدخول' };
  const i = f.make();
  const send = f.api.createMessage.bind(f.api);
  f.api.createMessage = async (...args) => { await send(...args); throw new DiscordApiError(502); };
  await assert.rejects(f.admin.incident.open(i, params), { status: 502 });
  const [message] = f.api.messages;
  assert.equal((await snap(f)).incidents[i.id].messageId, undefined);
  f.api.createMessage = send;
  f.clock.at += 3 * MIN;
  await assert.rejects(f.admin.incident.open(f.make(), params), { code: 'ADMIN_INCIDENT_UNCONFIRMED' });
  await f.admin.incident.recover(f.make(), { id: i.id, message: message.id });
  await f.admin.incident.open(f.make(), params);
  await f.admin.incident.update(f.make(), { id: i.id, status: 'monitoring', details: 'رجع الخدمة' });
  await f.admin.incident.update(f.make(), { id: i.id, status: 'resolved', details: 'تم الإصلاح' });
  assert.equal(f.api.messages.length, 1);
  assert.deepEqual(f.api.edits.map((r) => r.messageId), [message.id, message.id]);
  assert.equal((await snap(f)).incidents[i.id].status, 'resolved');
  assert.deepEqual(f.api.edits.map((r) => r.data.allowed_mentions), [{ parse: [] }, { parse: [] }]);
});

test('announce preview is private, schedules honour pause and cancellation, and the worker sends once without pings', async () => {
  const f = await adminFixture({ setup: true });
  const { worker, setReady } = startWorker(f);
  const announce = (fields = {}) => f.make({ command: 'announce', fields: { room: 'updates', title: 'تنبيه @everyone', body: '@here', ...fields } });
  const preview = announce({ preview: true, publish_at: '2027-01-01T10:05Z' });
  await f.invoke(preview);
  assert.equal(preview.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.deepEqual(preview.replies.at(-1)[1].allowedMentions, { parse: [], repliedUser: false });
  assert.equal(f.api.messages.length, 0);
  assert.equal((await f.store.read()).admin, undefined);
  await f.enable();
  const when = '2027-01-01T10:05Z';
  const cancelled = announce({ publish_at: when });
  const pending = announce({ publish_at: when });
  await f.invoke(cancelled);
  await f.invoke(pending);
  await assert.rejects(f.admin.publication.cancel(f.make({ by: STRANGER }), { id: cancelled.id }), { code: 'ADMIN_NOT_FOUND' });
  await f.admin.publication.cancel(f.make(), { id: cancelled.id });
  await f.admin.config.pause(f.make(), { module: 'announcements', paused: true });
  f.clock.at += 5 * MIN;
  await worker.tick();
  assert.equal(f.api.messages.length, 0);
  await f.admin.config.pause(f.make(), { module: 'announcements', paused: false });
  setReady(false);
  await worker.tick();
  assert.equal(f.api.messages.length, 0);
  setReady(true);
  await Promise.all([worker.tick(), worker.tick()]);
  await worker.tick();
  assert.equal(f.api.messages.length, 1);
  const posted = f.api.messages[0];
  assert.equal(posted.channelId, f.api.channels.find((r) => r.topic === roomMarker('updates')).id);
  assert.deepEqual(posted.data.allowed_mentions, { parse: [] });
  assert.equal(posted.data.enforce_nonce, true);
  const a = await snap(f);
  assert.equal(a.announcements[cancelled.id].status, 'cancelled');
  assert.equal(a.announcements[pending.id].status, 'sent');
  await worker.stop();
});

test('due announcement rechecks author and destination; recovery never replays an ambiguous dispatch', async () => {
  const f = await adminFixture({ setup: true });
  await f.enable();
  const dest = f.api.channels.find((r) => r.topic === roomMarker('updates'));
  const role = await f.team('ops', { flags: P.ManageMessages });
  await f.team('ops', { withRole: role, channel: dest });
  const make = (by) => f.make({ command: 'announce', channel: f.staffRoom, by,
    fields: { room: 'updates', title: 'News', body: 'Status', publish_at: '2027-01-01T10:02Z' } });
  const lostPermission = make(MOD_ID);
  const interrupted = make(OWNER_ID);
  const ambiguous = make(OWNER_ID);
  await f.invoke(lostPermission);
  await f.invoke(interrupted);
  await f.invoke(ambiguous);
  assert.equal((await snap(f)).announcements[lostPermission.id].status, 'scheduled');
  f.api.members.get(MOD_ID).roles = [];
  await f.store.update((s) => Object.assign(s.admin.announcements[interrupted.id], { status: 'dispatching', dispatchUntil: f.now() + MIN }));
  f.clock.at += 2 * MIN;
  const send = f.api.createMessage.bind(f.api);
  f.api.createMessage = async (...args) => { await send(...args); throw new DiscordApiError(502); };
  await f.restart().tick();
  await f.restart().tick();
  const a = await snap(f);
  assert.equal(a.announcements[lostPermission.id].status, 'failed');
  assert.equal(a.announcements[interrupted.id].status, 'review');
  assert.equal(a.announcements[ambiguous.id].status, 'review');
  assert.equal(f.api.messages.length, 1);
});

test('calendar only shows visible channels and warns of overlaps with legacy and scoped parties', async () => {
  const f = await adminFixture();
  await f.enable();
  await f.team('events');
  const context = () => f.make({ by: MOD_ID, channel: f.staffRoom });
  const starts_at = '2027-01-01T13:00Z';
  const maintenance = { kind: 'maintenance', title: 'تحديث الموقع', minutes: 30, starts_at };
  await f.admin.calendar.add(context(), maintenance);
  await assert.rejects(f.admin.calendar.add(context(), { ...maintenance, starts_at: '2027-01-01T13:29Z' }), { code: 'ADMIN_CALENDAR_CONFLICT' });
  const party = f.make({ by: MOD_ID, channel: f.staffRoom, command: 'party', action: 'schedule',
    fields: { title: 'عرض', url: ANIME.url, starts_at, capacity: 8, minutes: 60 } });
  await f.invoke(party);
  assert.match(asText(party.replies), /متعارض/);
  assert.equal((await f.store.read()).parties[party.id], undefined);
  const forced = { ...party, options: { ...party.options, getBoolean: () => true } };
  await f.invoke(forced);
  assert.equal((await f.store.read()).parties[party.id].capacity, 8);
  const hidden = await f.chan(C.GuildText, 'hidden', { permission_overwrites: [group(GUILD_ID, 0n, P.ViewChannel), own(f.botId, P.ViewChannel)] });
  await f.admin.calendar.add(f.make({ channel: hidden }), { ...maintenance, title: 'private event', starts_at: '2027-01-01T15:00Z' });
  const visible = asText(await f.admin.calendar.week(f.make({ by: MEMBER_ID })));
  assert.match(visible, /تحديث الموقع.*حفلة مشاهدة/);
  assert.doesNotMatch(visible, /private event/);
});

test('capped watch party reservations honour FIFO, are personal in /my, and never opt into DMs automatically', async () => {
  const f = await adminFixture();
  await f.enable();
  const at = f.now() + 10 * MIN;
  const { id } = f.make();
  const channelId = f.publicRoom.id;
  const args = { id, channelId, title: 'جلسة', url: ANIME.url, at, capacity: 1 };
  await scheduleParty(f.store, args, f.now());
  const { worker } = startWorker(f);
  await worker.tick();
  const party = (await f.store.read()).parties[id];
  const card = f.api.messages[0];
  assert.equal(card.data.components[0].components.length, 5);
  const handle = (userId, action, messageId = party.messageId) => respondParty(f.store, { id, channelId, messageId, userId, action, now: f.now() });
  await handle(MEMBER_ID, 'join');
  assert.match(await handle(STRANGER, 'join'), /الانتظار: 1/);
  assert.match(await handle(REVIEWER, 'join'), /الانتظار: 2/);
  await assert.rejects(handle(STRANGER, 'confirm'), { code: 'PARTY_WAITLIST' });
  await handle(MEMBER_ID, 'leave');
  assert.match(asText(await f.admin.my.view(f.make({ by: STRANGER }))), /المقعد متاح لك/);
  assert.doesNotMatch(asText(await f.admin.my.view(f.make({ by: DIM }))), new RegExp(id));
  assert.match(await handle(DIM, 'join'), /الانتظار: 3/);
  await assert.rejects(handle(REVIEWER, 'confirm'), { code: 'PARTY_WAITLIST' });
  await assert.rejects(handle(STRANGER, 'confirm', f.api.nextId()), { code: 'PARTY_NOT_FOUND' });
  const confirm = f.make({ by: STRANGER, customId: `bx:p:${id}:confirm`, messageId: party.messageId });
  await f.invoke(confirm);
  assert.match(asText(confirm.replies), /اتأكد مقعدك/);
  assert.deepEqual((await f.store.read()).parties[id].rsvps, { [STRANGER]: { remind: false } });
  assert.equal(f.api.dms.size, 0);
  await cancelParty(f.store, { id, channelId, now: f.now() });
  await worker.tick();
  assert.deepEqual((await f.store.read()).parties[id].waitlist, []);
  await worker.stop();
});

test('join-to-create and grace cleanup touch only empty bot-created voice rooms when the Gateway is healthy', async () => {
  const f = await adminFixture({ voice: true });
  const category = await f.chan(C.GuildCategory, 'temporary-voice');
  const lobby = await f.chan(C.GuildVoice, 'join-to-create');
  await f.room('voice_category', category);
  await f.room('voice_lobby', lobby);
  await f.enable();
  const fixed = await f.chan(C.GuildVoice, 'fixed-voice', { parent_id: category.id });
  const guild = { id: GUILD_ID, available: true, voiceStates: { cache: f.api.voiceStates }, shard: { status: Status.Ready } };
  const next = { id: MEMBER_ID, guild, channelId: lobby.id, member: { user: { bot: false } } };
  const join = () => f.admin.voice.join({ channelId: null }, next);
  f.api.voiceStates.set(MEMBER_ID, { channelId: lobby.id });
  await Promise.all([join(), join()]);
  const { channelId: temporary } = (await snap(f)).voices[MEMBER_ID];
  assert.equal(f.api.voiceStates.get(MEMBER_ID).channelId, temporary);
  assert.equal(writes(f, 'moveMember').length, 1);
  f.clock.at += MIN;
  await f.admin.tick(guild);
  assert.equal(writes(f, 'deleteChannel').length, 0);
  f.api.voiceStates.clear();
  await f.admin.tick(guild);
  f.clock.at += MIN;
  guild.shard.status = Status.Connecting;
  await f.admin.tick(guild);
  assert.equal(writes(f, 'deleteChannel').length, 0);
  guild.shard.status = Status.Ready;
  await f.restart().tick(guild);
  assert.deepEqual(writes(f, 'deleteChannel').map(({ channelId }) => channelId), [temporary]);
  assert.equal(f.api.channel(fixed.id).name, 'fixed-voice');
  assert.deepEqual((await snap(f)).voices, {});
});

test('AutoMod Gateway is opt-in and accumulates only scoped rule/channel counts, not matched text or member data', async (t) => {
  const f = await adminFixture({ automod: true, voice: true });
  const client = createBot(f);
  t.after(() => client.destroy());
  assert.deepEqual(new Set(client.options.intents.toArray()), new Set(['Guilds', 'GuildVoiceStates', 'AutoModerationExecution']));
  const modRole = await f.team('moderation');
  const otherChannel = await f.chan(C.GuildText, 'unscoped');
  await f.enable();
  const ruleId = f.api.nextId();
  const event = ({ guildId = GUILD_ID, channelId = f.staffRoom.id } = {}) => ({ guild: { id: guildId }, ruleId, channelId,
    get content() { throw new Error('content must not be read'); },
    get userId() { throw new Error('userId must not be read'); },
    get matchedContent() { throw new Error('matched content must not be read'); },
  });
  client.emit(Events.AutoModerationActionExecution, event());
  client.emit(Events.AutoModerationActionExecution, event());
  client.emit(Events.AutoModerationActionExecution, event({ guildId: OTHER_GUILD_ID }));
  client.emit(Events.AutoModerationActionExecution, event({ channelId: otherChannel.id }));
  await f.admin.tick();
  const i = f.make({ command: 'automod', by: MOD_ID, channel: f.staffRoom });
  await f.invoke(i);
  assert.equal(i.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.match(asText(i.replies), new RegExp(`${ruleId}.*2`));
  assert.doesNotMatch(asText(i.replies), new RegExp(otherChannel.id));
  await f.team('moderation', { withRole: modRole, channel: otherChannel });
  assert.match(asText(await f.admin.auto.summary(i)), new RegExp(otherChannel.id));
  await f.admin.config.pause(f.make(), { module: 'automod', paused: true });
  const before = (await snap(f)).automod;
  client.emit(Events.AutoModerationActionExecution, event());
  await f.admin.tick();
  assert.deepEqual((await snap(f)).automod, before);
  assert.equal(f.api.dms.size, 0);
});

test('a known rate-limit rejection is rechecked before a fresh scheduled dispatch; expired posts never send', async () => {
  const f = await adminFixture({ setup: true });
  await f.enable();
  const announce = (minute) => f.make({ command: 'announce', fields: { room: 'updates', title: 'News', body: 'Status', publish_at: `2027-01-01T10:0${minute}Z` } });
  const pending = announce(2);
  await f.invoke(pending);
  f.clock.at += 2 * MIN;
  const send = f.api.createMessage.bind(f.api);
  let attempts = 0;
  f.api.createMessage = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new DiscordApiError(429);
    return send(...args);
  };
  await f.admin.tick();
  assert.equal((await snap(f)).announcements[pending.id].status, 'scheduled');
  await f.admin.tick();
  assert.equal(attempts, 1);
  f.clock.at += MIN;
  await f.admin.tick();
  assert.equal(f.api.messages.length, 1);
  const expired = announce(4);
  await f.invoke(expired);
  f.clock.at += 20 * MIN;
  await f.admin.tick();
  assert.equal((await snap(f)).announcements[expired.id].status, 'expired');
  assert.equal(f.api.messages.length, 1);
});
