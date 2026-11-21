import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType as C, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { DiscordApiError } from '../src/lib/errors.js';
import { adminFixture, asText, own, REVIEWER, STRANGER } from './fixtures/admin.js';
import { MEMBER_ID, MOD_ID, OTHER_GUILD_ID } from './fixtures/discord.js';

const state = async (f) => (await f.store.read()).admin;
const messagesIn = (f, id) => f.api.messages.filter((m) => m.channelId === id);
const staff = (f, options) => f.make({ by: MOD_ID, channel: f.staffRoom, ...options });
const statusOf = (payload) => payload.embeds[0].fields.find(({ name }) => name === 'الحالة').value;

async function system() {
  const f = await adminFixture();
  const category = await f.chan(C.GuildCategory, 'cases');
  const role = await f.team('support', { users: [MOD_ID, REVIEWER] });
  await f.room('ticket_panel', f.publicRoom);
  await f.room('ticket_category', category);
  await f.enable();
  const open = async () => {
    const i = f.make({ by: MEMBER_ID });
    await f.admin.ticket.open(i, { type: 'site' });
    return (await state(f)).requests[i.id];
  };
  return { ...f, open, role };
}

test('the panel describes both paths and each private case has a single metadata card reflecting claim and close', async () => {
  const f = await system();
  await f.admin.ticket.panel(f.make());
  const [panel] = messagesIn(f, f.publicRoom.id);
  assert.equal(panel.data.embeds[0].title, '🎫 مركز دعم BLACK X');
  assert.deepEqual(panel.data.components[0].components.map(({ custom_id }) => custom_id), ['bx:x:ticket:site', 'bx:x:ticket:report']);
  const r = await f.open();
  const header = () => f.api.getMessage(r.channelId, r.cardMessageId);
  assert.equal(statusOf(await header()), 'مفتوحة');
  assert.match(asText(await header()), new RegExp(r.id));
  assert.match(asText(await header()), /اسم الصفحة/);
  assert.doesNotMatch(asText(await header()), new RegExp(MEMBER_ID));
  const again = await f.admin.ticket.open(f.make({ by: MEMBER_ID }), { type: 'site' });
  assert.match(asText(again), /تذكرة مفتوحة بالفعل/);
  assert.equal(messagesIn(f, r.channelId).length, 1);

  const detail = staff(f, { command: 'staff', action: 'detail', fields: { team: 'support', id: r.id } });
  await f.invoke(detail);
  assert.equal(detail.replies[0][1].flags, MessageFlags.Ephemeral);
  const details = detail.replies.at(-1)[1];
  const [claim, reply, close] = details.components[0].components.map(({ custom_id }) => custom_id);
  assert.equal(statusOf(details), 'مفتوحة');
  await assert.rejects(f.admin.button(staff(f, { customId: claim, by: MEMBER_ID })), { code: 'ADMIN_SCOPE' });
  await f.invoke(staff(f, { customId: claim }));
  await assert.rejects(f.admin.button(staff(f, { customId: claim, by: REVIEWER })), { code: 'ADMIN_STALE' });
  assert.equal(statusOf(await header()), 'مستلمة');
  assert.match(asText(await f.admin.staff.detail(staff(f), { team: 'support', id: r.id })), /مسؤول التذكرة/);

  const dialog = staff(f, { customId: reply });
  await f.invoke(dialog);
  assert.equal(dialog.replies[0][0], 'modal');
  assert.equal(dialog.replies[0][1].components[0].component.custom_id, 'body');
  assert.equal(dialog.replies[0][1].custom_id, reply);
  const response = 'رد للاختبار @everyone';
  await f.invoke(staff(f, { customId: reply, modal: true, fields: { body: response } }));
  const post = messagesIn(f, r.channelId).at(-1).data;
  assert.match(post.embeds[0].description, /رد للاختبار/);
  assert.deepEqual(post.allowed_mentions, { parse: [] });
  assert.ok(!(await state(f)).requests[r.id].shared);
  assert.doesNotMatch(asText(await state(f)), /رد للاختبار/);

  const approval = staff(f, { customId: close });
  await f.invoke(approval);
  assert.equal(approval.replies[0][1].components[0].component.custom_id, 'reason');
  const before = f.api.writes.length;
  await assert.rejects(f.admin.modal(staff(f, { customId: close, modal: true, fields: { reason: ' ' } })), { code: 'ADMIN_TEXT' });
  assert.equal(f.api.writes.length, before);
  const reason = 'اتحلّت المشكلة';
  await f.invoke(staff(f, { customId: close, modal: true, fields: { reason } }));
  assert.equal(statusOf(await header()), 'مقفولة');
  assert.doesNotMatch(asText(await header()), new RegExp(reason));
  assert.equal(f.api.channel(r.channelId).permission_overwrites.find(({ id }) => id === MEMBER_ID).deny, String(P.SendMessages));
  assert.equal(messagesIn(f, r.channelId).length, 2);
  assert.equal(messagesIn(f, f.publicRoom.id).length, 1);
  assert.deepEqual((await f.admin.staff.detail(staff(f), { team: 'support', id: r.id })).components, []);
  assert.doesNotMatch(asText(await f.admin.staff.audit(staff(f), { team: 'support' })), /رد للاختبار|اتحلّت المشكلة/);
  assert.ok(f.api.writes.every(({ method }) => method !== 'DELETE'));
});

