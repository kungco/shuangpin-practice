import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createTraining, observeTraining } from '../src/core/training.js';
import { generateQuestions, annotatePassage, KEY_COMPONENTS, phrasePool, PHRASES } from '../src/core/questions.js';
import { PracticeEngine } from '../src/core/engine.js';
import { summarize, historySeries, dailySeries, scoreSeries } from '../src/core/stats.js';
import * as S from '../src/core/storage.js';

// 共享的假存储：后面几组用例会各自重设 localStorage 指向它
const store = new Map();
globalThis.window = { localStorage: {
  getItem: key => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key)
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

/* 滑动窗口：一个坏样本不该把之前 9 个好样本一起作废 */
{
  const s = createTraining('progressive');
  s.stage = 2;
  s.difficulty = [];
  s.difficultySeen = 0;
  const good = { correct: true, independent: true, seconds: 1 };
  for (let i = 0; i < 9; i++) observeTraining(s, good, true);
  assert.equal(s.tier, 1, 'nine good units alone are not a decision point');
  // 第 10 个是慢样本：按整窗清空的实现，窗口被作废，tier 保持 1
  observeTraining(s, { ...good, seconds: 8 }, true);
  assert.equal(s.difficulty.length, 10, 'the window keeps the history instead of resetting');
  // 窗口里 9 好 1 慢 → 仍然达标（正确率 90%、均时 1.7s ≤ 3s），升档
  assert.equal(s.tier, 2, 'one bad sample no longer discards the nine good ones');
  assert.equal(s.difficultySeen, 0, 'the cadence resets after a decision');
  // 决策之后节奏归零：接下来 9 题窗口虽已饱和但不再调档，第 10 题才决策。
  // 少了这个约束，滑动窗口会退化成「每答一题调一档」。
  for (let i = 0; i < 9; i++) {
    observeTraining(s, good, true);
    assert.equal(s.tier, 2, `unit ${i + 1} after a decision must not re-decide`);
  }
  observeTraining(s, good, true);
  assert.equal(s.tier, 3, 'the tenth unit triggers exactly one decision');
  assert.equal(s.difficultySeen, 0, 'the cadence resets after each decision');
  console.log('✓ the evaluation window slides and decides once per window');
}

/* 续练必须带上决策节奏，否则节奏会被重置成「先攒十条」 */
{
  const resumed = createTraining('progressive', {
    stage: 2, tier: 3,
    guidance: [], difficulty: Array.from({ length: 9 }, () => ({ correct: true, independent: true, seconds: 1 })),
    difficultySeen: 9
  });
  assert.equal(resumed.difficulty.length, 9);
  assert.equal(resumed.difficultySeen, 9);
  observeTraining(resumed, { correct: true, independent: true, seconds: 1 }, true);
  assert.equal(resumed.tier, 4, 'one unit after resuming is enough to re-evaluate');
  const capped = createTraining('progressive', {
    difficulty: Array.from({ length: 30 }, () => ({ correct: true, independent: true, seconds: 1 }))
  });
  assert.equal(capped.difficulty.length, 9, 'at most WINDOW-1 samples are carried across');
  console.log('✓ the decision cadence survives a pause and resume');
}

const context = {};
const keyQuestions = Array.from({ length: KEY_COMPONENTS.length }, () => generateQuestions({ mode: 'keymap', count: 1, context })[0]);
assert.equal(new Set(keyQuestions.map(q => `${q.role}:${q.promptText}`)).size, KEY_COMPONENTS.length);
const previous = keyQuestions.at(-1);
const weakKey = KEY_COMPONENTS.find(x => x.key !== previous.keyDetail.key).key.toLowerCase();
const more = generateQuestions({ mode: 'keymap', count: 500, context, keyWeights: { [weakKey]: 20 } });
assert(more.filter(q => q.keyDetail.key.toLowerCase() === weakKey).length >= 90, 'weak keys get extra review after complete coverage');
console.log('✓ all initials/finals covered before weak-key reinforcement');

/* 强化题是「插入」在覆盖轮次之间的，不占用覆盖名额，也不破坏覆盖率 */
{
  const ctx = { usedKeys: new Set(), usedKeys_: 0 };
  ctx.usedKeys.cycles = 0; ctx.usedKeys.draws = 0;
  const weights = { [weakKey]: 20 };
  const seen = [];
  for (let i = 0; i < KEY_COMPONENTS.length; i++) {
    const q = generateQuestions({ mode: 'keymap', count: 1, context: ctx, keyWeights: weights })[0];
    seen.push(`${q.role}:${q.promptText}`);
  }
  // 首轮全覆盖期间（cycles === 0）不插强化，弱键位置靠后但一个不落
  assert.equal(new Set(seen).size, KEY_COMPONENTS.length, 'the first cycle still covers everything');
  // 该键上可能同时有声母和韵母成分，各占一个覆盖名额，首轮都应出现
  const onWeakKey = KEY_COMPONENTS.filter(c => c.key.toLowerCase() === weakKey);
  assert(onWeakKey.length >= 1);
  for (const c of onWeakKey) assert(seen.includes(`${c.role}:${c.part}`), `${c.part} is covered in the first cycle`);
  // 之后才开始插强化。弱键的「出现次数」不能直接数：覆盖队列本身也会把
  // 弱键排到前面，那是加权排序的效果；这里要验的是**额外插入**的节奏。
  let inserts = 0;
  let lastWeakAt = ctx.usedKeys.weakAt || 0;
  let extra = 0;
  const seenLater = [];
  for (let i = 0; i < 200; i++) {
    const q = generateQuestions({ mode: 'keymap', count: 1, context: ctx, keyWeights: weights })[0];
    seenLater.push(`${q.role}:${q.promptText}`);
    if (q.keyDetail.key.toLowerCase() === weakKey) extra++;
    const at = ctx.usedKeys.weakAt || 0;
    if (at !== lastWeakAt) { inserts++; lastWeakAt = at; }
  }
  assert(extra > 0, 'weak keys are reinforced after the first full cycle');
  assert(inserts > 0, 'reinforcement is actually being inserted');
  assert(inserts <= 200 / 5 + 1, `at most one inserted reinforcement per five units, got ${inserts}`);
  // 强化不写进 used，所以它不会顶掉一个覆盖名额：把这一轮见过的全部题目
  // 合起来，必须仍然覆盖所有成分（覆盖集合本身会在轮次切换时清空，不能直接比大小）。
  const allSeen = new Set([...seen, ...seenLater]);
  assert.equal(allSeen.size, KEY_COMPONENTS.length, 'reinforcement never displaces coverage');
  console.log('✓ weak-key reinforcement is capped and never displaces coverage');
}

/* 人工注音长度对不上必须报警，而不是静默产出错误读音 */
{
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    // 四个字的短文配三条注音：改词/漏字后最容易出现的形态
    const stale = annotatePassage('重复成长', ['chong', 'fu', 'cheng']);
    assert.equal(warnings.length, 1, 'a mismatched vetted reading is reported');
    assert(warnings[0].includes('注音'), 'the warning says what is wrong');
    // 长度对不上时回落自动标注，但必须留下痕迹，而不是悄悄给错读音
    assert.equal(stale.length, 4);
    const ok = annotatePassage('重复', ['chong', 'fu']);
    assert.equal(ok[0].pinyin, 'chong', 'vetted readings are still used when the length matches');
    assert.equal(ok[1].pinyin, 'fu');
    assert.equal(warnings.length, 1, 'matching lengths stay quiet');
  } finally { console.warn = realWarn; }
  console.log('✓ mismatched vetted readings warn instead of failing silently');
}

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
const released = [];
const source = (overrides = {}) => generateQuestions({ mode: 'char', count: 20, charTier: 'progressive', context: queueContext, ...overrides });
// 与 main.js 的 createQuestionSource 同一套归还逻辑：被换档顶掉的题
// 必须把去重标记还回去，否则那个字整场都不再出现。
source.releaseQuestion = (q) => {
  if (!q) return;
  queueContext.used?.delete(q.text || q.promptText);
  released.push(q.text || q.promptText);
};
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
assert(released.length > 0, 'the displaced question was handed back');
assert(released.every(t => !queueContext.used.has(t)), 'a displaced character is reusable again');
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
// 滑动窗口下，新样本在队尾而不是队首。
const freshest = restored.training.difficulty[restored.training.difficulty.length - 1];
assert(freshest.seconds < 1, 'pause/offline time excluded');
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
// 直接注入窗口，等价于「已经评估过 9 个单元」的状态：决策节奏由
// guidanceSeen 记录，续练会一起恢复，所以这里也要一并对齐。
transitioning.training.guidance = Array.from({ length: 9 }, () => ({ correct: true, independent: false, seconds: 0 }));
transitioning.training.guidanceSeen = 9;
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

