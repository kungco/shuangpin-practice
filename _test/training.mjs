import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createTraining, observeTraining } from '../src/core/training.js';
import { generateQuestions, KEY_COMPONENTS, phrasePool, PHRASES } from '../src/core/questions.js';
import { PracticeEngine } from '../src/core/engine.js';
import { summarize, historySeries, dailySeries } from '../src/core/stats.js';
import * as S from '../src/core/storage.js';

const memory = new Map();
globalThis.window = { localStorage: {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: key => memory.delete(key)
} };

const fast = { correct: true, independent: true, seconds: 2 };
let state = createTraining('progressive');
for (let i = 0; i < 10; i++) observeTraining(state, { ...fast, independent: false }, true);
assert.equal(state.stage, 1);
assert.equal(state.tier, 1, 'guided accuracy cannot promote difficulty');
for (let i = 0; i < 10; i++) observeTraining(state, { ...fast, independent: false }, true);
assert.equal(state.stage, 1, 'help prevents independent-stage graduation');
for (let i = 0; i < 10; i++) observeTraining(state, fast, true);
assert.equal(state.stage, 2);
for (let i = 0; i < 10; i++) observeTraining(state, fast, true);
assert.equal(state.tier, 2);
for (let i = 0; i < 10; i++) observeTraining(state, { ...fast, seconds: 7 }, true);
assert.equal(state.tier, 1, 'slow responses lower difficulty');
state.tier = 3;
for (let i = 0; i < 10; i++) observeTraining(state, { ...fast, independent: false }, true);
assert.equal(state.tier, 2, 'help/errors lower difficulty');
console.log('✓ training progression uses independent accuracy and response time');

const context = {};
const keyQuestions = Array.from({ length: KEY_COMPONENTS.length }, () => generateQuestions({ mode: 'keymap', count: 1, context })[0]);
assert.equal(new Set(keyQuestions.map(q => `${q.role}:${q.promptText}`)).size, KEY_COMPONENTS.length);
const previous = keyQuestions.at(-1);
const weakKey = KEY_COMPONENTS.find(x => x.key !== previous.keyDetail.key).key.toLowerCase();
const more = generateQuestions({ mode: 'keymap', count: 500, context, keyWeights: { [weakKey]: 20 } });
assert(more.filter(q => q.keyDetail.key.toLowerCase() === weakKey).length >= 90, 'weak keys get extra review after complete coverage');
console.log('✓ all initials/finals covered before weak-key reinforcement');

assert(PHRASES.every(p => ['daily', 'office', 'travel', 'idiom'].includes(p.c)), 'every phrase has an authored category');
for (const category of ['daily', 'office', 'travel', 'idiom']) {
  for (const length of [2, 3, 4]) {
    const pool = phrasePool({ phraseCategory: category, phraseLength: length });
    const questions = generateQuestions({ mode: 'phrase', count: 30, phraseCategory: category, phraseLength: length });
    assert.equal(questions.length, pool.length ? 30 : 0);
    assert(questions.every(q => q.meta.category === category && Array.from(q.text).length === length));
  }
}
const phraseContext = {};
const pool = phrasePool({ phraseCategory: 'office', phraseLength: 3 });
const unique = generateQuestions({ mode: 'phrase', count: pool.length, phraseCategory: 'office', phraseLength: 3, context: phraseContext });
assert.equal(new Set(unique.map(q => q.text)).size, pool.length);
const next = generateQuestions({ mode: 'phrase', count: 1, phraseCategory: 'office', phraseLength: 3, context: phraseContext });
assert.notEqual(next[0].text, unique.at(-1).text);
console.log('✓ phrase category/length filters and exhaustion boundaries');

const queueContext = {};
const source = (overrides = {}) => generateQuestions({ mode: 'char', count: 20, charTier: 'progressive', context: queueContext, ...overrides });
let now = 100000;
const originalNow = Date.now;
Date.now = () => now;
const eng = new PracticeEngine({ mode: 'char', generation: { charTier: 'progressive' }, questions: source(),
  questionSource: source, unlimited: true, trainingPolicy: 'independent', hintEnabled: false });
