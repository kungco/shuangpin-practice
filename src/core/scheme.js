/**
 * 双拼方案引擎
 * ------------------------------------------------------------
 * 负责：
 *   1. 方案定义（小鹤双拼）
 *   2. 反向索引：键位 → 可表示的声母 / 韵母集合
 *   3. 音节拆分：拼音 → { 声母, 韵母, 双拼编码, 拆解步骤 }
 *   4. 切分候选：一个音节可能有多种声韵切分，需全部列出用于校验
 *
 * 设计要点：
 *   - 使用「最长匹配」优先，但因为零声母/双字母声母可能产生歧义
 *     （如 "xian" → x+ian 或 xi+an），因此 splitSyllable 返回**候选数组**，
 *     逐键校验时只要用户输入匹配任一候选即算正确。
 */

import { SHENGMU_LIST, YUNMU_LIST, SHENGMU_SET, YUNMU_SET } from '../data/pinyin.js';

/* ============================================================
   方案定义
   ============================================================ */

/**
 * 小鹤双拼键位表
 * sheng: 该键可作为声母键时对应的声母（大写键位 → 声母）
 * yun:   该键可作为韵母键时对应的所有韵母（按展示优先级排序）
 */
const XIAOHE_LAYOUT = {
/* --- 第 1 行 --- */
  Q: { sheng: [],      yun: ['iu'] },
  W: { sheng: [],      yun: ['ei'] },
  E: { sheng: [],      yun: ['e'] },
  R: { sheng: [],      yun: ['uan', 'er'] },
  T: { sheng: [],      yun: ['ve', 'ue'] },
  Y: { sheng: [],      yun: ['un'] },
  U: { sheng: [],      yun: ['u'] },
  I: { sheng: [],      yun: ['i'] },
  O: { sheng: [],      yun: ['uo', 'o'] },
  P: { sheng: [],      yun: ['ie'] },

  A: { sheng: [],      yun: ['a'] },
  S: { sheng: [],      yun: ['ong', 'iong'] },
  D: { sheng: [],      yun: ['ai'] },
  F: { sheng: [],      yun: ['en'] },
  G: { sheng: [],      yun: ['eng'] },
  H: { sheng: [],      yun: ['ang'] },
  J: { sheng: [],      yun: ['an'] },
  K: { sheng: [],      yun: ['ing', 'uai'] },
  L: { sheng: [],      yun: ['iang', 'uang'] },

  Z: { sheng: [],      yun: ['ou'] },
  X: { sheng: [],      yun: ['ia', 'ua'] },
  C: { sheng: [],      yun: ['ao'] },
  V: { sheng: [],      yun: ['ui', 'v'] },
  B: { sheng: [],      yun: ['in'] },
  N: { sheng: [],      yun: ['iao'] },
  M: { sheng: [],      yun: ['ian'] }
};

/* 普通声母（除 zh/ch/sh 外）直接使用自身键位 */
const PLAIN_SHENGMU = [
  'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
  'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'
];

/**
 * 声母键位映射（小鹤双拼）
 *
 * 【重要】zh / ch / sh 各自只占 **一个键**：
 *   zh → V    ch → I    sh → U
 * 它们只是把「声母」这一个成分映射到 V/I/U，
 * **不会额外占用一个 H 键**。韵母仍然按自己的键位走。
 *
 * 例：zheng → zh + eng → V + G = **VG**（两键）
 *     zhang → zh + ang → V + H = **VH**（两键）
 *     shu   → sh + u   → U + U = **UU**（两键）
 *     zhui  → zh + ui  → V + V = **VV**（两键）
 *
 * 注意 H 在这里只是「韵母 ang 的键」，与声母无关：
 * zhang 的第二键 H 表示 ang，不是「zh 的第二键」。
 */
export const SHENGMU_KEY_SEQ = {
  zh: ['V'],
  ch: ['I'],
  sh: ['U']
};

/* 零声母规则：拼音以这些韵母开头时，双拼编码为「首字母 + 韵母键」 */
export const ZERO_INITIAL_YUNMU = [
  'a', 'o', 'e', 'ai', 'ei', 'ao', 'ou', 'an', 'en', 'ang', 'eng', 'er'
];

/* 零声母规则：拼音以这些韵母开头时，双拼编码为「首字母 + 韵母键」 */

/* ============================================================
   构建索引
   ============================================================ */

