import { resolveRooms } from '../discord/state.js';
import { AppError } from '../lib/errors.js';
import { adminOf, audit, fixedChoice, idOf, INTERESTS, live, MODULES, ROOM_TYPES, roomRef, TEAMS, TEXT_ROOMS } from './core.js';

export function configActions(c) {
  const changed = (i, action, target, update) => c.owner(i).then((by) => c.edit((a) => {
    update(a);
    a.version += 1;
    audit(a, 'ops', action, by, target, c.now());
  }));
  return {
    async enable(i, { enabled }) {
      await changed(i, enabled ? 'admin_enabled' : 'admin_disabled', 'admin', (a) => { a.enabled = enabled; });
      return [enabled ? 'اتفعّلت أدوات الإدارة. الميزات اللي بتحتاج روم أو فريق لازم تتضبط الأول.' :
        'أدوات الإدارة اتوقفت. انتهاء الوصول المؤقت والتهدئة يفضل شغّال للحماية.'];
    },
    async team(i, { team, role, channel }) {
      fixedChoice(TEAMS, team);
      const by = await c.owner(i);
      const roleId = idOf(role?.id);
      const w = await c.world();
      const destination = c.findRoom(w, idOf(channel?.id), TEXT_ROOMS);
      if (!w.allRoles.some((r) => r.id === roleId && !r.managed && r.id !== c.guildId) ||
        c.productRole(w, roleId)) {
        throw new AppError('ADMIN_TEAM_ROLE', 'اختار رول فريق مخصص، مش رول VIP أو Creator أو رول بوت.');
      }
      await c.edit((a) => {
        if (Object.values(a.interests).includes(roleId)) throw new AppError('ADMIN_TEAM_ROLE', 'رول الاهتمام ما ينفعش يتستخدم للتفويض.');
        const prior = a.teams[team];
        if (team === 'support' && prior?.roleId && prior.roleId !== roleId &&
          Object.values(a.requests).some((r) => r.kind === 'ticket' && !r.closedAt)) {
          throw new AppError('ADMIN_ACTIVE_TICKETS', 'اقفل تذاكر الدعم الحالية قبل تغيير رول الفريق.');
        }
        const rooms = prior?.roleId === roleId ? [...new Set([...prior.rooms, destination.id])] : [destination.id];
        if (rooms.length > 8) throw new AppError('ADMIN_TEAM_LIMIT', 'أقصى عدد للرومات المسموحة لكل فريق هو ٨.');
        a.teams[team] = { roleId, rooms };
        a.version += 1;
        audit(a, 'ops', 'team_configured', by, team, c.now());
      });
      return [`اتضبط فريق \`${team}\` في ${roomRef(destination.id)}. كرّر بنفس الرول لو عايز تضيف روم. تغيير الرول بيعيد ضبط النطاق.`];
    },
    async unteam(i, { team, channel }) {
      fixedChoice(TEAMS, team);
      const roomId = channel ? idOf(channel.id) : undefined;
      await changed(i, 'team_scope_removed', team, (a) => {
        const prior = a.teams[team];
        if (!prior) return;
        if (roomId) prior.rooms = prior.rooms.filter((key) => key !== roomId);
        else prior.rooms = []; // Keep the ticket role identity so changing it cannot strand open rooms.
      });
      return ['اتلغى نطاق التفويض للأوامر. صلاحيات ديسكورد اليدوية والرومات الموجودة ما اتغيّرتش.'];
    },
    async room(i, { purpose, channel }) {
      fixedChoice(Object.keys(ROOM_TYPES), purpose);
      const by = await c.owner(i);
      const w = await c.world();
      const destination = c.findRoom(w, idOf(channel?.id), ROOM_TYPES[purpose]);
      const base = resolveRooms(w.channels, c.config);
      const protectedCategory = ['ticket_category', 'voice_category'].includes(purpose);
      await c.edit((a) => {
        if (protectedCategory && (destination.id === base.category?.id ||
          (purpose === 'ticket_category' ? a.rooms.voice_category : a.rooms.ticket_category) === destination.id)) {
          throw new AppError('ADMIN_CATEGORY', 'اختار كاتيجوري منفصلة مش كاتيجوري BLACK X أو كاتيجوري ميزة تانية.');
        }
        if (protectedCategory && a.rooms[purpose] !== destination.id &&
          w.channels.some((ch) => ch.parent_id === destination.id)) {
          throw new AppError('ADMIN_CATEGORY', 'اختار كاتيجوري فاضية للميزة الجديدة عشان البوت ما يلمسش الرومات الثابتة.');
        }
        if (purpose === 'guest') c.protect(w, a, destination);
        if (purpose === 'forum') {
          const tags = destination.available_tags ?? [];
          if (!['بلا حرق', 'حرق'].every((name) => tags.some((tag) => tag.name === name && !tag.moderated))) {
            throw new AppError('ADMIN_FORUM_TAGS', 'جهّز الوسمين «بلا حرق» و«حرق» بدون تقييد للمشرفين في المنتدى قبل الربط.');
          }
        }
        if (purpose === 'ticket_category' && a.rooms[purpose] && a.rooms[purpose] !== destination.id &&
          Object.values(a.requests).some((r) => r.kind === 'ticket' && !r.closedAt)) {
          throw new AppError('ADMIN_ACTIVE_TICKETS', 'اقفل التذاكر المفتوحة قبل تغيير كاتيجوري الدعم.');
        }
        if (purpose === 'incident' && a.rooms[purpose] && a.rooms[purpose] !== destination.id &&
          Object.values(a.incidents).some((r) => r.status !== 'resolved')) {
          throw new AppError('ADMIN_ACTIVE_INCIDENT', 'اقفل كارت العطل المفتوح قبل تغيير روم الأعطال.');
        }
        a.rooms[purpose] = destination.id;
        a.version += 1;
        audit(a, 'ops', 'room_configured', by, purpose, c.now());
      });
      return [`اتربط ${roomRef(destination.id)} بـ\`${purpose}\`. إعدادات الروم نفسها ما اتغيّرتش.`];
    },
    async interest(i, { interest, role }) {
      fixedChoice(Object.keys(INTERESTS), interest);
      const by = await c.owner(i);
      const w = await c.world();
      const roleId = role ? idOf(role.id) : null;
      await c.edit((a) => {
        if (roleId) {
          c.ordinaryRole(w, a, roleId);
          if (Object.entries(a.interests).some(([key, id]) => key !== interest && id === roleId)) {
            throw new AppError('ADMIN_INTEREST_ROLE', 'اختار رول مختلف لكل اهتمام.');
          }
          a.interests[interest] = roleId;
        } else delete a.interests[interest];
        if (a.panels.guide) a.panels.guide.stale = true; // Keep the message ID for editing, but reject old buttons.
        a.version += 1;
        audit(a, 'ops', 'interest_configured', by, interest, c.now());
      });
      return ['اتحفظ اختيار الاهتمام. انشر لوحة «ابدأ هنا» من جديد عشان الأزرار الجديدة تشتغل.'];
    },
    async pause(i, { module, paused }) {
      fixedChoice(MODULES, module);
      await changed(i, paused ? 'module_paused' : 'module_resumed', module, (a) => {
        live(a);
        if (paused) a.paused[module] = true;
        else delete a.paused[module];
      });
      return [`\`${module}\` ${paused ? 'متوقفة مؤقتًا للعمليات الجديدة' : 'شغالة تاني'}.`];
    },
    async panel(i) {
      await c.owner(i);
      const a = adminOf(await c.read());
      return [`أدوات الإدارة: ${a.enabled ? 'مفعّلة' : 'متوقفة'}.`,
        `الميزات المتوقفة: ${Object.keys(a.paused).join('، ') || 'مفيش'}.`,
        ...Object.entries(a.rooms).map(([key, id]) => `• \`${key}\`: ${roomRef(id)}`),
        ...Object.entries(a.teams).map(([key, { rooms, roleId }]) => `• فريق \`${key}\` (رول \`${roleId}\`): ${rooms.map(roomRef).join('، ') || 'مفيش نطاق'}`),
        `الرومات الصوتية: ${c.config.adminVoice ? 'Gateway مفعّل' : 'اختيارية، لسه متوقفة'}. AutoMod: ${c.config.adminAutoMod ? 'Gateway مفعّل' : 'اختياري، لسه متوقف'}.`];
    },
  };
}
