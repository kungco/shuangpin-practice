/**
 * 自检脚本：验证双拼引擎与题库的正确性 / 完整性
 * 运行：node _test/verify.mjs
 */
import { splitSyllable, getKeymapData, ALL_KEYS, isKeyCorrect, buildSyllables,
         SHENGMU_TO_KEYS } from '../src/core/scheme.js';
import { ALL_CHARS, PHRASES, PASSAGES, CHAR_TIERS } from '../src/data/pinyin.js';
import { generateQuestions, generateReviewQuestions, isPunct,
         LEVELS, LEVEL_MAP, defaultCountFor, annotatePassage } from '../src/core/questions.js';
import { scoreExam, gradeOf, SCORE_CONFIG } from '../src/core/score.js';

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) { fail++; console.log('  ✗ ' + msg); }
};

console.log('【1】音节拆分正确性 — 抽样核对小鹤官方键位');
const expect = {
  // 拼音: 期望编码（小鹤：每个音节恒 2 键；zh→V、ch→I、sh→U 各占一键）
  'zhang': 'VH',  'chun': 'IY',   'shuang': 'UL',
  'xian': 'XM',   'an': 'AJ',     'lv': 'LV',
  'xue': 'XT',    'que': 'QT',    'yong': 'YS',
  'jun': 'JY',    'nv': 'NV',     'er': 'ER',
  'guang': 'GL',  'xiong': 'XS',  'ri': 'RI',
  'zeng': 'ZG',   'wang': 'WH',   'yu': 'YU',
  'yun': 'YY',    'ying': 'YK',   'o': 'OO',
  'ei': 'EW',     'weng': 'WG',   'nve': 'NT',
  // zh/ch/sh 专项：声母只占一键，第二键是韵母键
  'zhi': 'VI',    'chi': 'II',    'shi': 'UI',
  'zhu': 'VU',    'chu': 'IU',    'shu': 'UU',
  'zhui': 'VV',   'zheng': 'VG',  'zhong': 'VS',
  'chang': 'IH',  'sheng': 'UG',  'shuo': 'UO'
};
for (const [py, code] of Object.entries(expect)) {
  const s = splitSyllable(py)[0];
  ok(s && s.code === code, `${py} 期望 ${code}，实际 ${s ? s.code : '无解'}`);
}
console.log(`  抽样 ${Object.keys(expect).length} 个音节，错误 ${fail} 个`);

console.log('【2】全量题库可拆分性');
let badChar = [];
for (const [ch, py] of Object.entries(ALL_CHARS)) {
  if (!splitSyllable(py).length) badChar.push(`${ch}:${py}`);
}
ok(badChar.length === 0, `无法拆分的单字: ${badChar.slice(0, 10).join(' ')}`);
console.log(`  单字 ${Object.keys(ALL_CHARS).length} 个，全部可拆分`);

let badPhrase = [];
for (const p of PHRASES) {
  if (p.w.length !== p.p.length) badPhrase.push(`${p.w}(字数不符)`);
  p.p.forEach((py, i) => {
    if (!splitSyllable(py).length) badPhrase.push(`${p.w}[${i}]=${py}`);
  });
}
ok(badPhrase.length === 0, `词组问题: ${badPhrase.join(' ')}`);
console.log(`  词组 ${PHRASES.length} 个，全部可拆分`);

console.log('【2b】题量下限与唯一性');
ok(Object.keys(ALL_CHARS).length >= 900, `单字应 ≥900，实际 ${Object.keys(ALL_CHARS).length}`);
ok(PHRASES.length >= 1000, `词组应 ≥1000，实际 ${PHRASES.length}`);
ok(PASSAGES.length >= 100, `短文应 ≥100，实际 ${PASSAGES.length}`);
console.log(`  单字 ${Object.keys(ALL_CHARS).length} / 词组 ${PHRASES.length} / 短文 ${PASSAGES.length}`);

