import { PermissionFlagsBits as P } from 'discord.js';
import { button, row, timestamp } from '../community/ui.js';
import { compareRoles, hasPermission, highestRole } from '../discord/permissions.js';
import { AppError, errorFields, rejectedWrite } from '../lib/errors.js';
import { adminOf, audit, card, denied, idOf, isMissing, live, memberRef, onboardingRoleName, requestAt,
  safeTitle, stale, TEXT_ROOMS } from './core.js';

const MINUTE = 60_000;
const KICK_PREVIEW_TTL = 3 * MINUTE;
const MAX_CASES = 250;
const required = { kick: P.KickMembers, timeout: P.ModerateMembers, untimeout: P.ModerateMembers };
const labels = { kick: 'طرد', timeout: 'كتم مؤقت', untimeout: 'فك الكتم' };
const results = { pending: 'مستني التأكيد', applied: 'اتنفّذ', rejected: 'ما اتنفّذش', uncertain: 'نتيجة غير مؤكدة', reviewed: 'اتراجع يدويًا' };
const casesOf = (a) => a.moderation?.cases ?? {};
const moderation = (a) => a.moderation ??= { cases: {} };
const blocked = ({ status }) => status === 'pending' || status === 'uncertain';
const scopeKey = (subject) => `member-action:${subject}`;
const protectedMember = () => new AppError('MOD_PROTECTED_MEMBER', 'مش مسموح بالإجراء ده على نفسك أو على المالك أو البوتات أو حد معاه Administrator.', 403);
const uncertain = (id) => new AppError('MOD_ACTION_UNCONFIRMED', `نتيجة الإجراء ${id} مش مؤكدة. راجع حالة العضو وسجل تدقيق Discord قبل أي محاولة تانية.`, 409);

export const moderationEnabled = (c, w, a) => Boolean(a.enabled && a.moderation?.enabledBy &&
  a.moderation.enabledBy === c.config.ownerId && a.moderation.enabledBy === w.guild.owner_id);

export function moderationRole(c, w, a) {
  const id = a.teams.moderation?.roleId;
  const role = w.allRoles.find((r) => r.id === id && r.id !== c.guildId && !r.managed && !onboardingRoleName(r.name));
  return role && id !== a.teams.support?.roleId && !Object.values(a.interests).includes(id) && !c.productRole(w, id) ? role : undefined;
}

export const unresolvedModeration = (a) => Object.values(casesOf(a)).filter(blocked);

export function ownModerationLines(a, by) {
  return Object.values(casesOf(a)).filter((record) => record.subject === by && record.status === 'applied')
    .sort((l, r) => r.at - l.at).slice(0, 5)
    .map(({ id, action, at }) => `• إجراء إشراف \`${id}\` · ${labels[action]} · ${timestamp(at)}`);
}

function durationMs(value) {
  const match = /^(\d{1,5})([mhd])$/i.exec(typeof value === 'string' ? value.trim() : '');
  const minutes = match && Number(match[1]) * { m: 1, h: 60, d: 1440 }[match[2].toLowerCase()];
  if (!minutes || minutes > 28 * 1440) throw new AppError('MOD_DURATION', 'اختار مدة بين دقيقة و٢٨ يوم، مثل 10m أو 2h أو 1d.');
  return minutes * MINUTE;
}

function checkCase(cases, id, subject) {
  const old = cases[id];
  if (old) {
    if (blocked(old)) throw uncertain(id);
    throw new AppError('MOD_DUPLICATE', `الإجراء ${id} متسجّل بالفعل. راجع /mod cases.`, 409);
  }
  const pending = Object.values(cases).find((record) => record.subject === subject && blocked(record));
  if (pending) throw uncertain(pending.id);
}

