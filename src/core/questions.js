/**
 * 题库与分级系统
 * ------------------------------------------------------------
 * 七级难度，由易到难：
 *   L1  键位熟悉     — 单键识别：看到韵母/声母，按对应键
 *   L2a 听声母       — 只按「声母」那一键（诊断：声母键记不牢）
 *   L2b 听韵母       — 只按「韵母」那一键（诊断：韵母键混淆）
 *   L2  声韵拆分     — 完整音节：看到拼音，按出两键编码
 *   L3  单字练习     — 高频单字 → 双拼编码（沿 CHAR_TIERS 由易到难铺开）
 *   L4  词组练习     — 常用词组（2–4 字）
 *   L5  短文跟打     — 成段文字含标点
 *   TEST 能力测验    — 无提示综合测验：拆分 / 单字 / 词组混合，完成后给分数
 *
 * 关于 TEST（能力测验）：
 *   它不是「第 8 个难度」，而是一种**考核**形态 —— 强制关闭提示与求助，
 *   用混合题型一次性检验真实掌握程度，由 score.js 折算成 0–100 分。
 *   题目按「拆分 → 单字 → 词组」的固定比例铺开，避免纯考某一类，
 *   也避免单字占比过高导致分数被字频命中率左右。
 *
 * 为什么要拆出 L2a / L2b：
 *   直接练完整音节时，一次按错只能告诉你「这个编码错了」，
 *   无法区分是「声母 zh 的键没记住」还是「韵母 ang 和 ang/eng 混了」。
 *   把声母、韵母单独抽出来问，诊断粒度立刻从「音节」细到「成分」，
 *   错在哪一半一目了然。
 *
 * 题库规模（见 data/pinyin.js）：1787 单字（7 档） / 2247 词组 / 100 短文，
 * 合计 4134 个可出题项，另加键位图、声母/韵母专项、音节拆分四个无限题库。
 *
 * 每道题的统一结构（Question）：
 *   {
 *     id, level, kind, label,
 *     chars:   [{ ch, pinyin, syl }],   // 待输入的字符序列
 *     text:    '整个题目的展示文本',
 *     meta:    { tierName, source }
 *   }
 * 其中 syl 由 scheme.buildSyllables 产出，含全部候选拆分。
 */

import {
  ALL_CHARS, CHAR_TIERS, PHRASES, PASSAGES,
  CHARS_TIER1, CHARS_TIER2, CHARS_TIER3, CHARS_TIER4
} from '../data/pinyin.js';
import {
  buildSyllables, splitSyllable, primarySplit, ALL_KEYS, USED_KEYS,
  KEY_TO_SHENGMU, KEY_TO_YUNMU, SHENGMU_TO_KEYS
} from './scheme.js';
import { tokenizeWithPinyin, hasPinyin } from './tokenizer.js';

/* ============================================================
   模式定义
   ============================================================ */

export const LEVELS = [
  {
    id: 'keymap',
    level: 1,
    name: '键位熟悉',
    badge: 'L1',
    desc: '逐个认识韵母键。看到韵母，按下它所在的键。',
    tip: '只需按 1 个键'
  },
  {
    id: 'sheng',
    level: 2,
    name: '只听声母',
    badge: 'L2a',
    desc: '只按声母那一键，不要求韵母。用来确认声母键是否记牢。',
    tip: 'zh/ch/sh 各占一键（V/I/U）'
  },
  {
    id: 'yun',
    level: 2,
    name: '只听韵母',
    badge: 'L2b',
    desc: '只按韵母那一键，不要求声母。专门攻克容易混淆的韵母。',
    tip: 'ang→H、eng→G、ong→S'
  },
  {
    id: 'split',
    level: 3,
    name: '声韵拆分',
    badge: 'L2',
    desc: '练习把音节拆成声母 + 韵母，并按出完整编码。',
    tip: '每个音节恒为 2 键'
  },
  {
    id: 'char',
    level: 4,
    name: '单字打字',
    badge: 'L3',
    desc: '给一个常用字，按出它的完整双拼编码。',
    tip: '按常用度由易到难'
  },
  {
    id: 'phrase',
    level: 5,
    name: '词组打字',
    badge: 'L4',
    desc: '常用词语与成语，连续输入多个音节。',
    tip: '练流畅度'
  },
  {
    id: 'passage',
    level: 6,
    name: '短文跟打',
    badge: 'L5',
    desc: '成段文字跟打，标点会自动跳过。',
    tip: '最接近真实输入'
  },
  {
    id: 'exam',
    level: 7,
    name: '能力测验',
    badge: 'TEST',
    desc: '全程无提示、无求助，独立完成。测完给 0–100 的综合分。',
    tip: '50 题 · 拆分 / 单字 / 词组混合'
  }
];

