/**
 * 文本分词 / 注音
 * ------------------------------------------------------------
 * 用于给「短文跟打」的段落标注拼音。
 *
 * 难点：中文没有词边界，长句可能包含未收录的字。
 * 策略：
 *   - 用动态规划在「已收录字的连续区间」上求最优切分
 *   - 单个未收录字直接作为单字块
 *   - 已收录区间内，若无法切分为全部可查的多字词，
 *     则拆成单字（单字总能查到拼音）
 * 保证结果：每个块都能查到拼音，绝不出现「有字无音」。
 */

import { ALL_CHARS, PHRASES } from '../data/pinyin.js';

/* 词表索引：只保留「全部字都已收录」的词 */
const wordIndex = {};
(function buildWordIndex() {
  for (const p of PHRASES) {
    const chars = Array.from(p.w);
    if (chars.length !== p.p.length) continue;
    if (!chars.every(ch => ALL_CHARS[ch])) continue;
    if (!p.p.every(py => typeof py === 'string' && py)) continue;
    if (!wordIndex[p.w]) wordIndex[p.w] = p.p.slice();
  }
})();

// 经校对的语境读音。单字表只能提供默认音，不能用于判定多音字词。
const CONTEXT_READINGS = {
  '重复': ['chong', 'fu'], '重新': ['chong', 'xin'],
  '成长': ['cheng', 'zhang'], '长出来': ['zhang', 'chu', 'lai'],
  '长大': ['zhang', 'da'], '外行': ['wai', 'hang'],
  '散去': ['san', 'qu'], '散开': ['san', 'kai'],
  '散在': ['san', 'zai'], '得起': ['de', 'qi'],
  '觉得': ['jue', 'de'], '舍不得': ['she', 'bu', 'de']
};
Object.assign(wordIndex, CONTEXT_READINGS);

/** 单字拼音查询 */
export function pinyinOf(ch) {
  return ALL_CHARS[ch] || '';
}

/** 该字是否有拼音数据 */
export function hasPinyin(ch) {
  return !!ALL_CHARS[ch];
}

/** 单字成本略高，用于倾向于选择更长的词 */
const SINGLE_COST = 3;
/** 多字词的折扣系数，鼓励成词 */
const WORD_BONUS = 0.4;

/**
 * 把一段文本切成带拼音的块序列
 * @param {string} text
 * @returns {Array<{text:string, chars:Array<{ch:string,pinyin:string}>}>}
 */
export function tokenizeWithPinyin(text) {
  const out = [];
  const str = typeof text === 'string' ? text : '';
  const units = Array.from(str);
  const n = units.length;
  let i = 0;

  while (i < n) {
    const ch = units[i];
    if (!ALL_CHARS[ch]) {
      // 未收录：单字块（拼音留空，练习时跳过）
      out.push({ text: ch, chars: [{ ch, pinyin: '' }] });
      i += 1;
      continue;
    }

    // 在 [i, j) 上找最优切分，j 为「连续可查区间」的右边界
    let j = i;
    while (j < n && ALL_CHARS[units[j]]) j += 1;

    const seg = units.slice(i, j).join('');
    const pieces = bestSplit(seg);
    for (const p of pieces) {
      out.push(p);
    }
    i = j;
  }

  return out;
}

/**
 * 对「全部字都可查」的片段求最优切分（动态规划）
 * 目标是让每个块尽量查到拼音，且优先成词。
 */
function bestSplit(seg) {
  const n = seg.length;
  if (!n) return [];

  // best[k] = 切分前 k 个字的最小成本；choice[k] = 使成本最小的最后一块长度
  const best = new Array(n + 1).fill(Infinity);
  const choice = new Array(n + 1).fill(1);
  best[0] = 0;

  for (let k = 1; k <= n; k++) {
    // 只回溯最多 6 个字，覆盖所有四字成语 + 少量冗余
    for (let len = Math.min(6, k); len >= 1; len--) {
      const start = k - len;
      const sub = seg.slice(start, k);
      let cost;

      if (len === 1) {
        cost = SINGLE_COST;
      } else if (wordIndex[sub]) {
        // 词越长，单位字成本越低
        cost = len * (1 - WORD_BONUS);
      } else {
        continue; // 非词的多字组合不允许作为一块
      }

      const total = best[start] + cost;
      if (total < best[k]) {
        best[k] = total;
        choice[k] = len;
      }
    }

    // 兜底：极端情况下（例如上游数据异常）允许单字
    if (!Number.isFinite(best[k])) {
      best[k] = best[k - 1] + SINGLE_COST;
      choice[k] = 1;
    }
  }

  // 回溯
  const pieces = [];
  let k = n;
  let guard = 0;
  while (k > 0 && guard < 10000) {
    guard++;
    const len = choice[k] || 1;
    const start = k - len;
    const sub = seg.slice(start, k);
    const chars = Array.from(sub);

    let pinyins;
    if (len === 1) {
      pinyins = [ALL_CHARS[sub]];
    } else {
      pinyins = wordIndex[sub] ? wordIndex[sub].slice() : chars.map(c => ALL_CHARS[c]);
    }

    pieces.unshift({
      text: sub,
      chars: chars.map((c, idx) => ({ ch: c, pinyin: pinyins[idx] || '' }))
    });
    k = start;
  }
  return pieces;
}

/**
 * 把一段文本展开为逐字序列（附拼音），并标记标点
 * @param {string} text
 * @param {Function} isPunctFn 标点判定函数
 * @returns {Array<{ch, pinyin, punct}>}
 */
export function annotateText(text, isPunctFn) {
  const fn = typeof isPunctFn === 'function' ? isPunctFn : () => false;
  const result = [];
  const str = typeof text === 'string' ? text : '';

  for (const ch of Array.from(str)) {
    if (fn(ch)) {
      result.push({ ch, pinyin: '', punct: true });
    } else {
      result.push({ ch, pinyin: pinyinOf(ch) || '', punct: false });
    }
  }
  return result;
}

/** 统计一段文本中可打字的汉字数 */
export function countableChars(text, isPunctFn) {
  return annotateText(text, isPunctFn).filter(c => !c.punct).length;
}

/** 词表规模（便于自检） */
export function wordCount() {
  return Object.keys(wordIndex).length;
}
