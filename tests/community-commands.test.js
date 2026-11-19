import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { createInteractionHandler } from '../src/bot.js';
import { createAnimeService } from '../src/community/anime.js';
import { createQuizService } from '../src/community/quiz.js';
import { createMemoryStore } from '../src/community/store.js';
import { readConfig } from '../src/lib/env.js';
import { createLogger } from '../src/lib/log.js';
import { BOT_ID, GUILD_ID, MEMBER_ID, MOD_ID, OTHER_GUILD_ID, OWNER_ID, MemoryDiscord, fixtureEnv } from './fixtures/discord.js';

const CHANNEL = '400000000000000003';
const ID = '400000000000000004';
const NOW = Date.parse('2027-01-11T10:00:00Z');
const SEND = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

function fixture(t) {
  const store = createMemoryStore();
  const now = () => NOW;
  const api = new MemoryDiscord();
  const log = createLogger({ write: () => {} });
  const config = readConfig(fixtureEnv());
  const quiz = createQuizService({ api, store, log, now });
  const anime = createAnimeService({ store, now });
  t.after(() => quiz.close());
  const handle = createInteractionHandler({ api, config, botId: BOT_ID, log, community: { store, now, quiz, anime } });
  return { handle, store, api, anime };
}

function invocation(commandName, { userId = MEMBER_ID, guildId = GUILD_ID, options = {}, messageId,
  customId, autocomplete = false, permissions = [], appPermissions = SEND, channelType = ChannelType.GuildText } = {}) {
  const replies = [];
  return {
    id: ID, replies, commandName, guildId, channelId: CHANNEL, guild: { ownerId: OWNER_ID }, channel: { id: CHANNEL, guildId, type: channelType },
    user: { id: userId }, customId, message: { id: messageId },
    isChatInputCommand: () => !customId && !autocomplete, isButton: () => Boolean(customId), isAutocomplete: () => autocomplete,
    appPermissions: new PermissionsBitField(appPermissions), memberPermissions: new PermissionsBitField(permissions),
    options: { getSubcommand: () => options.action, getString: (key) => options[key], getFocused: () => options.query },
    async reply(value) { this.replied = true; replies.push(['reply', value]); },
    async deferReply(value) { this.deferred = true; replies.push(['defer', value]); },
    async deferUpdate() { this.deferred = true; replies.push(['update']); },
    async editReply(value) { this.replied = true; replies.push(['edit', value]); },
    async followUp(value) { replies.push(['followUp', value]); },
    async respond(value) { this.responded = true; replies.push(['choices', value]); },
  };
}
const last = (interaction) => interaction.replies.at(-1)[1];

test('ephemeral morning/evening adhkar cards have sources and owner-bound next/previous navigation', async (t) => {
  const { handle, api } = fixture(t);
  const morning = invocation('adhkar', { options: { period: 'morning' } });
  await handle(morning);
  assert.equal(morning.replies[0][1].flags, MessageFlags.Ephemeral);
  const card = last(morning);
  assert.match(card.embeds[0].title, /الصباح/);
  assert.match(card.embeds[0].fields[1].value, /sunnah\.com\/abudawud:5088/);
  assert.deepEqual(card.allowedMentions.parse, []);
  const [previous, next] = card.components[0].components;
  assert.equal(previous.disabled, true);
  const foreign = invocation(undefined, { customId: next.custom_id, guildId: OTHER_GUILD_ID });
  await handle(foreign);
  assert.deepEqual(foreign.replies.map(([action]) => action), ['reply']);
  const replay = invocation(undefined, { customId: next.custom_id, userId: MOD_ID });
  await handle(replay);
  assert.match(last(replay).content, /مش صالح ليك/);
  assert.equal(last(replay).flags, MessageFlags.Ephemeral);
  const authorized = invocation(undefined, { customId: next.custom_id });
  await handle(authorized);
  assert.deepEqual(authorized.replies.map(([action]) => action), ['update', 'edit']);
  assert.match(last(authorized).embeds[0].title, /الإخلاص/);
  assert.equal(api.messages.length, 0);
  const evening = invocation('adhkar', { options: { period: 'evening' } });
  await handle(evening);
  assert.match(last(evening).embeds[0].title, /المساء/);
});

