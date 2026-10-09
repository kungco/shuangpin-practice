// 训练阶段与自适应难度的评估。计时只用「有效练习时间」，暂停/后台不计入。
//
// 【窗口为什么是滑动的】窗口长度固定为 WINDOW，每次收样本就挤出最早的一条。
// 早先的实现是攒满 10 条就 splice(0) 全清，结果「9 好 + 1 差」会把前 9 条
// 一起作废——对「逐步撤提示」这种需要连续信心的场景偏狠，一个手滑要等
// 10 个单元才能重新攒。滑动窗口里坏样本只影响它所在的那一段。
//
// 【决策频率】滑动之后窗口一旦填满就会「每来一条评一次」，那是另一端的
// 极端：连续答对时档位会一题一档地往上跳（6 题就能从 1 档冲到 7 档）。
// 所以用 seen 计数把决策钉在「每 WINDOW 个单元一次」，与原实现节奏一致，
// 变的只是参与判定的样本集合。
export const TRAINING_LABELS = ['完整提示', '只显示拼音', '独立输入'];

/** 评估窗口长度（同时也是两次决策之间的单元数） */
const WINDOW = 10;

// 各阶段的晋级门槛。
// stage 0（完整提示）看「正确率」：此时答案本来就摆在眼前，能筛的只有手速。
// stage 1（只显示拼音）起只看「独立正确率」：靠提示打对的字符一律不算。
const PROMOTION = [
  { success: 0.9, seconds: 4 },   // 完整提示 → 只显示拼音
  { success: 0.9, seconds: 3 }    // 只显示拼音 → 独立输入
];
// 自适应难度的升降档门槛（仅在有提示的阶段生效，见 observeTraining）。
const RAISE = { accuracy: 0.9, seconds: 3 };
const LOWER = { accuracy: 0.7, seconds: 6 };
const TIER_MIN = 1;
const TIER_MAX = 7;

export function createTraining(policy = 'full', saved = {}) {
  saved = saved || {};
  const valid = ['full', 'progressive', 'pinyin', 'independent'].includes(policy) ? policy : 'full';
  return {
    policy: valid,
    stage: valid === 'progressive' ? Math.max(0, Math.min(2, Math.floor(Number(saved.stage) || 0)))
      : valid === 'pinyin' ? 1 : valid === 'independent' ? 2 : 0,
    tier: Math.max(TIER_MIN, Math.min(TIER_MAX, Math.floor(Number(saved.tier) || 1))),
    // 续练时最多带回来 WINDOW-1 条：再加一条刚好凑满一个窗口，
    // 用户回来答第一题就能重新评估，而不必先重攒十条。
    guidance: Array.isArray(saved.guidance) ? saved.guidance.slice(-(WINDOW - 1)) : [],
    difficulty: Array.isArray(saved.difficulty) ? saved.difficulty.slice(-(WINDOW - 1)) : [],
    // 自上次决策以来已评估的单元数（见文件头「决策频率」）。
    // 续练要带上，否则会把节奏重置成「先攒十条」。
    guidanceSeen: Math.max(0, Math.floor(Number(saved.guidanceSeen) || 0)),
    difficultySeen: Math.max(0, Math.floor(Number(saved.difficultySeen) || 0))
  };
}

/**
 * 判断这次样本是否到了「可以做决策」的点：窗口已满，且距上次决策已满 WINDOW 个单元。
 * 副作用：返回 true 时把计数归零。
 */
function dueFor(state, field, window) {
  state[field + 'Seen'] = (state[field + 'Seen'] || 0) + 1;
  if (state[field].length < window || state[field + 'Seen'] < window) return false;
  state[field + 'Seen'] = 0;
  return true;
}

/** 把窗口的样本汇总成 { rate, time }；rate 取该阶段真正在意的那个指标 */
function evaluate(window, stage) {
  const rate = window.filter(x => stage === 0 ? x.correct : x.independent).length / window.length;
  return { rate, time: window.reduce((sum, x) => sum + x.seconds, 0) / window.length };
}

export function observeTraining(state, { correct, independent, seconds }, adaptive = false) {
  const sample = { correct: !!correct, independent: !!independent, seconds: Math.max(0, Number(seconds) || 0) };
  const oldStage = state.stage;

  if (state.policy === 'progressive' && state.stage < 2) {
    state.guidance.push(sample);
    // 滑动窗口：出队最早的一条，保证窗口里始终是最近 WINDOW 个样本
    if (state.guidance.length > WINDOW) state.guidance.shift();
    if (dueFor(state, 'guidance', WINDOW)) {
      const rule = PROMOTION[state.stage];
      const { rate, time } = evaluate(state.guidance, state.stage);
      if (rate >= rule.success && time <= rule.seconds) state.stage++;
    }
  }

  if (oldStage !== state.stage) {
    // 提示刚变少，成绩不可比：难度窗口与决策节奏一起重置，
    // 避免用「有提示时」的样本去调难度。
    state.difficulty = [];
    state.difficultySeen = 0;
  } else if (adaptive && state.stage > 0) {
    state.difficulty.push(sample);
    if (state.difficulty.length > WINDOW) state.difficulty.shift();
    if (dueFor(state, 'difficulty', WINDOW)) {
      const { rate, time } = evaluate(state.difficulty, state.stage);
      if (rate >= RAISE.accuracy && time <= RAISE.seconds) state.tier = Math.min(TIER_MAX, state.tier + 1);
      else if (rate < LOWER.accuracy || time > LOWER.seconds) state.tier = Math.max(TIER_MIN, state.tier - 1);
    }
  }
}
