import { createHash } from 'node:crypto';
import { ChannelType as C } from 'discord.js';
import { button, row } from '../community/ui.js';
import { resolveRooms } from '../discord/state.js';
import { AppError, describeError, DiscordApiError, errorFields, ownerRequired } from '../lib/errors.js';
import { adminOf, audit, card, fixedChoice, idOf, roomRef, stale, TEXT_ROOMS } from './core.js';
import { checkAclWrite, checkProfile, equal, observedChange, planChannels, PROFILES, roomError, SETUP_TYPES, setupRole, syncedChildren } from './channel-plan.js';
import { rulesRoom } from './rules.js';
import { approvedSetupChanges, checkHiddenChildren, describeSupportSetup, hiddenChannelShapes,
  materializeSupportSetup, planSupportSetup } from './support-setup.js';

const TTL = 5 * 60_000;
const openTickets = (a) => Object.values(a.requests).some((r) => r.kind === 'ticket' && !r.closedAt);
const server = (a) => a.server ??= { profiles: {} };
const ensureVersion = (a, version) => { if (a.version !== version) throw stale(); };
const noSupportSetup = (missing) => new AppError('SERVER_PREPARE_SUPPORT', `كمّل الاختيارات الناقصة في /server prepare: ${missing.join('، ')}.`);
const intentForbidden = (error) => error instanceof DiscordApiError && error.status === 403;
const labels = { rules: 'القوانين · قراءة فقط', read_only: 'قراءة فقط', open: 'مفتوح للأعضاء', restricted: 'رول محدد', staff: 'فريق محدد',
  staff_log: 'سجل فريق · قراءة فقط', owner_only: 'المالك', ticket_panel: 'لوحة دعم · قراءة وزر شكوى', ticket_category: 'كاتيجوري تذاكر خاصة', support_staff: 'صندوق وأوامر دعم خاصة' };
const specialSpecs = (support) => !support ? {} : {
  [support.panelId]: { profile: 'ticket_panel' }, [support.categoryId]: { profile: 'ticket_category', roleId: support.roleId },
  [support.staffId]: { profile: 'support_staff', roleId: support.roleId },
};
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');

function supportRoom(c, w, refs, key, id) {
  const category = key === 'category';
  try { return c.findRoom(w, id, category ? [C.GuildCategory] : TEXT_ROOMS); }
  catch (error) {
    if (!(error instanceof AppError) || error.code !== 'ADMIN_ROOM') throw error;
    const source = refs[key] ? 'الاختيار الحالي' : 'الربط المحفوظ';
    const kind = category ? 'كاتيجوري التذاكر نفسها، مش روم جوّاها' : key === 'staff' ? 'روم نصّي خاص بالفريق' : 'روم نصّي للوحة الأعضاء';
    throw new AppError('ADMIN_ROOM', `${key}: ${source} (${id}) مش ظاهر للبوت أو نوعه مش مناسب. اختار ${kind} وراجع View Channel.`);
  }
}

function supportPlan(c, { by, w, a, hidden }, refs) {
  const prior = a.teams.support;
  const panelId = refs.panel ?? a.rooms.ticket_panel ?? resolveRooms(w.channels, c.config).rooms.support?.id;
  const categoryId = refs.category ?? a.rooms.ticket_category;
  const privateCandidates = prior?.rooms.filter((id) => id !== panelId && w.channels.some((ch) => ch.id === id && TEXT_ROOMS.includes(ch.type))) ?? [];
  const staffId = refs.staff ?? a.rooms.site_staff ?? (privateCandidates.length === 1 ? privateCandidates[0] : undefined);
  const roleId = refs.role ?? prior?.roleId;
  const missing = Object.entries({ panel: panelId, category: categoryId, staff: staffId, role: roleId }).filter(([, id]) => !id).map(([key]) => key);
  if (missing.length) {
    if (Object.keys(refs).length) throw noSupportSetup(missing);
    return undefined;
  }
  const panel = supportRoom(c, w, refs, 'panel', panelId);
  const category = supportRoom(c, w, refs, 'category', categoryId);
  const staffRoom = supportRoom(c, w, refs, 'staff', staffId);
  checkHiddenChildren(hidden, categoryId);
  if (panelId === staffId || panel.parent_id === categoryId || staffRoom.parent_id === categoryId) {
    throw roomError(category, 'لوحة الأعضاء وروم الفريق لازم يكونوا منفصلين وخارج كاتيجوري التذاكر.');
  }
  if (openTickets(a) && (categoryId !== a.rooms.ticket_category || roleId !== prior?.roleId)) {
    throw new AppError('ADMIN_ACTIVE_TICKETS', 'اقفل التذاكر الحالية قبل تغيير الكاتيجوري أو رول فريق الدعم.', 409);
  }
  if (w.channels.some((ch) => ch.parent_id === categoryId && (categoryId !== a.rooms.ticket_category ||
      ch.type !== C.GuildText || !/^bx-ticket:[0-9]{17,20}$/.test(ch.topic ?? '')))) {
    throw roomError(category, 'اختار كاتيجوري فاضية أو الكاتيجوري المخصصة للتذاكر بالفعل؛ ما ينفعش تحتوي رومات ثابتة.');
  }
  try { setupRole(c, w, a, roleId); }
  catch (error) {
    if (!(error instanceof AppError) || error.code !== 'SERVER_PREPARE_ROLE') throw error;
    throw new AppError(error.code, `role: ${refs.role ? 'الاختيار الحالي' : 'الربط المحفوظ'} (${roleId}). ${error.message}`, error.status);
  }
  return { ownerId: by, panelId, categoryId, staffId, roleId };
}

