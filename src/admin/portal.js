import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { SITE_ORIGIN } from '../community/anime.js';
import { button, linkButton, row } from '../community/ui.js';
import { hasPermission } from '../discord/permissions.js';
import { resolveRooms } from '../discord/state.js';
import { ROOMS, truncate } from '../lib/catalog.js';
import { AppError } from '../lib/errors.js';
import { adminOf, audit, card, denied, fixedChoice, idOf, INTERESTS, isMissing, limits, nonce, notFound, post,
  roomRef, stale, TEXT_ROOMS, within } from './core.js';

export function guideActions(c) {
  return {
    async publish(i, { rules }) {
      return c.serial('guide-panel', async () => {
        const s = await c.session(i, { team: 'ops', ownerOnly: true, types: TEXT_ROOMS });
        c.postNeeds(s.w, s.channel);
        const ruleRoom = c.findRoom(s.w, idOf(rules?.id), TEXT_ROOMS);
        const support = s.a.rooms.ticket_panel;
        const { rooms } = resolveRooms(s.w.channels, c.config);
        const publicRoom = (room) => room && hasPermission(c.bits(s.w, room, c.guildId, { roles: [] }), P.ViewChannel);
        const map = Object.entries(rooms).filter(([, room]) => publicRoom(room)).map(([key, room]) => `${roomRef(room.id)} (${ROOMS[key].name})`);
        for (const key of ['suggestions', 'forum', 'voice_lobby']) {
          const room = s.w.channels.find((r) => r.id === s.a.rooms[key]);
          if (publicRoom(room)) map.push(roomRef(room.id));
        }
        const buttons = Object.entries(s.a.interests).map(([key, id]) => {
          c.ordinaryRole(s.w, s.a, id);
          return button(`bx:x:interest:${key}`, INTERESTS[key]);
        });
        const body = ['أهلاً بيك في BLACK X!', `ابدأ من القوانين: ${roomRef(ruleRoom.id)}.`,
          ...(publicRoom(s.w.channels.find((r) => r.id === support)) ? [`محتاج مساعدة؟ افتح ${roomRef(support)}.`] : []),
          ...(map.length ? [`خريطة الرومات المتاحة: ${[...new Set(map)].join(' · ')}.`] : []),
          ...(buttons.length ? ['اختار اهتماماتك من الأزرار؛ اضغط تاني عشان تشيل نفس الرول.'] : [])].join('\n');
        const components = [row(linkButton(SITE_ORIGIN, 'افتح موقع BLACK X')), ...(buttons.length ? [row(...buttons)] : [])];
        const payload = { ...card('🧭 ابدأ هنا', body), components };
        const previous = s.a.panels.guide;
        let messageId;
        if (previous && previous.channelId !== s.channel.id) {
          try {
            await c.api.getMessage(previous.channelId, previous.messageId);
            throw new AppError('ADMIN_GUIDE_ROOM', 'فيه لوحة «ابدأ هنا» موجودة بالفعل. حدّثها في رومها، أو احذفها يدويًا قبل النقل.', 409);
          } catch (error) { if (!isMissing(error)) throw error; }
        }
        if (previous?.channelId === s.channel.id) {
          try {
            await c.api.editMessage(s.channel.id, previous.messageId, post(payload));
            messageId = previous.messageId;
          } catch (error) { if (!isMissing(error)) throw error; }
        }
        if (!messageId) messageId = idOf((await c.api.createMessage(s.channel.id, post(payload, i.id)))?.id);
        await c.edit((a) => {
          a.panels.guide = { channelId: s.channel.id, messageId };
          audit(a, 'ops', 'guide_published', s.by, s.channel.id, c.now());
        }, s);
        return ['لوحة «ابدأ هنا» جاهزة.'];
      });
    },
    async interest(i, key) {
      fixedChoice(Object.keys(INTERESTS), key);
      const userId = c.assertGuild(i);
      return c.serial(`interest:${userId}`, async () => {
        const s = await c.session(i, { types: TEXT_ROOMS });
        const panel = s.a.panels.guide;
        if (!panel || panel.stale || i.message?.id !== panel.messageId || s.channel.id !== panel.channelId) throw stale();
        const role = c.ordinaryRole(s.w, s.a, s.a.interests[key]);
        await c.assertCurrent(s);
        if (s.member.roles.includes(role.id)) {
          await c.api.revokeRole(c.guildId, s.by, role.id);
          return [`اتشال دور ${INTERESTS[key]} من حسابك.`];
        }
        await c.api.grantRole(c.guildId, s.by, role.id);
        return [`اتضاف دور ${INTERESTS[key]} لحسابك. مفيش تغيير في VIP.`];
      });
    },
  };
}

