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
 *
 * 为什么要拆出 L2a / L2b：
 *   直接练完整音节时，一次按错只能告诉你「这个编码错了」，
 *   无法区分是「声母 zh 的键没记住」还是「韵母 ang 和 ang/eng 混了」。
 *   把声母、韵母单独抽出来问，诊断粒度立刻从「音节」细到「成分」，
 *   错在哪一半一目了然。
 *
 * 题库规模（见 data/pinyin.js）：1107 单字（7 档） / 299 词组 / 45 短文，
 * 合计 1451 个可出题项，另加键位图、声母/韵母专项、音节拆分四个无限题库。
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
  KEY_TO_SHENGMU, KEY_TO_YUNMU
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
function makeKeymapQuestion() {
  const rng = Math.random;
  // 优先出韵母（韵母是双拼记忆的主体）
  const useYun = rng() < 0.78;

  const yunKeys = Object.keys(KEY_TO_YUNMU).filter(k => KEY_TO_YUNMU[k].length);
  const smKeys  = Object.keys(KEY_TO_SHENGMU).filter(k => KEY_TO_SHENGMU[k].length);

  if (useYun && yunKeys.length) {
    const key = yunKeys[Math.floor(rng() * yunKeys.length)];
    const yunmus = KEY_TO_YUNMU[key];
    const yun = yunmus[Math.floor(rng() * yunmus.length)];
    return {
      id: nextId(),
      level: 1,
      kind: 'key',
      label: '韵母键',
      promptText: yun,
      promptSub: '按出该韵母所在的键',
      answerKeys: [key],
      role: 'yun',
      explain: `韵母 ${yun} 在小鹤双拼中位于 ${key} 键`,
      keyDetail: { key, yunmu: yun, shengmu: null }
    };
  }

  if (smKeys.length) {
    const key = smKeys[Math.floor(rng() * smKeys.length)];
    const sms = KEY_TO_SHENGMU[key];
    const sm = sms[Math.floor(rng() * sms.length)];
    // zh/ch/sh 需要按两个键
    const seq = (sm === 'zh') ? ['V', 'H'] : (sm === 'ch' ? ['I', 'H'] : (sm === 'sh' ? ['U', 'H'] : [key]));
    return {
      id: nextId(),
      level: 1,
      kind: 'key',
      label: '声母键',
      promptText: sm,
      promptSub: seq.length > 1 ? '该声母需要按 2 个键' : '按出该声母所在的键',
      answerKeys: seq,
      role: 'sheng',
      explain: seq.length > 1
        ? `声母 ${sm} 需要按下 ${seq[0]} 与 ${seq[1]} 两个键`
        : `声母 ${sm} 位于 ${key} 键`,
      keyDetail: { key, shengmu: sm, yunmu: null }
    };
  }

  // 极端兜底：键表为空
  return {
    id: nextId(), level: 1, kind: 'key', label: '韵母键',
    promptText: 'a', promptSub: '按出该韵母所在的键',
    answerKeys: ['A'], role: 'yun',
    explain: '韵母 a 位于 A 键',
    keyDetail: { key: 'A', yunmu: 'a', shengmu: null }
  };
}

/**
 * L2：拆分训练 —— 单音节，按完整编码
 */