console.log('【2c】词组语料覆盖闭合性（词组里的每个字都要能单独练到）');
{
  const charSet = new Set(Object.keys(ALL_CHARS));

  const inPhrase = new Set();
  for (const p of PHRASES) for (const c of p.w) if (!charSet.has(c)) inPhrase.add(c);
  ok(inPhrase.size === 0,
    `词组中有 ${inPhrase.size} 个字不在单字表（不该只在词组里出现）: ${[...inPhrase].join(' ')}`);

  console.log(`  词组 ${PHRASES.length} 个的每个字都在单字表内（共 ${CHAR_TIERS.length} 档）`);
}

const dupChars = [];
{
  const owner = new Map();
  for (const t of CHAR_TIERS) {
    for (const ch of Object.keys(t.data)) {
      if (owner.has(ch)) dupChars.push(`${ch}(档${owner.get(ch)}↔档${t.id})`);
      else owner.set(ch, t.id);
    }
  }
}
ok(dupChars.length === 0, `单字跨档重复 ${dupChars.length} 个: ${dupChars.slice(0, 8).join(' ')}`);

const dupPhrase = [];
{
  const seen = new Set();
  for (const p of PHRASES) {
    if (seen.has(p.w)) dupPhrase.push(p.w);
    seen.add(p.w);
  }
}
ok(dupPhrase.length === 0, `词组重复: ${dupPhrase.join(' ')}`);

const dupPassage = [];
{
  const seen = new Set();
  for (const p of PASSAGES) {
    if (seen.has(p.t)) dupPassage.push(p.t.slice(0, 10));
    seen.add(p.t);
  }
}
ok(dupPassage.length === 0, `短文重复: ${dupPassage.join(' ')}`);
console.log(`  单字 / 词组 / 短文均无重复`);

console.log('【2d】短文语料 100% 有拼音');
{
  let missSet = new Set();
  for (const p of PASSAGES) {
    for (const ch of Array.from(p.t)) {
      if (!/[\u4e00-\u9fa5]/.test(ch)) continue;
      const py = ALL_CHARS[ch];
      if (!py || !splitSyllable(py).length) missSet.add(ch);
    }
  }
  const miss = [...missSet];
  ok(miss.length === 0, `短文未收录字 ${miss.length} 个: ${miss.join('')}`);
  const han = PASSAGES.reduce((n, p) => n + Array.from(p.t).filter(c => /[\u4e00-\u9fa5]/.test(c)).length, 0);
  console.log(`  短文共 ${han} 个汉字，全部可标注拼音`);
}

console.log('【3】键位表完整性');
const km = getKeymapData();
ok(km.length === 26, `键位数应为 26，实际 ${km.length}`);
const unused = km.filter(k => !k.used).map(k => k.key);
ok(unused.length === 0, `未使用键: ${unused.join(' ')}（双拼应覆盖全 26 键）`);
console.log(`  26 键全部参与，无空键`);

console.log('【4】zh/ch/sh 各占一键（不是三键）');
for (const [sm, py, code] of [['zh', 'zhang', 'VH'], ['ch', 'chun', 'IY'], ['sh', 'shen', 'UF']]) {
  const s = splitSyllable(py)[0];
  ok(s && s.keys.length === 2, `${py} 应为 2 键，实际 ${s ? s.keys.length : 0}`);
  ok(s && s.code === code, `${py} 期望 ${code}，实际 ${s ? s.code : '-'}`);
}
// 所有音节恒为 2 键 —— 这是小鹤的核心特性，必须全量守住
{
  const bad = [];
  for (const [ch, py] of Object.entries(ALL_CHARS)) {
    const s = splitSyllable(py)[0];
    if (!s) continue;
    if (s.keys.length !== 2) bad.push(`${ch}:${py}→${s.code}(${s.keys.length}键)`);
  }
  for (const p of PHRASES) p.p.forEach(py => {
    const s = splitSyllable(py)[0];
    if (s && s.keys.length !== 2) bad.push(`${py}→${s.code}(${s.keys.length}键)`);
  });
  ok(bad.length === 0, `存在非 2 键音节 ${bad.length} 个: ${bad.slice(0, 8).join(' ')}`);
  console.log(`  全量题库音节均为 2 键（zh/ch/sh 也只占一键）`);
}