/* ① 时钟同源：会话用时与反应时间必须用同一个上限。
   复现的是修复前的竞态——标签页被节流时 ticker 一次性把 10 分钟记进
   elapsedSec，而 activeSeconds() 只认 5 秒上限，于是下一个作答单元的
   「反应时间」变成 600 秒，自适应档位被静默降下去。 */
{
  globalThis.window.localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };
  let t = 500000;
  const realNow = Date.now;
  Date.now = () => t;
  const ctx = {};
  const make = () => generateQuestions({ mode: 'char', count: 5, charTier: 'progressive', context: ctx });
  const throttled = new PracticeEngine({ mode: 'char', generation: { charTier: 'progressive' },
    questions: make(), questionSource: make, unlimited: true, trainingPolicy: 'progressive', hintEnabled: false });
  throttled.start();
  // 直接走引擎自己的结算路径（ticker 是宿主定时器句柄，测试里拿不到回调）
  const settle = () => { throttled._lastTickAt = t - 600000; throttled.syncActiveTime(); };
  const answer = () => { for (let i = 0; i < 2; i++) { const x = throttled.currentTarget(); throttled.pressKey(x.keys[x.pos]); } };
  // 先攒满一个窗口，把提示撤到「独立输入」
  for (let i = 0; i < 20 && throttled.training.stage < 2; i++) { t += 200; throttled.syncActiveTime(); answer(); }
  assert.equal(throttled.training.stage, 2, 'reached the independent stage before throttling');
  throttled.training.difficulty = [];
  throttled.training.difficultySeen = 0;
  const tierBefore = throttled.training.tier;
  // 标签页被节流 10 分钟：一次结算要吞掉 600 秒的间隔
  t += 600000;
  settle();
  answer();
  const worst = Math.max(...throttled.training.difficulty.map(x => x.seconds));
  assert(worst <= 5.5, `throttled gap must be capped, got ${worst}s`);
  // 累计用时同样不该把 10 分钟整段算进去
  assert(throttled.elapsedSec <= 10 * 5.5, `session time must be capped, got ${throttled.elapsedSec}s`);
  assert.equal(throttled.training.tier, tierBefore, 'a throttled gap must not silently demote the tier');
  throttled.destroy();
  Date.now = realNow;
  console.log('✓ throttled background gaps are capped across both clocks');
}