export function memberModerationActions(c) {
  const offers = new Map();
  async function scope(i, action) {
    const s = await c.session(i, { team: 'moderation', types: TEXT_ROOMS, gated: Boolean(action) });
    if (!s.channel || s.member.pending === true) throw denied();
    if (action && !moderationEnabled(c, s.w, s.a)) {
      throw new AppError('MOD_DISABLED', 'الطرد والكتم متوقفين. المالك يقدر يفعّلهم بـ /admin moderation enabled:true.', 403);
    }
    if (!s.owner) {
      live(s.a);
      if (!moderationRole(c, s.w, s.a)) throw new AppError('MOD_TEAM', 'اضبط رول إشراف مستقل عن الدعم والاهتمامات.', 403);
      const bits = c.bits(s.w, undefined, s.by, s.member);
      if (action) {
        if (!hasPermission(bits, required[action])) {
          throw new AppError('MOD_ACTOR_PERMISSION', `محتاج ${action === 'kick' ? 'Kick Members' : 'Moderate Members'} على مستوى السيرفر.`, 403);
        }
      } else if (![P.ManageMessages, P.KickMembers, P.ModerateMembers].some((bit) => hasPermission(bits, bit))) throw denied();
    }
    if (action) c.botNeeds(s.w, undefined, required[action]);
    return s;
  }

  async function observe(i, action, subject) {
    const s = await scope(i, action);
    const { w } = s;
    if (subject === s.by || subject === c.botId || subject === w.guild.owner_id) throw protectedMember();
    const target = await c.api.getMember(c.guildId, subject).catch((error) => {
      if (isMissing(error) && error.discordCode === 10007) throw new AppError('MOD_MEMBER_MISSING', 'العضو مش موجود في السيرفر.', 404);
      throw error;
    });
    const known = new Set(w.allRoles.map(({ id }) => id));
    const joined = Date.parse(target?.joined_at);
    const currentUntil = target?.communication_disabled_until == null ? null : Date.parse(target.communication_disabled_until);
    if (target?.user?.id !== subject || !Number.isFinite(joined) || (currentUntil !== null && !Number.isFinite(currentUntil)) ||
      ![target.roles, w.botMember.roles, s.member.roles].every((roles) => Array.isArray(roles) && roles.every((id) => known.has(id)))) throw stale();
    if (target.user.bot || hasPermission(c.bits(w, undefined, subject, target), P.Administrator)) throw protectedMember();
    const rank = highestRole(w.allRoles, c.guildId, target.roles);
    const actorRank = highestRole(w.allRoles, c.guildId, s.member.roles);
    if (!rank || !w.botRole || compareRoles(w.botRole, rank, c.guildId) <= 0 ||
      (!s.owner && (!actorRank || compareRoles(actorRank, rank, c.guildId) <= 0))) {
      throw new AppError('MOD_HIERARCHY', 'رتبة العضو لازم تكون أقل من رتبة البوت وأقل من رتبة المشرف. ما ترفعش البوت فوق رولات الإدارة عشان تتخطى الحماية.', 403);
    }
    return { s, joined, currentUntil };
  }

  async function finish(id, status) {
    try {
      await c.edit((a) => {
        const record = requestAt(casesOf(a), id);
        if (record.status !== 'pending') throw stale();
        Object.assign(record, { status, finishedAt: c.now() });
        audit(a, 'moderation', `member_${record.action}`, record.by, id, c.now(), status);
      });
      return true;
    } catch (error) {
      // Leave the durable receipt pending if storage is unavailable; don't report a retry as safe.
      c.log.warn('moderation_receipt_failed', errorFields(error));
      return false;
    }
  }

  async function execute(i, { id, action, subject, reason, duration, offer }) {
    return c.serial(scopeKey(subject), async () => {
      const { s, joined, currentUntil } = await observe(i, action, subject);
      const checkOffer = () => {
        if (offer && (offer.version !== s.a.version || offer.joined !== joined || offer.expires <= c.now())) throw stale();
      };
      checkOffer();
      checkCase(casesOf(s.a), id, subject);
      const at = c.now();
      if (action === 'timeout' && currentUntil > at) {
        throw new AppError('MOD_TIMEOUT_EXISTS', `العضو موقوف بالفعل لحد ${timestamp(currentUntil)}. مش هنستبدل الكتم الحالي.`, 409);
      }
      if (action === 'untimeout' && !(currentUntil > at)) return ['العضو مش مكتوم حاليًا. مفيش تغيير.'];
      const until = action === 'timeout' ? at + duration : null;
      await c.edit((a) => {
        const cases = moderation(a).cases;
        checkCase(cases, id, subject);
        if (Object.keys(cases).length >= MAX_CASES) {
          const oldest = Object.values(cases).filter((r) => !blocked(r)).sort((l, r) => l.at - r.at)[0];
          if (!oldest) throw new AppError('MOD_CASE_LIMIT', 'راجع الإجراءات اللي نتيجتها مش مؤكدة قبل تسجيل إجراء جديد.', 409);
          delete cases[oldest.id];
        }
        cases[id] = { id, action, subject, by: s.by, reason, at, until, status: 'pending' };
        audit(a, 'moderation', 'member_action_requested', s.by, id, at, 'pending');
      }, s);

      let submitted = false;
      try {
        // Discord does not provide a conditional member write. Re-observe after reserving the receipt,
        // and never let the HTTP layer delay/replay the authorized write behind a rate limit.
        const fresh = await observe(i, action, subject);
        if (fresh.s.a.version !== s.a.version || fresh.joined !== joined || (action !== 'kick' && fresh.currentUntil !== currentUntil)) throw stale();
        const current = adminOf(await c.read());
        if (!current.enabled || current.version !== fresh.s.a.version || casesOf(current)[id]?.status !== 'pending') throw stale();
        checkOffer();
        if ((action === 'timeout' && until <= c.now()) || (action === 'untimeout' && currentUntil <= c.now())) throw stale();
        const auditReason = `BLACK X case ${id} by ${s.by}`;
        submitted = true;
        if (action === 'kick') await c.api.kickMember(c.guildId, subject, auditReason);
        else await c.api.setMemberTimeout(c.guildId, subject, until === null ? null : new Date(until).toISOString(), auditReason);
      } catch (error) {
        const status = submitted && !rejectedWrite(error) ? 'uncertain' : 'rejected';
        if (!await finish(id, status) || status === 'uncertain') throw uncertain(id);
        throw error;
      }
      if (!await finish(id, 'applied')) {
        throw new AppError('MOD_RECEIPT_UNCONFIRMED', `Discord أكد الإجراء ${id} لكن تحديث السجل مش مؤكد. راجع السجل قبل أي إجراء تاني.`, 503);
      }
      const target = memberRef(subject);
      return [action === 'kick' ? `اتطرد ${target} من السيرفر.` : action === 'timeout'
        ? `اتعمل كتم مؤقت لـ${target} لحد ${timestamp(until)}.` : `اتشال الكتم عن ${target}.`, `رقم الإجراء: \`${id}\`.`];
    });
  }

  function changeTimeout(i, action, { user, reason, duration }) {
    return execute(i, { id: idOf(i.id), action, subject: idOf(user?.id), reason: c.text(reason, 250),
      duration: action === 'timeout' ? durationMs(duration) : undefined });
  }

  return {
    async enable(i, { enabled }) {
      if (typeof enabled !== 'boolean') throw new AppError('ADMIN_CHOICE', 'اختار true أو false.');
      const by = await c.owner(i);
      await c.edit((a) => {
        if (enabled) {
          live(a);
          moderation(a).enabledBy = by;
        } else if (a.moderation) delete a.moderation.enabledBy;
        a.version += 1;
        audit(a, 'ops', enabled ? 'member_actions_enabled' : 'member_actions_disabled', by, 'moderation', c.now());
      });
      return [enabled ? 'أوامر الطرد والكتم اتفعّلت. استخدم /admin health لمراجعة الصلاحيات. مفيش رولات اتغيّرت.'
        : 'أوامر الطرد والكتم اتوقفت. أي كتم موجود لسه بينتهي في ميعاده على Discord.'];
    },
    async kick(i, { user, reason }) {
      const id = idOf(i.id);
      const subject = idOf(user?.id);
      const note = c.text(reason, 250);
      const { s, joined } = await observe(i, 'kick', subject);
      checkCase(casesOf(s.a), id, subject);
      const now = c.now();
      for (const [key, offer] of offers) if (offer.expires <= now || offer.by === s.by) offers.delete(key);
      if (offers.size >= 64) throw new AppError('ADMIN_BUSY', 'فيه معاينات كتير شغّالة. جرّب بعد لحظة.', 429);
      offers.set(id, { subject, reason: note, joined, by: s.by, channelId: i.channelId, version: s.a.version, expires: now + KICK_PREVIEW_TTL });
      return { ...card('معاينة طرد عضو', `العضو: ${memberRef(subject)}\nالسبب: ${safeTitle(note)}\n\nده طرد مش حظر، ومش هيحذف رسائله. الزر لنفس المشرف وفي نفس الروم خلال ٣ دقايق.`),
        components: [row(button(`bx:x:kick:${id}`, 'أكّد طرد العضو', 4))] };
    },
    confirmKick(i, id) {
      const by = c.assertGuild(i);
      const offer = offers.get(id);
      if (!offer || offer.by !== by || offer.channelId !== i.channelId || offer.expires <= c.now()) throw stale();
      offers.delete(id);
      return execute(i, { id, action: 'kick', subject: offer.subject, reason: offer.reason, offer });
    },
    timeout(i, options) { return changeTimeout(i, 'timeout', options); },
    untimeout(i, options) { return changeTimeout(i, 'untimeout', options); },
    async cases(i, { user }) {
      const s = await scope(i);
      const subject = user ? idOf(user.id) : undefined;
      const entries = Object.values(casesOf(s.a)).filter((r) => !subject || r.subject === subject).sort((l, r) => r.at - l.at).slice(0, 10);
      return ['📋 سجل إجراءات البوت', ...entries.map((r) => `• \`${r.id}\` · ${labels[r.action]} · ${results[r.status]} · ${timestamp(r.at)}\n` +
        `  العضو ${memberRef(r.subject)} · المشرف ${memberRef(r.by)} · ${safeTitle(r.reason)}${r.until ? ` · انتهاء الكتم المطلوب: ${timestamp(r.until)}` : ''}`),
        ...(!entries.length ? ['مفيش إجراءات مسجلة.'] : [])];
    },
    async review(i, { id, confirm }) {
      await c.owner(i);
      if (confirm !== true) throw new AppError('MOD_REVIEW_CONFIRM', 'راجع حالة العضو وسجل تدقيق Discord، وبعدها أعد الأمر مع confirm:true.');
      const record = requestAt(casesOf(adminOf(await c.read())), id);
      return c.serial(scopeKey(record.subject), async () => {
        const by = await c.owner(i);
        await c.edit((a) => {
          const current = requestAt(casesOf(a), id);
          if (!blocked(current) || (current.status === 'pending' && current.at + 5 * MINUTE > c.now())) throw stale();
          Object.assign(current, { status: 'reviewed', reviewedAt: c.now(), reviewedBy: by });
          audit(a, 'moderation', 'member_action_reviewed', by, id, c.now(), 'reviewed');
        });
        return ['اتسجلت المراجعة اليدوية واتشال منع الإجراءات الجديدة على العضو. مفيش إعادة تنفيذ ولا تغيير في Discord.'];
      });
    },
  };
}