console.log('【4b】L1 声母专项题：zh/ch/sh 必须是单键');
{
  /* 回归：曾把 zh/ch/sh 的 L1 答案写成 VH / IH / UH（多一个 H），
     理由是误以为「zh 要按 z 和 h 两下」。实际上小鹤里 zh/ch/sh 各占一键，
     H 是韵母 ang 的键，和声母无关。这个 bug 会逼用户多按一个键。

     makeKeymapQuestion 未导出且带随机性，因此通过公开接口 generateQuestions
     大批量出题，再对**每一道声母题**断言「答案恒为单键」。抽 2000 题足以
     覆盖全部 23 个声母（含 zh/ch/sh），漏测概率可忽略。 */
  const EXPECT_SHENGMU_KEY = { zh: 'V', ch: 'I', sh: 'U' };
  const seen = new Set();
  const bad = [];
  let shengmuCount = 0;

  for (let i = 0; i < 2000; i++) {
    const qs = generateQuestions({ mode: 'keymap', count: 5 });
    for (const q of qs) {
      if (q.role !== 'sheng') continue;
      shengmuCount++;
      seen.add(q.promptText);
      if (!Array.isArray(q.answerKeys) || q.answerKeys.length !== 1) {
        bad.push(`${q.promptText} → ${JSON.stringify(q.answerKeys)}`);
        continue;
      }
      // 答案必须等于方案表给出的键
      const want = SHENGMU_TO_KEYS[q.promptText];
      if (want && q.answerKeys[0] !== String(want[0]).toUpperCase()) {
        bad.push(`${q.promptText} 期望 ${want[0]} 实际 ${q.answerKeys[0]}`);
      }
      // 文案里不许再出现「需要按 2 个键」这种误导说法
      if (/2\s*个键|两个键|两键/.test(String(q.promptSub) + String(q.explain))) {
        bad.push(`${q.promptText} 文案仍称需按两键：${q.promptSub}`);
      }
    }
  }

  ok(shengmuCount > 0, `抽样中出现了声母题（${shengmuCount} 道）`);
  ok(bad.length === 0, `声母题恒为单键且与方案表一致（异常 ${bad.length}：${bad.slice(0, 5).join('；')}）`);

  // zh / ch / sh 三个特例必须被覆盖到，且分别是 V / I / U
  for (const [sm, key] of Object.entries(EXPECT_SHENGMU_KEY)) {
    ok(seen.has(sm), `抽样覆盖了声母 ${sm}`);
  }
  // 直接用方案表复核（不依赖抽样）
  for (const [sm, key] of Object.entries(EXPECT_SHENGMU_KEY)) {
    const keys = SHENGMU_TO_KEYS[sm] || [];
    ok(keys.length === 1 && keys[0] === key,
      `方案表中 ${sm} 恰为单键 ${key}（实际 ${JSON.stringify(keys)}）`);
  }
  console.log(`  抽样 ${shengmuCount} 道声母题，答案全为单键且与方案表一致`);
}

