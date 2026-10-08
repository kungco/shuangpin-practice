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

/**
 * 存储状态。三态（见下方注释说明为什么不能只用布尔值）：
 *   null            —— 尚未探测
 *   true            —— localStorage 可用
 *   false           —— localStorage 不可用（隐身模式 / 被策略禁用 / 探测失败）
 *   'quota-memory'  —— localStorage 存在但已经写不进去（配额满），改用内存
 *
 * 之所以拆成三态：以前只有 true/false，配额满时写进内存、读却仍走
 * localStorage，于是「刚写入内存的数据当前会话也读不回来」。
 */
let storageAvailable = null;

/* 内存降级存储（模块级，同一会话内共享） */
const memoryStore = new Map();

/** 是否已经降级到内存（配额满或 localStorage 不可用） */
export function isDegradedToMemory() {
  return storageAvailable === 'quota-memory' || storageAvailable === false;
}

/**
 * 探测 localStorage 是否真正可写（Safari 隐私模式下 setItem 会抛错）。
 *
 * 返回值仍按老语义：true = localStorage 存在且可写。
 * 注意「配额已满」时本函数返回 false，但数据并没有丢 —— 只是这一会话
 * 进了内存。调用方（设置页的存储占用提示）用 storageUsage() 拿实际字节数，
 * 不要用本函数的返回值推断数据是否还在。
 */
export function isStorageAvailable() {
  if (storageAvailable === null) {
    try {
      const probe = `${NS}.__probe`;
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      storageAvailable = true;
    } catch (err) {
      console.warn('[storage] localStorage 不可用，将使用内存存储', err && err.message);
      storageAvailable = false;
    }
  } else if (storageAvailable === 'quota-memory') {
    // 配额满之后，用户可能已经清理了空间；顺手探测一次，能恢复就恢复。
    recoverStorage();
  }
  return storageAvailable === true;
}

/**
 * 遇到配额错误后转入内存态。
 *
 * 为什么不能只在内存里兜住：readRaw 读的是 localStorage，写进内存的东西
 * 下一次读就没了 —— 「配额满时刚写入的数据，当前会话里也读不回来」。
 * 所以这里必须**整体切换存储状态**，让读路径也一起走内存。
 */
function degradeToMemory(reason) {
  if (storageAvailable !== 'quota-memory') {
    console.warn('[storage] localStorage 写入遇阻，本次会话降级为内存存储', reason);
  }
  storageAvailable = 'quota-memory';
}

/**
 * 当前存储状态的**可读名称**。
 *
 * 给设置页 / 状态提示用。之所以要一个「名称」而不是直接暴露内部枚举：
 * 内部值（null / true / false / 'quota-memory'）是实现细节，将来再加一态
 * 不该逼着每个 UI 点都改；而 UI 真正想说的是「数据现在存在哪」。
 *
 * @returns {'persistent'|'memory'|'quota-memory'|'unprobed'}
 */
export function storageModeName() {
  if (storageAvailable === null) return 'unprobed';
  if (storageAvailable === true) return 'persistent';
  if (storageAvailable === 'quota-memory') return 'quota-memory';
  return 'memory';
}

/**
 * 仅供测试：把存储状态与内存缓存清回初始态。
 *
 * 模块级 state（storageAvailable / memoryStore）会跨用例串味，
 * 测试每换一个 localStorage 桩就得复位一次，否则第 2 个用例会
 * 拿着第 1 个用例的探测结果跑。
 */
export function _resetStorageState() {
  storageAvailable = null;
  memoryStore.clear();
}

/**
 * 尝试从「配额满」状态恢复：探测能否写、并把内存里的数据补写回 localStorage。
 *
 * 为什么需要它：降级后内存里攒的是最新数据（读也优先读内存），一旦用户
 * 清理了空间，应该能重新落盘，而不是整次会话都白存。
 * 触发点：writeRaw 的降级分支、isStorageAvailable 的显式查询。
 */
