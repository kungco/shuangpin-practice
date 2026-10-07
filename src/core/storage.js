/**
 * 本地存储层（localStorage）
 * ------------------------------------------------------------
 * 设计原则：
 *   1. 所有读写都包在 try/catch 里 —— 隐私模式、配额满、被禁用
 *      都不能让应用崩溃，降级为「内存态」继续可用。
 *   2. 统一版本号，便于日后做数据迁移。
 *   3. 每种数据独立 key，避免单点损坏导致全部记录丢失。
 *   4. 写入做节流（history 可能较大）。
 */

const NS = 'shuangpin.v1';
export const KEYS = {
  settings: `${NS}.settings`,
  history: `${NS}.history`,     // 每次练习的成绩
  daily: `${NS}.daily`,         // 按日期聚合
  weak: `${NS}.weak`,           // 易错字词
  keyErrors: `${NS}.keyErrors`, // 键维度错误次数（错误热力图用）
  resume: `${NS}.resume`,       // 未完成的练习现场
  version: `${NS}.version`
};

export const DATA_VERSION = 2;

/* ============================================================
   底层读写（带降级）
   ============================================================ */

let storageAvailable = null;

/** 探测 localStorage 是否真正可写（Safari 隐私模式下 setItem 会抛错） */
export function isStorageAvailable() {
  if (storageAvailable !== null) return storageAvailable;
  try {
    const probe = `${NS}.__probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    storageAvailable = true;
  } catch (err) {
    console.warn('[storage] localStorage 不可用，将使用内存存储', err && err.message);
    storageAvailable = false;
  }
  return storageAvailable;
}

/* 内存降级存储 */
const memoryStore = new Map();

export function readRaw(key) {
  try {
    if (isStorageAvailable()) return window.localStorage.getItem(key);
    return memoryStore.has(key) ? memoryStore.get(key) : null;
  } catch (err) {
    console.warn('[storage] 读取失败', key, err && err.message);
    return null;
  }
}

export function writeRaw(key, value) {
  try {
    if (isStorageAvailable()) {
      window.localStorage.setItem(key, value);
    } else {
      memoryStore.set(key, value);
    }
    return true;
  } catch (err) {
    // 配额超限：尝试清理并重试一次
    console.warn('[storage] 写入失败', key, err && err.message);
    if (isQuotaError(err)) {
      try {
        pruneHistory(200);
        if (isStorageAvailable()) {
          window.localStorage.setItem(key, value);
        } else {
          memoryStore.set(key, String(value));
        }
        return true;
      } catch (e2) {
        console.error('[storage] 清理后仍写入失败，转为内存存储', e2 && e2.message);
        memoryStore.set(key, String(value));
        return false;
      }
    }
    memoryStore.set(key, String(value));
    return false;
  }
}

function isQuotaError(err) {
  if (!err) return false;
  const name = err.name || '';
  const code = err.code;
  return name === 'QuotaExceededError' ||
         name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
         code === 22 || code === 1014;
}

/** 安全 JSON 解析 */
export function readJSON(key, fallback) {
  const raw = readRaw(key);
  if (raw == null || raw === '') return clone(fallback);
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return clone(fallback);
    return parsed;
  } catch (err) {
    console.warn('[storage] JSON 解析失败，将重置该键', key, err && err.message);
    // 数据损坏：备份坏数据，避免静默丢失
    try { writeRaw(`${key}.corrupt`, String(raw).slice(0, 2000)); } catch (_) {}
    return clone(fallback);
  }
}

export function writeJSON(key, value) {
  try {
    return writeRaw(key, JSON.stringify(value));
  } catch (err) {
    console.error('[storage] 序列化失败', key, err && err.message);
    return false;
  }
}

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; }
}

/* ============================================================
   设置
   ============================================================ */

export const DEFAULT_SETTINGS = {
  scheme: 'xiaohe',
  mode: 'char',
  duration: 180,       // 秒，0 = 不限
  count: 20,           // 题量，0 = 不限
  weakBoost: false,    // 侧重易错内容
  showMiniKeymap: true,
  sound: false,
  strict: true,        // 严格模式：输错必须修正
  skipPunct: true,
  hint: true,          // 卡住自动提示总开关
  hintDelay: 3000,     // 停留多久开始闪键位（毫秒，0 = 不闪）
  revealDelay: 6000    // 停留多久直接给答案（毫秒，0 = 不给）
};

export function loadSettings() {
  const raw = readJSON(KEYS.settings, {});
  const merged = Object.assign({}, DEFAULT_SETTINGS);
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (raw[k] !== undefined && raw[k] !== null) {
        // 类型校验：防止手工改坏存储导致运行时异常
        if (typeof DEFAULT_SETTINGS[k] === 'boolean') {
          merged[k] = !!raw[k];
        } else if (typeof DEFAULT_SETTINGS[k] === 'number') {
          const n = Number(raw[k]);
          merged[k] = Number.isFinite(n) ? n : DEFAULT_SETTINGS[k];
        } else {
          merged[k] = String(raw[k]);
        }
      }
    }
  }
  return merged;
}

export function saveSettings(settings) {
  const safe = Object.assign({}, DEFAULT_SETTINGS);
  if (settings && typeof settings === 'object') Object.assign(safe, settings);
  return writeJSON(KEYS.settings, safe);
}

/* ============================================================
   练习历史
   ============================================================ */

/** 一条成绩记录 */
export function makeRecord(data) {
  const d = data || {};
  return {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    date: dateStr(new Date()),
    mode: String(d.mode || 'char'),
    modeName: String(d.modeName || ''),
    durationSec: num(d.durationSec),
    totalChars: num(d.totalChars),
    correctChars: num(d.correctChars),
    wrongChars: num(d.wrongChars),
    hintedChars: num(d.hintedChars),          // 依赖提示才打出的字数
    keystrokes: num(d.keystrokes),
    wrongKeystrokes: num(d.wrongKeystrokes),
    speed: num(d.speed, 1),        // 字/分
    accuracy: num(d.accuracy, 1),  // %
    // 独立正确率：剔除「靠提示打出」的字之后的正确率。
    // 老记录没有这个字段时回退到 accuracy，保证历史曲线不会突然断裂。
    independentAccuracy: d.independentAccuracy === undefined
      ? num(d.accuracy, 1) : num(d.independentAccuracy, 1),
    maxCombo: num(d.maxCombo),
    completed: !!d.completed,
    questionCount: num(d.questionCount)
  };
}

function num(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return digits ? Math.round(n * 10 ** digits) / 10 ** digits : Math.round(n);
}

/** 本地日期 YYYY-MM-DD */
export function dateStr(d) {
  const dt = d instanceof Date ? d : new Date();
  if (Number.isNaN(dt.getTime())) return '1970-01-01';
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function loadHistory() {
  const arr = readJSON(KEYS.history, []);
  if (!Array.isArray(arr)) return [];
  // 过滤掉结构异常的记录
  return arr.filter(r => r && typeof r === 'object' && Number.isFinite(Number(r.ts)));
}

export function appendRecord(record) {
  const list = loadHistory();
  list.push(record);
  // 上限 2000 条，防止无限增长
  const trimmed = list.length > 2000 ? list.slice(list.length - 2000) : list;
  const okWrite = writeJSON(KEYS.history, trimmed);
  updateDaily(record);
  if (!okWrite) console.warn('[storage] 成绩记录写入未完全成功');
  return trimmed;
}

export function pruneHistory(keep) {
  const list = loadHistory();
  if (list.length <= keep) return list;
  const trimmed = list.slice(list.length - keep);
  writeJSON(KEYS.history, trimmed);
  return trimmed;
}

export function clearHistory() {
  writeJSON(KEYS.history, []);
  writeJSON(KEYS.daily, {});
}

/* ============================================================
   每日聚合
   ============================================================ */

export function loadDaily() {
  const obj = readJSON(KEYS.daily, {});
  return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
}

function updateDaily(record) {
  try {
    const daily = loadDaily();
    const key = record.date;
    const cur = daily[key] || {
      date: key, sessions: 0, chars: 0, durationSec: 0,
      bestSpeed: 0, speedSum: 0, accSum: 0, correct: 0, wrong: 0, keystrokes: 0
    };
    cur.sessions += 1;
    cur.chars += record.totalChars;
    cur.durationSec += record.durationSec;
    cur.bestSpeed = Math.max(cur.bestSpeed || 0, record.speed);
    cur.speedSum += record.speed;
    cur.accSum += record.accuracy;
    cur.correct += record.correctChars;
    cur.wrong += record.wrongChars;
    cur.keystrokes += record.keystrokes;
    daily[key] = cur;
    writeJSON(KEYS.daily, daily);
  } catch (err) {
    console.warn('[storage] 每日聚合更新失败', err && err.message);
  }
}

/* ============================================================
   易错字词
   结构： { "字或词": { key, char, word, pinyin, count, lastTs, correct } }
   ============================================================ */

export function loadWeak() {
  const obj = readJSON(KEYS.weak, {});
  return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
}

export function saveWeak(map) {
  return writeJSON(KEYS.weak, map || {});
}

/**
 * 记录一次错误
 * @param {object} item { char?, word?, pinyin?, key? }
 */
export function recordWeak(item) {
  if (!item) return;
  try {
    const map = loadWeak();
    const key = item.word || item.char || '';
    if (!key) return;
    const cur = map[key] || {
      key,
      char: item.char || '',
      word: item.word || '',
      pinyin: item.pinyin || '',
      count: 0,
      correct: 0,
      lastTs: 0
    };
    cur.count += 1;
    cur.lastTs = Date.now();
    if (item.pinyin) cur.pinyin = item.pinyin;
    if (item.char) cur.char = item.char;
    if (item.word) cur.word = item.word;
    map[key] = cur;
    saveWeak(map);
  } catch (err) {
    console.warn('[storage] 易错记录失败', err && err.message);
  }
}

/** 记录一次正确（用于复习后消错） */
export function recordWeakCorrect(item) {
  if (!item) return;
  try {
    const map = loadWeak();
    const key = item.word || item.char || '';
    if (!key || !map[key]) return;
    map[key].correct = (map[key].correct || 0) + 1;
    map[key].lastTs = Date.now();
    // 连续正确多次后淡化权重（并非删除，保留历史）
    if (map[key].correct >= 3 && map[key].count <= map[key].correct) {
      map[key].mastered = true;
    }
    saveWeak(map);
  } catch (err) {
    console.warn('[storage] 正确记录失败', err && err.message);
  }
}

/**
 * 计算易错权重（用于排序 / 复习优先级）
 * 权重 = 错误次数 × 时间衰减 × (1 - 已掌握惩罚)
 */
export function weakWeight(entry, now = Date.now()) {
  if (!entry) return 0;
  const count = Number(entry.count) || 0;
  const last = Number(entry.lastTs) || 0;
  const ageDays = last ? (now - last) / 86400000 : 30;
  // 越近的错误权重越高，30 天后衰减到 0.4 倍
  const recency = 1 / (1 + Math.max(0, ageDays) / 12);
  const masteryPenalty = entry.mastered ? 0.15 : 1;
  return count * (0.4 + 0.6 * recency) * masteryPenalty;
}

/** 取得按权重排序的易错列表 */
export function getWeakList(options = {}) {
  const map = loadWeak();
  const now = Date.now();
  const limit = Math.max(1, Number(options.limit) || 50);
  const minCount = Number(options.minCount) || 1;
  const includeMastered = !!options.includeMastered;

  const list = Object.values(map)
    .filter(e => e && e.key)
    .filter(e => (Number(e.count) || 0) >= minCount)
    .filter(e => includeMastered || !e.mastered)
    .map(e => ({
      key: e.key,
      char: e.char || '',
      word: e.word || '',
      pinyin: e.pinyin || '',
      count: Number(e.count) || 0,
      correct: Number(e.correct) || 0,
      lastTs: Number(e.lastTs) || 0,
      errorRate: Number(e.count) > 0
        ? Number(e.count) / (Number(e.count) + Number(e.correct) || 1)
        : 0,
      weight: weakWeight(e, now)
    }));

  list.sort((a, b) => b.weight - a.weight || b.count - a.count);
  return list.slice(0, limit);
}

export function clearWeak() {
  writeJSON(KEYS.weak, {});
}

/* ============================================================
   键维度错误统计（错误热力图）
   ------------------------------------------------------------
   与「易错字词表」互补：字词表回答「哪些字不会」，
   热力图回答「哪些键位上想不起来」。诊断粒度更细，
   而且能发现一个隐蔽问题 —— 有些键你其实从没按错过，
   因为你一直在绕开它。

   结构：
     {
       all:   { A: 12, H: 30, ... },        // 累计（全历史）
       recent:[ { ts, keys:{A:1,H:2} } ]    // 最近 N 次会话明细，用于范围切换
     }
   ============================================================ */

const KEY_ERROR_RECENT_MAX = 60;   // 明细最多保留 60 次会话

export function loadKeyErrors() {
  const obj = readJSON(KEYS.keyErrors, null);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { all: {}, recent: [] };
  }
  const all = (obj.all && typeof obj.all === 'object' && !Array.isArray(obj.all)) ? obj.all : {};
  const recent = Array.isArray(obj.recent) ? obj.recent.filter(s => s && typeof s === 'object') : [];
  return { all, recent };
}

/**
 * 合并一次会话的键错误明细
 * @param {object} keyErrors { 小写键: 次数 }
 * @returns {boolean} 是否写入成功
 */
export function recordKeyErrors(keyErrors) {
  if (!keyErrors || typeof keyErrors !== 'object') return false;
  const clean = {};
  let total = 0;
  for (const [k, v] of Object.entries(keyErrors)) {
    const key = String(k || '').toUpperCase();
    if (!/^[A-Z]$/.test(key)) continue;       // 只收单字母键
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n <= 0) continue;
    clean[key] = n;
    total += n;
  }
  if (!total) return false;

  try {
    const data = loadKeyErrors();
    // 累计
    for (const [k, n] of Object.entries(clean)) {
      data.all[k] = (Number(data.all[k]) || 0) + n;
    }
    // 明细（用于「最近 N 次」范围）
    data.recent.push({ ts: Date.now(), keys: clean, total });
    if (data.recent.length > KEY_ERROR_RECENT_MAX) {
      data.recent = data.recent.slice(data.recent.length - KEY_ERROR_RECENT_MAX);
    }
    return writeJSON(KEYS.keyErrors, data);
  } catch (err) {
    console.warn('[storage] 键位错误记录失败', err && err.message);
    return false;
  }
}

/**
 * 取某个范围的键错误次数
 * @param {string} range 'all' | '30' | '10'
 * @returns {{counts:Object<string,number>, sessions:number, total:number}}
 */
export function getKeyErrorTotals(range = 'all') {
  const data = loadKeyErrors();
  const counts = {};
  let sessions = 0;

  if (range === 'all') {
    for (const [k, v] of Object.entries(data.all)) {
      const n = Number(v) || 0;
      if (n > 0) counts[k] = n;
    }
    sessions = data.recent.length;
  } else {
    const n = Math.max(1, parseInt(range, 10) || 10);
    const slice = data.recent.slice(Math.max(0, data.recent.length - n));
    for (const s of slice) {
      for (const [k, v] of Object.entries(s.keys || {})) {
        counts[k] = (counts[k] || 0) + (Number(v) || 0);
      }
    }
    sessions = slice.length;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, sessions, total };
}

/** 全部记录里的总错误数（用于卡片展示） */
export function keyErrorGrandTotal() {
  const data = loadKeyErrors();
  return Object.values(data.all).reduce((a, b) => a + (Number(b) || 0), 0);
}

export function clearKeyErrors() {
  writeJSON(KEYS.keyErrors, { all: {}, recent: [] });
}

/* ============================================================
   中断续练（练习现场）
   ============================================================ */

export function saveResume(state) {
  if (!state) { clearResume(); return; }
  // 只保存必要字段，避免把整个题库塞进存储
  const slim = {
    createdAt: Date.now(),
    mode: state.mode,
    modeName: state.modeName,
    questions: state.questions,
    index: state.index,
    charIndex: state.charIndex,
    typed: state.typed,
    elapsedSec: state.elapsedSec,
    stats: state.stats,
    settings: state.settings
  };
  try {
    writeJSON(KEYS.resume, slim);
  } catch (err) {
    console.warn('[storage] 保存续练进度失败', err && err.message);
  }
}

export function loadResume() {
  const raw = readJSON(KEYS.resume, null);
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.questions) || !raw.questions.length) return null;
  // 超过 24 小时的现场不再提示
  if (raw.createdAt && Date.now() - raw.createdAt > 24 * 3600 * 1000) {
    clearResume();
    return null;
  }
  return raw;
}

export function clearResume() {
  try {
    writeJSON(KEYS.resume, null);
    if (isStorageAvailable()) window.localStorage.removeItem(KEYS.resume);
    else memoryStore.delete(KEYS.resume);
  } catch (err) {
    console.warn('[storage] 清除续练进度失败', err && err.message);
  }
}

/* ============================================================
   导入 / 导出
   ============================================================ */

export function exportAll() {
  return {
    app: 'shuangpin-practice',
    version: DATA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: loadSettings(),
    history: loadHistory(),
    daily: loadDaily(),
    weak: loadWeak(),
    keyErrors: loadKeyErrors()
  };
}

/**
 * 导入数据（合并语义：导入项覆盖设置，记录追加）
 * @returns {{ok:boolean, message:string, imported?:object}}
 */
export function importAll(payload) {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: '文件内容不是有效的 JSON 对象' };
    }
    if (payload.app !== 'shuangpin-practice') {
      return { ok: false, message: '这不是本应用导出的数据文件' };
    }

    let n = 0;

    if (payload.settings && typeof payload.settings === 'object') {
      saveSettings(Object.assign(loadSettings(), payload.settings));
      n++;
    }

    if (Array.isArray(payload.history)) {
      const cur = loadHistory();
      const seen = new Set(cur.map(r => r.id));
      const dupDate = new Set(cur.map(r => r.ts));
      const add = payload.history
        .filter(r => r && typeof r === 'object')
        .filter(r => !seen.has(r.id) && !dupDate.has(r.ts));
      const merged = cur.concat(add);
      merged.sort((a, b) => a.ts - b.ts);
      writeJSON(KEYS.history, merged.slice(-2000));
      n += add.length;
    }

    if (payload.daily && typeof payload.daily === 'object') {
      const cur = loadDaily();
      for (const [k, v] of Object.entries(payload.daily)) {
        if (!v || typeof v !== 'object') continue;
        if (!cur[k]) { cur[k] = v; continue; }
        // 合并取较大值（避免重复导入导致数据膨胀）
        cur[k].sessions = Math.max(cur[k].sessions || 0, v.sessions || 0);
        cur[k].chars = Math.max(cur[k].chars || 0, v.chars || 0);
        cur[k].bestSpeed = Math.max(cur[k].bestSpeed || 0, v.bestSpeed || 0);
      }
      writeJSON(KEYS.daily, cur);
    }

    if (payload.weak && typeof payload.weak === 'object') {
      const cur = loadWeak();
      for (const [k, v] of Object.entries(payload.weak)) {
        if (!v || typeof v !== 'object') continue;
        if (!cur[k]) { cur[k] = v; continue; }
        cur[k].count = (cur[k].count || 0) + (v.count || 0);
        cur[k].correct = (cur[k].correct || 0) + (v.correct || 0);
        cur[k].lastTs = Math.max(cur[k].lastTs || 0, v.lastTs || 0);
      }
      writeJSON(KEYS.weak, cur);
      n++;
    }

    // 键位错误：与现有累计值相加；明细按 ts 去重合并
    if (payload.keyErrors && typeof payload.keyErrors === 'object') {
      const cur = loadKeyErrors();
      const inc = payload.keyErrors.all && typeof payload.keyErrors.all === 'object'
        ? payload.keyErrors.all : {};
      for (const [k, v] of Object.entries(inc)) {
        const key = String(k).toUpperCase();
        if (!/^[A-Z]$/.test(key)) continue;
        const num = Math.floor(Number(v)) || 0;
        if (num <= 0) continue;
        cur.all[key] = (Number(cur.all[key]) || 0) + num;
      }
      if (Array.isArray(payload.keyErrors.recent)) {
        const seenTs = new Set(cur.recent.map(s => s && s.ts));
        for (const s of payload.keyErrors.recent) {
          if (!s || typeof s !== 'object' || seenTs.has(s.ts)) continue;
          cur.recent.push(s);
          seenTs.add(s.ts);
        }
        cur.recent.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        if (cur.recent.length > KEY_ERROR_RECENT_MAX) {
          cur.recent = cur.recent.slice(cur.recent.length - KEY_ERROR_RECENT_MAX);
        }
      }
      writeJSON(KEYS.keyErrors, cur);
      n++;
    }

    return { ok: true, message: `导入完成（合并 ${n} 项）` };
  } catch (err) {
    console.error('[storage] 导入失败', err);
    return { ok: false, message: '导入失败：' + (err && err.message ? err.message : '未知错误') };
  }
}

/** 清空所有数据 */
export function clearAll() {
  try {
    for (const k of Object.values(KEYS)) {
      if (isStorageAvailable()) window.localStorage.removeItem(k);
      else memoryStore.delete(k);
    }
    memoryStore.clear();
    return true;
  } catch (err) {
    console.warn('[storage] 清空失败', err && err.message);
    return false;
  }
}

/** 存储占用估算 */
export function storageUsage() {
  let bytes = 0;
  try {
    if (isStorageAvailable()) {
      for (const k of Object.values(KEYS)) {
        const v = window.localStorage.getItem(k);
        if (v) bytes += v.length * 2; // UTF-16
      }
    } else {
      for (const v of memoryStore.values()) bytes += String(v).length * 2;
    }
  } catch (_) {}
  return bytes;
}