console.log('【4c】零声母：数据结构统一 + 恒为 2 键');
{
  /* ① 数据结构一致性：buildSyllables 产出的音节对象顶层 zero 字段
        必须与 split.zero 完全一致（曾经顶层根本没这个字段，
        导致 engine 里读 syl.zero 的分支成了永远走不到的死代码）。
     ② 行为一致性：零声母**也是 2 键**（首字母 + 韵母键），
        与 README 的 an → AJ / a → AA / ang → AH 完全对齐。 */
  const ZERO_SAMPLES = ['an', 'a', 'ang', 'en', 'ei', 'er', 'ou', 'ai', 'ao', 'e', 'o'];
  const mismatched = [];
  const notTwoKeys = [];

  for (const py of ZERO_SAMPLES) {
    const s = buildSyllables([py])[0];
    if (s.zero !== s.split.zero) mismatched.push(`${py}: 顶层 ${s.zero} ≠ split ${s.split.zero}`);
    if (s.split.keys.length !== 2) notTwoKeys.push(`${py} → ${s.split.code}(${s.split.keys.length}键)`);
  }
  ok(mismatched.length === 0, `零声母样本顶层 zero 与 split.zero 一致（不一致 ${mismatched.length}：${mismatched.join('；')}）`);
  ok(notTwoKeys.length === 0, `零声母样本恒为 2 键（异常 ${notTwoKeys.length}：${notTwoKeys.join('；')}）`);

  // 全量题库：凡是零声母音节，必须都是 2 键
  const badAll = [];
  for (const [ch, py] of Object.entries(ALL_CHARS)) {
    const s = buildSyllables([py])[0];
    if (!s || !s.split) continue;
    if (s.split.zero && s.split.keys.length !== 2) badAll.push(`${ch}:${py}→${s.split.code}`);
    if (s.zero !== s.split.zero) badAll.push(`${ch}:${py} zero 字段不一致`);
  }
  ok(badAll.length === 0, `全量题库零声母音节均为 2 键且字段一致（异常 ${badAll.length}：${badAll.slice(0, 5).join(' ')}）`);

  // 几个点名核对（与 README 对照表一致）
  const README_CASES = { an: 'AJ', a: 'AA', ang: 'AH' };
  for (const [py, code] of Object.entries(README_CASES)) {
    const s = buildSyllables([py])[0];
    ok(s.split.code === code, `${py} → ${code}（实际 ${s.split.code}）`);
  }
  console.log(`  零声母样本 ${ZERO_SAMPLES.length} 个全部 2 键，全量题库字段与键数一致`);
}

console.log('【5】多候选拆分容错（xian: 声母方案 + 零声母方案）');
const multi = buildSyllables(['xian'])[0];
ok(multi.candidates.length >= 1, `xian 应有候选方案`);
console.log(`  xian 候选: ${multi.candidates.map(c => c.text).join('  |  ')}`);

console.log('【6】逐键校验');
const syl = buildSyllables(['zhang'])[0];
ok(isKeyCorrect(syl, 0, 'v') === true, 'zhang 第 1 键应为 v');
ok(isKeyCorrect(syl, 1, 'h') === true, 'zhang 第 2 键应为 h（ang 的键）');
ok(isKeyCorrect(syl, 0, 'z') === false, 'zhang 第 1 键不是 z（zh 映射到 V）');
ok(isKeyCorrect(syl, 1, 'x') === false, 'zhang 第 2 键 x 应判错');
ok(isKeyCorrect(syl, 0, 'V') === true, '大写 V 应被接受');
console.log(`  zhang 两键 V/H 校验通过`);

console.log('【7】全部模式题目生成');
for (const mode of ['keymap', 'sheng', 'yun', 'split', 'char', 'phrase', 'passage', 'exam']) {
  const qs = generateQuestions({ mode, count: mode === 'passage' ? 2 : 10 });
  ok(qs.length > 0, `${mode} 生成 0 题`);
  qs.forEach(q => {
    ok(!!q.id, `${mode} 题目缺少 id`);
    ok(Array.isArray(q.chars) || q.kind === 'key' || q.kind === 'part',
      `${mode} 题目结构异常`);
    if (q.kind === 'word') {
      q.chars.forEach(c => ok(c.syl && c.syl.candidates.length > 0, `${q.text} 中「${c.ch}」无拆分`));
    }
    // 声母 / 韵母专项：必须恰好 1 个答案键，且与完整拆分中对应成分一致
    if (q.kind === 'part') {
      ok(q.answerKeys.length === 1, `${mode} 专项题应只要求 1 键`);
      ok(q.part === mode, `${mode} 专项题 part 字段应为 ${mode}`);
      const step = q.fullSplit.steps.find(st => st.role === (mode === 'sheng' ? 'sheng' : 'yun'));
      ok(!!step && step.key === q.answerKeys[0],
        `${q.pinyin} 的${mode}答案 ${q.answerKeys[0]} 与拆分步骤不符`);
    }
  });
  console.log(`  ${mode}: ${qs.length} 题`);
}

