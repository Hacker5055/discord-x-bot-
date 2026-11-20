import { AppError } from '../lib/errors.js';
import { adminOf, audit, card, idOf, isMissing, post, roomRef, stale, TEXT_ROOMS } from './core.js';

export const DEFAULT_RULES = [
  '1. احترم كل الأعضاء. الاختلاف في الرأي عادي؛ الإهانة والتنمر والعنصرية والتحرش مش مقبولين، في الشات أو الصوت.',
  '2. من غير حرق. اكتب اسم الأنمي ورقم الحلقة قبل أي حرق، واستخدم إخفاء الحرق أو الروم المخصص.',
  '3. استخدم كل روم لغرضه. بلاش سبام، منشنات مزعجة، أو إعلانات ودعوات لسيرفرات تانية من غير إذن.',
  '4. ممنوع المحتوى الجنسي الصريح، الاحتيال، الروابط الضارة، أو انتحال شخصية عضو أو حد من الإدارة.',
  '5. احترم الخصوصية. ما تنشرش بيانات أو صور أو محادثات خاصة من غير إذن، وما تبعتش كلمة سر أو كود تحقق لأي حد، حتى في تذكرة.',
  '6. لو عندك مشكلة أو بلاغ، افتح تذكرة من روم الدعم الفني بدل ما تنشر تفاصيل البلاغ في الشات العام.',
  '7. الإدارة بتتعامل مع المخالفات حسب شدّتها وتكرارها: من تنبيه لحد الحظر. ولو شايف إن قرار اتاخد بالغلط، اطلب مراجعته من الدعم.',
].join('\n\n');

export const rulesRoom = (a) => Object.entries(a.server?.profiles ?? {}).find(([, spec]) => spec.profile === 'rules')?.[0];
const rulesPayload = (a) => card('📜 قوانين BLACK X', a.server?.rulesText ?? DEFAULT_RULES);

export function rulesActions(c) {
  return {
    async edit(i, { text }) {
      const by = await c.owner(i);
      text = c.text(text, 3000, true);
      await c.edit((a) => {
        (a.server ??= { profiles: {} }).rulesText = text;
        a.version += 1;
        audit(a, 'ops', 'rules_draft_saved', by, 'rules', c.now());
      });
      return { content: 'اتحفظت المسودة. استخدم `/rules publish` لتحديث الرسالة المنشورة، أو شغّل `/server prepare` مع باقي التجهيز.', ...rulesPayload({ server: { rulesText: text } }) };
    },
    async preview(i) {
      await c.owner(i);
      return { content: 'معاينة خاصة للقوانين؛ مش منشورة من الأمر ده.', ...rulesPayload(adminOf(await c.read())) };
    },
    async publish(i, { version } = {}) {
      return c.serial('rules-card', async () => {
        const by = await c.owner(i);
        const [w, state] = await Promise.all([c.world(), c.read()]);
        const a = adminOf(state);
        if (w.guild.owner_id !== by || (version !== undefined && a.version !== version)) throw stale();
        const roomId = rulesRoom(a);
        if (!roomId) throw new AppError('RULES_ROOM_REQUIRED', 'اربط روم القوانين بـ /server bind profile:rules الأول.');
        const ch = c.findRoom(w, roomId, TEXT_ROOMS);
        c.postNeeds(w, ch);
        const prior = a.panels.rules;
        let messageId;
        const payload = rulesPayload(a);
        if (prior?.channelId === roomId && prior.messageId) {
          try {
            await c.api.editMessage(roomId, prior.messageId, post(payload));
            messageId = prior.messageId;
          } catch (error) { if (!isMissing(error) || error.discordCode !== 10008) throw error; }
        }
        if (!messageId) messageId = idOf((await c.api.createMessage(roomId, post(payload, `rules:${roomId}:${i.id}`), { guarded: true }))?.id);
        await c.edit((current) => {
          if (current.version !== a.version || rulesRoom(current) !== roomId) throw stale();
          current.panels.rules = { channelId: roomId, messageId };
          audit(current, 'ops', 'rules_published', by, messageId, c.now());
        });
        return [`القوانين منشورة في ${roomRef(roomId)}.`];
      });
    },
  };
}