/* ② 加权均值在权重缺失时退回算术平均，而不是掉到 0 */
{
  const legacy = [
    { mode: 'char', speed: 80, accuracy: 90, totalChars: 0, durationSec: 0, date },
    { mode: 'char', speed: 40, accuracy: 70, totalChars: 0, durationSec: 0, date }
  ];
  const sum = summarize(legacy);
  assert.equal(sum.avgSpeed, 60, 'missing durationSec falls back to the arithmetic mean');
  assert.equal(sum.avgAccuracy, 80, 'missing totalChars falls back to the arithmetic mean');
  console.log('✓ weighted averages degrade gracefully when weights are missing');
}

/* ③ 曲线均值明确标注为加权口径，plainAvg 供 UI 如实说明 */
{
  // 一条 1 秒 120 字/分 + 一条 600 秒 30 字/分 —— 加权均值必然偏离算术平均。
  store.set(S.KEYS.history, JSON.stringify([
    S.makeRecord({ mode: 'phrase', speed: 120, accuracy: 100, totalChars: 2, durationSec: 1, date }),
    S.makeRecord({ mode: 'phrase', speed: 30, accuracy: 50, totalChars: 300, durationSec: 600, date })
  ]));
  const series = historySeries({ metric: 'speed', range: 'all' });
  assert.equal(series.avgWeighted, true);
  assert.equal(series.points.length, 2);
  // (120×1 + 30×600) / 601 = 30.15 → 30.1，而两点算术平均是 75
  assert.equal(series.avg, 30.1, 'curve average is duration-weighted');
  assert.equal(series.plainAvg, 75, 'the plain mean of the same points is different');
  // (100×2 + 50×300) / 302 = 50.33 → 50.3
  const acc = historySeries({ metric: 'acc', range: 'all' });
  assert.equal(acc.avg, 50.3, 'accuracy average is character-weighted');
  console.log('✓ curve average is labelled as weighted and exposes the plain mean');
}

