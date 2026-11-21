import { ChannelType as C, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js';
import { adminUnavailable } from '../admin/index.js';
import { adminOf, INTERESTS, MODULES, ROOM_TYPES, TEAMS, TEXT_ROOMS } from '../admin/core.js';
import { PROFILES, SETUP_TYPES } from '../admin/channel-plan.js';
import { SOCIAL_PLATFORMS } from '../admin/welcome.js';
import { AppError } from '../lib/errors.js';

const option = (type, name, description, more, required = true) => ({ type, name, description, more, required });
const text = (name, description, max, required = true) => option('String', name, description, (o) => o.setMaxLength(max), required);
const choice = (name, description, values) => option('String', name, description, (o) => o.addChoices(...values.map((value) => ({ name: value, value }))));
const integer = (name, description, min, max) => option('Integer', name, description, (o) => o.setMinValue(min).setMaxValue(max));
const bool = (name, description, required = false) => option('Boolean', name, description, undefined, required);
const channel = (name = 'channel', description = 'الروم المقصود', types = TEXT_ROOMS, required = true) => option('Channel', name, description, (o) => o.addChannelTypes(...types), required);
const user = (description = 'العضو المقصود') => option('User', 'user', description);
const role = (required = true) => option('Role', 'role', 'اختار رول موجود', undefined, required);
const team = () => choice('team', 'الفريق المصرّح له', TEAMS);
const id = () => text('id', 'رقم السجل اللي رجّعه البوت', 20);
const reason = () => text('reason', 'السبب أو نتيجة المراجعة', 250);
const outcome = () => choice('outcome', 'نتيجة المراجعة', ['approved', 'rejected']);
const title = () => text('title', 'عنوان مختصر', 100);
const when = (name) => text(name, 'التاريخ بفرق توقيت، مثل 2027-02-01T21:30+02:00', 28);
const anime = () => option('String', 'anime', 'اختار عملاً من الكتالوج', (o) => o.setMaxLength(48).setAutocomplete(true));
const r = (name, description, ...options) => ({ name, method: name, description, options });
const method = (row, method) => ({ ...row, method });
const optBuilder = (builder, options) => {
  for (const { type, name, description, required, more } of options) {
    builder[`add${type}Option`]((o) => {
      o.setName(name).setDescription(description).setRequired(required);
      more?.(o);
      return o;
    });
  }
  return builder;
};

function command(name, description, service, routes, { single = false, owner = false, autocomplete = false } = {}) {
  const data = new SlashCommandBuilder().setName(name).setDescription(description);
  if (owner) data.setDefaultMemberPermissions(P.ManageGuild);
  if (single) optBuilder(data, routes[0].options);
  else for (const route of routes) data.addSubcommand((s) => optBuilder(s.setName(route.name).setDescription(route.description), route.options));
  const byName = new Map(routes.map((route) => [route.name, route]));
  return {
    data,
    run(i, { admin }) {
      if (!admin) throw adminUnavailable();
      const route = single ? routes[0] : byName.get(i.options.getSubcommand());
      if (!route) throw new AppError('UNKNOWN_ADMIN_ACTION', 'اختار إجراءً من قائمة الأمر.');
      const options = Object.fromEntries(route.options.map(({ type, name, required }) => [name, i.options[`get${type}`](name, required)]));
      return admin[service][route.method](i, options);
    },
    ...(autocomplete ? { async autocomplete(i, { admin, community }) {
      if (!admin?.core.store || !community?.anime || i.user?.bot) return [];
      const a = adminOf(await admin.core.read());
      if (!a.enabled || a.paused.content) return [];
      return community.anime.autocomplete(i.user.id, i.options.getFocused(), false);
    } } : {}),
  };
}

export const adminCommands = [
  command('admin', 'تفعيل وتنظيم أدوات إدارة BLACK X (للمالك)', 'config', [
    r('enable', 'فعّل أو أوقف أدوات الإدارة الجديدة', bool('enabled', 'حالة أدوات الإدارة', true)),
    r('team', 'فوّض فريقًا في روم محدد', team(), role(), channel()),
    r('unteam', 'شيل رومًا من التفويض أو صفّر نطاق الفريق', team(), channel('channel', 'لو سبتها فاضية يتشال كل نطاق الفريق', TEXT_ROOMS, false)),
    r('room', 'اربط ميزة بروم أو كاتيجوري موجودة', choice('purpose', 'وظيفة الروم', Object.keys(ROOM_TYPES)),
      channel('channel', 'الروم أو الكاتيجوري', [...TEXT_ROOMS, C.GuildCategory, C.GuildForum, C.GuildVoice])),
    r('interest', 'اضبط رول اهتمام عادي في لوحة ابدأ هنا', choice('interest', 'نوع الاهتمام', Object.keys(INTERESTS)), role(false)),
    r('pause', 'أوقف ميزة واحدة أو رجّعها من غير ريستارت', choice('module', 'اسم الميزة', MODULES), bool('paused', 'توقف مؤقت', true)),
    r('bridge', 'تفعيل أو إيقاف ربط الموقع من غير تغيير التذاكر', bool('enabled', 'حالة ربط الموقع', true)),
    method(r('settings', 'اعرض التفعيل والتفويض والرومات المربوطة'), 'panel'),
  ], { owner: true }),
  command('ticket', 'تذاكر BLACK X الخاصة', 'ticket', [
    r('panel', 'انشر لوحة فتح التذاكر في روم الدعم المضبوط'),
    r('open', 'افتح تذكرة خاصة من روم الدعم', choice('type', 'نوع الطلب', ['site', 'report'])),
    r('claim', 'استلم تذكرة لفريق الدعم', id()),
    r('reply', 'ابعت ردًا في روم التذكرة واحسب أول رد', id(), text('body', 'الرد الخاص بصاحب التذكرة', 1000),
      bool('share', 'شارك الرد أيضًا في الموقع لصاحب التذكرة والدعم')),
    r('share', 'صاحب التذكرة: ابعت رسالة مشتركة من داخل روم تذكرتك', id(), text('body', 'الرسالة المشتركة مع الموقع', 1000)),
    r('close', 'اقفل التذكرة للكتابة من غير حذف', id(), reason()),
    r('alerts', 'للمالك: حالة توصيل تنبيهات الشكوى', id()),
  ]),
  command('staff', 'متابعة الطلبات والمهام والسجل داخل الفريق', 'staff', [
    r('inbox', 'اعرض الطلبات المفتوحة', team()), r('detail', 'اعرض تفاصيل طلب حسب صلاحيات الفريق', team(), id()),
    r('audit', 'اعرض آخر الإجراءات بدون نصوص المحادثات', team()),
    r('task', 'سجّل مهمة بموعد ومسؤول', team(), user('المسؤول من نفس الفريق'), title(), when('due')),
    r('done', 'علّم مهمة كمكتملة', team(), id()), r('handoff', 'ملخص تسليم الوردية', team()),
    r('stats', 'تقرير الدعم لآخر ٧ أيام'), r('practice', 'محاكاة تدريبية بدون أثر على السيرفر', team(), choice('scenario', 'حالة وهمية للتدريب', ['ticket', 'warning', 'slow'])),
  ]),
  command('mod', 'توثيق التنبيهات والاستئناف بدون عقوبات تلقائية', 'mod', [
    r('warn', 'سجّل تنبيهًا إداريًا من غير DM', user(), reason()), r('history', 'اعرض سجل تنبيهات العضو', user()),
    r('appeal', 'قدّم استئنافًا لتنبيه يخصك', id(), reason()), r('review', 'راجع استئنافًا أنشأ تنبيهه مشرف آخر', id(), outcome(), reason()),
  ]),
  command('kb', 'الردود المعتمدة لفريق الدعم', 'kb', [
    r('set', 'احفظ ردًا جاهزًا للمراجعة قبل النشر', text('key', 'مفتاح الرد بحروف إنجليزية', 24), title(), text('body', 'الرد', 900)),
    r('draft', 'اعرض مسودة رد قبل اعتمادها', text('key', 'مفتاح الرد', 24)),
    r('approve', 'اعتمد ردًا بعد مراجعته', text('key', 'مفتاح الرد', 24)),
    r('search', 'ابحث في الردود المعتمدة الخاصة', text('query', 'كلمة من العنوان أو المفتاح', 100)),
    r('remove', 'شيل ردًا قديمًا من المكتبة', text('key', 'مفتاح الرد', 24)),
  ]),
  command('incident', 'كارت واحد لحالة عطل يتحدّث في مكانه', 'incident', [
    r('open', 'افتح كارت عطل في الروم المخصص', title(), text('details', 'وصف العطل للنشر', 1000)),
    r('update', 'حدّث نفس الكارت من غير إرسال رسالة جديدة', id(), choice('status', 'حالة العطل', ['investigating', 'monitoring', 'resolved']), text('details', 'آخر تحديث للنشر', 1000)),
    r('recover', 'للمالك: اربط كارتًا اتنشر بدون تأكيد أو اقفل سجله', id(), text('message', 'ID الكارت الأصلي، أو سيبه فاضي للإغلاق', 20, false)),
  ]),
  command('access', 'تشخيص رؤية الروم والكتابة من غير تعديل', 'diagnostics', [
    method(r('check', 'فحص وصول عضو لروم نصي', user(), channel()), 'access'),
  ]),
  command('layout', 'جرد هيكل الرومات والرولات من غير استرجاع تلقائي', 'diagnostics', [
    r('capture', 'احفظ لقطة حالية للهيكل بدون محتوى الرسائل'), r('diff', 'اعرض تغييرات الهيكل مقارنة باللقطة'),
  ], { owner: true }),
  command('room', 'تهدئة مؤقتة ووصول محدود ومراجعة الأذونات', 'room', [
    r('slow', 'عاين أو طبّق تهدئة مؤقتة', channel(), integer('seconds', 'مدة Slow Mode بالثواني', 0, 21600),
      integer('minutes', 'مدة الإعداد المؤقت بالدقايق', 1, 120), bool('confirm', 'فعّل التنفيذ بدل المعاينة')),
    r('guest', 'وصول مؤقت لروم الضيوف المخصص', user(), integer('minutes', 'مدة الوصول بالدقايق', 1, 360)),
    r('propose', 'اقترح تغيير رؤية روم لعضو واحد بدون تنفيذ', channel(), user(), choice('visibility', 'رؤية الروم', ['allow', 'deny'])),
    r('pending', 'اعرض طلبات الرؤية المفتوحة للمراجعة'),
    r('approve', 'عاين أو وافق على طلب مشرف آخر', id(), bool('confirm', 'تنفيذ الموافقة')),
    r('leases', 'حالة الإعدادات المؤقتة والاسترجاع'),
    r('forget', 'للمالك: اقفل سجل استرجاع فاشل بعد المراجعة اليدوية، بدون تعديل الروم', id()),
  ]),
  command('guide', 'لوحة قوانين واهتمامات «ابدأ هنا»', 'guide', [
    r('publish', 'انشر لوحة ابدأ هنا في الروم الحالي', channel('rules', 'روم القوانين')),
  ], { owner: true }),
  command('welcome', 'ترحيب شخصي من مالك BLACK X ومعاينة أسئلة الدخول', 'welcome', [
    r('configure', 'احفظ روم الترحيب واسم المالك ونص الرسالة', channel(), text('owner_name', 'الاسم العلني للمالك', 64),
      text('message', 'رسالة الترحيب للأعضاء الجدد', 1200)),
    r('social', 'أضف حسابًا علنيًا، أو اترك الرابط فاضيًا لإزالته', choice('platform', 'المنصة', SOCIAL_PLATFORMS),
      text('url', 'رابط HTTPS مباشر للبروفايل', 300, false)),
    r('preview', 'عاين ترحيبك في رد خاص من غير إرسال في الروم'),
    r('enable', 'فعّل أو أوقف الترحيب بالأعضاء الجدد', bool('enabled', 'حالة الترحيب', true)),
    r('onboarding', 'افحص رومات وأسئلة Discord Onboarding الحالية من غير تعديل',
      option('Role', 'members', 'اختياري: رول العضوية الآمن', undefined, false), option('Role', 'boy', 'اختياري: رول اختيار Boy', undefined, false),
      option('Role', 'girl', 'اختياري: رول اختيار Girl', undefined, false)),
  ], { owner: true }),
  command('idea', 'اقتراحات BLACK X وتصويت ومراجعة', 'idea', [
    r('add', 'سجّل اقتراح في الروم المضبوط', title(), text('note', 'تفاصيل مختصرة', 300)),
    r('list', 'اعرض الاقتراحات المتاحة للتصويت'), r('vote', 'سجّل صوتك بدون تكرار', id(), choice('choice', 'اختيارك', ['yes', 'no'])),
    r('review', 'حدّث حالة اقتراح من قناة الفريق', id(), choice('status', 'الحالة الجديدة', ['review', 'approved', 'rejected', 'implemented'])),
  ]),
  command('content', 'طلبات صُنّاع المحتوى وتصحيحات الكتالوج', 'content', [
    r('apply', 'قدّم طلب الانضمام لصُنّاع المحتوى', text('url', 'رابط HTTPS للقناة من غير معاملات', 300), text('type', 'نوع المحتوى', 100)),
    r('correction', 'اقترح تصحيح بيانات عمل من غير تغيير الموقع', anime(), choice('issue', 'نوع المشكلة', ['link', 'episodes', 'data']), text('note', 'اللي محتاج يتراجع', 300)),
    r('review', 'راجع طلب محتوى أو تصحيح من قناة الفريق', id(), outcome(), reason()),
  ], { autocomplete: true }),
  command('discussion', 'نقاشات الأنمي في منتدى بوسم الحرق', 'discussion', [
    r('topic', 'افتح نقاشًا أو اعرض الموجود لنفس العمل والموسم', anime(), integer('season', 'الموسم', 1, 100), bool('spoiler', 'النقاش فيه حرق', true)),
  ], { autocomplete: true }),
  command('calendar', 'أجندة الفعاليات والصيانة وحفلات المشاهدة', 'calendar', [
    r('week', 'اعرض مواعيد الأسبوع اللي تقدر تشوفها'),
    r('add', 'أضف ميعادًا للأجندة في الروم الحالي', choice('kind', 'نوع الميعاد', ['maintenance', 'quiz', 'event']), title(),
      when('starts_at'), integer('minutes', 'المدة المتوقعة بالدقايق', 5, 360), bool('force', 'أكّد التعارض المقصود')),
    r('cancel', 'ألغِ ميعادًا من الروم اللي اتضاف فيه', id()),
  ]),
  command('my', 'اعرض طلباتك وتنبيهاتك وحجوزاتك للعرض الخاص', 'my', [r('view', 'طلباتي')], { single: true }),
  command('schedule', 'قائمة الإعلانات المؤجلة وإلغاؤها', 'publication', [
    r('list', 'اعرض الإعلانات المجدولة وحالتها'), r('cancel', 'ألغِ إعلانًا لم يُرسل بعد', id()),
  ]),
  command('automod', 'ملخص أعداد تنفيذ قواعد AutoMod لنطاق المشرف', 'auto', [r('summary', 'ملخص الرصد')], { single: true }),
  command('server', 'تجهيز أذونات الرومات ولوحات BLACK X بمعاينة خاصة', 'server', [
    r('bind', 'حدد غرض روم أو كاتيجوري بدون تعديل الأذونات', channel('channel', 'الروم أو الكاتيجوري', SETUP_TYPES),
      choice('profile', 'غرض الروم أو الكاتيجوري', PROFILES), role(false)),
    r('unbind', 'شيل ربط الروم من خطط التجهيز؛ ما تمسحش الروم', channel('channel', 'الروم أو الكاتيجوري', SETUP_TYPES, false),
      text('channel_id', 'معرّف روم اتحذف لو مش موجود في القائمة', 20, false)),
    r('prepare', 'عاين خطة التجهيز ووافق بزر خاص لتطبيقها', channel('panel', 'روم لوحة فتح الشكاوى للأعضاء', TEXT_ROOMS, false),
      channel('category', 'كاتيجوري التذاكر الخاصة', [C.GuildCategory], false), channel('staff', 'روم مراجعة الشكاوى الخاص', TEXT_ROOMS, false), role(false)),
    r('undo', 'عاين استرجاع الأذونات لآخر تطبيق بدون الكتابة فوق تعديل أحدث'),
  ], { owner: true }),
  command('rules', 'احفظ مسودة قوانين BLACK X وعاينها وحدّث الرسالة المنشورة', 'rules', [
    r('edit', 'احفظ نص القوانين كمسودة بدون نشر', text('text', 'نص القوانين؛ ينفع تنسخ أكثر من سطر', 3000)),
    r('preview', 'عاين النص الحالي بشكل خاص'), r('publish', 'انشر أو عدّل رسالة القوانين في الروم المربوط'),
  ], { owner: true }),
];