eng.start();
const complete = () => {
  now += 1500;
  eng._lastTickAt = now; eng.elapsedSec += 1.5;
  for (let i = 0; i < 2; i++) { const t = eng.currentTarget(); eng.pressKey(t.keys[t.pos]); }
};
for (let i = 0; i < 10; i++) complete();
assert.equal(eng.training.tier, 2);
assert.equal(eng.currentQuestion().meta.tier, 2, 'finite queued questions refresh immediately after a tier change');
now += 100;
eng.pause();
const atPause = eng.activeSeconds();
now += 600000;
assert.equal(eng.activeSeconds(), atPause);
S.saveResume(eng.exportResume());
const saved = S.loadResume();
eng.destroy();
const restored = PracticeEngine.restore(saved, source);
assert.equal(restored.training.tier, 2);
assert.equal(restored.training.stage, 2);
assert.equal(restored._unitStartedAt, saved.unitStartedAt);
restored.start();
for (let i = 0; i < 2; i++) { const t = restored.currentTarget(); restored.pressKey(t.keys[t.pos]); }
assert(restored.training.difficulty[0].seconds < 1, 'pause/offline time excluded');
for (let n = 0; n < 11; n++) {
  restored.elapsedSec += 1.5; now += 1500; restored._lastTickAt = now;
  for (let i = 0; i < 2; i++) { const t = restored.currentTarget(); restored.pressKey(t.keys[t.pos]); }
}
assert(restored.questionOffset >= 20);
assert.equal(restored.currentQuestion().meta.tier, restored.training.tier);
restored.destroy();
Date.now = originalNow;
const guided = new PracticeEngine({ mode: 'char', questions: generateQuestions({ mode: 'char', count: 2 }), trainingPolicy: 'full', hintEnabled: false });
for (let i = 0; i < 2; i++) { const t = guided.currentTarget(); guided.pressKey(t.keys[t.pos]); }
assert.equal(guided.visibleStats().independentAccuracy, 0, 'visible answers are assistance');
guided.destroy();
const transitioning = new PracticeEngine({ mode: 'phrase', questions: generateQuestions({ mode: 'phrase', count: 1, phraseLength: 2 }),
  trainingPolicy: 'progressive', hintEnabled: false });
transitioning.training.guidance = Array.from({ length: 9 }, () => ({ correct: true, independent: false, seconds: 0 }));
for (let unit = 0; unit < 2; unit++) {
  for (let key = 0; key < 2; key++) { const t = transitioning.currentTarget(); transitioning.pressKey(t.keys[t.pos]); }
}
assert.equal(transitioning.training.stage, 1);
assert.equal(transitioning.stats.hintedCorrectChars, 2, 'previewed next-character answer remains assisted after guidance withdrawal');
transitioning.destroy();
console.log('✓ adaptive tier, pause timing, unlimited replenishment and persisted training');

const date = S.dateStr(new Date());
const records = [
  { mode: 'keymap', speed: 120, durationSec: 1, accuracy: 100, totalChars: 2, date },
  { mode: 'phrase', speed: 30, durationSec: 60, accuracy: 50, totalChars: 60, date }
];
assert.equal(summarize(records).avgSpeed, 31.5);
assert.equal(summarize(records).avgAccuracy, 51.6);
for (const rec of records) S.appendRecord(S.makeRecord(rec));
assert(historySeries({ mode: 'phrase' }).points.every(p => p.mode === 'phrase'));
assert.equal(dailySeries(1, 'phrase')[0].chars, 60);
assert.equal(dailySeries(1, 'keymap')[0].chars, 2);
console.log('✓ per-mode series/daily totals and duration/character weighted averages');

for (const count of [500, 5000]) {
  const started = performance.now();
  assert.equal(generateQuestions({ mode: 'phrase', count }).length, count);
  console.log(`phrase ${count}: ${(performance.now() - started).toFixed(1)} ms`);
}