/** 声母 → 键位序列（大写字母数组） */
export const SHENGMU_TO_KEYS = {};
PLAIN_SHENGMU.forEach(sm => { SHENGMU_TO_KEYS[sm] = [sm.toUpperCase()]; });
Object.assign(SHENGMU_TO_KEYS, SHENGMU_KEY_SEQ);

/** 兼容旧接口：声母 → 主键位字母 */
export const SHENGMU_TO_KEY = {};
Object.entries(SHENGMU_TO_KEYS).forEach(([sm, keys]) => { SHENGMU_TO_KEY[sm] = keys[0]; });

/** 韵母 → 候选键位字母数组（大写） */
export const YUNMU_TO_KEYS = {};
Object.entries(XIAOHE_LAYOUT).forEach(([key, cfg]) => {
  cfg.yun.forEach(ym => {
    if (!YUNMU_TO_KEYS[ym]) YUNMU_TO_KEYS[ym] = [];
    if (!YUNMU_TO_KEYS[ym].includes(key)) YUNMU_TO_KEYS[ym].push(key);
  });
});

/** 键位 → 声母集合（用于键位图 / 键位熟悉模式） */
export const KEY_TO_SHENGMU = {};
Object.keys(XIAOHE_LAYOUT).forEach(k => KEY_TO_SHENGMU[k] = []);
Object.entries(SHENGMU_TO_KEYS).forEach(([sm, keys]) => {
  keys.forEach((k) => {
    if (!KEY_TO_SHENGMU[k]) return;
    if (!KEY_TO_SHENGMU[k].includes(sm)) KEY_TO_SHENGMU[k].push(sm);
  });
});
// 声母列表中短声母排在前面，展示更自然
Object.keys(KEY_TO_SHENGMU).forEach(k => {
  KEY_TO_SHENGMU[k].sort((a, b) => (a.length - b.length) || a.localeCompare(b));
});

/**
 * 键位 → 该键作为「双字母声母第二键」时服务的声母列表。
 *
 * 【已废弃，恒为空】
 * 早期版本误以为 zh/ch/sh 是「首字母 + H」三键编码，
 * 因此 H 键需要额外标注「zh/ch/sh 二键」。实际上小鹤中
 * zh→V、ch→I、sh→U 各占一键，不存在「第二键」这一概念。
 * 保留此导出仅为兼容旧引用，值始终为空对象。
 */
export const KEY_TO_SECOND_SHENGMU = {};

/** 键位 → 韵母数组 */
export const KEY_TO_YUNMU = {};
Object.entries(XIAOHE_LAYOUT).forEach(([k, cfg]) => {
  KEY_TO_YUNMU[k] = cfg.yun.slice();
});

/** 全部键位字母（A–Z） */
export const ALL_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** 有效键位集合（本方案真正用到的） */
export const USED_KEYS = new Set(Object.keys(XIAOHE_LAYOUT));

/* ============================================================
   韵母归一化
   输入法习惯把 ü / ê 等写成 v / e，做题时统一为 v
   ============================================================ */

export function normalizeYunmu(y) {
  if (typeof y !== 'string') return '';
  let s = y.toLowerCase().trim();
  s = s.replace(/ü/g, 'v').replace(/ǖ|ǘ|ǚ|ǜ/g, 'v');
  return s;
}

/**
 * 全拼韵母 → 双拼韵母（处理全拼中的缩写形式）
 * 全拼中 ju/qu/xu/yu 后的 u 实际是 ü；wen 实际是 uen；等
 */
function canonicalYunmu(sheng, yun) {
  let y = normalizeYunmu(yun);
  // j/q/x/y + u → v
  if (['j', 'q', 'x', 'y'].includes(sheng) && y.startsWith('u') && !y.startsWith('ue') === false) {
    // 处理 jue/que/xue/yue：ue → ve；ju/qu/xu/yu：u → v
  }
  if (['j', 'q', 'x'].includes(sheng)) {
    if (y === 'u') y = 'v';
    else if (y === 'ue') y = 've';
    else if (y === 'un') y = 'un'; // jun/qun/xun 的 un 就是 un
  }
  // 全拼里的 iou/uei/uen 缩写为 iu/ui/un，这里保持缩写（与韵母表一致）
  if (y === 'iou') y = 'iu';
  if (y === 'uei') y = 'ui';
  if (y === 'uen') y = 'un';
  return y;
}

/* ============================================================
   音节拆分
   ============================================================ */