function makeSplitQuestion(usedPinyin) {
  // 从常用字中抽音节，避免重复
  const pool = Object.values(CHARS_TIER1).concat(Object.values(CHARS_TIER2));
  let tries = 0;
  let py = '';
  while (tries < 40) {
    py = pool[Math.floor(Math.random() * pool.length)];
    if (!usedPinyin.has(py) && splitSyllable(py).length) break;
    tries++;
  }
  if (!py || !splitSyllable(py).length) py = 'zhang';

  usedPinyin.add(py);
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
  const pool = Object.values(CHARS_TIER1).concat(Object.values(CHARS_TIER2));
  let py = '';
  let picked = null;

  for (let i = 0; i < 60; i++) {
    const cand = pool[Math.floor(Math.random() * pool.length)];
    if (!cand || usedPinyin.has(`${part}:${cand}`)) continue;
    const sp = primarySplit(cand);
    if (!sp) continue;
    // 零声母音节没有独立声母键，练「只听声母」时应跳过
    if (wantSheng && sp.zero) continue;
    picked = sp;
    py = cand;
    break;
  }

  // 极端兜底：字表里挑不到（不该发生）时用手写样例
  if (!picked || !py) {
    py = wantSheng ? 'zhang' : 'zhuang';
    picked = primarySplit(py);
  }
  if (!picked) {
    return makeFallbackCharQuestion();
  }

  usedPinyin.add(`${part}:${py}`);

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
  let entries = Object.entries(t).filter(([, py]) => splitSyllable(py).length);
  if (!entries.length) entries = Object.entries(ALL_CHARS).filter(([, py]) => splitSyllable(py).length);
  if (!entries.length) return makeFallbackCharQuestion();

  // 尽量避开最近出过的字
  let pick = null;
  for (let i = 0; i < 30; i++) {
    const cand = entries[Math.floor(Math.random() * entries.length)];
    if (!usedSet.has(cand[0])) { pick = cand; break; }
  }
  if (!pick) pick = entries[Math.floor(Math.random() * entries.length)];

  usedSet.add(pick[0]);
  return buildWordQuestion(pick[0], [pick[1]], 3, { tierName: tierName(tier) });
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
function makePhraseQuestion(usedSet) {
  const pool = PHRASES.filter(p => p.w.length === p.p.length &&
    p.p.every(py => splitSyllable(py).length));
  if (!pool.length) return makeFallbackCharQuestion();

  let pick = null;
  for (let i = 0; i < 30; i++) {
    const cand = pool[Math.floor(Math.random() * pool.length)];
    if (!usedSet.has(cand.w)) { pick = cand; break; }
  }
  if (!pick) pick = pool[Math.floor(Math.random() * pool.length)];
  usedSet.add(pick.w);

  return buildWordQuestion(pick.w, pick.p, 4);
}

/**
 * L5：短文跟打
 * 一题 = 一段短文，按标点/长度切成可逐字推进的序列。
 * 每个汉字都带拼音，从而可以逐字校验双拼编码。
 */
function makePassageQuestion(diff, usedSet) {
  let pool = PASSAGES.filter(p => !diff || p.d <= diff);
  if (!pool.length) pool = PASSAGES.slice();
  if (!pool.length) {
    // 兜底：用高频词组拼一段
    return buildWordQuestion('双拼练习', ['shuang', 'pin', 'lian', 'xi'], 5);
  }
  let pick = null;
  for (let i = 0; i < 20; i++) {
    const cand = pool[Math.floor(Math.random() * pool.length)];
    if (!usedSet.has(cand.t)) { pick = cand; break; }
  }
  if (!pick) pick = pool[Math.floor(Math.random() * pool.length)];
  usedSet.add(pick.t);

  const text = pick.t;
  const raw = annotatePassage(text);
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
 * 为短文逐字标注：标点 / 拼音 / 音节拆分
 * 未收录拼音的字标记为 unknown，练习时会被自动跳过而不会导致卡死。
 */
function annotatePassage(text) {
  const arr = Array.from(String(text || ''));
  return arr.map(ch => {
    if (isPunct(ch)) {
      return { ch, pinyin: '', syl: null, punct: true, unknown: false };
    }
    const py = ALL_CHARS[ch] || '';
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
 *   - count:     题目数量（0 = 不限，默认 20）
 *   - adaptive:  是否启用自适应难度（根据正确率升降）
 * @returns {Array<Question>}
 */
export function generateQuestions(opts = {}) {
  const mode = opts.mode || 'char';
  const count = Math.max(0, Number(opts.count) || 0);
  const target = count > 0 ? count : 20;
  const used = new Set();
  const usedPinyin = new Set();
  const out = [];

  try {
    for (let i = 0; i < target; i++) {
      let q = null;
      switch (mode) {
        case 'keymap':
          q = makeKeymapQuestion();
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
          // 渐进：把题量沿字表分层由易到难铺开（当前 7 档）。
          // 用「档位数」动态均分，避免以后增减档位时曲线写死而失真。
          const total = Math.max(1, CHAR_TIERS.length);
          const ratio = i / Math.max(1, target - 1);
          const tier = Math.min(total, 1 + Math.floor(ratio * total));
          q = makeCharQuestion(tier, used);
          break;
        }
        case 'phrase':
          q = makePhraseQuestion(used);
          break;
        case 'passage': {
          // 短文按难度循环出，题量语义为「段落数」
          const diff = Math.min(3, 1 + Math.floor(i / Math.max(1, target / 3)));
          q = makePassageQuestion(diff, used);
          break;
        }
        default:
          q = makeCharQuestion(1, used);
      }
      if (q) out.push(q);
    }
  } catch (err) {
    console.error('[questions] 生成题目时出错，返回已生成部分', err);
  }

  // 极端兜底：保证至少有一题
  if (!out.length) out.push(makeFallbackCharQuestion());
  return out;
}

/**
 * 题量受限时（count 为空）也保证短文至少有 1 段
 */
export function defaultCountFor(mode) {
  if (mode === 'passage') return 3;
  if (mode === 'keymap') return 40;
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

  // 按权重降序
  list.sort((a, b) => (b.weight || 0) - (a.weight || 0));

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

  // 不足时用高频字补齐
  let guard = 0;
  while (out.length < Math.min(limit, 10) && guard < 60) {
    guard++;
    const q = makeCharQuestion(1 + Math.floor(Math.random() * 2), used);
    out.push(q);
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