function recoverStorage() {
  try {
    const probe = `${NS}.__probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
  } catch (_) {
    return false;
  }
  // 内存里比 localStorage 新的数据要补写回去，否则「清理空间后仍看到旧数据」
  for (const [k, v] of memoryStore) {
    try { window.localStorage.setItem(k, v); } catch (_) { return false; }
  }
  memoryStore.clear();
  storageAvailable = true;
  return true;
}

export function readRaw(key) {
  try {
    // 内存优先：降级之后内存里的一定是最新的（写入时同步写入），
    // 而 localStorage 里的可能是配额满之前的老副本。
    if (memoryStore.has(key)) return memoryStore.get(key);
    if (storageAvailable === false) return null;
    return window.localStorage.getItem(key);
  } catch (err) {
    console.warn('[storage] 读取失败', key, err && err.message);
    return null;
  }
}

export function writeRaw(key, value) {
  const str = String(value);
  // 已降级：先试着恢复落盘，不行就只写内存（此时 readRaw 也读内存，读写自洽）
  if (storageAvailable === 'quota-memory') {
    // 每次写入都试一次恢复，而不是一降到底 —— 用户在设置页「清空数据」
    // 之后应该能立刻恢复落盘，不必刷新页面。
    if (recoverStorage()) {
      try {
        window.localStorage.setItem(key, str);
        return true;
      } catch (err) {
        degradeToMemory(err && err.message);
      }
    }
    memoryStore.set(key, str);
    return false;
  }
  if (storageAvailable === false) {
    memoryStore.set(key, str);
    return false;
  }
  try {
    window.localStorage.setItem(key, str);
    return true;
  } catch (err) {
    console.warn('[storage] 写入失败', key, err && err.message);
    if (isQuotaError(err)) {
      // 配额超限：先尝试清理老记录并重试一次
      try {
        pruneHistory(200);
        window.localStorage.setItem(key, str);
        return true;
      } catch (e2) {
        console.error('[storage] 清理后仍写入失败，转为内存存储', e2 && e2.message);
        memoryStore.set(key, str);
        degradeToMemory('quota');
        return false;
      }
    }
    // 非配额错误（隐私模式、键名非法等）：同样不能只写内存就完事，
    // 必须连读路径一起切过去，否则这份数据当场就丢。
    memoryStore.set(key, str);
    degradeToMemory(err && err.message);
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
  revealDelay: 6000,   // 停留多久直接给答案（毫秒，0 = 不给）
  /* 动效偏好。'auto' 跟随系统 prefers-reduced-motion；
     'on'/'off' 是用户显式覆盖系统设置（有些用户系统开着但本应用想要动画）。 */
  reduceMotion: 'auto',
  /* 复习队列：是否只练「到期」的错题（间隔重复）。false = 练全部易错项 */
  reviewDueOnly: true,
  /* 快捷键。对象在 loadSettings 里单独处理（不是标量），
     合并/校验逻辑见 ui/a11y.js::mergeShortcuts */
  shortcuts: null
};

/** 设置项里属于「结构化对象」的键，走各自的合并逻辑而非标量类型校验 */
const SETTINGS_OBJECT_KEYS = ['shortcuts'];

/**
 * 取值受限的枚举型设置：非法值一律回落到默认值。
 *
 * 为什么单独列一张表：这类设置一旦存进脏值（手工改存储、旧版本残留、
 * 导入的备份来自别的分支），下游 switch / if 就会走进「没有分支匹配」
 * 的空白区 —— 表现是「设置不生效但也不报错」，最难查。
 */
const SETTINGS_ENUMS = {
  reduceMotion: ['auto', 'on', 'off']
};

export function loadSettings() {
  const raw = readJSON(KEYS.settings, {});
  const merged = Object.assign({}, DEFAULT_SETTINGS);
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      // 结构化字段不在这里处理，交给调用方（main.js 用 mergeShortcuts）
      if (SETTINGS_OBJECT_KEYS.includes(k)) continue;
      if (raw[k] !== undefined && raw[k] !== null) {
        // 类型校验：防止手工改坏存储导致运行时异常
        if (typeof DEFAULT_SETTINGS[k] === 'boolean') {
          merged[k] = !!raw[k];
        } else if (typeof DEFAULT_SETTINGS[k] === 'number') {
          const n = Number(raw[k]);
          merged[k] = Number.isFinite(n) ? n : DEFAULT_SETTINGS[k];
        } else {
          const s = String(raw[k]);
          // 枚举型：只认白名单里的值，其余回落到默认
          const allow = SETTINGS_ENUMS[k];
          merged[k] = (allow && !allow.includes(s)) ? DEFAULT_SETTINGS[k] : s;
        }
      }
    }
    // 结构化字段原样带出（形制由各自的 merge 函数负责），
    // 但只接受对象，避免脏数据把下游搞崩
    for (const k of SETTINGS_OBJECT_KEYS) {
      if (raw[k] && typeof raw[k] === 'object' && !Array.isArray(raw[k])) {
        merged[k] = raw[k];
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

/** 每日聚合里被累加的字段；重建时按此表单逐条累加 */
const DAILY_ADD_FIELDS = [
  'sessions', 'chars', 'durationSec', 'speedSum', 'accSum',
  'correct', 'wrong', 'keystrokes'
];

/**
 * 把日期桶初始化成固定形状。
 *
 * 字段必须与 updateDaily 写入的形状完全一致，否则「重建一次的日报」和
 * 「逐条增量更新的日报」会长得不一样，统计页读字段时就会时有时无。
 */
function emptyDay(key) {
  return {
    date: key, sessions: 0, chars: 0, durationSec: 0,
    bestSpeed: 0, speedSum: 0, accSum: 0, correct: 0, wrong: 0, keystrokes: 0
  };
}

/** 一条成绩记录 → 它在日报里的贡献（与 updateDaily 的口径保持一致） */
function dailyDelta(rec) {
  return {
    sessions: 1,
    chars: num(rec.totalChars),
    durationSec: num(rec.durationSec),
    speedSum: num(rec.speed, 1),
    accSum: num(rec.accuracy, 1),
    correct: num(rec.correctChars),
    wrong: num(rec.wrongChars),
    keystrokes: num(rec.keystrokes)
  };
}

/** 把一条记录累加进日报（增量更新与全量重建共用这段口径） */
function applyRecordToDaily(bucket, rec) {
  const d = dailyDelta(rec);
  for (const f of DAILY_ADD_FIELDS) bucket[f] += d[f];
  bucket.bestSpeed = Math.max(bucket.bestSpeed || 0, num(rec.speed, 1));
  return bucket;
}

/**
 * 从历史记录全量重建每日聚合。
 *
 * 为什么不再用「逐字段取较大值」合并：那是为了防重复导入导致数据膨胀，
 * 但两台设备同一天各有记录时，取较大值会**少算**总量；而历史记录本身是
 * 相加合并的，于是「日报」和「历史」对不上号。既然历史已经合并好了，
 * 日报就应该由它推导出来 —— 单一数据源，天然一致。
 *
 * @param {Array} history 已合并、已排序的历史记录
 * @param {Array<string>} keepKeys 需要保留、但历史里没有记录的日期
 *        （老备份的 daily 可能是唯一来源：早期版本删过历史却没留日报）
 */
export function rebuildDailyFromHistory(history, keepKeys = []) {
  const list = Array.isArray(history) ? history : [];
  const daily = {};

  // 先铺保留键，再铺历史记录，保证「历史里有记录的日期」永远赢
  for (const k of keepKeys) {
    if (typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k)) daily[k] = emptyDay(k);
  }
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    const key = rec.date || dateStr(new Date(num(rec.ts)));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (!daily[key]) daily[key] = emptyDay(key);
    applyRecordToDaily(daily[key], rec);
  }
  return daily;
}

function num(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return digits ? Math.round(n * 10 ** digits) / 10 ** digits : Math.round(n);
}

/**
 * 取一个「小数也要保住」的数值。
 *
 * 为什么不能直接用 num()：num(v) 不带 digits 时会**四舍五入到整数**，
 * 而 ease 是 1.3–2.8 之间的小数 —— 用 num 会把 2.5 变成 3、把下限 1.3
 * 变成 1，夹在 [EASE_MIN, EASE_MAX] 里的值会被舍入顶出边界，
 * 于是「ease 上限 2.8」这条规则形同虚设。
 */
function numFloat(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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
    // 老数据缺字段时用 emptyDay 的默认值补形状，再走统一累加
    if (!daily[key]) daily[key] = emptyDay(key);
    applyRecordToDaily(daily[key], record);
    writeJSON(KEYS.daily, daily);
  } catch (err) {
    console.warn('[storage] 每日聚合更新失败', err && err.message);
  }
}

/* ============================================================
   易错字词 + 间隔重复调度
   ------------------------------------------------------------
   记录结构（在原来的基础上扩展了复习调度字段）：
     {
       key, char, word, pinyin,
       count,      // 累计错误次数
       correct,    // 累计正确次数
       lastTs,     // 最后一次出错时间
       mastered,   // 兼容旧字段：连续答对足够多时置位

       // ---- 间隔重复（SM-2 简化版）新增 ----
       streak,     // 连续答对次数（答错清零）
       interval,   // 当前复习间隔（天）
       ease,       // 难度系数（SM-2 的 EF，1.3–2.8）
       due,        // 下次复习时间戳（ms）
       reviewedAt  // 上次复习时间戳（ms）
     }
   ============================================================ */

/* ---- 间隔重复参数 ---- */

/** 各阶段的起始间隔（天）。答对一次就往后走一格。 */
export const REVIEW_STEPS = [1, 3, 7, 16, 35, 75];

/** 难度系数上下限（SM-2 的经典取值） */
export const EASE_MIN = 1.3;
export const EASE_MAX = 2.8;
export const EASE_DEFAULT = 2.5;

/** 答错后的重来间隔（天）。不是 0 —— 0 会让它立刻又在待复习列表里刷屏。 */
export const RELAPSE_INTERVAL = 1;

const DAY_MS = 86400000;

/**
 * 首次进入复习队列时，多久之后到期。
 * 用 1 天而不是「立刻」：刚错的字应该当场在练习里消化，
 * 隔天再抽到才是「复习」的意义。
 */
const NEW_DUE_MS = DAY_MS;

/**
 * 从当前状态推出「下一次间隔」。
 *
 * SM-2 简化版的核心：
 *   - 答对：间隔按 REVIEW_STEPS 阶梯前进；越往后每次乘 ease 拉长
 *   - 答错：间隔重置回 RELAPSE_INTERVAL，并小幅下调 ease
 *
 * 为什么用「阶梯 + ease」而不是纯 SM-2 的 `interval * EF`：
 * 纯乘法的起步太陡（1 → 2.5 → 6.25 → 15.6），对打字练习这种
 * 「一个字的键位其实两三次就够」的场景过度拖长，反而不如固定阶梯直观。
 *
 * @param {object} entry
 * @param {boolean} correct
 * @returns {{interval:number, ease:number, streak:number}}
 */
export function nextSchedule(entry, correct) {
  const e = entry || {};
  // ease 必须用 numFloat 读 —— 用 num 会把它四舍五入成整数，
  // 直接毁掉「1.3–2.8 的小数刻度」这层设计（详见 numFloat 注释）
  let ease = numFloat(e.ease) || EASE_DEFAULT;
  let streak = Math.max(0, Math.floor(num(e.streak)));
  let interval = Math.max(0, num(e.interval));

  if (!correct) {
    // 答错：清零连对、间隔回落、难度上调（越难的东西间隔越短）
    return {
      interval: RELAPSE_INTERVAL,
      ease: Math.max(EASE_MIN, ease - 0.2),
      streak: 0
    };
  }

  streak += 1;
  // 阶梯内先按步进
  const stepIdx = Math.min(streak - 1, REVIEW_STEPS.length - 1);
  let next = REVIEW_STEPS[stepIdx];
  // 超出阶梯后按 ease 继续拉长（例如第 7 次：75 * 2.5）
  if (streak > REVIEW_STEPS.length) {
    const base = REVIEW_STEPS[REVIEW_STEPS.length - 1];
    next = Math.round(base * Math.pow(ease, streak - REVIEW_STEPS.length));
  }
  // 保证总是不小于上一次（避免 ease 被下调后间隔反而变短）
  next = Math.max(interval || 0, next || 1);
  // 上限一年，避免溢出成天文数字
  next = Math.min(365, next);

  // 答得越顺（连对越多）难度略微下调 → 以后间隔拉得更长
  if (streak >= 3) ease = Math.min(EASE_MAX, ease + 0.1);

  return { interval: next, ease, streak };
}

/**
 * 计算下次到期时间戳。
 * @param {number} now
 * @param {number} intervalDays
 */
export function dueAt(now, intervalDays) {
  const days = Math.max(0, num(intervalDays));
  return Number(now || Date.now()) + Math.max(1, Math.round(days)) * DAY_MS;
}

/** 把一条记录规范成完整形状（兼容旧数据 / 脏数据） */
function normalizeWeakEntry(e, key) {
  const base = {
    key: key || e.key || '',
    char: e.char || '',
    word: e.word || '',
    pinyin: e.pinyin || '',
    count: num(e.count),
    correct: num(e.correct),
    lastTs: num(e.lastTs),
    mastered: !!e.mastered,
    streak: Math.max(0, Math.floor(num(e.streak))),
    interval: Math.max(0, num(e.interval)),
    ease: numFloat(e.ease) || EASE_DEFAULT,
    due: num(e.due),
    reviewedAt: num(e.reviewedAt)
  };
  // 老数据没有 due：补成「已到期」，让它进入待复习队列。
  // 这是有意为之 —— 升级后用户应该看到历史错题重新排队，
  // 而不是因为缺字段而被静默忽略。
  if (!base.due) base.due = base.lastTs ? base.lastTs + NEW_DUE_MS : Date.now();
  return base;
}

export function loadWeak() {
  const obj = readJSON(KEYS.weak, {});
  return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
}

export function saveWeak(map) {
  return writeJSON(KEYS.weak, map || {});
}

/**
 * 记录一次错误
 *
 * 同时把这条打回复习队列的起点：连对清零、间隔回落、明天到期。
 * @param {object} item { char?, word?, pinyin? }
 */
export function recordWeak(item) {
  if (!item) return;
  try {
    const map = loadWeak();
    const key = item.word || item.char || '';
    if (!key) return;
    const cur = normalizeWeakEntry(map[key] || {}, key);
    const now = Date.now();

    cur.count += 1;
    cur.lastTs = now;
    if (item.pinyin) cur.pinyin = item.pinyin;
    if (item.char) cur.char = item.char;
    if (item.word) cur.word = item.word;

    // 答错 → 重新排期
    const s = nextSchedule(cur, false);
    cur.streak = s.streak;
    cur.interval = s.interval;
    cur.ease = s.ease;
    cur.due = dueAt(now, s.interval);
    cur.mastered = false;          // 又错了，谈不上掌握

    map[key] = cur;
    saveWeak(map);
  } catch (err) {
    console.warn('[storage] 易错记录失败', err && err.message);
  }
}

/**
 * 记录一次正确（用于复习后消错 + 推进间隔）
 *
 * 这是间隔重复的「答对」路径：连对 +1，间隔按 SM-2 简化版前进。
 */
export function recordWeakCorrect(item) {
  if (!item) return;
  try {
    const map = loadWeak();
    const key = item.word || item.char || '';
    if (!key || !map[key]) return;
    const cur = normalizeWeakEntry(map[key], key);
    const now = Date.now();

    cur.correct += 1;
    cur.reviewedAt = now;

    const s = nextSchedule(cur, true);
    cur.streak = s.streak;
    cur.interval = s.interval;
    cur.ease = s.ease;
    cur.due = dueAt(now, s.interval);

    // 连对到一定次数且错误率已经不高 → 标记掌握（不再出现在默认队列）
    if (cur.streak >= 4 && cur.count <= cur.correct) cur.mastered = true;

    map[key] = cur;
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

/**
 * 取得按权重排序的易错列表
 *
 * @param {object} options
 *   - limit          最多返回多少条
 *   - minCount       错误次数下限
 *   - includeMastered 是否包含已掌握的
 *   - dueOnly        只要「已到期」（间隔重复用）
 *   - now            便于测试注入时间
 */
export function getWeakList(options = {}) {
  const map = loadWeak();
  const now = Number(options.now) || Date.now();
  const limit = Math.max(1, Number(options.limit) || 50);
  const minCount = Number(options.minCount) || 1;
  const includeMastered = !!options.includeMastered;
  const dueOnly = !!options.dueOnly;

  const list = Object.values(map)
    .filter(e => e && (e.key || e.char || e.word))
    .map(e => normalizeWeakEntry(e, e.key || e.char || e.word))
    .filter(e => e.count >= minCount)
    .filter(e => includeMastered || !e.mastered)
    .filter(e => !dueOnly || e.due <= now)
    .map(e => ({
      key: e.key,
      char: e.char || '',
      word: e.word || '',
      pinyin: e.pinyin || '',
      count: e.count,
      correct: e.correct,
      lastTs: e.lastTs,
      // mastered 必须透出去：复习页要区分「已掌握」与「巩固中」，
      // 调用方用 includeMastered 取到记录后没有这个字段就没法分组。
      mastered: !!e.mastered,
      // 间隔重复调度信息，供复习页展示
      streak: e.streak,
      interval: e.interval,
      ease: round2(e.ease),
      due: e.due,
      reviewedAt: e.reviewedAt,
      dueInDays: Math.round((e.due - now) / DAY_MS * 10) / 10,
      isDue: e.due <= now,
      errorRate: e.count > 0 ? e.count / (e.count + e.correct || 1) : 0,
      weight: weakWeight(e, now)
    }));

  // 排序：**到期优先** → 越早到期越靠前 → 权重 → 错误次数。
  //
  // 为什么到期排在 weight 前面：间隔重复的核心是「现在该复习什么」。
  // 一个错误 20 次但刚刚复习过（下次在 30 天后）的字，此刻不该挤在
  // 一个错误 3 次但已经到期、快要忘记的字前面 —— 前者很稳，后者告急。
  list.sort((a, b) =>
    (Number(b.isDue) - Number(a.isDue)) ||
    (a.due - b.due) ||
    (b.weight - a.weight) ||
    (b.count - a.count)
  );
  return list.slice(0, limit);
}

/**
 * 复习队列概览：给复习页顶部显示「今日待复习 N 项」。
 *
 * @param {number} [now]
 * @returns {{due:number, total:number, learning:number, mastered:number, nextDue:number}}
 */
export function reviewSummary(now) {
  const t = Number(now) || Date.now();
  const map = loadWeak();
  let due = 0, total = 0, learning = 0, mastered = 0, nextDue = 0;

  for (const raw of Object.values(map)) {
    if (!raw) continue;
    const e = normalizeWeakEntry(raw, raw.key || raw.char || raw.word);
    if (!e.key) continue;
    total += 1;
    if (e.mastered) { mastered += 1; continue; }
    // 已掌握的不参与到期统计（它已经不排队了）
    if (e.due <= t) due += 1;
    else if (!nextDue || e.due < nextDue) nextDue = e.due;
    if (e.streak >= 1) learning += 1;
  }

  return { due, total, learning, mastered, nextDue };
}

/** 仅供测试：把所有记录的 due 直接改成某个时间，便于构造「到期」场景 */
export function _setAllDue(ts) {
  const map = loadWeak();
  for (const k of Object.keys(map)) {
    map[k] = normalizeWeakEntry(map[k], k);
    map[k].due = Number(ts) || 0;
  }
  saveWeak(map);
}

function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
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
    // 两边都删：降级期间 localStorage 里可能还留着老现场，
    // 只删内存会造成「点了清除，刷新后又提示继续练习」。
    try { window.localStorage.removeItem(KEYS.resume); } catch (_) {}
    memoryStore.delete(KEYS.resume);
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
 * 导入数据（合并语义：设置被覆盖；历史追加并按 id+时间戳去重；
 * 日报、易错表、键位错误在合并后**由合并结果重新推导**）
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
    let mergedHistory = null;   // 不为 null 表示本次动过 history

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
      mergedHistory = merged.slice(-2000);
      writeJSON(KEYS.history, mergedHistory);
      n += add.length;
    }

    /* 日报：不再逐字段取较大值。
       取较大值是为了防「重复导入同一备份」导致数据膨胀，但代价是
       两台设备同一天各有记录时会把总量**少算**，而 history 本身是相加
       合并的，于是日报和历史对不上。
       正确做法是：历史合并完之后，日报由历史重新推导 —— 单一数据源。 */
    if (mergedHistory) {
      // 老备份 / 本地旧数据里可能有 daily 独有的日期（历史被裁剪过，
      // 或来自更早的版本）。这类日期在历史里重建不出来，必须原样保留，
      // 否则用户导入一次就发现几天记录凭空消失。
      // 来源有两处：本地已有的 daily，以及本次备份自己的 daily。
      const staleDaily = loadDaily();
      const incomingDaily = (payload.daily && typeof payload.daily === 'object') ? payload.daily : {};
      const keepMap = {};
      for (const [k, v] of Object.entries(staleDaily)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && v && typeof v === 'object') keepMap[k] = v;
      }
      for (const [k, v] of Object.entries(incomingDaily)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== 'object') continue;
        // 两边都有时逐字段取较大值（我们没有原始记录，无法相加，
        // 只能保守地保留「更完整」的那份）
        if (!keepMap[k]) { keepMap[k] = Object.assign(emptyDay(k), v, { date: k }); continue; }
        for (const f of DAILY_ADD_FIELDS) {
          keepMap[k][f] = Math.max(Number(keepMap[k][f]) || 0, Number(v[f]) || 0);
        }
        keepMap[k].bestSpeed = Math.max(Number(keepMap[k].bestSpeed) || 0, Number(v.bestSpeed) || 0);
      }
      const keepKeys = Object.keys(keepMap)
        .filter(k => !mergedHistory.some(r => r && r.date === k));
      const rebuilt = rebuildDailyFromHistory(mergedHistory, keepKeys);
      // 把保留键的数据盖回去（rebuild 只会给它们建空桶）
      for (const k of keepKeys) rebuilt[k] = Object.assign(rebuilt[k], keepMap[k]);
      writeJSON(KEYS.daily, rebuilt);
    } else if (payload.daily && typeof payload.daily === 'object') {
      // 备份里只有 daily、没有 history：没有原始记录可推导，只能按日期并集保留
      // （并按需把缺字段补成统一形状）。取较大值在这里仍然不对，
      // 但两份「聚合值」之间本来就没有可靠的合并方式，宁可保留本地已知值。
      const cur = loadDaily();
      for (const [k, v] of Object.entries(payload.daily)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
        if (!v || typeof v !== 'object') continue;
        if (!cur[k]) { cur[k] = Object.assign(emptyDay(k), v, { date: k }); continue; }
        for (const f of DAILY_ADD_FIELDS) {
          cur[k][f] = Math.max(Number(cur[k][f]) || 0, Number(v[f]) || 0);
        }
        cur[k].bestSpeed = Math.max(Number(cur[k].bestSpeed) || 0, Number(v.bestSpeed) || 0);
      }
      writeJSON(KEYS.daily, cur);
    }

    // 易错字词：count / correct 是累计「次数」，与历史一样属于可加量，
    // 所以这里用**相加**而不是取较大值 —— 两台设备各自记过同一个字，
    // 合并后应该反映两边的总错误次数，取较大值会少算。
    // 重复导入同一份备份的场景交给上面的 history 去重兜底：只要能对上
    // 时间戳/ID，就不会被重复累加。
    //
    // 复习调度字段（streak / ease / due）**不累加**，只取「更靠后的那次复习」：
    // 调度是状态而不是计数，两台设备各自排过期的，以进度更超前的一方为准，
    // 否则同一份进度会来回互相拉扯（今天推到 7 天、明天又被另一台拉回 3 天）。
    if (payload.weak && typeof payload.weak === 'object') {
      const cur = loadWeak();
      for (const [k, v] of Object.entries(payload.weak)) {
        if (!v || typeof v !== 'object') continue;
        if (!cur[k]) { cur[k] = Object.assign({}, v); continue; }
        cur[k].count = (cur[k].count || 0) + (v.count || 0);
        cur[k].correct = (cur[k].correct || 0) + (v.correct || 0);
        cur[k].lastTs = Math.max(cur[k].lastTs || 0, v.lastTs || 0);

        const a = normalizeWeakEntry(cur[k], k);
        const b = normalizeWeakEntry(v, k);
        // 取「间隔更长 / 进度更靠前」的调度状态，其余字段保留本地
        const ahead = (b.interval || 0) > (a.interval || 0) ? b : a;
        cur[k].streak = ahead.streak;
        cur[k].interval = ahead.interval;
        cur[k].ease = ahead.ease;
        cur[k].due = Math.max(a.due || 0, b.due || 0);
        cur[k].reviewedAt = Math.max(a.reviewedAt || 0, b.reviewedAt || 0);
        // 两边都掌握了才算掌握；只要还有一边在复习队列里，就继续排期
        cur[k].mastered = !!(a.mastered && b.mastered);
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
    // 两处都要清：降级期间 localStorage 里可能还留着配额满之前的老副本，
    // 只清 memoryStore 会导致「清空后刷新页面，老数据又回来了」。
    for (const k of Object.values(KEYS)) {
      try { window.localStorage.removeItem(k); } catch (_) {}
      memoryStore.delete(k);
    }
    memoryStore.clear();
    // 用户清空数据后大概率是空间已经腾出来了，顺手尝试恢复落盘能力。
    // 失败也无妨：下一次写入会自动再试。
    if (storageAvailable === 'quota-memory') recoverStorage();
    return true;
  } catch (err) {
    console.warn('[storage] 清空失败', err && err.message);
    return false;
  }
}

/**
 * 存储占用估算（字节，UTF-16 按 2 字节/字符粗略计）。
 *
 * 降级期间只报内存占用 + localStorage 里残留的老数据 —— 两者都算上，
 * 否则用户在设置页会看到「0 KB」而误以为数据没了。
 */
export function storageUsage() {
  let bytes = 0;
  try {
    for (const k of Object.values(KEYS)) {
      try {
        const v = window.localStorage.getItem(k);
        if (v) bytes += v.length * 2;
      } catch (_) { /* 读取被拒时跳过 */ }
    }
    for (const [k, v] of memoryStore) {
      if (Object.values(KEYS).includes(k)) bytes += String(v).length * 2;
    }
  } catch (_) {}
  return bytes;
}
