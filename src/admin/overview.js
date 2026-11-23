import { ChannelType as C, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { SITE_ORIGIN } from '../community/anime.js';
import { linkButton, row } from '../community/ui.js';
import { canManageRole, hasPermission } from '../discord/permissions.js';
import { AppError, ownerRequired } from '../lib/errors.js';
import { TICKET_BOT } from './channel-plan.js';
import { adminOf, card, denied, roomRef, TEXT_ROOMS } from './core.js';
import { moderationEnabled, moderationRole, unresolvedModeration } from './moderation.js';
import { rulesRoom } from './rules.js';

const EDIT = P.ViewChannel | P.ManageChannels | P.ManageRoles;
const POST = P.ViewChannel | P.SendMessages | P.EmbedLinks;
const channelAt = (c, w, id, types) => id && w.channels.find((ch) => ch.id === id &&
  (!ch.guild_id || ch.guild_id === c.guildId) && types.includes(ch.type));
const missing = (bits, mask) => hasPermission(bits, mask) ? [] : new PermissionsBitField(mask & ~bits).toArray();
const status = (flags) => flags.length ? `ناقص ${flags.join('، ')}` : 'الأذونات الأساسية موجودة';

async function savedAdmin(c) {
  if (!c.store) return { storage: 'مش متضبط' };
  try { return { a: adminOf(await c.read()), storage: 'متاح للقراءة' }; }
  catch (error) {
    if (error instanceof AppError && error.code === 'COMMUNITY_STORAGE_UNAVAILABLE') return { storage: 'مش متاح دلوقتي' };
    throw error;
  }
}

export function overviewActions(c) {
  return {
    async help(i) {
      const by = c.assertGuild(i);
      const [{ a }, w, member] = await Promise.all([savedAdmin(c), c.world(), c.api.getMember(c.guildId, by)]);
      if (member?.user?.id !== by || member.user.bot || !Array.isArray(member.roles)) throw denied();
      const canSee = (id, types) => {
        const ch = channelAt(c, w, id, types);
        return ch && !ch.nsfw && ch.id !== a?.rooms.site_staff && (!a?.rooms.ticket_category || ch.parent_id !== a.rooms.ticket_category) &&
          !ch.topic?.startsWith('bx-ticket:') && hasPermission(c.bits(w, ch, by, member), P.ViewChannel) ? roomRef(id) : undefined;
      };
      const rules = canSee(rulesRoom(a ?? {}), TEXT_ROOMS);
      const panel = a?.enabled && !a.paused.tickets && a.rooms.ticket_panel === a.panels.ticket?.channelId &&
        canSee(a.rooms.ticket_panel, TEXT_ROOMS);
      const ideas = a?.enabled && !a.paused.suggestions && canSee(a.rooms.suggestions, TEXT_ROOMS);
      const forum = a?.enabled && !a.paused.content && canSee(a.rooms.forum, [C.GuildForum]);
      const lines = [
        ...(rules ? [`📜 **القوانين:** ${rules}`] : []),
        ...(panel ? [`🎫 **مساعدة أو شكوى:** افتح تذكرة خاصة من ${panel}. ما تبعتش كلمة سر أو توكن.`] : []),
        ...(ideas ? [`💡 **اقتراح للسيرفر:** استخدم \`/idea add\` في ${ideas}.`] : []),
        ...(forum ? [`💬 **نقاش أنمي:** ${forum}، أو استخدم \`/discussion topic\`.`] : []),
        ...(a?.enabled ? ['🧾 **متابعتك:** `/my` لطلباتك وحجوزاتك، و`/calendar week` لأجندة الرومات اللي تقدر تشوفها.'] : []),
        '🎮 **الأنمي والفعاليات:** `/recommend` للترشيحات، و`/party` لحفلات المشاهدة.',
        '🌙 **الركن الإسلامي:** `/adhkar` للأذكار و`/prayer` لمواقيت الصلاة.',
      ];
      return { ...card('🧭 دليل BLACK X للأعضاء', lines.join('\n')), components: [row(linkButton(SITE_ORIGIN, 'موقع BLACK X'))] };
    },
    async health(i) {
      const by = await c.owner(i);
      const [{ a, storage }, w] = await Promise.all([savedAdmin(c), c.world()]);
      if (w.guild.owner_id !== by) throw ownerRequired();
      const botBits = c.bits(w, undefined, c.botId, w.botMember);
      const lines = ['🩺 فحص إعدادات BLACK X · قراءة فقط', `التخزين: ${storage}.`,
        ...(w.botRole ? [`أعلى رول للبوت: <@&${w.botRole.id}>.`] : []),
        ...(hasPermission(botBits, P.Administrator) ? ['⚠ البوت معاه Administrator. الميزات دي مش محتاجاه.'] : [])];
      if (!a) return [...lines, 'ربط الرومات والإشراف مش ممكن يتفحص من غير قراءة التخزين الدائم.'];
      const supportRole = w.allRoles.find(({ id }) => id === a.teams.support?.roleId);
      const modRole = moderationRole(c, w, a);
      const modRooms = (a.teams.moderation?.rooms ?? []).filter((id) => {
        const ch = channelAt(c, w, id, TEXT_ROOMS);
        return ch && hasPermission(c.bits(w, ch, c.botId, w.botMember), P.ViewChannel);
      });
      const modRoomCount = a.teams.moderation?.rooms.length ?? 0;
      const pending = unresolvedModeration(a);
      const everyoneSees = (ch) => hasPermission(c.bits(w, ch, c.guildId, { roles: [] }), P.ViewChannel);
      const supportLine = (label, id, types, mask, publicRoom) => {
        if (!id) return `• ${label}: مش مربوط.`;
        const ch = channelAt(c, w, id, types);
        if (!ch) return `• ${label}: ${roomRef(id)} مش ظاهر للبوت أو نوعه غلط. راجع View Channel والربط.`;
        const flags = missing(c.bits(w, ch, c.botId, w.botMember), mask);
        const visibility = everyoneSees(ch) === publicRoom ? '' : publicRoom ? ' · ⚠ مش ظاهر لـ@everyone' : ' · ⚠ ظاهر لـ@everyone';
        return `• ${label}: ${roomRef(id)} · ${status(flags)}${visibility}.`;
      };
      const guildSupport = EDIT | TICKET_BOT;
      return [...lines, `أدوات الإدارة: ${a.enabled ? 'مفعّلة' : 'متوقفة'}. فتح التذاكر: ${!a.enabled || a.paused.tickets ? 'متوقف' : 'مش موقوف'}.`,
        `طرد وكتم الأعضاء: ${moderationEnabled(c, w, a) ? 'مفعّلين' : 'متوقفين (تفعيل منفصل للمالك)'}.`,
        `أذونات الإشراف الاختيارية للبوت: ${status(missing(botBits, P.KickMembers | P.ModerateMembers))}.`,
        `نطاق المشرفين: ${modRole ? `<@&${modRole.id}> · ${modRooms.length}/${modRoomCount} روم نصّي ظاهر للبوت` : 'مفيش رول إشراف مستقل صالح'}.`,
        ...(pending.length ? [`إجراءات إشراف محتاجة مراجعة: ${pending.length} · ${pending.slice(0, 5).map(({ id }) => `\`${id}\``).join('، ')}.`] : []),
        `أذونات البوت على مستوى السيرفر للتذاكر: ${status(missing(botBits, guildSupport))}.`,
        `رول الدعم: ${!supportRole ? 'مش مربوط أو مش موجود' : `<@&${supportRole.id}> · ${canManageRole(w.botRole, supportRole, c.guildId) ? 'تحت رول البوت' : 'مش قابل للإدارة من البوت'}`}.`,
        supportLine('لوحة الأعضاء', a.rooms.ticket_panel, TEXT_ROOMS, EDIT | POST, true),
        supportLine('كاتيجوري التذاكر', a.rooms.ticket_category, [C.GuildCategory], guildSupport, false),
        supportLine('روم فريق الدعم', a.rooms.site_staff, TEXT_ROOMS, EDIT | POST, false),
        'ده فحص الروابط والأذونات الأساسية؛ لمراجعة تغييرات أذونات الدعم بالتفصيل استخدم `/setup scope:support dry_run:true`.'];
    },
  };
}
