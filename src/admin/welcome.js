import { ChannelType as C, escapeMarkdown, PermissionFlagsBits as P } from 'discord.js';
import { SITE_ORIGIN } from '../community/anime.js';
import { DAY } from '../community/time.js';
import { linkButton, row } from '../community/ui.js';
import { hasPermission } from '../discord/permissions.js';
import { isSnowflake } from '../lib/catalog.js';
import { AppError, DiscordApiError, ownerRequired } from '../lib/errors.js';
import { adminOf, audit, fixedChoice, idOf, memberRef, nonce, post, roomRef, stale, TEXT_ROOMS } from './core.js';

const social = {
  instagram: ['Instagram', ['instagram.com', 'www.instagram.com'], /^\/[a-z\d_.]{1,30}\/?$/iu],
  tiktok: ['TikTok', ['tiktok.com', 'www.tiktok.com'], /^\/@[a-z\d_.]{1,32}\/?$/iu],
  youtube: ['YouTube', ['youtube.com', 'www.youtube.com'], /^\/(?:@[\p{L}\p{N}._-]{1,50}|channel\/[a-z\d_-]{1,50}|(?:c|user)\/[a-z\d_.-]{1,50})\/?$/iu],
  x: ['X', ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'], /^\/[a-z\d_]{1,15}\/?$/iu],
  facebook: ['Facebook', ['facebook.com', 'www.facebook.com'], /^(?:\/[a-z\d.]{1,80}\/?|\/profile\.php)$/iu],
  twitch: ['Twitch', ['twitch.tv', 'www.twitch.tv'], /^\/[a-z\d_]{1,25}\/?$/iu],
  github: ['GitHub', ['github.com', 'www.github.com'], /^\/[a-z\d-]{1,39}\/?$/iu],
};
export const SOCIAL_PLATFORMS = Object.keys(social);
const welcomeConfig = () => new AppError('WELCOME_CONFIG', 'اضبط روم الترحيب واسم المالك ونص الرسالة باستخدام /welcome configure الأول.');
const welcomeIntent = () => new AppError('WELCOME_GATEWAY', 'فعّل Server Members Intent ثم اضبط BX_WELCOME=1 على تطبيق البوت.');
const rolesUnsafe = () => new AppError('ONBOARDING_ROLE', 'اختار ٣ رولات مختلفة لـ members وboy وgirl، أو سيبهم كلهم فاضيين لفحص Onboarding العام. الأسماء الظاهرة مش شرط.');
const joinRoleKeys = ['members', 'boy', 'girl'];
const DEFAULT_TEXT = [...TEXT_ROOMS, C.GuildForum, C.GuildMedia];
const productLike = (name) => /^(?:black\s*x|vip\b|creator\b)/iu.test(name.replace(/^[^\p{L}\p{N}]+/u, ''));
const MAX_WELCOME_RECEIPTS = 512;

function profileLink(platform, value, redact) {
  const [, hosts, path] = social[platform];
  try {
    if (typeof value !== 'string' || value.length > 300 || !/^https:\/\//iu.test(value) ||
      /[\u0000-\u0020\u007F\\#]/u.test(value) || redact(value) !== value) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname) ||
      !path.test(decodeURIComponent(url.pathname)) || (url.pathname === '/' && !url.search)) throw new Error();
    const numericFacebook = platform === 'facebook' && url.pathname.toLowerCase() === '/profile.php';
    if (numericFacebook ? !/^\?id=[1-9][0-9]{0,19}$/u.test(url.search) : value.includes('?')) throw new Error();
    return url.href;
  } catch {
    throw new AppError('WELCOME_SOCIAL_URL', 'استخدم رابط HTTPS مباشر للبروفايل على المنصة المختارة بدون تتبع أو بيانات دخول.');
  }
}

function welcomeCard(settings, by) {
  const links = [linkButton(`${SITE_ORIGIN}/profile`, 'حسابك على BLACK X')];
  for (const [platform, url] of Object.entries(settings.links ?? {})) links.push(linkButton(url, social[platform][0]));
  const components = [row(...links.slice(0, 5)), ...(links.length > 5 ? [row(...links.slice(5))] : [])];
  return {
    embeds: [{ title: '👋 أهلًا بيك في BLACK X!', color: 0x9B59B6,
      description: `نورتنا يا ${memberRef(by)}!\n\n${escapeMarkdown(settings.message)}`,
      footer: { text: `رسالة من ${settings.ownerName} · مالك BLACK X` } }],
    components,
  };
}

function welcomeDestination(c, w, a, channelId) {
  const ch = c.findRoom(w, channelId, TEXT_ROOMS);
  if (ch.topic?.startsWith('bx-ticket:') || ch.id === a.rooms.site_staff ||
    (ch.parent_id && ch.parent_id === a.rooms.ticket_category) || Object.values(a.teams).some(({ rooms }) => rooms.includes(ch.id))) {
    throw new AppError('WELCOME_ROOM', 'اختار روم ترحيب منفصل عن الرومات الخاصة بالفِرق والتذاكر.');
  }
  c.postNeeds(w, ch);
  return ch;
}

function isJoinPrompt(prompt, roleIds) {
  if (prompt.in_onboarding !== true || prompt.single_select !== true || prompt.required !== true || prompt.options.length !== 3) return false;
  const sets = prompt.options.map((option) => [...option.role_ids].sort().join(','));
  const [members, boy, girl] = roleIds;
  return [[members], [members, boy], [members, girl]].every((ids) => sets.includes(ids.sort().join(',')));
}

function selfSelectableRole(c, w, a, id) {
  const role = c.ordinaryRole(w, a, id, { manageable: false });
  if (productLike(role.name)) throw new AppError('ONBOARDING_ROLE', 'رول BLACK X أو VIP أو Creator مش للاختيار الذاتي.');
  return role;
}

function defaultChannelLines(c, w, current) {
  const ids = [...new Set(current.default_channel_ids)];
  const channels = ids.map((id) => w.channels.find((ch) => ch.id === id && (!ch.guild_id || ch.guild_id === c.guildId)));
  const publicChat = channels.filter((ch) => ch && DEFAULT_TEXT.includes(ch.type) &&
    hasPermission(c.bits(w, ch, c.guildId, { roles: [] }), P.ViewChannel | P.SendMessages)).length;
  const unknown = channels.filter((ch) => !ch).length;
  return [`رومات Onboarding الافتراضية: ${ids.length} · منها ${publicChat} روم نصّي ظاهر ومفتوح لـ @everyone في الفحص.`,
    ...(unknown ? [`⚠ البوت مش شايف ${unknown} من الرومات الافتراضية؛ راجعها في Discord.`] : []),
    ...(current.mode === 0 && (ids.length < 7 || publicChat < 5)
      ? ['⚠ في وضع الإعداد الافتراضي راجع شرط Discord: ٧ رومات افتراضية، منها ٥ مفتوحة لـ @everyone. ما تفتحش رومات الإدارة عشان تكمل العدد.'] : []),
    ...(current.mode === 1 ? ['Advanced Mode بيحسب الاختيارات كمان؛ راجع النتيجة في Preview بتاع Discord.'] : [])];
}

export function welcomeActions(c) {
  const change = (by, action, fn) => c.edit((a) => {
    const settings = a.welcome ??= { enabled: false };
    fn(settings, a);
    a.version += 1;
    audit(a, 'ops', action, by, 'welcome', c.now());
  });
  return {
    async configure(i, { channel, owner_name, message }) {
      const by = await c.owner(i);
      const ownerName = c.text(owner_name, 64);
      message = c.text(message, 1200, true);
      const w = await c.world();
      if (w.guild.owner_id !== by) throw ownerRequired();
      await change(by, 'welcome_configured', (settings, a) => {
        const ch = welcomeDestination(c, w, a, idOf(channel?.id));
        if (settings.ownerId !== by) Object.assign(settings, { enabled: false, links: {} });
        Object.assign(settings, { channelId: ch.id, ownerId: by, ownerName, message });
      });
      return [`اتحفظ ترحيب ${roomRef(channel.id)}. راجعه بـ /welcome preview. لو لسه متوقف شغّله بعد المعاينة.`];
    },
    async social(i, { platform, url }) {
      const by = await c.owner(i);
      fixedChoice(SOCIAL_PLATFORMS, platform);
      const link = url == null ? null : profileLink(platform, url, c.redact);
      await change(by, 'welcome_social_updated', (settings) => {
        if (settings.ownerId !== by) throw welcomeConfig();
        const links = settings.links ??= {};
        if (link) links[platform] = link;
        else delete links[platform];
      });
      return [link ? 'اتحفظ لينك الحساب. راجعه في /welcome preview.' : 'اتشال لينك المنصّة من الترحيب.'];
    },
    async enable(i, { enabled }) {
      const by = await c.owner(i);
      if (enabled && !c.config.welcomeGateway) throw welcomeIntent();
      const w = enabled ? await c.world() : undefined;
      if (w && w.guild.owner_id !== by) throw ownerRequired();
      await change(by, enabled ? 'welcome_enabled' : 'welcome_disabled', (settings, a) => {
        if (enabled) {
          if (settings.ownerId !== by || !settings.message || !settings.channelId) throw welcomeConfig();
          welcomeDestination(c, w, a, settings.channelId);
        }
        settings.enabled = enabled;
      });
      return [enabled ? 'اتفعّل الترحيب للأعضاء الجدد. مش هيتبعت للأعضاء الموجودين.' : 'اتوقف إرسال الترحيب للأعضاء الجدد.'];
    },
    async preview(i) {
      const by = await c.owner(i);
      const { welcome } = adminOf(await c.read());
      if (welcome?.ownerId !== by || !welcome.message) throw welcomeConfig();
      const state = c.config.welcomeGateway && welcome.enabled ? 'مفعّل' : 'متوقف';
      return { content: `معاينة خاصة · الوجهة: ${roomRef(welcome.channelId)} · الترحيب ${state}.`, ...welcomeCard(welcome, by) };
    },
    async onboarding(i, selected = {}) {
      const by = await c.owner(i);
      const [w, state] = await Promise.all([c.world(), c.read()]);
      if (w.guild.owner_id !== by) throw ownerRequired();
      const a = adminOf(state);
      const requested = joinRoleKeys.map((key) => selected[key]);
      if (requested.some(Boolean) && !requested.every(Boolean)) throw rolesUnsafe();
      const ids = requested.every(Boolean) ? requested.map((role) => idOf(role.id)) : [];
      if (new Set(ids).size !== ids.length) throw rolesUnsafe();
      ids.forEach((id) => selfSelectableRole(c, w, a, id));
      // Read native onboarding; never overwrite the server's questions/default channels or assign roles ourselves.
      const current = await c.api.getOnboarding(c.guildId);
      if (current?.guild_id !== c.guildId || typeof current.enabled !== 'boolean' || !Array.isArray(current.default_channel_ids) ||
        !current.default_channel_ids.every(isSnowflake) || !Array.isArray(current.prompts) ||
        !current.prompts.every((p) => Array.isArray(p.options) && p.options.every((o) => Array.isArray(o.role_ids)))) {
        throw new AppError('ONBOARDING_UNAVAILABLE', 'تعذّر تأكيد إعداد Discord Onboarding. راجعه من Server Settings.', 502);
      }
      const matching = ids.length > 0 && current.prompts.some((p) => isJoinPrompt(p, ids));
      let otherRisk = false;
      for (const id of new Set(current.prompts.flatMap((p) => p.options.flatMap((o) => o.role_ids)))) {
        try { selfSelectableRole(c, w, a, id); }
        catch (error) { if (!(error instanceof AppError)) throw error; otherRisk = true; }
      }
      return [`Discord Onboarding: ${current.enabled ? 'مفعّل' : 'متوقف'} · ${current.prompts.length} سؤال.`,
        ...defaultChannelLines(c, w, current),
        ...(Array.isArray(w.guild.features) ? [
          `Rules Screening: ${w.guild.features.includes('MEMBER_VERIFICATION_GATE_ENABLED') ? 'مفعّل' : 'مش مفعّل'}؛ مستقل عن رسالة القوانين.`,
        ] : []),
        ...(ids.length ? [matching ? 'فيه سؤال دخول باختيار واحد مطابق لتوزيع الرولات.' : 'لسه مفيش سؤال دخول مطابق لتوزيع الرولات.',
          'لو هتعمل السؤال ده، سيب خيار تخطّي: Boy → Members + Boy | Girl → Members + Girl | تخطّي → Members فقط. المسميات في الأمر أدوار في السؤال، مش أسماء لازم تغيّرها.'] : []),
        ...(otherRisk ? ['⚠️ في أسئلة فيها رولات غير آمنة للاختيار الذاتي؛ راجعها قبل التفعيل.'] : []),
        'سيب BLACK X وVIP وCreator ورولات الفرق خارج الاختيارات. راجع توزيع الرومات من Server Settings → Onboarding.',
        'ده فحص قراءة بس. Discord هو اللي يطرح السؤال ويعيّن الرول؛ البوت مش هيغيّر الـOnboarding أو الدعوات.'];
    },
    async join(event) {
      const { id, guild, user, joinedTimestamp, pending } = event;
      if (!c.config.welcomeGateway || guild?.id !== c.guildId || user?.id !== id || !isSnowflake(id) ||
        user.bot || pending === true || !Number.isSafeInteger(joinedTimestamp)) return;
      return c.serial('welcome-join', async () => {
        const a = adminOf(await c.read());
        const settings = a.welcome;
        if (!settings?.enabled || settings.ownerId !== c.config.ownerId) return;
        const [w, member] = await Promise.all([c.world(), c.api.getMember(c.guildId, id).catch((error) => {
          if (error instanceof DiscordApiError && error.status === 404 && error.discordCode === 10007) return null;
          throw error;
        })]);
        if (w.guild.owner_id !== settings.ownerId || member?.user?.id !== id || member.user.bot || member.pending === true ||
          Date.parse(member.joined_at) !== joinedTimestamp) return;
        const ch = welcomeDestination(c, w, a, settings.channelId);
        if (!hasPermission(c.bits(w, ch, id, member), P.ViewChannel)) return;
        const key = nonce(`guild-join:${c.guildId}:${id}:${joinedTimestamp}`);
        const mayPost = await c.edit((fresh) => {
          if (fresh.version !== a.version || !fresh.welcome?.enabled) throw stale();
          const receipts = fresh.welcome.receipts ??= {};
          if (receipts[key] > c.now() - 7 * DAY) return false;
          for (const [fingerprint, at] of Object.entries(receipts)) if (at <= c.now() - 7 * DAY) delete receipts[fingerprint];
          if (Object.keys(receipts).length >= MAX_WELCOME_RECEIPTS) {
            const oldest = Object.entries(receipts).sort((l, r) => l[1] - r[1])[0][0];
            delete receipts[oldest];
          }
          receipts[key] = c.now();
          return true;
        });
        if (!mayPost) return;
        await c.api.createMessage(ch.id, post(welcomeCard(settings, id), key), { guarded: true });
      });
    },
  };
}