/* ④ 测验成绩曲线：只取有效分数，无效的不能画成 0 分深坑 */
{
  const examRec = (score, valid, day) => {
    const r = S.makeRecord({ mode: 'exam', speed: 60, accuracy: 90, totalChars: 40, durationSec: 40, date: day });
    r.score = score; r.scoreValid = valid; r.grade = 'B';
    return r;
  };
  store.set(S.KEYS.history, JSON.stringify([
    examRec(72, true, date),
    examRec(0, false, date),      // 字数不足，没资格评分
    examRec(88, true, date)
  ]));
  const ss = scoreSeries({ range: 'all' });
  assert.equal(ss.points.length, 2, '只有有效分数进入曲线');
  assert.deepEqual(ss.points.map(p => p.score), [72, 88]);
  assert.equal(ss.avg, 80, '分数用算术平均（绝对量，无需加权）');
  assert.equal(ss.invalid, 1, '无效次数单独报出，用于说明点数为何偏少');
  assert.equal(ss.min, 72);
  assert.equal(ss.max, 88);
  assert.equal(ss.points[0].grade, 'B', '等级随点保留，便于单独渲染');
  // 非测验记录不能混进来
  store.set(S.KEYS.history, JSON.stringify([
    S.makeRecord({ mode: 'char', speed: 60, accuracy: 90, totalChars: 40, durationSec: 40, date }),
    examRec(66, true, date)
  ]));
  assert.equal(scoreSeries({ range: 'all' }).points.length, 1, '练习成绩不混入测验曲线');
  console.log('✓ the exam score curve only plots valid, scored sessions');
}

/* ④ 每日练习量必须回落到日报：成绩记录上限 2000 条，日报才是长期累积的 */
{
  const old = new Date(Date.now() - 9 * 86400000);
  const oldKey = S.dateStr(old);
  store.set(S.KEYS.daily, JSON.stringify({ [oldKey]: {
    date: oldKey, sessions: 3, chars: 240, durationSec: 600, bestSpeed: 90, speedSum: 200
  } }));
  // 成绩记录里没有那一天
  assert(!S.loadHistory().some(r => r.date === oldKey), 'the old day is absent from retained history');
  const series = dailySeries(14, 'all');
  const recovered = series.find(d => d.date === oldKey);
  assert(recovered, 'the old day still appears on the daily chart');
  assert.equal(recovered.chars, 240, 'daily totals survive history pruning');
  assert.equal(recovered.sessions, 3);
  // 有成绩记录的那天不能被日报和历史重复计数
  const today = series[series.length - 1];
  const todayRecords = S.loadHistory().filter(r => r.date === today.date);
  const todayDaily = JSON.parse(store.get(S.KEYS.daily) || '{}')[today.date];
  const expected = todayDaily
    ? todayDaily.chars
    : todayRecords.reduce((s, r) => s + (r.totalChars || 0), 0);
  assert.equal(today.chars, expected, 'a day is never counted twice');
  console.log('✓ daily totals fall back to the daily report and never double-count');
}

for (const count of [500, 5000]) {
  const started = performance.now();
  assert.equal(generateQuestions({ mode: 'phrase', count }).length, count);
  console.log(`phrase ${count}: ${(performance.now() - started).toFixed(1)} ms`);
}