test('Arena and Seerah game administration requires a moderator, a safe text channel, and bot permissions', async (t) => {
  const { api, handle } = fixture(t);
  const options = { action: 'start' };
  const member = invocation('arena', { options });
  await handle(member);
  assert.match(last(member).content, /للإدارة فقط/);
  const moderator = { options, userId: MOD_ID, permissions: [PermissionFlagsBits.ManageMessages] };
  const noEmbeds = invocation('seerah', { ...moderator, appPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel] });
  await handle(noEmbeds);
  assert.match(last(noEmbeds).content, /Embed Links/);
  const wrongChannel = invocation('arena', { ...moderator, channelType: ChannelType.GuildVoice });
  await handle(wrongChannel);
  assert.match(last(wrongChannel).content, /رومًا نصيًا/);
  assert.equal(api.messages.length, 0);
  await handle(invocation('arena', moderator));
  assert.equal(api.messages.length, 1);
  const [{ id, data }] = api.messages;
  const customId = data.components[0].components[0].custom_id;
  const answer = invocation(undefined, { messageId: id, customId });
  await handle(answer);
  assert.equal(answer.replies[0][1].flags, MessageFlags.Ephemeral);
  assert.match(last(answer).content, /اتسجّلت إجابتك/);
  assert.equal(api.messages.length, 1);
});

test('the party command rejects off-site URLs and queues a valid party for the current official room', async (t) => {
  const { handle, store } = fixture(t);
  const base = { userId: MOD_ID, permissions: [PermissionFlagsBits.ManageMessages] };
  const options = { action: 'schedule', title: 'حلقة جديدة', starts_at: '2027-01-11T21:00+02:00', url: 'https://example.org/anime' };
  const outside = invocation('party', { ...base, options });
  await handle(outside);
  assert.match(last(outside).content, /استخدم رابط HTTPS صالح/);
  assert.deepEqual((await store.read()).parties, {});
  const ok = invocation('party', { ...base, options: { ...options, url: 'https://black-x-anime.ai.studio/anime/demo' } });
  await handle(ok);
  assert.match(last(ok).content, /اتجدولت/);
  assert.equal((await store.read()).parties[ID].channelId, CHANNEL);
});

test('daily preview is public to guild members privately, but a daily schedule needs Manage Guild', async (t) => {
  const { handle, store } = fixture(t);
  const preview = invocation('daily', { options: { action: 'preview', mode: 'hadith' } });
  await handle(preview);
  assert.match(last(preview).embeds[0].title, /حديث اليوم/);
  assert.equal(preview.replies[0][1].flags, MessageFlags.Ephemeral);
  const mod = { userId: MOD_ID, options: { action: 'enable', mode: 'alternate', city: 'giza', time: '09:30' } };
  const denied = invocation('daily', { ...mod, permissions: [PermissionFlagsBits.ManageMessages] });
  await handle(denied);
  assert.match(last(denied).content, /للإدارة فقط/);
  assert.equal((await store.read()).daily, null);
  await handle(invocation('daily', { ...mod, permissions: [PermissionFlagsBits.ManageGuild] }));
  assert.deepEqual((await store.read()).daily, { mode: 'alternate', minute: 570, city: 'giza', channelId: CHANNEL, version: ID });
});

test('autocomplete does not disclose catalog entries outside the allowed guild', async (t) => {
  const { handle, anime } = fixture(t);
  await anime.updateCatalog({ items: [{ id: 'a1', title: 'Example Anime', genres: ['fantasy'], episodes: 12, url: 'https://black-x-anime.ai.studio/anime/example' }] });
  const options = { action: 'add', query: 'example' };
  const foreign = invocation('follow', { autocomplete: true, guildId: OTHER_GUILD_ID, options });
  await handle(foreign);
  assert.deepEqual(last(foreign), []);
  const allowed = invocation('follow', { autocomplete: true, options });
  await handle(allowed);
  assert.deepEqual(last(allowed), [{ name: 'Example Anime', value: 'a1' }]);
});
