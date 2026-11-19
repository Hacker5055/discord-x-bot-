import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { AppError } from '../lib/errors.js';
import { createRedactor } from '../lib/redact.js';
import { cleanText, siteUrl } from '../community/anime.js';
import { adhkarPage, prayerCard, ramadanCard, ramadanReminder, setDaily } from '../community/islamic.js';
import { dailyEmbed } from '../community/jobs.js';
import { cancelParty, respondParty, scheduleParty } from '../community/party.js';
import { CITY_CHOICES, cityFor, clockMinutes, localDateTime, parsePartyDate } from '../community/time.js';
import { requireModerator, requirePostChannel, timestamp } from '../community/ui.js';

const requireCommunity = (community) => {
  if (!community) throw new AppError('COMMUNITY_UNAVAILABLE', 'الميزة مش جاهزة دلوقتي. جرّب لاحقًا.', 503);
  return community;
};
const command = (name, desc) => new SlashCommandBuilder().setName(name).setDescription(desc);
const choice = (name, value) => ({ name, value });
const required = (option, name, label, maxLength) => option.setName(name).setDescription(label).setRequired(true).setMaxLength(maxLength);
const cityOption = (option) => option.setName('city').setDescription('اختار المدينة').setRequired(true).addChoices(...CITY_CHOICES);
const modes = [choice('آية', 'ayah'), choice('حديث', 'hadith'), choice('بالتبادل', 'alternate')];
const modeOption = (option) => option.setName('mode').setDescription('نوع المحتوى').setRequired(true).addChoices(...modes);
const readMode = (interaction) => {
  const mode = interaction.options.getString('mode', true);
  if (!modes.some(({ value }) => value === mode)) throw new AppError('INVALID_DAILY_MODE', 'اختار نوع المحتوى من القائمة.');
  return mode;
};

function makeQuizCommand(name, kind, desc) {
  return {
    data: command(name, desc)
      .addSubcommand((sub) => sub.setName('start').setDescription('يبدأ تحدّي من ٥ أسئلة في الروم الحالي (للإدارة)'))
      .addSubcommand((sub) => sub.setName('stop').setDescription('إيقاف التحدّي الحالي في الروم (للإدارة)'))
      .addSubcommand((sub) => sub.setName('leaderboard').setDescription('عرض ترتيب لاعبي الأسبوع')),
    async run(interaction, { config, community }) {
      const { quiz } = requireCommunity(community);
      const action = interaction.options.getSubcommand();
      if (action === 'leaderboard') return quiz.leaderboard(kind);
      requireModerator(interaction, config);
      if (action === 'stop') {
        await quiz.stop(kind, interaction.channelId);
        return ['اتوقفت الجولة.'];
      }
      requirePostChannel(interaction.channel, config.guildId, interaction.appPermissions);
      await quiz.start({ kind, id: interaction.id, channelId: interaction.channelId });
      return ['المسابقة بدأت! جاوب من الأزرار في كارت الروم.'];
    },
  };
}

export const partyCommand = {
  data: command('party', 'حفلات مشاهدة BLACK X')
    .addSubcommand((sub) => sub.setName('schedule').setDescription('جدولة حفلة مشاهدة في الروم الحالي (للإدارة)')
      .addStringOption((opt) => required(opt, 'title', 'عنوان الحفلة', 90))
      .addStringOption((opt) => required(opt, 'starts_at', 'صيغة التاريخ والوقت: 2027-02-01T21:30+02:00', 28))
      .addStringOption((opt) => required(opt, 'url', 'رابط المشاهدة من موقع BLACK X', 600)))
    .addSubcommand((sub) => sub.setName('cancel').setDescription('إلغاء حفلة في الروم الحالي (للإدارة)')
      .addStringOption((opt) => required(opt, 'id', 'رقم الحفلة المكتوب على الكارت', 20))),
  async run(interaction, { config, community }) {
    requireModerator(interaction, config);
    const { store, now } = requireCommunity(community);
    if (interaction.options.getSubcommand() === 'cancel') {
      await cancelParty(store, { id: interaction.options.getString('id', true), channelId: interaction.channelId, now: now() });
      return ['اتلغت الحفلة والتذكيرات. لو الكارت منشور، هيتحدّث قريب.'];
    }
    requirePostChannel(interaction.channel, config.guildId, interaction.appPermissions);
    const redact = createRedactor([config.apiSecret, config.botToken, config.databaseUrl]);
    const title = cleanText(interaction.options.getString('title', true), 90, redact,
      () => new AppError('INVALID_PARTY_TITLE', 'اكتب عنوانًا صالحًا من غير أي أسرار أو روابط Webhook.'));
    const url = siteUrl(cleanText(interaction.options.getString('url', true), 600, redact));
    const at = parsePartyDate(interaction.options.getString('starts_at', true));
    await scheduleParty(store, { id: interaction.id, channelId: interaction.channelId, title, at, url }, now());
    return [`اتجدولت الحفلة في ${timestamp(at)}. الكارت هيتنشر في الروم قريب. رقم الحفلة: \`${interaction.id}\`.`];
  },
};