export const LEVEL_MAP = {};
LEVELS.forEach(l => { LEVEL_MAP[l.id] = l; });

/* ============================================================
   工具函数
   ============================================================ */

/** 稳定伪随机（mulberry32），保证同一 seed 出同一套题 */
function makeRng(seed) {
  let a = seed >>> 0;
  if (a === 0) a = 0x9e3779b9;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates 洗牌（原地） */
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 取对象的键数组 */
function keysOf(obj) {
  return Object.keys(obj || {});
}

/* ============================================================
   各类题目构造
   ============================================================ */

let uid = 0;
function nextId() { uid += 1; return `q${Date.now().toString(36)}${uid}`; }

/**
 * L1：键位熟悉 —— 单键作答
 * 题目形态：给出一个韵母或声母，要求按对应键。
 */
export const KEY_COMPONENTS = [
  ...Object.entries(KEY_TO_YUNMU).flatMap(([key, parts]) => parts.map(part => ({ key, part, role: 'yun' }))),
  ...Object.entries(KEY_TO_SHENGMU).flatMap(([key, parts]) => parts.map(part => ({ key, part, role: 'sheng' })))
];
function makeKeymapQuestion(ctx, weights = {}) {
  const used = ctx.usedKeys ||= new Set();
  used.draws = (used.draws || 0) + 1;
  const weak = used.cycles > 0 && used.draws % 5 === 0
    ? KEY_COMPONENTS.filter(x => (Number(weights[x.key.toLowerCase()]) || 0) > 0 && `${x.role}:${x.part}` !== used.last) : [];
  let pick;
  if (weak.length) {
    const total = weak.reduce((sum, x) => sum + Math.min(20, Number(weights[x.key.toLowerCase()])), 0);
    let ticket = Math.random() * total;
    pick = weak.find(x => (ticket -= Math.min(20, Number(weights[x.key.toLowerCase()]))) < 0) || weak[0];
    used.last = `${pick.role}:${pick.part}`;
  } else pick = pickUnused(KEY_COMPONENTS, used, x => `${x.role}:${x.part}`, weights);
  const { key, part, role } = pick;
  const seq = role === 'sheng' ? (SHENGMU_TO_KEYS[part] || [key]) : [key];
  return {
    id: nextId(), level: 1, kind: 'key', label: role === 'yun' ? '韵母键' : '声母键',
    promptText: part, promptSub: `按出该${role === 'yun' ? '韵母' : '声母'}所在的键`,
    answerKeys: seq.map(k => String(k).toUpperCase()), role,
    explain: `${part} 位于 ${seq.join('')} 键`,
    keyDetail: { key, shengmu: role === 'sheng' ? part : null, yunmu: role === 'yun' ? part : null }
  };
}

/**
 * L2：拆分训练 —— 单音节，按完整编码
 */
// 先随机抽取尚未出过的候选；候选耗尽后才开始下一轮。
// used 可跨批次复用，并以近期实际见过的内容初始化。
// One shuffled queue per stable pool and used set: O(n) per cycle, O(1) per draw.
const drawQueues = new WeakMap();
function pickUnused(pool, used, key = x => x, weights = null) {
  let queues = drawQueues.get(used);
  if (!queues) { queues = new Map(); drawQueues.set(used, queues); }
  let queue = queues.get(pool);
  if (!queue?.length) {
    queue = pool.filter(x => !used.has(key(x)));
    if (!queue.length) {
      for (const x of pool) used.delete(key(x));
      queue = pool.slice();
    }
    // After the first complete key cycle, weak keys get earlier positions,
    // while every component is still covered before another cycle starts.
    if (weights && used.cycles > 0) {
      queue = queue.map(x => ({ x, rank: -Math.log(Math.max(1e-9, Math.random())) /
        (1 + Math.min(20, Number(weights[x.key?.toLowerCase()]) || 0)) }))
        .sort((a, b) => b.rank - a.rank).map(x => x.x);
    } else {
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
    }
    if (queue.length > 1 && key(queue[queue.length - 1]) === used.last)
      [queue[0], queue[queue.length - 1]] = [queue[queue.length - 1], queue[0]];
    queues.set(pool, queue);
  }
  let pick = queue.pop();
  // A shared set can also be populated by another pool (exam or tier changes).
  while (pick !== undefined && used.has(key(pick))) pick = queue.pop();
  if (pick === undefined && pool.length) return pickUnused(pool, used, key, weights);
  if (pick !== undefined) {
    used.add(key(pick)); used.last = key(pick);
    if (weights && !queue.length) used.cycles = (used.cycles || 0) + 1;
  }
  return pick;
}
const candidatePools = new Map();
function cachedPool(name, build) {
  if (!candidatePools.has(name)) candidatePools.set(name, build());
  return candidatePools.get(name);
}

function makeSplitQuestion(usedPinyin) {
  // 从常用字中抽音节，避免重复
  const pool = cachedPool('split', () => [...new Set(Object.values(CHARS_TIER1).concat(Object.values(CHARS_TIER2)))].filter(py => splitSyllable(py).length));
  const py = pickUnused(pool, usedPinyin) || 'zhang';
  return buildSyllableQuestion(py, 2);
}

/** 由拼音构造 L2 题目 */
function buildSyllableQuestion(py, level) {
  const syl = buildSyllables([py])[0];
  return {
    id: nextId(),
    level,
    kind: 'syllable',
    label: '音节拆分',
    promptText: py,
    promptSub: '按出完整双拼编码',
    chars: [{ ch: '', pinyin: py, syl }],
    text: py
  };
}

/**
 * L2a / L2b：只听声母 / 只听韵母
 *
 * 只要求按出音节中的**某一个成分**所对应的键：
 *   part='sheng' → 只要声母那一键（zh→V、ang 的部分不管）
 *   part='yun'   → 只要韵母那一键
 * 零声母音节（an / en / ou…）没有声母，因此 part='sheng' 时跳过。
 *
 * 引擎侧对应 kind:'part'，会按 part 自动定位到 split.steps 里
 * role 匹配的那一步，只校验那一步。
 *
 * @param {'sheng'|'yun'} part
 * @param {Set<string>} usedPinyin 已出过的拼音（避免连出同一音节）
 */
function makePartQuestion(part, usedPinyin) {
  const wantSheng = part !== 'yun';

  // 优先从高频字里抽，保证练习的是真正会遇到的音节
  const pool = cachedPool(`part:${part}`, () => [...new Set(Object.values(CHARS_TIER1).concat(Object.values(CHARS_TIER2)))].filter(py => {
    const sp = primarySplit(py);
    return sp && (!wantSheng || !sp.zero);
  }));
  const py = pickUnused(pool, usedPinyin, py => `${part}:${py}`);
  const picked = primarySplit(py);
  if (!picked) return makeFallbackCharQuestion();

  const stepIndex = wantSheng ? 0 : (picked.zero ? 1 : 1);
  const step = picked.steps[stepIndex] || picked.steps[0] || {};
  const cname = wantSheng ? (picked.sheng || '') : (picked.yun || '');

  return {
    id: nextId(),
    level: 2,
    kind: 'part',
    part: wantSheng ? 'sheng' : 'yun',
    label: wantSheng ? '只听声母' : '只听韵母',
    promptText: cname,
    promptSub: wantSheng ? '按出声母所在的键' : '按出韵母所在的键',
    answerKeys: [String(step.key || '').toUpperCase()],
    // 完整拆分带上，UI 才能在答完后展示整音节的对照
    fullSplit: picked,
    pinyin: py,
    chars: [{ ch: '', pinyin: py, syl: buildSyllables([py])[0] }],
    text: `${cname}  ←  ${py}`,
    explain: wantSheng
      ? `声母「${cname}」在 ${String(step.key || '').toUpperCase()} 键（整个音节 ${py} → ${picked.code}）`
      : `韵母「${cname}」在 ${String(step.key || '').toUpperCase()} 键（整个音节 ${py} → ${picked.code}）`
  };
}

/**
 * L3：单字打字
 * @param {number} tier 1–4，字表分层
 */
function makeCharQuestion(tier, usedSet) {
  const tiers = CHAR_TIERS.slice().sort((a, b) => a.id - b.id).map(x => x.data);
  const t = tiers[Math.max(0, Math.min(tiers.length - 1, (tier || 1) - 1))];
  let entries = cachedPool(`char:${tier}`, () => Object.entries(t).filter(([, py]) => splitSyllable(py).length));
  if (!entries.length) entries = Object.entries(ALL_CHARS).filter(([, py]) => splitSyllable(py).length);
  if (!entries.length) return makeFallbackCharQuestion();

  const pick = pickUnused(entries, usedSet, x => x[0]);
  return buildWordQuestion(pick[0], [pick[1]], 3, { tier, tierName: tierName(tier) });
}

function tierName(t) {
  const found = CHAR_TIERS.find(x => x.id === t);
  return found ? found.name : '常用字';
}

function makeFallbackCharQuestion() {
  return buildWordQuestion('的', ['de'], 3, { tierName: '高频字' });
}

/** 由汉字串 + 拼音数组构造题目（L3/L4 通用） */
function buildWordQuestion(word, pinyins, level, meta = {}) {
  const chars = Array.from(word);
  const syls = buildSyllables(pinyins, chars);
  return {
    id: nextId(),
    level,
    kind: 'word',
    label: level === 3 ? '单字' : '词组',
    promptText: word,
    promptSub: pinyins.join(' '),
    chars: chars.map((ch, i) => ({ ch, pinyin: pinyins[i] || '', syl: syls[i] })),
    text: word,
    meta
  };
}

/**
 * L4：词组打字
 */
export function phrasePool(opts = {}) {
  const category = ['daily', 'office', 'travel', 'idiom'].includes(opts.phraseCategory) ? opts.phraseCategory : 'all';
  const length = [2, 3, 4].includes(Number(opts.phraseLength)) ? Number(opts.phraseLength) : 0;
  return cachedPool(`phrase:${category}:${length}`, () => PHRASES.filter(p =>
    (category === 'all' || p.c === category) && (!length || Array.from(p.w).length === length) &&
    Array.from(p.w).length === p.p.length && p.p.every(py => splitSyllable(py).length)));
}
function makePhraseQuestion(usedSet, opts = {}) {
  const pick = pickUnused(phrasePool(opts), usedSet, x => x.w);
  return pick ? buildWordQuestion(pick.w, pick.p, 4, { category: pick.c }) : null;
}

/**
 * L5：短文跟打
 * 一题 = 一段短文，按标点/长度切成可逐字推进的序列。
 * 每个汉字都带拼音，从而可以逐字校验双拼编码。
 */
function makePassageQuestion(diff, usedSet) {
  let pool = PASSAGES.filter(p => !diff || p.d <= diff);
  // 简单短文已练完时，引入尚未见过的较难段落，再考虑重复。
  if (pool.length && pool.every(p => usedSet.has(p.t))) {
    const unseen = PASSAGES.filter(p => !usedSet.has(p.t));
    if (unseen.length) pool = unseen;
  }
  if (!pool.length) pool = PASSAGES.slice();
  if (!pool.length) {
    // 兜底：用高频词组拼一段
    return buildWordQuestion('双拼练习', ['shuang', 'pin', 'lian', 'xi'], 5);
  }
  const pick = pickUnused(pool, usedSet, x => x.t);

  const text = pick.t;
  const raw = annotatePassage(text, pick.p);
  return {
    id: nextId(),
    level: 5,
    kind: 'passage',
    label: '短文跟打',
    promptText: text,
    promptSub: '标点自动跳过',
    text,
    chars: raw,
    meta: {
      difficulty: pick.d,
      hanCount: raw.filter(c => !c.punct).length,
      unknownCount: raw.filter(c => !c.punct && !c.syl).length
    }
  };
}

/**
 * TEST：能力测验 —— 非难度档，而是考核形态
 *
 * 出题策略：按「声韵拆分 : 单字 : 词组 = 3 : 4 : 3」的比例铺开，
 *   ① 只考高频 / 常用字（档 1–2），避免生僻字把分数拉成运气；
 *   ② 词组题让相邻两个字组成常见词，检验真实连贯输入；
 *   ③ 拆分词与词组题在整卷里交错，防止连续同类型造成节奏惯性。
 *
 * 之所以不用「按 index 线性决定题型」，是因为那样在题量变化时
 * （用户可自选题数）比例会漂移。这里改成按比例算「配额」，
 * 再让三类轮流取，题量无论多少都保持同样的混合度。
 */
export const EXAM_MIX = { split: 3, char: 4, phrase: 3 };

function pickExamKind(i, target) {
  const keys = Object.keys(EXAM_MIX);
  const totalW = keys.reduce((s, k) => s + EXAM_MIX[k], 0);
  // 用「累积配额」判断第 i 题该出哪一类：等价于按比例轮流取，且对 target 不敏感
  const acc = [];
  let run = 0;
  for (const k of keys) { run += EXAM_MIX[k]; acc.push({ k, at: (run / totalW) * target }); }
  const pos = i + 0.5;
  for (const a of acc) if (pos <= a.at) return a.k;
  return keys[keys.length - 1];
}

function makeExamQuestion(i, target, ctx) {
  const kind = pickExamKind(i, target);

  if (kind === 'split') {
    const q = makeSplitQuestion(ctx.usedPinyin);
    if (q) { q.label = '拆分'; q.meta = Object.assign({}, q.meta, { examPart: 'split' }); }
    return q;
  }

  if (kind === 'phrase') {
    const q = makePhraseQuestion(ctx.usedPhrase);
    if (q) { q.meta = Object.assign({}, q.meta, { examPart: 'phrase' }); }
    return q;
  }

  // 单字：只用档 1–2（高频 / 常用），保证「都会但看快不快」
  const tier = i % 2 === 0 ? 1 : 2;
  const q = makeCharQuestion(tier, ctx.usedChar);
  if (q) { q.meta = Object.assign({}, q.meta, { examPart: 'char' }); }
  return q;
}

/**
 * 为短文逐字标注：标点 / 拼音 / 音节拆分
 * 未收录拼音的字标记为 unknown，练习时会被自动跳过而不会导致卡死。
 */
export function annotatePassage(text, vettedReadings = null) {
  const arr = Array.from(String(text || ''));
  const readings = Array.isArray(vettedReadings) && vettedReadings.length === arr.length
    ? [] : tokenizeWithPinyin(text).flatMap(block => block.chars);
  return arr.map((ch, i) => {
    if (isPunct(ch)) {
      return { ch, pinyin: '', syl: null, punct: true, unknown: false };
    }
    const py = Array.isArray(vettedReadings) && vettedReadings.length === arr.length
      ? vettedReadings[i] : (readings[i] ? readings[i].pinyin : '');
    if (!py || !splitSyllable(py).length) {
      // 未收录或无法拆分：标记为 unknown，引擎会跳过
      return { ch, pinyin: py, syl: null, punct: false, unknown: true };
    }
    const syl = buildSyllables([py], [ch])[0];
    return { ch, pinyin: py, syl, punct: false, unknown: false };
  });
}

/* ============================================================
   标点判定
   ============================================================ */

const PUNCT_SET = new Set(Array.from('，。、；：？！“”‘’「」『』（）《》〈〉—…·～,.;:?!"\'()[]<>-~` '));

export function isPunct(ch) {
  if (!ch) return false;
  if (PUNCT_SET.has(ch)) return true;
  const code = ch.codePointAt(0);
  // 常见中文/英文标点区间
  if (code >= 0x3000 && code <= 0x303F) return true;   // CJK 符号
  if (code >= 0xFF00 && code <= 0xFFEF) return true;   // 全角字符
  if (code >= 0x2000 && code <= 0x206F) return true;   // 常用标点
  return false;
}

export { ALL_CHARS, PHRASES, PASSAGES, CHAR_TIERS };

/* ============================================================
   题目生成器（对外主入口）
   ============================================================ */

/**
 * 生成一套练习题
 * @param {object} opts
 *   - mode:      'keymap' | 'sheng' | 'yun' | 'split' | 'char' | 'phrase' | 'passage'
 *   - tier:      1–7（仅 char 模式有效，表示起始字表分层）
 *   - count:     当前批次题数（0 时返回 20 题；不限量由引擎持续获取批次）
 *   - adaptive:  是否启用自适应难度（根据正确率升降）
 * @returns {Array<Question>}
 */
export function generateQuestions(opts = {}) {
  const mode = opts.mode || 'char';
  const count = Math.max(0, Number(opts.count) || 0);
  const target = count > 0 ? count : 20;
  const ctx = opts.context || {};
  const recent = Array.isArray(opts.recent) ? opts.recent : [];
  const used = ctx.used ||= new Set(recent);
  const usedPinyin = ctx.usedPinyin ||= new Set(recent);
  const out = [];

  // 测验模式的「去重集合」按题型分开，否则三类题会互相挤占候选
  const examCtx = { usedChar: used, usedPhrase: (ctx.usedPhrase ||= new Set(recent)), usedPinyin };

  try {
    for (let i = 0; i < target; i++) {
      let q = null;
      switch (mode) {
        case 'keymap':
          q = makeKeymapQuestion(ctx, opts.keyWeights);
          break;
        case 'sheng':
          q = makePartQuestion('sheng', usedPinyin);
          break;
        case 'yun':
          q = makePartQuestion('yun', usedPinyin);
          break;
        case 'split':
          q = makeSplitQuestion(usedPinyin);
          break;
        case 'char': {
          // 自适应档位由练习表现决定，续题不会按批内位置重新升档。
          const total = Math.max(1, CHAR_TIERS.length);
          const fixedTier = Math.floor(Number(opts.charTier));
          const tier = fixedTier >= 1 && fixedTier <= total
            ? fixedTier : Math.max(1, Math.min(total, Number(opts.adaptiveTier) || 1));
          q = makeCharQuestion(tier, used);
          break;
        }
        case 'phrase':
          q = makePhraseQuestion(used, opts);
          break;
        case 'passage': {
          // 短文按难度循环出，题量语义为「段落数」
          const diff = Math.min(3, 1 + Math.floor(i / Math.max(1, target / 3)));
          q = makePassageQuestion(diff, used);
          break;
        }
        case 'exam':
          q = makeExamQuestion(i, target, examCtx);
          break;
        default:
          q = makeCharQuestion(1, used);
      }
      if (q) out.push(q);
    }
  } catch (err) {
    console.error('[questions] 生成题目时出错，返回已生成部分', err);
  }

  // 极端兜底：保证至少有一题
  if (!out.length && mode !== 'phrase') out.push(makeFallbackCharQuestion());
  return out;
}

/**
 * 题量受限时（count 为空）也保证短文至少有 1 段
 */
export function defaultCountFor(mode) {
  if (mode === 'passage') return 3;
  if (mode === 'keymap') return 40;
  if (mode === 'exam') return 50;      // 测验：题量固定偏大，样本才够可信
  return 20;
}

/**
 * 由「易错字词」生成强化复习题
 * @param {Array<{char?:string, word?:string, pinyin:string[]|string, weight:number}>} items
 * @param {number} limit
 */
export function generateReviewQuestions(items, limit = 20) {
  const out = [];
  const used = new Set();
  const list = Array.isArray(items) ? items.slice() : [];

  // ★ 不在这里按权重重排 —— 调用方传入的顺序就是**出题范围与优先级**。
  // 历史 bug：复习页「只练今天到期的 1 项」时，按钮把到期项排在最前传入，
  // 这里一按权重重排，低权重的到期项被沉底，配合截断后 20 道题
  // 可能全部变成未到期内容 —— 按钮承诺的范围被悄悄换掉。
  // 权重排序是调用方（storage.getWeakList）已经做过的事，这里保持原序。

  for (const it of list) {
    if (out.length >= limit) break;
    try {
      if (it.word && /\p{Script=Han}/u.test(it.word) && Array.from(it.word).length >= 2) {
        const pinyins = Array.isArray(it.pinyin) ? it.pinyin : [it.pinyin];
        if (pinyins.length !== Array.from(it.word).length) continue;
        if (!pinyins.every(py => py && splitSyllable(py).length)) continue;
        if (used.has(it.word)) continue;
        used.add(it.word);
        out.push(buildWordQuestion(it.word, pinyins, 4, { from: 'review' }));
      } else if (it.char && /\p{Script=Han}/u.test(it.char)) {
        const py = Array.isArray(it.pinyin) ? it.pinyin[0] : it.pinyin;
        if (!py || !splitSyllable(py).length) continue;
        if (used.has(it.char)) continue;
        used.add(it.char);
        out.push(buildWordQuestion(it.char, [py], 3, { from: 'review' }));
      }
    } catch (err) {
      console.warn('[review] 跳过一条异常题目', it, err);
    }
  }

  // 只有**一条都出不来**时才用高频字兜底，保证按钮永远有内容可练。
  // 不能「不足 10 就补」—— 那会把随机高频字掺进「只练到期项」的范围里，
  // 用户明确圈定的练习范围不该被悄悄稀释。
  if (out.length === 0) {
    let guard = 0;
    while (out.length < Math.min(limit, 10) && guard < 60) {
      guard++;
      const q = makeCharQuestion(1 + Math.floor(Math.random() * 2), used);
      out.push(q);
    }
  }
  return out;
}

/* ============================================================
   指定内容的题目（错题复习页「只练这道」用）
   ============================================================ */

export function questionFromCharChar(char, pinyin) {
  if (!char) return null;
  const py = pinyin || ALL_CHARS[char];
  if (!py || !splitSyllable(py).length) return null;
  return buildWordQuestion(char, [py], 3, { from: 'single' });
}

export function questionFromPhrase(word, pinyins) {
  if (!word || !Array.isArray(pinyins)) return null;
  const chars = Array.from(word);
  if (chars.length !== pinyins.length) return null;
  if (!pinyins.every(py => splitSyllable(py).length)) return null;
  return buildWordQuestion(word, pinyins, 4, { from: 'single' });
}