console.log('【7b】单字练习覆盖全部字表档位');
{
  const qs = generateQuestions({ mode: 'char', count: 60 });
  const names = new Set(qs.map(q => q.meta && q.meta.tierName).filter(Boolean));
  ok(names.size === CHAR_TIERS.length,
    `单字题应覆盖 ${CHAR_TIERS.length} 个档位，实际 ${names.size} 个: ${[...names].join('/')}`);
  ok(qs.every(q => q.chars.every(c => c.syl && c.syl.candidates.length)),
    '单字题存在无法拆分的字');
  console.log(`  60 题覆盖 ${names.size} 档：${[...names].join(' / ')}`);
}

console.log('【8】标点判定');
ok(isPunct('，') === true, '中文逗号应判为标点');
ok(isPunct('。') === true, '句号应判为标点');
ok(isPunct('「') === true, '引号应判为标点');
ok(isPunct('你') === false, '汉字不应判为标点');
ok(isPunct('a') === false, '字母不应判为标点');
console.log(`  标点判定正确`);

console.log('【9】复习题生成');
const review = generateReviewQuestions([
  { char: '春', pinyin: 'chun', weight: 5 },
  { word: '工作', pinyin: ['gong', 'zuo'], weight: 3 },
  { char: '不存在', pinyin: 'xyz', weight: 99 }
], 5);
ok(review.length > 0, '复习题生成失败');
ok(!review.some(q => q.text.includes('不存在')), '异常数据应被过滤');
console.log(`  生成 ${review.length} 道复习题，异常数据已过滤`);

console.log('【10】边界情况');
ok(splitSyllable('') .length === 0, '空串应返回空');
ok(splitSyllable(null).length === 0, 'null 应返回空');
ok(splitSyllable(undefined).length === 0, 'undefined 应返回空');
ok(splitSyllable('xyz').length === 0, '非法拼音应返回空');
ok(splitSyllable('123').length === 0, '数字应返回空');
ok(splitSyllable('zh').length === 0, '纯声母应返回空');
ok(splitSyllable('ZHANG').length === 1, '大写输入应正常处理');
const empty = generateQuestions({ mode: 'char', count: 0 });
ok(empty.length === 20, `count=0 应回退到 20 题，实际 ${empty.length}`);
const neg = generateQuestions({ mode: 'char', count: -5 });
ok(neg.length === 20, `负数 count 应回退，实际 ${neg.length}`);
console.log(`  空值 / 非法输入 / 异常参数均被安全处理`);

/* ============================================================
   测验模式（exam）：出题与评分
   ============================================================ */
console.log('【11】能力测验出题');

{
  const LEVEL_EXAM = LEVELS.find(l => l.id === 'exam');
  ok(!!LEVEL_EXAM, 'LEVELS 中定义了 exam 模式');
  ok(LEVEL_MAP.exam && LEVEL_MAP.exam.name === '能力测验', 'LEVEL_MAP.exam 名称正确');
  ok(defaultCountFor('exam') === 50, `exam 默认题量应为 50，实际 ${defaultCountFor('exam')}`);

  // 混合比例：3:4:3，且在任何题量下都稳定
  for (const n of [10, 20, 50, 100]) {
    const qs = generateQuestions({ mode: 'exam', count: n });
    ok(qs.length === n, `exam count=${n} 应生成 ${n} 题，实际 ${qs.length}`);

    const tally = { split: 0, char: 0, phrase: 0 };
    for (const q of qs) {
      const part = q.meta && q.meta.examPart;
      ok(!!part, `exam 每题都应带 meta.examPart（题 ${q.id} 缺失）`);
      if (part in tally) tally[part] += 1;
    }
    // 三类都必须出现（题量 ≥10 时）
    ok(tally.split > 0 && tally.char > 0 && tally.phrase > 0,
      `count=${n} 三类题型齐全（拆分 ${tally.split} / 单字 ${tally.char} / 词组 ${tally.phrase}）`);
    // 单字占比应最高（权重 4）
    ok(tally.char >= tally.split && tally.char >= tally.phrase,
      `count=${n} 单字题占比最高（${tally.char}）`);
  }

  // 测验的每道题都必须可作答（没有无法拆分的字符）
  const examQs = generateQuestions({ mode: 'exam', count: 60 });
  let unsplittable = 0;
  let noChars = 0;
  for (const q of examQs) {
    if (!Array.isArray(q.chars) || !q.chars.length) { noChars += 1; continue; }
    for (const c of q.chars) {
      if (c.punct) continue;
      if (!c.syl) unsplittable += 1;
    }
  }
  ok(noChars === 0, `exam 无空题（实际 ${noChars} 题无字符）`);
  ok(unsplittable === 0, `exam 全部字符可拆分（实际 ${unsplittable} 个不可拆分）`);

  // 单字题只能来自高频 / 常用档（保证「会打，只是看速度」）
  const charParts = examQs.filter(q => q.meta && q.meta.examPart === 'char');
  const badTier = charParts.filter(q => {
    const n = q.meta && q.meta.tierName;
    return n && n !== '高频字' && n !== '常用字';
  });
  ok(badTier.length === 0,
    `exam 单字题只取高频/常用档（越档 ${badTier.length} 题：${badTier.slice(0, 3).map(q => q.meta.tierName).join('/')}）`);

  console.log(`  混合比例稳定在 3:4:3（拆分/单字/词组），60 题中单字 ${charParts.length} 题`);
}