/**
 * 尝试把一个无声调拼音切成「声母 + 韵母」的所有合法方案。
 * @param {string} pinyin 无声调小写拼音，如 "zhang" / "xian" / "an" / "lv"
 * @returns {Array<{sheng,yun,keys,steps,zero,code,text,key1,key2}>}
 */
export function splitSyllable(pinyin) {
  const result = [];
  if (typeof pinyin !== 'string') return result;
  const py = pinyin.toLowerCase().trim().replace(/[0-9]/g, '');
  if (!py || !/^[a-z\u00fc]+$/.test(py)) return result;

  // —— 方案 A：有声母 ——
  // 按声母长度降序尝试，zh/ch/sh 优先于 z/c/s
  for (const sm of SHENGMU_LIST) {
    if (!py.startsWith(sm)) continue;
    const rest = py.slice(sm.length);
    if (!rest) continue;                      // 只有声母，非法音节
    const yun = canonicalYunmu(sm, rest);
    if (!YUNMU_SET.has(yun)) continue;

    const yunKeys = YUNMU_TO_KEYS[yun];
    const smKeys = SHENGMU_TO_KEYS[sm];
    if (!yunKeys || !yunKeys.length || !smKeys || !smKeys.length) continue;

    result.push(buildResult(sm, yun, smKeys, yunKeys[0], false));
  }

  // —— 方案 B：零声母 ——
  // 整串作为韵母，双拼编码为「首字母 + 韵母键」
  const yunAll = canonicalYunmu('', py);
  if (YUNMU_SET.has(yunAll)) {
    const yunKeys = YUNMU_TO_KEYS[yunAll];
    if (yunKeys && yunKeys.length) {
      const firstKey = py[0].toUpperCase();
      result.push(buildResult('', yunAll, [firstKey], yunKeys[0], true));
    }
  }

  return dedupe(result);
}

/** 构造拆分结果对象 */
function buildResult(sheng, yun, shengKeys, yunKey, zero) {
  const keys = shengKeys.concat([yunKey]);
  const steps = [];

  if (zero) {
    // 零声母：首字母 + 韵母键。
    // 注意当首字母本身等于韵母键时（如 a → A+A、o → O+O），
    // 视觉上是同一个键按两次，这里仍按两步展示，因为操作确实是两次按键。
    steps.push({ role: 'zero', key: keys[0], part: yun, label: '首字母' });
    steps.push({ role: 'yun',  key: keys[1], part: yun, label: '韵母' });
  } else {
    // 有声母：声母一键 + 韵母一键，正好两键。
    // zh/ch/sh 的声母键是 V/I/U，同样只占一键。
    steps.push({ role: 'sheng', key: keys[0], part: sheng, label: '声母' });
    steps.push({ role: 'yun',   key: keys[1], part: yun,   label: '韵母' });
  }

  const desc = zero
    ? `${yun}（零声母）→ ${keys.join('')}`
    : `${sheng}+${yun} → ${keys.join('')}`;

  return {
    sheng, yun, zero,
    keys,
    steps,
    code: keys.join(''),
    len: keys.length,
    key1: keys[0], key2: keys[1] || '',
    text: desc
  };
}

/** 去重（同声母同韵母只保留一个） */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const id = r.sheng + '|' + r.yun;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

/**
 * 取主拆分（优先有声母方案，其次零声母）
 */
export function primarySplit(pinyin) {
  const all = splitSyllable(pinyin);
  if (!all.length) return null;
  return all[0];
}

/**
 * 文本 → 音节序列
 * @param {Array<string>} pinyins 拼音数组（与汉字一一对应）
 * @returns {Array<{pinyin, hanzi, candidates, split, zero, ok}>}
 *
 * 关于 zero（零声母）：
 *   音节对象顶层**带** zero 字段，取值来自主拆分（split.zero）。
 *   历史上这里漏了该字段，导致 engine 里读 syl.zero 的分支永远是 undefined
 *   （死代码），既掩盖了真实行为，又埋了「一旦被赋值就把 an 截成单键」的雷。
 *   现在顶层字段与 split 保持一致，读 syl.zero 与读 syl.split.zero 结果相同。
 *
 *   注意：零声母**不代表只需按一键**。小鹤里零声母音节同样恒为 2 键 ——
 *   编码是「首字母 + 韵母键」，例如 an → AJ、a → AA、ang → AH。
 *   首字母起到声母的位置作用（因为零声母没有声母键）。
 */
export function buildSyllables(pinyins, hanziList = []) {
  return pinyins.map((py, i) => {
    const candidates = splitSyllable(py);
    const split = candidates[0] || null;
    return {
      pinyin: py,
      hanzi: hanziList[i] || '',
      candidates,
      split,
      zero: !!(split && split.zero),
      ok: candidates.length > 0
    };
  });
}