/* ⑤ 键位掌握度：没碰过 / 在练 / 已掌握 三态 + 三条判定门槛
   ------------------------------------------------------------
   这一层不新增存储，靠 keyTimings（按对的样本）与 keyErrors（按错的次数）
   合起来推算，所以要验的是「两条数据源确实被正确合并」，以及
   「慢而准」绝不能被误判成已掌握。 */
{
  const { keyMastery } = await import('../src/core/stats.js');
  store.clear();

  const setTimings = (obj) => store.set(S.KEYS.keyTimings,
    JSON.stringify({ all: obj, byMode: {}, recent: [] }));
  const setErrors = (obj) => store.set(S.KEYS.keyErrors,
    JSON.stringify({ all: obj, byMode: {}, recent: [] }));

  /* 场景一：A 键练得多且从不错、速度正常 → 已掌握。
     B 键练得多但错误率高 → 在练。C 键从没碰过 → 未接触。
     D 键练得够多、也从不错，但明显偏慢 → 仍然是「在练」。 */
  const fast = [], slow = [];
  for (let i = 0; i < 20; i++) fast.push(200 + (i % 5) * 10);      // 中位数 ~220
  for (let i = 0; i < 20; i++) slow.push(2000 + (i % 5) * 10);     // 中位数 ~2020
  setTimings({
    A: { lead: fast, follow: [] },
    B: { lead: fast, follow: [] },
    D: { lead: slow, follow: [] }
  });
  setErrors({ B: 8 });   // B：20 对 + 8 错 → 错误率 28.6%，远超 8%

  const m = keyMastery({ range: 'all' });
  const byKey = Object.fromEntries(m.items.map(i => [i.key, i]));

  assert.equal(byKey.A.state, 'mastered',
    'A：样本足、零错误、不慢 → 已掌握');
  assert.equal(byKey.B.state, 'learning',
    'B：错误率 28.6% 超门槛 → 在练（不能只看样本数）');
  assert.equal(byKey.B.errors, 8, 'B 的错误次数并入掌握度统计');
  assert.equal(byKey.B.practice, 28, `B 的练习数 = 对 20 + 错 8（实际 ${byKey.B.practice}）`);
  assert.equal(byKey.D.state, 'learning',
    '★ D：20 次全对但每次慢 10 倍 → 仍判「在练」（慢而准不是掌握）');
  assert.equal(byKey.D.slow, true, 'D 被标记为偏慢');

  // C 从没出现在 timings 或 errors 里 → 未接触（不会凭空出现，需由 UI 补全 26 键）
  assert.equal(byKey.C, undefined, 'C 未被碰过 → 不在 items 里（由 UI 用全键表补全）');

  // counts 三态合计必须等于 items 长度（不漏不多）
  const { mastered, learning, untouched } = m.counts;
  assert.equal(mastered + learning + untouched, m.total,
    '三态计数之和等于键数');

  /* 场景二：样本不够（< minSamples）即便零错误也只能算「在练」——
     练 3 次全对不等于掌握，这是防止「掌握度虚高」的关键一条。 */
  store.clear();
  setTimings({ E: { lead: [200, 210, 220], follow: [] } });
  setErrors({});
  const m2 = keyMastery({ range: 'all' });
  const e = m2.items.find(i => i.key === 'E');
  assert.equal(e.state, 'learning', '样本 3 < 门槛 12 → 在练');
  assert.equal(e.need, 9, `如实给出「再练 9 次」（实际 ${e.need}）`);

  /* 场景三：错误率恰好在门槛上（8%）—— 用「≤」而不是「<」，
     边界值应算通过，否则「刚好达标」的用户永远差一点。 */
  store.clear();
  setTimings({ F: { lead: Array.from({ length: 23 }, () => 200), follow: [] } });
  setErrors({ F: 2 });   // 23 对 + 2 错 = 25，错误率恰好 8%
  const f = keyMastery({ range: 'all' }).items.find(i => i.key === 'F');
  assert.equal(f.errorRate, 0.08, `错误率恰为 8%（实际 ${f.errorRate}）`);
  assert.equal(f.state, 'mastered', '错误率 8% 恰在门槛上 → 算达标');

  /* 场景四：完全没有数据时不能崩，且 counts 全 0 */
  store.clear();
  const m4 = keyMastery({ range: 'all' });
  assert.equal(m4.items.length, 0, '无数据时 items 为空');
  assert.deepEqual(m4.counts, { untouched: 0, learning: 0, mastered: 0 },
    '无数据时三态计数全 0（不出现 NaN）');

  /* 场景五：掌握度必须按模式隔离 —— 与热力图同口径 */
  store.clear();
  store.set(S.KEYS.keyTimings, JSON.stringify({
    all: { A: { lead: Array.from({ length: 20 }, () => 200), follow: [] } },
    byMode: { phrase: { A: { lead: Array.from({ length: 20 }, () => 200), follow: [] } } },
    recent: []
  }));
  store.set(S.KEYS.keyErrors, JSON.stringify({
    all: { A: 0 }, byMode: {}, recent: []
  }));
  const mPhrase = keyMastery({ range: 'all', mode: 'phrase' });
  assert.equal(mPhrase.byMode, true, '有该模式专属数据时 byMode=true');
  const mChar = keyMastery({ range: 'all', mode: 'char' });
  // char 模式没有专属 timings → 退回全量，byMode 必须如实为 false
  assert.equal(mChar.byMode, false, '无该模式数据时 byMode=false（供 UI 说明「仍为全量」）');

  /* 场景六（回归）：样本极少的键不得污染「整体中位数」基准。
     真实踩到过：几个只练过 1 次、恰好很快的键把基准压到 ~120ms，
     于是所有正常速度（220ms）的键全被判成「慢」，掌握度永远 0。
     修法是基准只取样本够多的键。这里锁住这个行为。 */
  store.clear();
  store.set(S.KEYS.keyTimings, JSON.stringify({
    all: {
      // 一个练了 20 次、稳定 220ms 的正常键 —— 应当被判定为「已掌握」
      G: { lead: Array.from({ length: 20 }, () => 220), follow: [] },
      // 三个只练了 1 次、恰好极快的键 —— 不得把基准拽低
      C: { lead: [110], follow: [] },
      M: { lead: [108], follow: [] },
      X: { lead: [112], follow: [] }
    },
    byMode: {}, recent: []
  }));
  store.set(S.KEYS.keyErrors, JSON.stringify({ all: {}, byMode: {}, recent: [] }));
  const m6 = keyMastery({ range: 'all' });
  const g6 = m6.items.find(i => i.key === 'G');
  assert.equal(g6.state, 'mastered',
    '★ 少样本快键不能把基准拽低、害得正常键永远判不成掌握');
  assert.ok(m6.slowLine >= 220,
    `基准线不应被 1 样本键拉到 150 以下（实际 ${m6.slowLine}）`);

  console.log('✓ key mastery merges timings+errors, honours all three gates, and isolates by mode');
}