console.log('【12】测验评分算法');

{
  // 满分场景：全对、够快、打完、样本充足
  const perfect = scoreExam({
    independentAccuracy: 100, accuracy: 100, speed: 150,
    correctChars: 120, wrongChars: 0, totalChars: 120, hintedChars: 0,
    doneQuestions: 50, questionCount: 50, completed: true, durationSec: 60
  });
  ok(perfect.score >= 99, `全对且超速应接近满分，实际 ${perfect.score}`);
  ok(perfect.grade === '卓越', `全对应评「卓越」，实际「${perfect.grade}」`);
  ok(perfect.valid === true, '无提示时分数应标记为有效');

  // 及格线场景：正确率 80、速度达标、打完
  const decent = scoreExam({
    independentAccuracy: 80, accuracy: 80, speed: 80,
    correctChars: 96, wrongChars: 24, totalChars: 120, hintedChars: 0,
    doneQuestions: 50, questionCount: 50, completed: true, durationSec: 90
  });
  ok(decent.score > 55 && decent.score < 95,
    `中等表现应落在及格到良好之间，实际 ${decent.score}`);

  // 全错：分数必须以正确率为主，跌到很低
  const allWrong = scoreExam({
    independentAccuracy: 0, accuracy: 0, speed: 200,
    correctChars: 0, wrongChars: 50, totalChars: 50, hintedChars: 0,
    doneQuestions: 50, questionCount: 50, completed: true, durationSec: 30
  });
  ok(allWrong.score < 20, `全错即使超快也应低分，实际 ${allWrong.score}`);

  /* 关键不变式：打得快不能弥补打错。
     同样正确率下，速度更快分应更高；但「正确率 0 + 超快」必须低于
     「正确率 100 + 很慢」。否则用户会狂按乱打刷分。 */
  const slowPerfect = scoreExam({
    independentAccuracy: 100, accuracy: 100, speed: 30,
    correctChars: 50, wrongChars: 0, totalChars: 50, hintedChars: 0,
    doneQuestions: 50, questionCount: 50, completed: true, durationSec: 100
  });
  ok(slowPerfect.score > allWrong.score,
    `准确优先：慢而全对（${slowPerfect.score}）必须高于快而全错（${allWrong.score}）`);

  // 提示介入 → 分数标记无效，并给出警告
  const hinted = scoreExam({
    independentAccuracy: 100, accuracy: 100, speed: 100,
    correctChars: 50, wrongChars: 0, totalChars: 50, hintedChars: 5,
    doneQuestions: 50, questionCount: 50, completed: true, durationSec: 40
  });
  ok(hinted.valid === false, '有提示介入时分数应标记为无效');
  ok(hinted.warnings.some(w => /提示/.test(w)), '有提示时应给出警告文案');

  // 样本量不足不形成有效成绩
  const tiny = scoreExam({
    independentAccuracy: 100, accuracy: 100, speed: 120,
    correctChars: 3, wrongChars: 0, totalChars: 3, hintedChars: 0,
    doneQuestions: 3, questionCount: 50, completed: false, durationSec: 5
  });
  ok(tiny.score < 95, `只打 3 个字不该拿高分，实际 ${tiny.score}`);
  ok(tiny.warnings.some(w => /样本/.test(w)), '样本不足时应给出警告');

  // 未完成按完成度扣分：同样的正确率与速度，打完 > 打一半
  const base = {
    independentAccuracy: 95, accuracy: 95, speed: 90,
    correctChars: 100, wrongChars: 5, totalChars: 105, hintedChars: 0,
    durationSec: 80, completed: true
  };
  const full = scoreExam(Object.assign({}, base, { doneQuestions: 50, questionCount: 50 }));
  const half = scoreExam(Object.assign({}, base, { doneQuestions: 25, questionCount: 50, completed: false }));
  ok(full.score > half.score,
    `完成度应影响分数：打完（${full.score}）> 一半（${half.score}）`);

  // 不限题量（questionCount=0）不应被判为未完成
  const noLimit = scoreExam({
    independentAccuracy: 100, accuracy: 100, speed: 120,
    correctChars: 40, wrongChars: 0, totalChars: 40, hintedChars: 0,
    doneQuestions: 20, questionCount: 0, completed: false, durationSec: 30
  });
  ok(noLimit.parts.completion === 100,
    `questionCount=0（不限量）完成度应为 100%，实际 ${noLimit.parts.completion}%`);

  // 健壮性：空参数 / null / 垃圾值都不能抛
  let threw = false;
  try {
    const r1 = scoreExam(null);
    const r2 = scoreExam({});
    const r3 = scoreExam({ independentAccuracy: NaN, speed: 'abc', totalChars: undefined });
    ok(r1.score >= 0 && r1.score <= 100, 'scoreExam(null) 返回合法分数');
    ok(r2.score >= 0 && r2.score <= 100, 'scoreExam({}) 返回合法分数');
    ok(r3.score >= 0 && r3.score <= 100, 'scoreExam(垃圾值) 返回合法分数');
  } catch (e) {
    threw = true;
  }
  ok(!threw, 'scoreExam 对异常输入不应抛错');

  // 分数恒在 0–100
  const samples = [];
  for (let acc = 0; acc <= 100; acc += 10) {
    for (let spd = 0; spd <= 200; spd += 40) {
      samples.push(scoreExam({
        independentAccuracy: acc, accuracy: acc, speed: spd,
        correctChars: 100, wrongChars: 20, totalChars: 120, hintedChars: 0,
        doneQuestions: 50, questionCount: 50, completed: true, durationSec: 90
      }).score);
    }
  }
  ok(samples.every(s => s >= 0 && s <= 100),
    `所有组合的分数都在 0–100（${samples.length} 组）`);

  // 单调性：正确率越高分越高
  const accScores = [40, 60, 80, 95, 100].map(acc => scoreExam({
    independentAccuracy: acc, accuracy: acc, speed: 80,
    correctChars: 100, wrongChars: 10, totalChars: 110, hintedChars: 0,
    doneQuestions: 50, questionCount: 50, completed: true, durationSec: 80
  }).score);
  let monotone = true;
  for (let i = 1; i < accScores.length; i++) if (accScores[i] < accScores[i - 1]) monotone = false;
  ok(monotone, `分数随正确率单调递增（${accScores.join(' → ')}）`);

  // 等级映射
  ok(gradeOf(100).badge === 'S', '100 分应为 S 级');
  ok(gradeOf(85).badge === 'A', '85 分应为 A 级');
  ok(gradeOf(70).badge === 'B', '70 分应为 B 级');
  ok(gradeOf(55).badge === 'C', '55 分应为 C 级');
  ok(gradeOf(0).badge === 'E', '0 分应为 E 级');

  console.log(`  满分 ${perfect.score}(${perfect.grade}) / 中等 ${decent.score}(${decent.grade}) / 全错 ${allWrong.score}(${allWrong.grade})`);
}

