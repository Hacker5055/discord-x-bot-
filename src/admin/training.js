import { button, row } from '../community/ui.js';
import { card, denied, fixedChoice, idOf, stale } from './core.js';

const scenarios = {
  ticket: { team: 'support', name: 'تذكرة وهمية T-01', steps: [
    ['عضو تجريبي طلب مساعدة. الحالة: مستنية.', 'استلم التذكرة'],
    ['التذكرة مع المشرف التجريبي. مفيش رسالة لأي عضو حقيقي.', 'سجّل أول رد'],
    ['اتسجّل أول رد وهمي. سبب الإغلاق: «اتحلّت».', 'اقفل التذكرة'],
    ['التذكرة الوهمية مقفولة؛ ما اتمسحش أي روم.'],
  ] },
  warning: { team: 'moderation', name: 'تنبيه وهمي W-01', steps: [
    ['عضو وهمي U-01. السبب التدريبي: مخالفة قاعدة الروم.', 'سجّل تنبيهًا'],
    ['اتسجّل التنبيه بدون Timeout أو حظر. العضو التجريبي طلب مراجعة.', 'افتح الاستئناف'],
    ['الاستئناف مستني مشرف تجريبي مختلف عن صاحب التنبيه.', 'راجع كمشرف آخر'],
    ['اتقبل الاستئناف والتنبـيه الوهمي اتلغى. مفيش عضو حقيقي اتأثّر.'],
  ] },
  slow: { team: 'ops', name: 'تهدئة في روم وهمي R-01', steps: [
    ['معاينة: ٠ → ١٠ ثواني، لمدة ٥ دقايق.', 'أكّد المحاكاة'],
    ['اتضبطت التهدئة في المحاكاة. بعدها مشرف غيّرها يدويًا لـ٣ ثواني.', 'مرّر وقت الانتهاء'],
    ['التهدئة فضلت ٣ ثواني بسبب التعديل اليدوي. مفيش روم حقيقي اتأثّر.'],
  ] },
};

export function trainingActions(c) {
  async function step(i, key, index, by, team) {
    const scenario = scenarios[fixedChoice(Object.keys(scenarios), key)];
    if (scenario.team !== team) throw denied();
    const ctx = await c.session(i, { team });
    if (ctx.by !== by || !scenario.steps[index]) throw stale();
    const [text, action] = scenario.steps[index];
    return { ...card(`🧪 تدريب فقط · ${scenario.name}`, `${text}\n\nالخطوة ${index + 1} من ${scenario.steps.length}. مفيش تغيير في ديسكورد أو سجل حقيقي.`),
      components: action ? [row(button(`bx:x:train:${key}:${index + 1}:${by}`, action, 1))] : [] };
  }
  return {
    practice: (i, { team, scenario }) => step(i, scenario, 0, c.assertGuild(i), team),
    button(i) {
      const match = /^bx:x:train:(ticket|warning|slow):([1-3]):(\d{17,20})$/.exec(i.customId);
      if (!match || idOf(match[3]) !== c.assertGuild(i)) throw stale();
      return step(i, match[1], Number(match[2]), match[3], scenarios[match[1]].team);
    },
  };
}