const followAnimeOption = (opt) => required(opt, 'anime', 'اسم الأنمي أو معرّفه من كتالوج BLACK X', 100).setAutocomplete(true);
const followCommand = {
  data: command('follow', 'متابعة تنبيهات حلقات الأنمي في الرسائل الخاصة')
    .addSubcommand((sub) => sub.setName('add').setDescription('اشترك في تنبيهات حلقات أنمي في الخاص').addStringOption(followAnimeOption))
    .addSubcommand((sub) => sub.setName('remove').setDescription('إيقاف تنبيهات أنمي').addStringOption(followAnimeOption))
    .addSubcommand((sub) => sub.setName('list').setDescription('اعرض الأنميات اللي بتتابعها')),
  async run(interaction, { community }) {
    const action = interaction.options.getSubcommand();
    return requireCommunity(community).anime.follow(interaction.user.id, action,
      action === 'list' ? undefined : interaction.options.getString('anime', true));
  },
  async autocomplete(interaction, { community }) {
    return requireCommunity(community).anime.autocomplete(interaction.user.id, interaction.options.getFocused(), interaction.options.getSubcommand() === 'remove');
  },
};

const recommendCommand = {
  data: command('recommend', 'BLACK Z: اقتراح أنمي من كتالوج الموقع بدون حرق')
    .addStringOption((opt) => required(opt, 'query', 'وصف اللي بتحبّه، مثال: أنمي غموض قصير من غير حرق', 180)),
  run: (interaction, { community }) => requireCommunity(community).anime.recommend(interaction.options.getString('query', true)),
};

const adhkarCommand = {
  data: command('adhkar', 'أذكار مختارة من الصباح والمساء بمصادرها')
    .addStringOption((opt) => opt.setName('period').setDescription('اختار الصباح أو المساء').setRequired(true)
      .addChoices(choice('أذكار الصباح', 'morning'), choice('أذكار المساء', 'evening'))),
  run: (interaction) => adhkarPage(interaction.options.getString('period', true), 0, interaction.user.id),
};

const prayerCommand = {
  data: command('prayer', 'احسب مواقيت الصلاة حسب المدينة').addStringOption(cityOption),
  run: (interaction, { community }) => prayerCard(interaction.options.getString('city', true), community?.now() ?? Date.now()),
};

const ramadanCommand = {
  data: command('ramadan', 'فجر ومغرب مدينتك وموعد الإفطار التقريبي').addStringOption(cityOption),
  run: (interaction, { community }) => ramadanCard(interaction.options.getString('city', true), interaction.user.id,
    community?.now() ?? Date.now(), Boolean(community?.store)),
};

const dailyCommand = {
  data: command('daily', 'آية أو حديث اليوم من نصوص موثّقة')
    .addSubcommand((sub) => sub.setName('preview').setDescription('شوف مثالًا لكارت الآية أو الحديث').addStringOption(modeOption))
    .addSubcommand((sub) => sub.setName('enable').setDescription('جدولة آية أو حديث في الروم الحالي (للإدارة)')
      .addStringOption(modeOption).addStringOption(cityOption)
      .addStringOption((opt) => required(opt, 'time', 'وقت النشر حسب المدينة HH:MM (مثال 09:30)', 5)))
    .addSubcommand((sub) => sub.setName('disable').setDescription('إيقاف النشر اليومي (للإدارة)')),
  async run(interaction, { config, community }) {
    const action = interaction.options.getSubcommand();
    if (action === 'preview') {
      const { date } = localDateTime(community?.now() ?? Date.now(), cityFor('giza').zone);
      return { embeds: [dailyEmbed(readMode(interaction), date)] };
    }
    requireModerator(interaction, config, PermissionFlagsBits.ManageGuild);
    const { store } = requireCommunity(community);
    if (action === 'disable') {
      await setDaily(store, null);
      return ['اتوقف نشر آية أو حديث اليوم.'];
    }
    requirePostChannel(interaction.channel, config.guildId, interaction.appPermissions);
    const city = interaction.options.getString('city', true);
    const time = interaction.options.getString('time', true);
    const minute = clockMinutes(time);
    const { zone } = cityFor(city);
    await setDaily(store, { mode: readMode(interaction), minute, city, channelId: interaction.channelId, version: interaction.id });
    return [`اتضبط النشر اليومي في الروم ده الساعة ${time} حسب ${zone}. لإيقافه استخدم /daily disable.`];
  },
};

export const communityCommands = [makeQuizCommand('arena', 'anime', 'تحدّي الأنمي الجماعي'), partyCommand, followCommand,
  recommendCommand, adhkarCommand, prayerCommand, dailyCommand, ramadanCommand, makeQuizCommand('seerah', 'seerah', 'مسابقة السيرة والقرآن')];

const stale = () => new AppError('OLD_BUTTON', 'الزر ده مش صالح ليك أو الكارت قديم. افتح الأمر من جديد.');

export async function communityButton(interaction, { community }) {
  const { customId, channelId, message, user } = interaction;
  if (user.bot) throw stale();
  let match = /^bx:a:(morning|evening):(\d{1,2}):(\d{17,20})$/.exec(customId);
  if (match) {
    if (match[3] !== user.id) throw stale();
    return adhkarPage(match[1], Number(match[2]), user.id);
  }
  const { quiz, store, now } = requireCommunity(community);
  match = /^bx:q:(\d{17,20}):([0-4]):([0-3])$/.exec(customId);
  if (match) return [quiz.answer({ id: match[1], channelId, messageId: message?.id, userId: user.id, index: Number(match[2]), choice: Number(match[3]) })];
  match = /^bx:p:(\d{17,20}):(join|leave|remind|mute)$/.exec(customId);
  if (match) return [await respondParty(store, { id: match[1], channelId, messageId: message?.id, userId: user.id, action: match[2], now: now() })];
  match = /^bx:r:(add|remove):([a-z_]{1,20}):(\d{13}):(\d{17,20})$/.exec(customId);
  if (match) {
    if (match[4] !== user.id) throw stale();
    return [await ramadanReminder(store, { userId: user.id, action: match[1], city: match[2], maghrib: Number(match[3]), now: now() })];
  }
  throw stale();
}
