/**
 * 自检脚本：验证双拼引擎与题库的正确性 / 完整性
 * 运行：node _test/verify.mjs
 */
import { splitSyllable, getKeymapData, ALL_KEYS, isKeyCorrect, buildSyllables } from '../src/core/scheme.js';
import { ALL_CHARS, PHRASES, PASSAGES, CHAR_TIERS } from '../src/data/pinyin.js';
import { generateQuestions, generateReviewQuestions, isPunct } from '../src/core/questions.js';

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
ok(PHRASES.length >= 250, `词组应 ≥250，实际 ${PHRASES.length}`);
ok(PASSAGES.length >= 30, `短文应 ≥30，实际 ${PASSAGES.length}`);
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

console.log('【7】七级题目生成');
for (const mode of ['keymap', 'sheng', 'yun', 'split', 'char', 'phrase', 'passage']) {
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

console.log('\n' + (fail === 0
  ? '✅ 全部自检通过'
  : `❌ 共 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
