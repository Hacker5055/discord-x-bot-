import { randomInt } from 'node:crypto';
import { isSnowflake } from '../lib/catalog.js';
import { AppError, errorFields } from '../lib/errors.js';
import { QUESTION_BANK } from './data/quiz.js';
import { requireStore } from './store.js';
import { DAY } from './time.js';
import { button, mute, row, timestamp } from './ui.js';

const titles = { anime: '🏆 BLACK X Arena', seerah: '📚 مسابقة السيرة والقرآن' };
const QUESTION_COUNT = 5;
const MAX_PLAYERS = 200;
const absent = () => new AppError('QUIZ_NOT_ACTIVE', 'السؤال خلص أو المسابقة دي مش شغّالة دلوقتي.');

function draw(bank, count, random) {
  const pool = [...bank];
  return Array.from({ length: count }, () => pool.splice(random(pool.length), 1)[0]);
}

function weekOf(now) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(+d - ((d.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
}

function weeklyScores(state, week) {
  if (state.scores.week !== week) {
    const previous = new Date(Date.parse(`${week}T00:00:00Z`) - 7 * DAY).toISOString().slice(0, 10);
    const winners = (scores = {}) => {
      const top = Math.max(0, ...Object.values(scores));
      return top ? Object.keys(scores).filter((id) => scores[id] === top).sort().slice(0, 10) : [];
    };
    const champions = state.scores.week === previous
      ? { anime: winners(state.scores.anime), seerah: winners(state.scores.seerah) } : {};
    state.scores = { week, anime: {}, seerah: {}, champions };
  }
  return state.scores;
}

function standings(scores, limit = 10) {
  const items = Object.entries(scores).sort(([a, scoreA], [b, scoreB]) => scoreB - scoreA || a.localeCompare(b)).slice(0, limit);
  let place = 0;
  return items.map(([id, score], index) => {
    if (index === 0 || score !== items[index - 1][1]) place = index + 1;
    const badge = place === 1 && score > 0 ? '🏅 ' : '';
    return `${place}. ${badge}<@${id}> — ${score} نقطة`;
  });
}

function questionMessage(game) {
  const question = game.questions[game.index];
  return mute({ embeds: [{ title: `${titles[game.kind]} · ${game.index + 1}/${QUESTION_COUNT}`, color: 0x9B59B6,
    description: `${question.prompt}\n\nاختار إجابتك قبل ${timestamp(game.deadline, 'R')}. إجابتك بتفضل خاصة.` }],
  components: [row(...question.choices.map((label, answer) => button(`bx:q:${game.id}:${game.index}:${answer}`, label, 1)))] });
}

function answerLine(question) {
  return `**الإجابة:** ${question.choices[question.answer]}\n${question.explanation}${question.source ? `\n[${question.source[0]}](${question.source[1]})` : ''}`;
}

export function createQuizService({ api, store, log, now = Date.now, random = randomInt,
  schedule = setTimeout, unschedule = clearTimeout, questionMs = 20_000, revealMs = 5500 }) {
  const games = new Map();
  let closed = false;

  function release(game) {
    unschedule(game.timer);
    game.phase = 'closed';
    if (games.get(game.channelId) === game) games.delete(game.channelId);
  }

  const active = (game) => !['stopping', 'closed'].includes(game.phase);

  function timer(game, ms, next) {
    game.timer = schedule(() => {
      if (!active(game)) return;
      const running = next().catch((error) => {
        log.warn('quiz_round_failed', { kind: game.kind, ...errorFields(error) });
        if (active(game)) release(game);
      });
      game.running = running;
      return running.finally(() => { if (game.running === running) game.running = undefined; });
    }, Math.max(0, ms));
    game.timer?.unref?.();
  }

  async function finish(game, question) {
    let saved = false;
    if (store && Object.values(game.scores).some((score) => score > 0)) {
      try {
        const week = weekOf(now());
        await store.update((state) => {
          const weekly = weeklyScores(state, week)[game.kind];
          let size = Object.keys(weekly).length;
          for (const [id, score] of Object.entries(game.scores)) {
            if (!score || (!Object.hasOwn(weekly, id) && size >= 2000)) continue;
            if (!Object.hasOwn(weekly, id)) size += 1;
            weekly[id] = (weekly[id] ?? 0) + score;
          }
        });
        saved = true;
      } catch (error) { log.warn('quiz_weekly_save_failed', errorFields(error)); }
    }
    if (!active(game)) return;
    const scores = standings(game.scores);
    await api.editMessage(game.channelId, game.messageId, mute({ embeds: [{ title: `${titles[game.kind]} · النتيجة النهائية`, color: 0xD7AC48,
      description: `${answerLine(question)}\n\n${scores.join('\n') || 'محدّش جاوب الجولة دي.'}${saved ? '\n\nاتحدّث ترتيب الأسبوع.' : ''}` }], components: [] }));
    release(game);
  }

  async function closeQuestion(game) {
    if (game.phase !== 'question') return;
    if (game.deadline > now()) { timer(game, game.deadline - now(), () => closeQuestion(game)); return; }
    game.phase = 'reveal';
    const question = game.questions[game.index];
    for (const [id, answer] of game.answers) game.scores[id] = (game.scores[id] ?? 0) + (answer === question.answer ? 100 : 0);
    if (game.index + 1 === game.questions.length) { game.phase = 'finishing'; await finish(game, question); return; }
    await api.editMessage(game.channelId, game.messageId, mute({ embeds: [{ title: `${titles[game.kind]} · الحل`, color: 0x2ECC71,
      description: `${answerLine(question)}\n\nالسؤال الجاي بعد ثواني.` }], components: [] }));
    if (active(game)) timer(game, revealMs, async () => {
      game.index += 1;
      game.answers.clear();
      game.deadline = now() + questionMs;
      game.phase = 'opening';
      await api.editMessage(game.channelId, game.messageId, questionMessage(game));
      if (active(game)) {
        game.phase = 'question';
        timer(game, game.deadline - now(), () => closeQuestion(game));
      }
    });
  }

  return {
    async start({ kind, id, channelId }) {
      if (closed) throw absent();
      if (!Object.hasOwn(QUESTION_BANK, kind)) throw absent();
      if (games.has(channelId)) throw new AppError('QUIZ_BUSY', 'فيه تحدّي شغّال في الروم بالفعل.');
      if (games.size >= 5) throw new AppError('QUIZ_LIMIT', 'فيه تحدّيات كتير شغّالة دلوقتي. جرّب بعدين.');
      const game = { kind, id, channelId, index: 0, phase: 'opening', deadline: now() + questionMs,
        questions: draw(QUESTION_BANK[kind], QUESTION_COUNT, random), answers: new Map(), scores: {}, players: new Set() };
      games.set(channelId, game);
      try {
        const result = await api.createMessage(channelId, { ...questionMessage(game), nonce: id, enforce_nonce: true });
        if (!isSnowflake(result?.id)) throw new AppError('QUIZ_MESSAGE_FAILED', 'تعذّر تأكيد نشر المسابقة.', 502);
        game.messageId = result.id;
        if (closed) throw absent();
        game.phase = 'question';
        timer(game, game.deadline - now(), () => closeQuestion(game));
      } catch (error) { release(game); throw error; }
    },
    answer({ id, channelId, messageId, userId, index, choice }) {
      const game = games.get(channelId);
      if (!game || !isSnowflake(userId) || game.id !== id || game.messageId !== messageId || game.index !== index
        || game.phase !== 'question' || now() >= game.deadline || !Number.isInteger(choice) || choice < 0
        || choice >= game.questions[index].choices.length) throw absent();
      if (game.answers.has(userId)) throw new AppError('ALREADY_ANSWERED', 'إجابتك اتسجّلت بالفعل للسؤال ده.');
      if (!game.players.has(userId) && game.players.size >= MAX_PLAYERS) throw new AppError('QUIZ_FULL', 'المسابقة وصلت للحد الأقصى من اللاعبين.');
      game.players.add(userId);
      game.answers.set(userId, choice);
      return 'اتسجّلت إجابتك. استنى إعلان الحل.';
    },
    async stop(kind, channelId) {
      const game = games.get(channelId);
      if (!game?.messageId || game.kind !== kind || !active(game) || game.phase === 'finishing') throw absent();
      game.phase = 'stopping';
      unschedule(game.timer);
      try {
        await game.running;
        await api.editMessage(channelId, game.messageId, mute({ embeds: [{ title: titles[kind], description: 'الإدارة أوقفت الجولة.' }], components: [] }));
      } finally { release(game); }
    },
    async leaderboard(kind) {
      const state = await requireStore(store).read();
      const week = weekOf(now());
      const weekly = weeklyScores(state, week);
      const lines = standings(weekly[kind]);
      const champions = weekly.champions?.[kind] ?? [];
      return [`${titles[kind]} · ترتيب الأسبوع (UTC)`, ...(lines.length ? lines : ['مفيش نتائج للأسبوع ده لسه.']),
        ...(champions.length ? [`🏅 أبطال الأسبوع اللي فات: ${champions.map((id) => `<@${id}>`).join(' · ')}`] : [])];
    },
    close() { closed = true; for (const game of games.values()) release(game); },
  };
}