async function assertStaffRolesNotSelectable(c, w, specs) {
  if (!w.guild.features?.includes('COMMUNITY')) return;
  const roles = new Set(Object.values(specs).filter(({ profile }) => ['staff', 'staff_log', 'support_staff'].includes(profile)).map(({ roleId }) => roleId));
  if (!roles.size) return;
  const onboarding = await c.api.getOnboarding(c.guildId);
  if (onboarding?.guild_id !== c.guildId || !Array.isArray(onboarding.prompts) || !onboarding.prompts.every((p) =>
    Array.isArray(p.options) && p.options.every((o) => Array.isArray(o.role_ids)))) {
    throw new AppError('SERVER_ONBOARDING', 'اتعذّر التحقق من رولات Onboarding. مش هنفعّل رول إداري قبل المراجعة.', 409);
  }
  if (onboarding.prompts.some((p) => p.options.some((o) => o.role_ids.some((role) => roles.has(role))))) {
    throw new AppError('SERVER_ONBOARDING_ROLE', 'فيه رول فريق متاح للاختيار في Onboarding. افصله من الاختيارات أو اختار رول إدارة مخصص.', 409);
  }
}

async function draft(c, ctx, refs, { supportOnly = false } = {}) {
  const { a, w } = ctx;
  const support = supportPlan(c, ctx, refs);
  const profiles = a.server?.profiles ?? {};
  const specs = supportOnly ? {} : { ...profiles };
  for (const [id, spec] of Object.entries(specialSpecs(support))) {
    const saved = profiles[id];
    if (saved && !(spec.profile === 'ticket_panel' && saved.profile === 'read_only') &&
      !(spec.profile === 'support_staff' && saved.profile === 'staff' && saved.roleId === spec.roleId)) {
      throw roomError(c.findRoom(w, id), 'له غرض تاني مسجّل. شيل الربط القديم بـ /server unbind قبل تجهيز الدعم.');
    }
    specs[id] = spec;
  }
  const changes = planChannels(c, w, a, specs);
  await assertStaffRolesNotSelectable(c, w, specs);
  return { version: a.version, changes, specs, support, rulesId: supportOnly ? undefined : rulesRoom(a), paused: Boolean(a.paused.tickets) };
}

function undoPlan(c, { by, w, a, hidden }) {
  const backup = a.server?.undo;
  if (!backup || backup.ownerId !== by || !backup.attempted.length) {
    throw new AppError('SERVER_UNDO_EMPTY', 'مفيش تعديل أذونات محفوظ للتراجع عنه.');
  }
  const changes = [];
  for (const id of [...backup.attempted].reverse()) {
    const entry = backup.changes.find(({ shape }) => shape[0] === id);
    if (entry.profile === 'ticket_category') checkHiddenChildren(hidden, id);
    if (observedChange(c, w.channels, entry, entry.before)) continue; // Already rolled back or never accepted.
    if (!observedChange(c, w.channels, entry, entry.after)) {
      throw roomError(c.findRoom(w, id), 'الأذونات أو مزامنة الرومات اتغيّرت بعد التجهيز. مش هنستبدل تعديل أحدث.', 'ADMIN_STALE');
    }
    checkAclWrite(c, w, c.findRoom(w, id), entry.after, entry.before);
    changes.push({ ...entry, before: entry.after, after: entry.before });
  }
  const supportIds = [a.rooms.ticket_panel, a.rooms.ticket_category, a.rooms.site_staff];
  return { version: a.version, backupId: backup.id, changes, pauseSupport: backup.attempted.some((id) => supportIds.includes(id)) };
}