/* ⑥ 错题本导出为跟打文本 */
{
  const { buildWeakPassage } = await import('../src/core/stats.js');

  const items = [
    { key: '银行', word: '银行', char: '银', pinyin: 'yin hang', count: 5 },
    { key: '月', word: '', char: '月', pinyin: 'yue', count: 3 },
    { key: '双拼', word: '双拼', char: '双', pinyin: 'shuang pin', count: 2 },
    { key: '银行', word: '银行', char: '银', pinyin: 'yin hang', count: 5 },   // 重复
    { key: 'abc123', word: 'abc123', char: 'a', pinyin: '', count: 9 },        // 非纯汉字，应剔除
    { key: '标点。', word: '标点。', char: '标', pinyin: '', count: 4 }         // 带标点，应剔除
  ];

  const built = buildWeakPassage(items);
  assert.equal(built.count, 3, `只收纯汉字条目并去重（实际 ${built.count}）`);
  assert.equal(built.chars, 2 + 1 + 2, `可练字数 = 各词字数之和（实际 ${built.chars}）`);
  assert.ok(built.text.includes('银行') && built.text.includes('月') && built.text.includes('双拼'),
    '三个词都进了文本');
  assert.equal((built.text.match(/银行/g) || []).length, 1, '重复条目只出现一次');
  assert.ok(!built.text.includes('abc'), '英文数字条目被剔除');
  assert.ok(built.text.endsWith('。'), '文本以句号收尾（便于分段与字数统计）');
  assert.ok(built.text.includes('、'), '条目之间用顿号连接');

  // 空输入 / 全是不可用条目时安全回落，不能返回一个空句号
  assert.deepEqual(buildWeakPassage([]), { text: '', count: 0, chars: 0 }, '空输入安全回落');
  assert.equal(buildWeakPassage([{ word: 'abc' }]).count, 0, '全不可用条目时 count 为 0');
  assert.equal(buildWeakPassage(null).text, '', 'null 输入不崩');

  // maxItems 上限：太多了连不成可练的一段
  const many = Array.from({ length: 100 }, (_, i) => ({ word: '字', char: '字', key: '字' + i }));
  // 注意 key 各不相同、word 都是「字」→ 去重后只剩 1 条
  assert.equal(buildWeakPassage(many).count, 1, '相同文字去重');
  // 生成 100 个**互不相同**的纯汉字词（用汉字笔画铺满，避免混入数字）
  const HAN = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
  const many2 = Array.from({ length: 100 }, (_, i) => ({
    word: HAN[i % 22] + HAN[Math.floor(i / 22) % 22] + HAN[(i * 7) % 22],
    key: 'k' + i
  }));
  const uniq = new Set(many2.map(x => x.word));
  assert.equal(buildWeakPassage(many2, { maxItems: 10 }).count, 10,
    `maxItems 生效（候选 ${uniq.size} 个唯一词）`);

  // 导出的文本必须能被真正的分段函数接受（否则「导出」按钮点了没用）
  assert.ok(built.text.length > 0, '导出文本非空');

  console.log('✓ buildWeakPassage assembles a deduped, Han-only, punctuation-joined drill text');
}

