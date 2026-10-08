// Each decision uses a fresh window of ten completed units. Active time excludes pauses.
export const TRAINING_LABELS = ['完整提示', '只显示拼音', '独立输入'];
export function createTraining(policy = 'full', saved = {}) {
  saved = saved || {};
  const valid = ['full', 'progressive', 'pinyin', 'independent'].includes(policy) ? policy : 'full';
  return {
    policy: valid,
    stage: valid === 'progressive' ? Math.max(0, Math.min(2, Math.floor(Number(saved.stage) || 0)))
      : valid === 'pinyin' ? 1 : valid === 'independent' ? 2 : 0,
    tier: Math.max(1, Math.min(7, Math.floor(Number(saved.tier) || 1))),
    guidance: Array.isArray(saved.guidance) ? saved.guidance.slice(-9) : [],
    difficulty: Array.isArray(saved.difficulty) ? saved.difficulty.slice(-9) : []
  };
}
export function observeTraining(state, { correct, independent, seconds }, adaptive = false) {
  const sample = { correct: !!correct, independent: !!independent, seconds: Math.max(0, Number(seconds) || 0) };
  const oldStage = state.stage;
  if (state.policy === 'progressive' && state.stage < 2) {
    state.guidance.push(sample);
    if (state.guidance.length >= 10) {
      const window = state.guidance.splice(0);
      const success = window.filter(x => state.stage === 0 ? x.correct : x.independent).length / window.length;
      const time = window.reduce((sum, x) => sum + x.seconds, 0) / window.length;
      if (success >= .9 && time <= (state.stage === 0 ? 4 : 3)) state.stage++;
    }
  }
  if (oldStage !== state.stage) state.difficulty = [];
  else if (adaptive && state.stage > 0) {
    state.difficulty.push(sample);
    if (state.difficulty.length >= 10) {
      const window = state.difficulty.splice(0);
      const accuracy = window.filter(x => x.independent).length / window.length;
      const time = window.reduce((sum, x) => sum + x.seconds, 0) / window.length;
      if (accuracy >= .9 && time <= 3) state.tier = Math.min(7, state.tier + 1);
      else if (accuracy < .7 || time > 6) state.tier = Math.max(1, state.tier - 1);
    }
  }
}