/* ============================================================
   校验
   ============================================================ */

/**
 * 判断某个按键在某音节位置上是否正确。
 * @param {object} syl      由 buildSyllables 产出的音节对象
 * @param {number} pos      键位序号（从 0 开始）
 * @param {string} letter   用户按下的字母（任意大小写）
 */
export function isKeyCorrect(syl, pos, letter) {
  if (!syl || !syl.candidates) return false;
  const L = String(letter || '').toLowerCase();
  return syl.candidates.some(c => {
    const k = c.keys[pos];
    return k != null && k.toLowerCase() === L;
  });
}

/**
 * 获取某音节某位置的「标准答案键位」（取主拆分）
 */
export function expectedKey(syl, pos) {
  const split = syl && (syl.split || (syl.candidates && syl.candidates[0]));
  if (!split) return '';
  return split.keys[pos] || '';
}

/**
 * 获取某音节某位置的「所有可接受键位」（小写数组）
 */
export function acceptableKeys(syl, pos) {
  if (!syl || !syl.candidates) return [];
  const set = new Set();
  syl.candidates.forEach(c => {
    const k = c.keys[pos];
    if (k) set.add(k.toLowerCase());
  });
  return Array.from(set);
}

/**
 * 判断一个音节是否已经全部输入完毕（输入串长度是否达到最短合法编码长度）
 */
export function isSyllableComplete(syl, typed) {
  if (!syl || !syl.candidates || !syl.candidates.length) return false;
  const t = String(typed || '').toLowerCase();
  const min = Math.min(...syl.candidates.map(c => c.keys.length));
  return t.length >= min;
}

/**
 * 校验整个音节的输入串是否完全正确
 */
export function isSyllableAccepted(syl, typed) {
  if (!syl || !syl.candidates) return false;
  const t = String(typed || '').toLowerCase();
  return syl.candidates.some(c => c.code.toLowerCase() === t);
}

/**
 * 判断当前输入串是否是某个候选编码的合法前缀（用于实时判断"还没错"）
 */
export function isPrefixValid(syl, typed) {
  if (!syl || !syl.candidates) return false;
  const t = String(typed || '').toLowerCase();
  if (!t) return true;
  return syl.candidates.some(c => c.code.toLowerCase().startsWith(t));
}

/**
 * 一个音节最少需要几次按键（zh/ch/sh 为 3，其余为 2）
 */
export function minKeystrokes(syl) {
  if (!syl || !syl.candidates || !syl.candidates.length) return 0;
  return Math.min(...syl.candidates.map(c => c.keys.length));
}

/* ============================================================
   键位图数据（供 UI 渲染）
   ============================================================ */

/**
 * 返回 26 键的展示数据
 */
export function getKeymapData() {
  return ALL_KEYS.map(k => ({
    key: k,
    shengmu: (KEY_TO_SHENGMU[k] || []).slice(),
    secondOf: (KEY_TO_SECOND_SHENGMU[k] || []).slice(),
    yunmu: (KEY_TO_YUNMU[k] || []).slice(),
    used: USED_KEYS.has(k)
  }));
}

/**
 * 为一个已拆分的音节，标注每一步落在哪个键上（供键位图高亮）
 * @returns {Array<{key, role, part, label, pos}>}
 */
export function highlightForSplit(split) {
  if (!split || !split.steps) return [];
  return split.steps.map((s, i) => ({
    key: String(s.key).toUpperCase(),
    role: s.role,
    part: s.part,
    label: s.label,
    pos: i
  }));
}

/** 声母 → 键位（仅用于展示「zh 需要按 V+H」这类提示） */
export const SHENGMU_KEY_FOR = SHENGMU_KEY_SEQ;

/** 方案的元信息 */
export const SCHEME_META = {
  xiaohe: {
    id: 'xiaohe',
    name: '小鹤双拼',
    desc: '由鹤舞飞扬提出，使用者众多，键位分布均衡，学习资料丰富。',
    layout: XIAOHE_LAYOUT
  }
};

/** 当前激活方案（预留多方案扩展） */
let activeSchemeId = 'xiaohe';
export function getActiveScheme() { return SCHEME_META[activeSchemeId]; }
export function setActiveScheme(id) {
  if (SCHEME_META[id]) { activeSchemeId = id; return true; }
  return false;
}