export function discussionActions(c) {
  return {
    async topic(i, { anime, season, spoiler }) {
      c.assertGuild(i);
      within(season, 1, 100);
      const target = idOf(adminOf(await c.read()).rooms.forum);
      return c.serial('forum-posts', async () => {
        const s = await c.session(i, { roomId: target, types: [ChannelType.GuildForum], flags: [P.SendMessages], module: 'content' });
        if (s.a.rooms.forum !== target) throw denied();
        if (typeof anime !== 'string' || !Object.hasOwn(s.state.catalog, anime)) throw notFound();
        const tagName = spoiler ? 'حرق' : 'بلا حرق';
        const entry = s.state.catalog[anime];
        const tagNames = [tagName, truncate(entry.title, 20).trim(), `موسم ${season}`];
        const tags = tagNames.map((name) => s.channel.available_tags?.find((entry) => entry.name === name && !entry.moderated)?.id);
        if (tags.some((id) => !id) || new Set(tags).size !== tagNames.length) {
          throw new AppError('ADMIN_FORUM_TAGS', `محتاج وسوم المنتدى دي من الإدارة: ${tagNames.map((name) => `«${name}»`).join('، ')}.`);
        }
        c.botNeeds(s.w, s.channel, P.ViewChannel, P.SendMessages);
        const key = `${target}:${anime}:${season}:${spoiler ? 'spoiler' : 'safe'}`;
        let record = s.a.topics[key];
        if (record?.threadId) {
          try {
            const prior = await c.api.getChannel(record.threadId);
            if (prior?.parent_id !== target || prior.guild_id !== c.guildId || prior.type !== ChannelType.PublicThread) throw stale();
            return [`النقاش موجود: ${roomRef(prior.id)}.`];
          } catch (error) { if (!isMissing(error)) throw error; }
        }
        if (!record && Object.values(s.a.topics).filter(({ by, at }) => by === s.by && c.now() - at < 86_400_000).length >= 3) {
          throw new AppError('ADMIN_FORUM_LIMIT', 'تقدر تفتح ٣ مواضيع جديدة بالبوت خلال اليوم.');
        }
        // Stable signature for finding a forum post after a possibly successful POST.
        const name = `${truncate(entry.title, 56)} · موسم ${season} · ${tagName} · ${nonce(key).slice(0, 8)}`;
        const recover = async () => (await c.api.getActiveThreads(c.guildId)).threads
          ?.find((t) => t.parent_id === target && t.owner_id === c.botId && t.name === name);
        await c.edit((a) => {
          if (!a.topics[key]) limits(a.topics, 250);
          record = { by: s.by, at: c.now(), threadId: null };
          a.topics[key] = record;
        }, s);
        const thread = await recover() ?? await c.api.createForumPost(target, {
          name, applied_tags: tags.map(idOf), message: post({ content: `${spoiler ? '⚠️ النقاش ده فيه حرق.' : 'النقاش ده من غير حرق.'}\nرابط العمل: <${entry.url}>` }),
        }, recover);
        if (thread.parent_id !== target || thread.guild_id !== c.guildId || thread.type !== ChannelType.PublicThread || thread.owner_id !== c.botId) throw stale();
        const threadId = idOf(thread.id);
        await c.edit((a) => {
          a.topics[key].threadId = threadId;
          audit(a, 'content', 'discussion_opened', s.by, threadId, c.now());
        });
        return [`اتفتح النقاش: ${roomRef(threadId)}.`];
      });
    },
  };
}