// 实际短文注音链路必须使用语境读音，未知字符不影响后续索引。
for (const [text, expected] of [
  ['重复', 'chong fu'], ['重新', 'chong xin'], ['成长', 'cheng zhang'],
  ['长出来', 'zhang chu lai'], ['外行', 'wai hang'], ['觉得', 'jue de']
]) {
  const actual = annotatePassage(text).map(c => c.pinyin).join(' ');
  ok(actual === expected, `${text} 应读 ${expected}，实际 ${actual}`);
}
const mixed = annotatePassage('🌱重新，成长');
ok(mixed.length === 6 && mixed[1].pinyin === 'chong' && mixed[5].pinyin === 'zhang',
  '未知扩展字符与标点不会错位短文注音');
for (const tier of CHAR_TIERS) {
  const qs = generateQuestions({ mode: 'char', count: 60, charTier: String(tier.id) });
  ok(qs.every(q => q.chars.every(c => Object.hasOwn(tier.data, c.ch))),
    `固定难度 ${tier.id} 的所有题目来自所选字表`);
}
const emptyExam = scoreExam({});
ok(emptyExam.score === 0 && !emptyExam.valid && emptyExam.badge === '',
  '空测验不再获得及格分或等级');
const shortExam = scoreExam({ totalChars: 3, correctChars: 3, independentAccuracy: 100,
  speed: 120, doneQuestions: 3, questionCount: 3 });
