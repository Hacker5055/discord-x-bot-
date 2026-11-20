import { randomUUID } from 'node:crypto';
import { ChannelType, PermissionFlagsBits as P, Status } from 'discord.js';
import { DAY } from '../community/time.js';
import { hasPermission } from '../discord/permissions.js';
import { isSnowflake } from '../lib/catalog.js';
import { AppError } from '../lib/errors.js';
import { adminOf, audit, idOf, isMissing, roomRef, stale } from './core.js';

const VOICE_GRACE = 30_000;
const voiceAvailable = (guild) => guild?.available && (!guild.shard || guild.shard.status === Status.Ready);
const inVoice = (guild, by) => guild.voiceStates?.cache.get(by)?.channelId;
const sameVoice = (ch, r, guildId) => ch?.guild_id === guildId && ch.type === ChannelType.GuildVoice && ch.parent_id === r.categoryId && ch.name === r.name;

export function voiceRooms(c) {
  async function join(oldState, next) {
    const by = next.id;
    const guild = next.guild;
    if (!c.config.adminVoice || !c.store || guild?.id !== c.guildId || !voiceAvailable(guild) || oldState.channelId === next.channelId ||
      !isSnowflake(by) || !next.channelId || !next.member?.user || next.member.user.bot) return;
    // A caller still in the configured lobby can have at most one bot-owned voice room.
    await c.serial('temp-voice', async () => {
      const a = adminOf(await c.read());
      const lobby = a.rooms.voice_lobby;
      if (!a.enabled || a.paused.voice || next.channelId !== lobby || !a.rooms.voice_category || inVoice(guild, by) !== lobby) return;
      const w = await c.world();
      const category = c.findRoom(w, a.rooms.voice_category, [ChannelType.GuildCategory]);
      const entry = c.findRoom(w, lobby, [ChannelType.GuildVoice]);
      const member = await c.api.getMember(c.guildId, by);
      const perms = c.bits(w, category, by, member);
      if (member.user?.bot || ![P.ViewChannel, P.Connect].every((flag) => hasPermission(perms, flag))) return;
      c.botNeeds(w, entry, P.ViewChannel, P.Connect, P.MoveMembers);
      c.botNeeds(w, category, P.ViewChannel, P.Connect, P.MoveMembers, P.ManageChannels);
      let r = a.voices[by];
      if (r && r.categoryId !== category.id) return; // A former category's room is cleaned separately.
      if (!r) {
        r = await c.edit((draft) => {
          if (!draft.enabled || draft.paused.voice || draft.rooms.voice_lobby !== lobby || draft.rooms.voice_category !== category.id) throw stale();
          if (Object.keys(draft.voices).length >= 12) throw new AppError('ADMIN_VOICE_LIMIT', 'الحد الأقصى للرومات المؤقتة ١٢ روم.');
          return draft.voices[by] = { by, categoryId: category.id, name: `bx-voice-${randomUUID().slice(0, 12)}`, at: c.now() };
        });
      }
      const match = (chs) => chs.find((ch) => sameVoice(ch, r, c.guildId));
      let room;
      if (r.channelId) {
        room = w.channels.find((ch) => ch.id === r.channelId);
        if (!sameVoice(room, r, c.guildId)) return;
      } else {
        const recover = async () => match(await c.api.getChannels(c.guildId));
        room = match(w.channels) ?? await c.api.createChannel(c.guildId, {
          name: r.name, parent_id: r.categoryId, type: ChannelType.GuildVoice, user_limit: 10,
          permission_overwrites: category.permission_overwrites ?? [],
        }, recover);
        if (!sameVoice(room, r, c.guildId) || !isSnowflake(room.id)) throw stale();
        await c.edit((draft) => {
          const r = draft.voices[by];
          r.channelId = idOf(room.id);
          r.emptySince = c.now();
          audit(draft, 'events', 'voice_opened', by, room.id, c.now());
        });
      }
      if (inVoice(guild, by) !== lobby || !voiceAvailable(guild)) return;
      const targetPerms = c.bits(w, room, by, member);
      if (![P.ViewChannel, P.Connect].every((flag) => hasPermission(targetPerms, flag))) return;
      c.botNeeds(w, room, P.ViewChannel, P.Connect, P.MoveMembers);
      await c.api.moveMember(c.guildId, by, room.id);
      await c.edit((draft) => { if (draft.voices[by]) delete draft.voices[by].emptySince; });
    });
  }
  async function cleanup(guild, snapshot) {
    if (!c.config.adminVoice || guild?.id !== c.guildId || !voiceAvailable(guild) || !guild.voiceStates?.cache || !Object.keys(snapshot.voices).length) return;
    await c.serial('temp-voice', async () => {
      const now = c.now();
      const active = (id) => [...guild.voiceStates.cache.values()].some(({ channelId }) => channelId === id);
      const due = await c.edit((a) => {
        const result = [];
        for (const [by, r] of Object.entries(a.voices)) {
          if (!r.channelId) {
            // A failed creation without a verified channel ID is never deleted by name.
            if (r.at + DAY < now) delete a.voices[by];
            continue;
          }
          if (active(r.channelId)) delete r.emptySince;
          else {
            r.emptySince ??= now;
            if (r.emptySince + VOICE_GRACE <= now && !(r.recheckAt > now)) result.push(r);
          }
        }
        return result.slice(0, 3);
      });
      for (const r of due) {
        let outcome = 'missing';
        try {
          const room = await c.api.getChannel(r.channelId);
          if (!sameVoice(room, r, c.guildId)) outcome = 'changed_elsewhere';
          else {
            // Don't touch any unapproved room, even if someone later reuses a display name.
            if (!voiceAvailable(guild) || active(r.channelId)) continue;
            await c.api.deleteChannel(r.channelId);
            outcome = 'empty_deleted';
          }
        } catch (error) {
          if (!isMissing(error)) {
            await c.edit((a) => {
              const current = a.voices[r.by];
              if (!current || current.channelId !== r.channelId) return;
              current.recheckAt = c.now() + 5 * 60_000;
              audit(a, 'events', 'voice_cleanup_retry', undefined, r.channelId, c.now());
            });
            continue;
          }
        }
        await c.edit((a) => {
          if (a.voices[r.by]?.channelId !== r.channelId) return;
          delete a.voices[r.by];
          audit(a, 'events', 'voice_cleanup', undefined, r.channelId, c.now(), outcome);
        });
      }
    });
  }
  return { join, cleanup };
}