function preview(ctx, plan, mode, canList, observed) {
  const specs = plan.specs ?? {};
  const included = new Set(Object.keys(specs));
  for (const ch of ctx.w.channels) if (included.has(ch.id) && ch.type === C.GuildCategory) {
    for (const id of syncedChildren(ctx.w.channels, ch)) included.add(id);
  }
  const skipped = ctx.w.channels.filter((ch) => SETUP_TYPES.includes(ch.type) && !included.has(ch.id) && !(ch.topic ?? '').startsWith('bx-ticket:'));
  const rows = plan.changes.map(({ shape: [id], profile, children }) => {
    const roleId = specs[id]?.roleId;
    const role = roleId === 'new:role' ? 'رول الدعم الجديد' : roleId && `<@&${roleId}>`;
    return `• ${roomRef(id)} — ${labels[profile]}${role ? ` · ${role}` : ''}${children.length ? ` · ومعاه ${children.length} متزامنين` : ''}`;
  });
  const m = plan.support;
  const details = mode === 'undo' ? [
    'ده بيرجّع أذونات آخر تطبيق فقط، مش إعدادات البوت أو رسائل القوانين واللوحة. بعض الرومات ممكن ترجع لجمهورها السابق.',
    ...(plan.pauseSupport ? ['فتح التذاكر الجديدة والتنبيهات هيتوقفوا قبل استرجاع أذونات الدعم. التذاكر الحالية هتفضل موجودة.'] : []),
  ] : [
    ...(m ? [...(observed ? describeSupportSetup(observed) : [`الدعم: اللوحة ${roomRef(m.panelId)} · الكاتيجوري ${roomRef(m.categoryId)} · أوامر الدعم في ${roomRef(m.staffId)} لرول <@&${m.roleId}>.`]),
      'روم الفريق ده هيبقى نطاق أوامر الدعم وربط موظفي الدعم بالموقع. المالك يستلم نص النموذج على الخاص؛ رول الدعم يستلم رابط التذكرة الخاصة، من غير نسخ النص.',
      ...(!ctx.a.enabled ? ['أدوات الإدارة هتتفعّل عشان اللوحة تشتغل.'] : []),
      ...(plan.paused ? ['⚠ فتح التذاكر متوقف بقرار المالك. التجهيز مش هيلغي الإيقاف.'] : []),
      ...(canList === false ? ['⚠ Discord رفض قراءة أعضاء الرول. فعّل Server Members Intent من Developer Portal لتنبيهات الفريق على الخاص؛ المالك وصندوق الفريق مش محتاجين قراءة القائمة.'] : []),
    ] : ['الدعم مش مكتمل. اختار panel/category/staff/role عشان تجهزه.']),
    ...(observed ? [
      'لو فيه مورد دعم باسم مختلف، اختاره صراحةً في /server prepare قبل الموافقة. راجع مين معاه رول الدعم؛ البوت مش هيوزّعه.',
      'اللوحة عامة للقراءة. أوامر فريق الدعم هتتحصر في روم الفريق الخاص. التجهيز مش بيغيّر الويب هوكات أو رولات الموقع أو القوانين.',
    ] : [
      ...(plan.rulesId ? [`القوانين هتتنشر أو تتحدّث في ${roomRef(plan.rulesId)}.`] : ['القوانين لسه من غير روم مرتبط: `/server bind profile:rules`.']),
      `الرومات خارج الخطة (${skipped.length}) تفضل زي ما هي${skipped.length ? `: ${skipped.slice(0, 5).map(({ id }) => roomRef(id)).join('، ')}` : '.'} استخدم /server bind للرومات الثابتة اللي عايز تجهّزها.`,
    ]),
    'هنعدّل الأذونات اللي تخص الغرض ده بس. مالك السيرفر واللي معاهم Administrator بيتجاوزوا الأذونات بطبيعة Discord.',
  ];
  const report = plan.changes.flatMap(({ shape: [id], children, profile, before, after }) =>
    [`#${id} · ${labels[profile]}`, `رومات متزامنة: ${children.map(([key]) => key).join(', ') || 'لا يوجد'}`,
      `قبل: ${JSON.stringify(before)}`, `بعد: ${JSON.stringify(after)}`, '']).join('\n');
  return { ...card(mode === 'undo' ? 'معاينة التراجع' : observed ? 'معاينة إعداد دعم BLACK X' : 'معاينة تجهيز BLACK X',
    [`${rows.length} تعديل أذونات. مفيش كتابة في المعاينة.${rows.length ? ' أذونات قبل/بعد في ملف الخطة.' : ''}`, ...details,
      ...rows.slice(0, 18), ...(rows.length > 18 ? ['باقي الرومات في الملف.'] : [])].join('\n')), ...(rows.length ? {
    files: [{ attachment: Buffer.from(report), name: 'black-x-permissions.txt' }],
  } : {}) };
}