ok(!shortExam.valid && shortExam.badge === '', '小样本即使全部答对也不评等级');

console.log('【新增】候选耗尽、近期避重与语境读音');
{
  // 用最不利随机数检验：不能靠多次随机重试碰巧避免重复。
  const random = Math.random;
  Math.random = () => 0;
  try {
    const phrases = generateQuestions({ mode: 'phrase', count: 500 });
    ok(new Set(phrases.map(q => q.text)).size === 500, '500 个词组候选未耗尽时不重复');
    const passages = generateQuestions({ mode: 'passage', count: PASSAGES.length });
    ok(new Set(passages.map(q => q.text)).size === PASSAGES.length, '100 段短文覆盖全库后才重复');
    const context = {};
    const recent = PHRASES.slice(0, 100).map(p => p.w);
    const first = generateQuestions({ mode: 'phrase', count: 20, context, recent });
    const second = generateQuestions({ mode: 'phrase', count: 20, context, recent });
    ok([...first, ...second].every(q => !recent.includes(q.text)), '续题优先避开近期已见词组');
    ok(new Set([...first, ...second].map(q => q.text)).size === 40, '去重集合跨批次保留');
    const tier = CHAR_TIERS[0];
    const n = Object.keys(tier.data).length;
    const chars = generateQuestions({ mode: 'char', count: n + 2, charTier: '1' });
    ok(new Set(chars.slice(0, n).map(q => q.text)).size === n && chars.length === n + 2,
      '固定档位完整覆盖后仍可继续出题');
    const splits = generateQuestions({ mode: 'split', count: 500 });
    const poolSize = new Set([...Object.values(CHAR_TIERS[0].data), ...Object.values(CHAR_TIERS[1].data)]).size;
    ok(new Set(splits.slice(0, poolSize).map(q => q.text)).size === poolSize, '拆分音节用完前不重复');
  } finally { Math.random = random; }
  for (const p of PASSAGES) {
    if (p.p) ok(p.p.length === Array.from(p.t).length, '逐字短文读音与标点对齐');
    ok(annotatePassage(p.t, p.p).every(c => c.punct || (c.pinyin && c.syl)), '全部短文可逐字输入');
  }
  for (const [word, reading] of Object.entries({ 重做:'chong zuo', 银行:'yin hang', 行走:'xing zou',
    长大:'zhang da', 调查:'diao cha', 调整:'tiao zheng', 薄饼:'bao bing', 角色:'jue se',
    便宜:'pian yi', 睡觉:'shui jiao', 着凉:'zhao liang', 盛饭:'cheng fan', 择菜:'zhai cai' })) {
    ok(PHRASES.find(p => p.w === word)?.p.join(' ') === reading, `${word} 使用语境读音`);
  }
}

console.log('\n' + (fail === 0
  ? '✅ 全部自检通过'
  : `❌ 共 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