test('a case modal cannot bypass delegation, guild boundaries, pending status or changed channel privacy', async () => {
  const f = await system();
  const r = await f.open();
  const modal = { customId: `bx:x:case:reply:${r.id}`, modal: true, fields: { body: 'must not leak' } };
  const before = f.api.writes.length;
  for (const overrides of [{ channel: f.publicRoom }, { guildId: OTHER_GUILD_ID }, { by: STRANGER }]) {
    await assert.rejects(f.admin.modal(staff(f, { ...modal, ...overrides })), { code: 'ADMIN_SCOPE' });
  }
  f.api.members.get(MOD_ID).roles = [];
  await assert.rejects(f.admin.modal(staff(f, modal)), { code: 'ADMIN_SCOPE' });
  f.api.members.get(MOD_ID).roles = [f.role.id];
  f.api.members.get(MOD_ID).pending = true;
  await assert.rejects(f.admin.modal(staff(f, modal)), { code: 'ADMIN_SCOPE' });
  f.api.members.get(MOD_ID).pending = false;
  const fetch = f.api.getChannel.bind(f.api);
  f.api.getChannel = (id) => {
    f.api.channel(id).permission_overwrites.push(own(STRANGER, P.ViewChannel));
    return fetch(id);
  };
  await assert.rejects(f.admin.modal(staff(f, modal)), { code: 'ADMIN_TICKET_PRIVACY' });
  await assert.rejects(f.admin.staff.detail(staff(f), { team: 'support', id: r.id }), { code: 'ADMIN_TICKET_PRIVACY' });
  assert.equal(f.api.writes.length, before);
  assert.doesNotMatch(asText(f.api.messages), /must not leak/);
});

test('losing the card acknowledgement neither duplicates the card nor blocks work on the private ticket', async () => {
  const f = await system();
  const create = f.api.createMessage.bind(f.api);
  f.api.createMessage = async (...args) => { await create(...args); throw new DiscordApiError(502); };
  const r = await f.open();
  assert.equal(r.cardMessageId, undefined);
  assert.equal(r.status, 'open');
  f.api.createMessage = create;
  await f.restart().ticket.open(f.make({ by: MEMBER_ID }), { type: 'site' });
  assert.equal(messagesIn(f, r.channelId).length, 1);
  await f.admin.ticket.claim(staff(f), { id: r.id });
  await f.admin.ticket.close(staff(f), { id: r.id, reason: 'resolved' });
  assert.equal((await state(f)).requests[r.id].status, 'closed');
  assert.equal(messagesIn(f, r.channelId).length, 1);
  assert.equal(f.api.edits.length, 0);
});