export function serverActions(c, { ticket, rules }) {
  const offers = new Map();
  const serial = (run) => c.serial('server-layout', run);
  async function snapshot(i) {
    const by = await c.owner(i);
    const [w, state] = await Promise.all([c.world(), c.read()]);
    if (w.guild.owner_id !== by) throw ownerRequired();
    return { by, w, a: adminOf(state), hidden: hiddenChannelShapes(i, w.channels) };
  }

  async function reviewed(ctx, mode, refs) {
    if (mode === 'undo') return { plan: undoPlan(c, ctx) };
    if (mode !== 'setup') return { plan: await draft(c, ctx, refs) };
    const { observed, refs: selected, virtual } = planSupportSetup(c, ctx);
    return { observed, plan: await draft(c, virtual, selected, { supportOnly: true }) };
  }

  async function createOffer(i, mode, fields = {}, { dryRun = false } = {}) {
    const ctx = await snapshot(i);
    const refs = Object.fromEntries(['panel', 'category', 'staff', 'role'].filter((key) => fields[key]).map((key) => [key, idOf(fields[key].id)]));
    const review = await reviewed(ctx, mode, refs);
    const { plan, observed } = review;
    let canList;
    if (plan.support) {
      try { await c.api.listGuildMembers(c.guildId, { limit: 1 }); }
      catch (error) { if (intentForbidden(error)) canList = false; else throw error; }
    }
    const result = preview(ctx, plan, mode, canList, observed);
    if (dryRun || (mode !== 'undo' && !plan.changes.length && !plan.support && !plan.rulesId)) return result;
    for (const [id, value] of offers) if (value.expires <= c.now() || offers.size >= 8) offers.delete(id);
    const id = idOf(i.id);
    offers.set(id, { mode, refs, by: ctx.by, channelId: i.channelId, expires: c.now() + TTL, hash: digest(review) });
    return { ...result, components: [row(button(`bx:x:server:${id}`, mode === 'undo' ? 'تأكيد التراجع' : mode === 'setup' ? 'نفّذ إعداد الدعم' : 'تطبيق التجهيز', mode === 'undo' ? 4 : 1))] };
  }

  async function writeChanges(i, plan, beforeWrite) {
    const applied = [];
    for (const change of plan.changes) {
      const [id, type] = change.shape;
      const observe = async () => {
        if (type !== C.GuildCategory) return [await c.api.getChannel(id)];
        const channels = await c.api.getChannels(c.guildId);
        // A newly synced hidden child must not be changed indirectly by a category PATCH.
        if (change.profile === 'ticket_category') checkHiddenChildren(hiddenChannelShapes(i, channels), id);
        return channels;
      };
      try {
        if (!observedChange(c, await observe(), change, change.before)) throw stale();
        await beforeWrite(id);
        await c.api.updateChannel(id, { permission_overwrites: change.after }, { guarded: true, reason: 'BLACK X approved server layout' });
        if (!observedChange(c, await observe(), change, change.after)) throw stale();
        applied.push(id);
      } catch (error) {
        return { applied, failed: id, reason: describeError(error) };
      }
    }
    return { applied };
  }

  return {
    async bind(i, { channel, profile, role }) {
      return serial(async () => {
        const { a, by, w } = await snapshot(i);
        fixedChoice(PROFILES, profile);
        const ch = c.findRoom(w, idOf(channel?.id), SETUP_TYPES);
        const spec = { profile, ...(role ? { roleId: idOf(role.id) } : {}) };
        checkProfile(c, w, a, ch, spec);
        await c.edit((current) => {
          ensureVersion(current, a.version);
          const oldRules = rulesRoom(current);
          if (profile === 'rules' && oldRules && oldRules !== ch.id) throw roomError(ch, 'افصل روم القوانين القديم بـ /server unbind الأول.');
          const { profiles } = server(current);
          if (!profiles[ch.id] && Object.keys(profiles).length >= 100) throw roomError(ch, 'القائمة فيها ١٠٠ ربط بالفعل.');
          profiles[ch.id] = spec;
          current.version += 1;
          audit(current, 'ops', 'server_profile_bound', by, ch.id, c.now());
        });
        return [`اتحدد غرض ${roomRef(ch.id)}: ${labels[profile]}. مفيش إذن اتغيّر لسه؛ شغّل /server prepare.`];
      });
    },
    async unbind(i, { channel, channel_id }) {
      return serial(async () => {
        const by = await c.owner(i);
        if (Boolean(channel) === Boolean(channel_id)) throw new AppError('SERVER_UNBIND_TARGET', 'اختار روم واحد أو اكتب معرّف روم اتحذف.');
        const id = idOf(channel?.id ?? channel_id);
        await c.edit((a) => {
          if (a.server?.profiles[id]) {
            delete a.server.profiles[id];
            a.version += 1;
            audit(a, 'ops', 'server_profile_unbound', by, id, c.now());
          }
        });
        return [`اتشال ربط ${roomRef(id)}. الأذونات والرسائل الموجودة ما اتغيّروش.`];
      });
    },
    prepare(i, fields) { return serial(() => createOffer(i, 'prepare', fields)); },
    setup(i, options) { return serial(() => createOffer(i, 'setup', {}, options)); },
    undo(i) { return serial(() => createOffer(i, 'undo')); },
    async confirm(i, id) {
      return serial(async () => {
        let ctx = await snapshot(i);
        const offer = offers.get(id);
        if (!offer || offer.expires <= c.now() || offer.by !== ctx.by || offer.channelId !== i.channelId) throw stale();
        offers.delete(id);
        const undo = offer.mode === 'undo';
        const setup = offer.mode === 'setup';
        const review = await reviewed(ctx, offer.mode, offer.refs);
        if (digest(review) !== offer.hash) throw stale();
        let { plan } = review;
        const created = [];
        if (setup) {
          try {
            const initial = plan;
            const materialized = await materializeSupportSetup(c, () => snapshot(i), review, initial.version, id, created);
            ctx = materialized.ctx;
            plan = await draft(c, ctx, materialized.refs, { supportOnly: true });
            if (!equal(plan.changes, approvedSetupChanges(initial.changes, plan.support.roleId))) throw stale();
          } catch (error) {
            c.log.warn('support_setup_interrupted', { created: created.length, ...errorFields(error) });
            return [`إعداد الدعم وقف: ${describeError(error)}`,
              ...(created.length ? [`الموارد اللي اتأكد إنشاؤها: ${created.join('، ')}.`] : []),
              'ما اتطبّقش ربط جديد ولا اتنشرت لوحة. راجع الحالة وشغّل /setup للمعاينة من جديد.'];
          }
        }
        let version = plan.version;
        version = await c.edit((a) => {
          ensureVersion(a, plan.version);
          if (!undo && plan.changes.length) server(a).undo = { id, ownerId: ctx.by, attempted: [], changes: plan.changes };
          if (undo && plan.pauseSupport) {
            a.paused.tickets = true;
            delete a.complaints;
            a.version += 1;
          }
          return a.version;
        });
        const newlyCreated = created.length ? `الموارد اللي اتأكد إنشاؤها: ${created.join('، ')}.` : undefined;
        const result = await writeChanges(i, plan, (key) => c.edit((a) => {
          ensureVersion(a, version);
          if (!undo) a.server.undo.attempted.push(key); // Journal before the REST write, including ambiguous responses.
        }));
        if (result.failed) return [`اتأكد ${result.applied.length} تعديل بس. التنفيذ وقف عند ${roomRef(result.failed)}: ${result.reason}`,
          ...(newlyCreated ? [newlyCreated] : []),
          `راجع الحالة من جديد بـ ${setup ? '/setup أو ' : ''}/server prepare أو /server undo. مفيش نشر لوحات في الخطوة اللي وقفت.`];
        if (undo) {
          await c.edit((a) => {
            ensureVersion(a, version);
            if (a.server.undo.id !== plan.backupId) throw stale();
            delete a.server.undo;
            audit(a, 'ops', 'server_acl_restored', ctx.by, plan.backupId, c.now());
          });
          return [`التراجع خلص: ${result.applied.length} أذونات رجعت. اللوحات والربط مش اتحذفوا.`,
            ...(plan.pauseSupport ? ['فتح التذاكر متوقف؛ راجع الأذونات قبل ما ترجع تفعّله.'] : [])];
        }
        try {
          const verified = await c.world();
          if (verified.guild.owner_id !== ctx.by || planChannels(c, verified, ctx.a, plan.specs).length) throw stale();
          if (plan.support) {
            const { roleId, categoryId, panelId, staffId } = plan.support;
            const refs = { role: roleId, category: categoryId, panel: panelId, staff: staffId };
            const live = { ...ctx, w: verified, hidden: hiddenChannelShapes(i, verified.channels) };
            if (setup) {
              const found = planSupportSetup(c, live).refs;
              if (Object.entries(refs).some(([key, id]) => found[key] !== id)) throw stale();
            }
            supportPlan(c, live, refs);
          }
          await assertStaffRolesNotSelectable(c, verified, plan.specs);
        } catch (error) {
          return [`تم تطبيق ${result.applied.length} تعديل، لكن تعذّر تأكيد الخطة النهائية. ${describeError(error)}`,
            ...(newlyCreated ? [newlyCreated] : []),
            'ما اتغيّرش تفويض الدعم وما اتنشرتش اللوحات. اعمل معاينة جديدة أو تراجع.'];
        }
        version = await c.edit((a) => {
          ensureVersion(a, version);
          const support = plan.support;
          if (support) {
            if (a.server?.supportSetup) delete a.server.supportSetup;
            if (openTickets(a) && (a.rooms.ticket_category !== support.categoryId || a.teams.support?.roleId !== support.roleId)) throw stale();
            const nextTeam = { roleId: support.roleId, rooms: [support.staffId] };
            const nextRooms = { ticket_panel: support.panelId, ticket_category: support.categoryId, site_staff: support.staffId };
            if (!a.enabled || a.teams.support?.roleId !== nextTeam.roleId || !equal(a.teams.support?.rooms, nextTeam.rooms) ||
              Object.entries(support).some(([key, value]) => a.complaints?.[key] !== value) ||
              Object.entries(nextRooms).some(([purpose, id]) => a.rooms[purpose] !== id)) {
              a.enabled = true;
              Object.assign(a.rooms, nextRooms);
              a.teams.support = nextTeam;
              a.complaints = support;
              a.version += 1;
            }
          }
          audit(a, 'ops', setup ? 'support_setup_applied' : 'server_prepared', ctx.by, id, c.now());
          return a.version;
        });
        const lines = [...(setup ? [`الدعم اتجهّز: اللوحة ${roomRef(plan.support.panelId)}، التذاكر ${roomRef(plan.support.categoryId)}، الفريق ${roomRef(plan.support.staffId)} · <@&${plan.support.roleId}>.`,
          created.length ? `اتعمل ${created.length} مورد ناقص. وزّع رول الدعم يدويًا على المخوّلين بس.` : 'استخدمت الموارد الموجودة؛ ما اتعملش أي روم أو رول جديد.'] : []),
          `اتأكد تعديل الأذونات في ${result.applied.length} روم أو كاتيجوري.`];
        for (const [label, publish] of [
          ...(plan.rulesId ? [['القوانين', () => rules.publish(i, { version })]] : []),
          ...(plan.support && !plan.paused ? [['لوحة الدعم', () => ticket.publishForOwner(i, plan.support.panelId, version)]] : []),
        ]) {
          try { lines.push(...await publish()); }
          catch (error) { lines.push(`⚠ ${label}: النشر مش مؤكد. ${describeError(error)} راجع الروم قبل إعادة المحاولة.`); }
        }
        if (plan.support && plan.paused) lines.push('فتح التذاكر لسه متوقف. بعد المراجعة استخدم /admin pause module:tickets paused:false، ثم /ticket panel في روم اللوحة.');
        return lines;
      });
    },
  };
}
