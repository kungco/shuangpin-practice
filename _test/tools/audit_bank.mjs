/* 题库体检：找出真实的数据缺口，用数据说话，不靠印象。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const D = await import(new URL('../../src/data/pinyin.js', import.meta.url).href);
const S = await import(new URL('../../src/core/scheme.js', import.meta.url).href);

const {
  CHARS_TIER1, CHARS_TIER2, CHARS_TIER3, CHARS_TIER4, CHARS_TIER5, CHARS_TIER6, CHARS_TIER7,
  ALL_CHARS, CHAR_TIERS, PHRASES, PASSAGES
} = D;

const tiers = [CHARS_TIER1, CHARS_TIER2, CHARS_TIER3, CHARS_TIER4, CHARS_TIER5, CHARS_TIER6, CHARS_TIER7];
const names = ['高频字', '常用字', '中频字', '进阶字', '书面字', '扩充字', '词组配套'];

console.log('══════ 一、规模统计 ══════');
let total = 0;
tiers.forEach((t, i) => {
  const n = Object.keys(t).length;
  total += n;
  console.log(`  ${names[i]}(T${i + 1}): ${n} 字`);
});
console.log(`  ── 单字合计: ${total}`);
console.log(`  ALL_CHARS 去重后: ${Object.keys(ALL_CHARS).length}`);
if (total !== Object.keys(ALL_CHARS).length) {
  console.log(`  ⚠️ 跨档位重复字: ${total - Object.keys(ALL_CHARS).length} 个`);
}
console.log(`  词组: ${PHRASES.length}`);
console.log(`  短文: ${PASSAGES.length}`);

console.log('\n══════ 二、拼音映射质量 ══════');
const allEntries = Object.entries(ALL_CHARS);
const badPinyin = allEntries.filter(([c, p]) => !/^[a-z]+$/.test(p));
console.log(`  非纯小写字母拼音: ${badPinyin.length} 个`);
badPinyin.slice(0, 10).forEach(([c, p]) => console.log(`    「${c}」→ "${p}"`));

// 用方案引擎验证每个字的拼音能否拆分成合法音节
let unparseable = [];
let zeroInitial = 0;
for (const [c, p] of allEntries) {
  try {
    const syls = S.buildSyllables([p]);
    if (!syls || !syls[0] || !syls[0].candidates || !syls[0].candidates.length) {
      unparseable.push([c, p]);
    } else {
      const sp = syls[0].candidates[0];
      if (sp.zero) zeroInitial++;
      // 校验键数
      if (!sp.steps || sp.steps.length < 1 || sp.steps.length > 2) {
        unparseable.push([c, p + ' (键数 ' + (sp.steps ? sp.steps.length : '?') + ')']);
      }
    }
  } catch (e) {
    unparseable.push([c, p + ' (' + e.message + ')']);
  }
}
console.log(`  无法解析的音节: ${unparseable.length} 个`);
unparseable.slice(0, 15).forEach(([c, p]) => console.log(`    「${c}」→ ${p}`));
console.log(`  零声母音节: ${zeroInitial} 个`);

console.log('\n══════ 三、韵母覆盖率（关键！找缺口）══════');
// 统计每个韵母键被多少字覆盖
const yunmuKeyCount = {};
const shengmuKeyCount = {};
for (const [c, p] of allEntries) {
  try {
    const syls = S.buildSyllables([p]);
    const sp = syls[0].candidates[0];
    for (const st of sp.steps) {
      if (st.role === 'yun') {
        const k = (st.key || '').toUpperCase();
        yunmuKeyCount[k] = (yunmuKeyCount[k] || 0) + 1;
      }
      if (st.role === 'sheng') {
        const k = (st.key || '').toUpperCase();
        shengmuKeyCount[k] = (shengmuKeyCount[k] || 0) + 1;
      }
    }
  } catch (e) {}
}
const allKeys = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
console.log('  韵母键覆盖（0 = 完全没练到，是缺口）:');
const missingYun = [];
allKeys.forEach(k => {
  const n = yunmuKeyCount[k] || 0;
  if (n === 0) missingYun.push(k);
  console.log(`    ${k}: ${String(n).padStart(3)}${n === 0 ? '  ← 缺' : ''}`);
});
console.log(`  韵母键空缺: ${missingYun.join(', ') || '（无）'}`);

console.log('\n══════ 四、词组的字覆盖 ══════');
// 词组里出现的字是否都在单字表里
const charSet = new Set(Object.keys(ALL_CHARS));
const missingInPhrase = new Set();
for (const ph of PHRASES) {
  for (const ch of ph.w) {
    if (!charSet.has(ch)) missingInPhrase.add(ch);
  }
}
console.log(`  词组中不在单字表的字: ${missingInPhrase.size} 个`);
console.log(`    ${[...missingInPhrase].join(' ') || '（无）'}`);

console.log('\n══════ 五、短文的字覆盖 ══════');
const missingInPassage = new Set();
let passageChars = 0;
for (const ps of PASSAGES) {
  for (const ch of ps.t) {
    if (/[\u4e00-\u9fa5]/.test(ch)) {
      passageChars++;
      if (!charSet.has(ch)) missingInPassage.add(ch);
    }
  }
}
console.log(`  短文汉字总数: ${passageChars}`);
console.log(`  短文中不在单字表的字: ${missingInPassage.size} 个`);
console.log(`    ${[...missingInPassage].join(' ') || '（无）'}`);

console.log('\n══════ 六、词组拼音与汉字数量一致性 ══════');
let mismatch = [];
for (const ph of PHRASES) {
  if ([...ph.w].length !== ph.p.length) {
    mismatch.push(`${ph.w}(${[...ph.w].length}字) vs ${ph.p.length}拼音`);
  }
}
console.log(`  数量不一致的词组: ${mismatch.length}`);
mismatch.slice(0, 10).forEach(m => console.log(`    ${m}`));

console.log('\n══════ 七、词组/短文难度分布 ══════');
const phraseLens = {};
for (const ph of PHRASES) {
  const n = [...ph.w].length;
  phraseLens[n] = (phraseLens[n] || 0) + 1;
}
console.log('  词组按字数: ' + Object.entries(phraseLens).map(([k, v]) => `${k}字×${v}`).join('  '));
const dDist = {};
for (const ps of PASSAGES) dDist[ps.d] = (dDist[ps.d] || 0) + 1;
console.log('  短文按难度: ' + Object.entries(dDist).map(([k, v]) => `d${k}×${v}`).join('  '));

console.log('\n══════ 八、拼音重复度 ══════');
const pinyinCount = {};
for (const [c, p] of allEntries) pinyinCount[p] = (pinyinCount[p] || 0) + 1;
const dupPinyin = Object.entries(pinyinCount).filter(([, n]) => n >= 8)
  .sort((a, b) => b[1] - a[1]);
console.log(`  出现 ≥8 次的拼音（同音字扎堆）: ${dupPinyin.length} 组`);
dupPinyin.slice(0, 12).forEach(([p, n]) => console.log(`    ${p}: ${n} 字`));