export function automodMonitor(c) {
  let pending = new Map();
  return {
    observe({ guild, channelId, ruleId }) {
      // Deliberately never read content, matched strings, user IDs, or the rule configuration.
      if (!c.config.adminAutoMod || !c.store || guild?.id !== c.guildId || ![channelId, ruleId].every(isSnowflake)) return;
      const day = Math.floor(c.now() / DAY);
      const key = `${day}:${channelId}:${ruleId}`;
      const prior = pending.get(key);
      if (prior) prior.count = Math.min(prior.count + 1, 2_000_000_000);
      else if (pending.size < 250) pending.set(key, { day, channelId, ruleId, count: 1 });
    },
    async flush(snapshot) {
      if (!pending.size) return;
      const batch = pending;
      pending = new Map();
      if (!snapshot.enabled || snapshot.paused.automod) return;
      const cutoff = Math.floor(c.now() / DAY) - 13;
      await c.edit((a) => {
        if (!a.enabled || a.paused.automod || a.version !== snapshot.version) return;
        for (const [key, value] of Object.entries(a.automod)) if (value.day < cutoff) delete a.automod[key];
        let size = Object.keys(a.automod).length;
        for (const [key, value] of batch) {
          if (a.automod[key]) a.automod[key].count = Math.min(a.automod[key].count + value.count, 2_000_000_000);
          else if (size < 500) { a.automod[key] = value; size += 1; }
        }
      });
    },
    async summary(i) {
      const ctx = await c.session(i, { team: 'moderation' });
      if (!c.config.adminAutoMod) return ['رصد AutoMod مش مفعّل للتشغيل ده. راجع BX_ADMIN_AUTOMOD في التوثيق.'];
      const cutoff = Math.floor(c.now() / DAY) - 6;
      const totals = new Map();
      for (const value of Object.values(ctx.a.automod)) {
        if (value.day < cutoff) continue;
        const { channelId, ruleId } = value;
        const channel = ctx.w.channels.find((ch) => ch.id === channelId);
        if (!channel || !hasPermission(c.bits(ctx.w, channel, ctx.by, ctx.member), P.ViewChannel) ||
          (!ctx.owner && !ctx.a.teams.moderation?.rooms.includes(channelId))) continue;
        const key = `${channelId}:${ruleId}`;
        const entry = totals.get(key) ?? { channelId, ruleId, count: 0 };
        entry.count += value.count;
        totals.set(key, entry);
      }
      return ['🛡️ تنفيذ قواعد AutoMod · آخر ٧ أيام UTC · الأعداد المرصودة فقط', ...[...totals.values()].sort((a, b) => b.count - a.count).slice(0, 15)
        .map((r) => `• ${roomRef(r.channelId)} · قاعدة \`${r.ruleId}\` · ${r.count}`), ...(totals.size ? [] : ['مفيش أحداث مرصودة في نطاقك.'])];
    },
  };
}
