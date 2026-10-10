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
  keyTimings: `${NS}.keyTimings`, // 键维度按键耗时样本（慢键诊断用）
  resume: `${NS}.resume`,       // 未完成的练习现场
  device: `${NS}.device`,       // 错题计数的设备来源（不随备份覆盖）
  recent: `${NS}.recent`,       // 最近实际展示的练习内容
  shelf: `${NS}.shelf`,         // 个人文本书架（多份自定义跟打材料）
  course: `${NS}.course`,       // 新手引导课程的进度
  version: `${NS}.version`
};

export const DATA_VERSION = 3;

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
        memoryStore.delete(key);
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
    // 成功落盘后必须清掉同一键的内存副本。
    //
    // 为什么：readRaw 是**内存优先**的。内存副本只在「写入失败」时产生，
    // 但一旦产生，若之后同键的写入成功落盘而没有删掉旧副本，
    // 读路径会永远命中内存里的老值 —— 表现为「明明保存了 50，
    // 页面读出来还是 10」，而且怎么改设置都不生效。
    // 不变量：memoryStore 里只允许存在「尚未成功落盘」的值。
    memoryStore.delete(key);
    return true;
  } catch (err) {
    console.warn('[storage] 写入失败', key, err && err.message);
    if (isQuotaError(err) && !pruneInFlight) {
      // 配额超限：清理老记录后重试**一次**。
      //
      // 为什么要有 pruneInFlight 守卫：pruneHistory 内部也要写回裁剪后的
      // 历史（writeJSON → writeRaw），如果这次写回又撞配额，就会再次走到
      // 这里再清理一次 —— 清理触发清理，无递归归无递归地烧掉几千次写入
      // （实测一次保存触发约 4800 次 setItem）。守卫保证整条调用链里
      // **最多只做一次清理**：嵌套的写入直接走内存兜底。
      pruneInFlight = true;
      try {
        pruneHistory(200);
        window.localStorage.setItem(key, str);
        memoryStore.delete(key);
        return true;
      } catch (e2) {
        console.warn('[storage] 清理后仍写入失败，转为内存存储', e2 && e2.message);
        memoryStore.set(key, str);
        degradeToMemory('quota');
        return false;
      } finally {
        pruneInFlight = false;
      }
    }
    // 非配额错误（隐私模式、键名非法等）：同样不能只写内存就完事，
    // 必须连读路径一起切过去，否则这份数据当场就丢。
    memoryStore.set(key, str);
    degradeToMemory(err && err.message);
    return false;
  }
}

/**
 * 配额重试守卫：true 表示当前调用链已经在做「清理后重试」，
 * 嵌套的写入不得再次触发清理（否则清理自己触发的写入会无限递归）。
 */
let pruneInFlight = false;

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
  charTier: '1',       // 单字默认从高频字开始，可选固定档位或渐进
  trainingPolicy: 'full',
  phraseCategory: 'all',
  phraseLength: 'all',
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
  /* 主题。'auto' 跟随系统 prefers-color-scheme；
     'light'/'dark' 是用户显式覆盖（有些系统是浅色但用户想夜里练）。
     实际生效的属性是 <html data-theme>，由 main.js::applyTheme 写入。 */
  theme: 'auto',
  /* 复习队列：是否只练「到期」的错题（间隔重复）。false = 练全部易错项 */
  reviewDueOnly: true,
  /* 每日目标。0 = 不设目标（不显示进度条）。
     打字练习最容易半途而废，而「连续天数」只有断了才痛 ——
     需要一个「今天还没达标」的软提醒。两个维度都要：
     字数反映练习量，次数反映「有坐下来练」这件事本身。 */
  dailyGoalChars: 300,
  dailyGoalSessions: 1,
  /* 自定义文本内容。跟打自己的材料 —— 内置语料练到头之后，
     边际收益趋近于零。存进设置而不是单独的 key，是为了跟着
     「导出数据」一起备份：用户辛苦粘的长文不该导出时丢掉。
     上限 20000 字（见 clampText），足够一整章小说，
     再长会把 localStorage 撑爆。 */
  customText: '',
  /* 旧数据迁移旗标：customText 已被搬进书架后置 true，
     防止「用户删掉那条条目」又被迁移逻辑塞回来（删除是明确决定）。
     见 migrateCustomTextToShelf()。 */
  shelfMigrated: false,
  /* 语音朗读。默认关闭，理由与音效相同（打字练习本来就有环境音）。
     打开后，「只听声母 / 只听韵母」会真正朗读音节 ——
     没有中文语音包的机器上会自动降级并如实告知，不会变成哑巴按钮。 */
  speech: false,
  /* 朗读语速。教学场景略慢于常速，0.85 是「听得清」与「不拖沓」的折中。 */
  speechRate: 0.85,
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
  trainingPolicy: ['full', 'progressive', 'pinyin', 'independent'],
  phraseCategory: ['all', 'daily', 'office', 'travel', 'idiom'],
  phraseLength: ['all', '2', '3', '4'],
  charTier: ['progressive', '1', '2', '3', '4', '5', '6', '7'],
  reduceMotion: ['auto', 'on', 'off'],
  theme: ['auto', 'light', 'dark']
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
  merged.count = normalizeCount(merged.count);
  /* 每日目标是数值型，上面那张表只管枚举。负数字数会让进度条算成
     负数百分比（宽度 -30%），所以在这里夹到 [0, 上限]。
     上限取 100 万：再多的目标不是目标，是笔误。 */
  merged.dailyGoalChars = clampInt(merged.dailyGoalChars, 0, 1000000);
  merged.dailyGoalSessions = clampInt(merged.dailyGoalSessions, 0, 100);
  merged.customText = clampText(merged.customText);
  // 语速夹到 [0.5, 2]：低于 0.5 慢到失真，高于 2 听不清声母
  merged.speechRate = clampNum(merged.speechRate, 0.5, 2, 0.85);
  return merged;
}

/** 取整并夹到 [lo, hi]；非有限数回落到 lo（0 = 不设目标） */
function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 截断自定义文本。
 *
 * 上限 20000 字符：一整章小说的量级。再长的话 localStorage 单键
 * 5MB 的限制就危险了（中文字符 UTF-16 占 2 字节，2 万字约 40KB，
 * 留足余量给历史记录）。超长直接截断而不是拒绝 ——
 * 用户粘了一本书的话，「截断后能用」比「报错什么也做不了」友好。
 *
 * 非字符串一律归零：导入的备份可能带 null / 数字 / 对象。
 */
function clampText(v) {
  if (typeof v !== 'string') return '';
  const arr = Array.from(v);
  return arr.length > 20000 ? arr.slice(0, 20000).join('') : v;
}

/** 小数夹取；非有限数回落 fallback（与 clampInt 同属「把脏值挡在门外」） */
function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function saveSettings(settings) {
  const safe = Object.assign({}, DEFAULT_SETTINGS);
  if (settings && typeof settings === 'object') Object.assign(safe, settings);
  safe.count = normalizeCount(safe.count);
  // 与 loadSettings 同口径：写进去的也必须是干净的，否则下次读出来才发现
  safe.dailyGoalChars = clampInt(safe.dailyGoalChars, 0, 1000000);
  safe.dailyGoalSessions = clampInt(safe.dailyGoalSessions, 0, 100);
  safe.customText = clampText(safe.customText);
  safe.speechRate = clampNum(safe.speechRate, 0.5, 2, 0.85);
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
    reviewedAt: num(e.reviewedAt),
    successDay: typeof e.successDay === 'string' ? e.successDay : '',
    countsBySource: weakSources(e)
  };
  base.count = Object.values(base.countsBySource).reduce((sum, value) => sum + value.count, 0);
  base.correct = Object.values(base.countsBySource).reduce((sum, value) => sum + value.correct, 0);
  // 老数据没有 due：补成「已到期」，让它进入待复习队列。
  // 这是有意为之 —— 升级后用户应该看到历史错题重新排队，
  // 而不是因为缺字段而被静默忽略。
  if (!base.due) base.due = base.lastTs ? base.lastTs + NEW_DUE_MS : Date.now();
  return base;
}

// 每个来源是单调增长的计数器，合并时取 max，再求和。
// 老备份没有来源编号，用稳定的快照身份兼容重复导入。
function weakSources(e) {
  const sources = {};
  if (e.countsBySource && typeof e.countsBySource === 'object') {
    for (const [id, value] of Object.entries(e.countsBySource)) {
      if (!value || typeof value !== 'object') continue;
      sources[id] = { count: Math.max(0, num(value.count)), correct: Math.max(0, num(value.correct)) };
    }
  }
  if (!Object.keys(sources).length) {
    const id = `legacy:${num(e.lastTs)}:${num(e.reviewedAt)}:${num(e.count)}:${num(e.correct)}`;
    sources[id] = { count: Math.max(0, num(e.count)), correct: Math.max(0, num(e.correct)) };
  }
  return sources;
}

function incrementWeak(entry, field) {
  let device = readJSON(KEYS.device, null);
  if (typeof device !== 'string' || !device) {
    device = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    writeJSON(KEYS.device, device);
  }
  const id = `device:${device}`;
  const counter = entry.countsBySource[id] || { count: 0, correct: 0 };
  counter[field] += 1;
  entry.countsBySource[id] = counter;
  entry[field] += 1;
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

    incrementWeak(cur, 'count');
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

    // 同一天的重复练习不代表已经形成长期记忆。
    const today = dateStr(new Date(now));
    if (cur.successDay === today) return;
    incrementWeak(cur, 'correct');
    cur.reviewedAt = now;
    cur.successDay = today;

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
const KEY_ERROR_MODES_MAX = 12;    // 按模式的累计表最多保留 12 种模式

export function loadKeyErrors() {
  const obj = readJSON(KEYS.keyErrors, null);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { all: {}, byMode: {}, recent: [] };
  }
  const all = (obj.all && typeof obj.all === 'object' && !Array.isArray(obj.all)) ? obj.all : {};
  const byMode = (obj.byMode && typeof obj.byMode === 'object' && !Array.isArray(obj.byMode)) ? obj.byMode : {};
  const recent = Array.isArray(obj.recent) ? obj.recent.filter(s => s && typeof s === 'object') : [];
  return { all, byMode, recent };
}

/**
 * 合并一次会话的键错误明细
 * @param {object} keyErrors { 小写键: 次数 }
 * @param {string} [mode] 本次练习的模式，用于统计页的「按模式查看」
 * @returns {boolean} 是否写入成功
 */
export function recordKeyErrors(keyErrors, mode = '') {
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
    // 按模式的累计。统计页的模式筛选要覆盖热力图，就必须有这一层 ——
    // 否则选中「词组」时热力图仍是全模式的数字，看起来像筛选失灵。
    // 老数据没有这层，按模式筛选时只能退回全量（见 getKeyErrorTotals）。
    const modeKey = String(mode || '').trim();
    if (modeKey) {
      const bucket = (data.byMode[modeKey] && typeof data.byMode[modeKey] === 'object') ? data.byMode[modeKey] : {};
      for (const [k, n] of Object.entries(clean)) {
        bucket[k] = (Number(bucket[k]) || 0) + n;
      }
      data.byMode[modeKey] = bucket;
      const names = Object.keys(data.byMode);
      if (names.length > KEY_ERROR_MODES_MAX) {
        // 模式是固定枚举（8 个），12 足够；超了只可能是脏数据
        names.filter(nm => nm !== modeKey).slice(0, names.length - KEY_ERROR_MODES_MAX)
          .forEach(nm => delete data.byMode[nm]);
      }
    }
    // 明细（用于「最近 N 次」范围）
    data.recent.push({ ts: Date.now(), keys: clean, total, mode: modeKey });
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
 * @param {string} [mode] 按模式过滤（'all' 或省略 = 不限）
 * @returns {{counts:Object<string,number>, sessions:number, total:number, byMode:boolean}}
 *   byMode=false 表示该模式下**没有**专属数据（老版本记录没带模式），
 *   调用方应如实说明「本次按全量统计」，而不是让用户以为筛选生效了。
 */
export function getKeyErrorTotals(range = 'all', mode = 'all') {
  const data = loadKeyErrors();
  const counts = {};
  let sessions = 0;
  let byMode = false;
  const wantMode = mode && mode !== 'all' ? String(mode) : '';

  if (range === 'all') {
    if (wantMode) {
      const bucket = data.byMode[wantMode];
      if (bucket && typeof bucket === 'object') {
        byMode = true;
        for (const [k, v] of Object.entries(bucket)) {
          const n = Number(v) || 0;
          if (n > 0) counts[k] = n;
        }
      }
      // 没有该模式的专属数据 → 退回全量，但 byMode 保持 false 供 UI 说明
      if (!byMode) {
        for (const [k, v] of Object.entries(data.all)) {
          const n = Number(v) || 0;
          if (n > 0) counts[k] = n;
        }
      }
    } else {
      for (const [k, v] of Object.entries(data.all)) {
        const n = Number(v) || 0;
        if (n > 0) counts[k] = n;
      }
    }
    sessions = data.recent.length;
  } else {
    const n = Math.max(1, parseInt(range, 10) || 10);
    let slice = data.recent.slice(Math.max(0, data.recent.length - n));
    if (wantMode) {
      const filtered = slice.filter(s => s && s.mode === wantMode);
      if (filtered.length) {
        byMode = true;
        slice = filtered;
      } else {
        // 近 N 次里恰好没有该模式的记录：宁可退回这 N 次的全量，
        // 也不要返回空图让用户以为「这个模式最近没按错键」
      }
    }
    for (const s of slice) {
      for (const [k, v] of Object.entries((s && s.keys) || {})) {
        counts[k] = (counts[k] || 0) + (Number(v) || 0);
      }
    }
    sessions = slice.length;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, sessions, total, byMode };
}

/** 全部记录里的总错误数（用于卡片展示） */
export function keyErrorGrandTotal() {
  const data = loadKeyErrors();
  return Object.values(data.all).reduce((a, b) => a + (Number(b) || 0), 0);
}

export function clearKeyErrors() {
  writeJSON(KEYS.keyErrors, { all: {}, byMode: {}, recent: [] });
}

/* ============================================================
   键维度按键耗时（反应时间）
   ------------------------------------------------------------
   与 keyErrors 同构但**分开存**，因为两者回答的是不同问题：
     keyErrors  = 哪些键按错（错得出来）
     keyTimings = 哪些键按得慢（对但犹豫，且早于错误出现）
   混在一张表里就分不清「这个键我不会」和「这个键我还不熟」。

   存的是**每键每桶的有界样本池**（FIFO，最近 N 次），不是均值也不是
   累加秒数：中位数必须由原始样本算，累加值算不出中位数，而均值会被
   偶尔的走神彻底带偏。有界是为了不让 localStorage 无限增长。
   ============================================================ */

/** 单桶样本上限（与 KEY_TIMING.storedPerBucket 对应，此处独立一份避免循环依赖） */
const KEY_TIMING_STORED_MAX = 60;
/** 最近 N 次会话的中位数明细上限，用于范围切换 */
const KEY_TIMING_RECENT_MAX = 30;
/** 单键名的合法形态：单个大写字母 */
const KEY_TIMING_KEY_RE = /^[A-Z]$/;
/** 记住最近若干份备份的指纹，用来识别「同一份备份又导了一次」 */
const KEY_TIMING_SIG_MAX = 5;

/** 32 位 FNV-1a：给一段样本池算个短指纹。只用于判重，不做安全用途。 */
function sampleSignature(src) {
  let h = 0x811c9dc5;
  const s = JSON.stringify(src || {});
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * 中位数。
 *
 * 放在 storage 而不是 stats：stats.js 依赖 storage.js，反向依赖会成环。
 * 它本身就是数据层的归约操作，归约样本池时要用，两边都得用。
 *
 * @param {number[]} list 已排序或未排序均可；空数组返回 0
 * @returns {number} 偶数个样本取中间两数的平均（向上取整到整毫秒）
 */
export function median(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  const nums = [];
  for (const v of list) {
    const n = Number(v);
    if (Number.isFinite(n)) nums.push(n);
  }
  if (!nums.length) return 0;
  nums.sort((a, b) => a - b);
  const mid = nums.length >> 1;
  if (nums.length % 2 === 1) return Math.round(nums[mid]);
  return Math.round((nums[mid - 1] + nums[mid]) / 2);
}

/** 把任意输入压成 { K: { lead:[], follow:[] } }，逐样本清洗 */
function normalizeKeyTimings(src) {
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const [k, rec] of Object.entries(src)) {
    const key = String(k || '').toUpperCase();
    if (!KEY_TIMING_KEY_RE.test(key)) continue;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const lead = sanitizeMsList(rec.lead);
    const follow = sanitizeMsList(rec.follow);
    if (lead.length || follow.length) out[key] = { lead, follow };
  }
  return out;
}

/** 清洗 + FIFO 截断到上限（升序返回，便于直接取中位数） */
function sanitizeMsList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const n = Math.round(Number(v));
    // 上限与引擎的 KEY_TIMING.maxMs 一致：超过 5 秒的等待不是「犹豫」，
    // 是「人不在」，留着只会污染中位数。
    if (!Number.isFinite(n) || n <= 0 || n > 5000) continue;
    out.push(n);
  }
  if (out.length > KEY_TIMING_STORED_MAX) out.splice(0, out.length - KEY_TIMING_STORED_MAX);
  out.sort((a, b) => a - b);
  return out;
}

/** byMode 的键是**模式 id**（char/phrase/…），不是单字母键 ——
 *  所以不能直接套 normalizeKeyTimings（那会按单字母正则校验模式名，
 *  把整层 byMode 悄悄抹掉 —— 按模式筛选于是永远退回全量）。
 *  这里逐个模式各自清洗内层。 */
function normalizeKeyTimingsByMode(src) {
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const [mode, rec] of Object.entries(src)) {
    const m = String(mode || '').trim();
    if (!m) continue;
    const inner = normalizeKeyTimings(rec);
    if (Object.keys(inner).length) out[m] = inner;
  }
  return out;
}

export function loadKeyTimings() {
  const obj = readJSON(KEYS.keyTimings, null);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { all: {}, byMode: {}, recent: [], sigs: [] };
  }
  return {
    all: normalizeKeyTimings(obj.all),
    byMode: normalizeKeyTimingsByMode(obj.byMode),
    recent: Array.isArray(obj.recent)
      ? obj.recent.filter(s => s && typeof s === 'object').slice(-KEY_TIMING_RECENT_MAX)
      : [],
    sigs: Array.isArray(obj.sigs) ? obj.sigs.filter(x => typeof x === 'string') : []
  };
}

/**
 * 合并一次会话的按键耗时样本
 * @param {object} keyTimings { K: { lead:[ms], follow:[ms] } }
 * @param {string} [mode] 本次练习的模式
 * @returns {boolean} 是否写入成功
 */
export function recordKeyTimings(keyTimings, mode = '') {
  const clean = normalizeKeyTimings(keyTimings);
  let total = 0;
  for (const rec of Object.values(clean)) total += rec.lead.length + rec.follow.length;
  if (!total) return false;

  try {
    const data = loadKeyTimings();
    const merge = (bucket) => {
      for (const [k, rec] of Object.entries(clean)) {
        const dst = bucket[k] || (bucket[k] = { lead: [], follow: [] });
        for (const b of ['lead', 'follow']) {
          if (!rec[b].length) continue;
          dst[b] = sanitizeMsList(dst[b].concat(rec[b]));
        }
      }
    };
    merge(data.all);
    // 与 keyErrors 一致地带上模式：统计页的模式筛选必须同时覆盖
    // 「错得多」和「按得慢」两层，否则筛选看着生效了其实只筛了一半。
    const modeKey = String(mode || '').trim();
    if (modeKey) {
      const bucket = (data.byMode[modeKey] && typeof data.byMode[modeKey] === 'object')
        ? data.byMode[modeKey] : {};
      merge(bucket);
      data.byMode[modeKey] = bucket;
      const names = Object.keys(data.byMode);
      if (names.length > 12) {
        names.filter(nm => nm !== modeKey).slice(0, names.length - 12).forEach(nm => delete data.byMode[nm]);
      }
    }
    /* 范围切换用的明细：**只存中位数**，不存原始样本。
     * 「最近 N 次」要的是这 N 次里这个键有多慢，中位数的中位数已经够用，
     * 而原始样本 × 30 次会让这块数据比累计池还大，得不偿失。 */
    const snapshot = {};
    for (const [k, rec] of Object.entries(clean)) {
      const leadM = median(rec.lead);
      const followM = median(rec.follow);
      snapshot[k] = { lead: leadM || 0, follow: followM || 0 };
    }
    data.recent.push({ ts: Date.now(), mode: modeKey, keys: snapshot });
    if (data.recent.length > KEY_TIMING_RECENT_MAX) {
      data.recent = data.recent.slice(data.recent.length - KEY_TIMING_RECENT_MAX);
    }
    return writeJSON(KEYS.keyTimings, data);
  } catch (err) {
    console.warn('[storage] 按键耗时记录失败', err && err.message);
    return false;
  }
}

/**
 * 取按键耗时汇总（供统计页的「慢键」层与结算面板使用）
 *
 * range='all' 时读累计样本池（真中位数）；range='30'/'10' 时读最近 N 次的
 * 中位数明细（中位数的中位数）。后者不是严格的合并中位数，但对「谁更慢」
 * 的排序结论一致，且省一个数量级的存储 —— 这个取舍写在这里是为了让后来人
 * 知道它是**有意的近似**，而不是偷懒。
 *
 * @param {string} range 'all' | '30' | '10'
 * @param {string} [mode] 'all' 或省略 = 不限
 * @returns {{items:Array, sessions:number, byMode:boolean}}
 */
export function getKeyTimings(range = 'all', mode = 'all') {
  const data = loadKeyTimings();
  const wantMode = mode && mode !== 'all' ? String(mode) : '';
  let byMode = false;

  if (range === 'all') {
    let src = data.all;
    if (wantMode) {
      const bucket = data.byMode[wantMode];
      // 老数据没有这层 → 退回全量，但 byMode 保持 false 供 UI 如实说明，
      // 与 getKeyErrorTotals 的处理一致。
      if (bucket && Object.keys(bucket).length) { src = bucket; byMode = true; }
    }
    const items = [];
    for (const [k, rec] of Object.entries(src)) {
      const lead = sanitizeMsList(rec.lead);
      const follow = sanitizeMsList(rec.follow);
      const samples = lead.length + follow.length;
      if (!samples) continue;
      items.push({ key: k, samples, leadMs: median(lead), followMs: median(follow), medianMs: median(lead.concat(follow)) });
    }
    return { items, sessions: data.recent.length, byMode };
  }

  const n = Math.max(1, parseInt(range, 10) || 10);
  let slice = data.recent.slice(Math.max(0, data.recent.length - n));
  if (wantMode) {
    const filtered = slice.filter(s => s.mode === wantMode);
    if (filtered.length) { slice = filtered; byMode = true; }
    // 该范围内没有该模式的记录 → 保留这 N 次的全量，但 byMode 仍为 false
  }
  const acc = {};
  for (const s of slice) {
    for (const [k, rec] of Object.entries((s && s.keys) || {})) {
      const dst = acc[k] || (acc[k] = { lead: [], follow: [], n: 0 });
      for (const b of ['lead', 'follow']) {
        const m = Math.round(Number(rec && rec[b]));
        if (!Number.isFinite(m) || m <= 0 || m > 5000) continue;
        dst[b].push(m);
      }
      dst.n += 1;
    }
  }
  const items = [];
  for (const [k, rec] of Object.entries(acc)) {
    if (!rec.lead.length && !rec.follow.length) continue;
    items.push({ key: k, samples: rec.n, leadMs: median(rec.lead), followMs: median(rec.follow), medianMs: median(rec.lead.concat(rec.follow)) });
  }
  return { items, sessions: slice.length, byMode };
}

export function clearKeyTimings() {
  writeJSON(KEYS.keyTimings, { all: {}, byMode: {}, recent: [], sigs: [] });
}

/** 单次会话内最慢的若干个键（结算面板用，纯内存计算，不落盘） */
export function slowestKeys(keyTimings, opts = {}) {
  const min = Math.max(1, Math.floor(Number(opts.min)) || 5);
  const top = Math.max(1, Math.floor(Number(opts.top)) || 5);
  const src = normalizeKeyTimings(keyTimings);
  const rows = [];
  for (const [key, rec] of Object.entries(src)) {
    const lead = sanitizeMsList(rec.lead);
    const follow = sanitizeMsList(rec.follow);
    const samples = lead.length + follow.length;
    if (!samples) continue;
    rows.push({ key, samples, medianMs: median(lead.concat(follow)), leadMs: median(lead), followMs: median(follow) });
  }
  // 样本不足的键不参与排序：中位数在 2 个样本上完全不可靠，
  // 排进来只会让「最慢的键」变成「碰巧只按过两次的键」。
  const eligible = rows.filter(r => r.samples >= min).sort((a, b) => b.medianMs - a.medianMs);
  return {
    items: eligible.slice(0, top),
    eligible: eligible.length,
    // 被门槛挡下的键：如实告知有几个样本太少，免得用户以为「只有这几个慢」
    thin: rows.filter(r => r.samples < min).length,
    total: rows.length,
    min,
    all: rows
  };
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
    questionOffset: state.questionOffset,
    unlimited: state.unlimited,
    generation: state.generation,
    generationState: state.generationState,
    training: state.training,
    unitStartedAt: state.unitStartedAt,
    charIndex: state.charIndex,
    keyIndex: state.keyIndex,
    typed: state.typed,
    erroredChars: state.erroredChars,
    hintedMarks: state.hintedMarks,
    skipped: state.skipped,
    elapsedSec: state.elapsedSec,
    stats: state.stats,
    settings: state.settings,
    /* 会话归属：这份现场属于书架里的哪份材料、哪门课，以及书架续打的
       段基数。没有它们，「练到一半刷新 → 续练 → 打完」这一局就成了
       无主的成绩 —— 书架统计不更新、课程不判晋级（上报的 P1 缺陷）。
       字段是可选的：旧存档没有就当无归属，行为与从前一致。 */
    shelfId: (typeof state.shelfId === 'string' && state.shelfId) || undefined,
    courseLessonId: (typeof state.courseLessonId === 'string' && state.courseLessonId) || undefined,
    shelfSegBase: Number.isFinite(Number(state.shelfSegBase)) ? Math.max(0, Math.floor(Number(state.shelfSegBase))) : undefined
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

/* ============================================================
   个人文本书架
   ============================================================ */

/**
 * 一份书架条目。升级自「单个可覆盖的 customText」——用户粘的第二篇
 * 不该把第一篇冲掉。
 *
 *   id          稳定标识（随机串），备份合并按它判重
 *   title       显示名（默认「未命名材料」）
 *   tags        自由标签（如 ['小说','工作']），最多 6 个
 *   text        正文（与 settings.customText 同一个 20000 字上限）
 *   createdAt   加入时间
 *   lastAt      最近一次练习时间（0 = 还没练过）
 *   progress    最近练到哪：{ segIndex, segCount }（切段口径与跟打一致）
 *   stats       本材料自己的累计：按「速度按时长、正确率按字数」加权
 */
/**
 * 条目 id 的合法形态。id 会被写进 DOM 属性（书架列表的 data-id），
 * 曾经验证过：不设白名单的话，一份恶意构造的备份能让 id 带上
 * `"><img onerror=...>`，渲染时直接变成可执行脚本。
 * 白名单是最靠得住的一道闸 —— 字符集之外的一律重新生成，
 * 而不是试着「转义」；转义只能证明当前渲染点安全，拦不住下一个调用方。
 */
const SHELF_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
function genShelfId() {
  return `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e12).toString(36)}`;
}

function normalizeShelfEntry(raw) {
  const e = (raw && typeof raw === 'object') ? raw : {};
  const st = (e.stats && typeof e.stats === 'object') ? e.stats : {};
  const pr = (e.progress && typeof e.progress === 'object') ? e.progress : {};
  const tags = Array.isArray(e.tags)
    ? e.tags.map(t => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 6)
    : [];
  const rawId = String(e.id || '');
  return {
    id: SHELF_ID_RE.test(rawId) ? rawId : genShelfId(),
    title: String(e.title || '').trim().slice(0, 60) || '未命名材料',
    tags,
    text: clampText(e.text),
    createdAt: Number(e.createdAt) || Date.now(),
    lastAt: Number(e.lastAt) || 0,
    progress: {
      segIndex: clampInt(pr.segIndex, 0, 100000),
      segCount: clampInt(pr.segCount, 0, 100000)
    },
    stats: {
      sessions: clampInt(st.sessions, 0, 1000000),
      chars: clampInt(st.chars, 0, 100000000),
      durationSum: Math.max(0, Number(st.durationSum) || 0),
      speedWSum: Math.max(0, Number(st.speedWSum) || 0),
      accWSum: Math.max(0, Number(st.accWSum) || 0),
      bestSpeed: Math.max(0, Number(st.bestSpeed) || 0)
    }
  };
}

/** 本材料的加权平均速度 / 正确率（给书架列表展示用） */
export function shelfEntryAverages(entry) {
  const s = (entry && entry.stats) || {};
  const speed = s.durationSum > 0 ? s.speedWSum / s.durationSum : 0;
  const acc = s.chars > 0 ? s.accWSum / s.chars : 0;
  return {
    avgSpeed: Math.round(speed * 10) / 10,
    avgAccuracy: Math.round(acc * 10) / 10,
    sessions: s.sessions || 0,
    chars: s.chars || 0
  };
}

export function loadShelf() {
  const raw = readJSON(KEYS.shelf, []);
  const list = Array.isArray(raw) ? raw : [];
  const safe = list.map(normalizeShelfEntry);
  // Persist generated ids once. Otherwise legacy/imported invalid ids would
  // get a different random replacement on every read, breaking row actions.
  if (safe.some((entry, i) => String(list[i]?.id || '') !== entry.id)) {
    writeJSON(KEYS.shelf, safe);
  }
  return safe;
}

export function saveShelf(list) {
  const safe = (Array.isArray(list) ? list : []).map(normalizeShelfEntry);
  return writeJSON(KEYS.shelf, safe);
}

export function addShelfEntry({ title, tags, text } = {}) {
  const entry = normalizeShelfEntry({ title, tags, text, createdAt: Date.now(), lastAt: 0 });
  if (!entry.text.trim()) return null;   // 空文本不给建条目
  const list = loadShelf();
  list.push(entry);
  saveShelf(list);
  return entry;
}

export function updateShelfEntry(id, patch = {}) {
  const list = loadShelf();
  const i = list.findIndex(e => e.id === id);
  if (i < 0) return null;
  const next = normalizeShelfEntry(Object.assign({}, list[i], patch, { id: list[i].id }));
  list[i] = next;
  saveShelf(list);
  return next;
}

export function removeShelfEntry(id) {
  const list = loadShelf();
  const next = list.filter(e => e.id !== id);
  if (next.length === list.length) return false;
  saveShelf(next);
  return true;
}

/**
 * 练完一份材料后回写进度与统计。
 * @param {string} id
 * @param {{segIndex?:number, segCount?:number}} progress
 * @param {{totalChars?:number, durationSec?:number, speed?:number, accuracy?:number}} summary
 */
export function touchShelfEntry(id, progress, summary) {
  const list = loadShelf();
  const i = list.findIndex(e => e.id === id);
  if (i < 0) return null;
  const e = list[i];
  const s = summary || {};
  const chars = Math.max(0, Math.floor(Number(s.totalChars) || 0));
  const dur = Math.max(0, Number(s.durationSec) || 0);
  e.stats.sessions += 1;
  e.stats.chars += chars;
  e.stats.durationSum += dur;
  e.stats.speedWSum += Math.max(0, Number(s.speed) || 0) * dur;
  e.stats.accWSum += Math.max(0, Number(s.accuracy) || 0) * chars;
  e.stats.bestSpeed = Math.max(e.stats.bestSpeed, Math.max(0, Number(s.speed) || 0));
  e.lastAt = Date.now();
  if (progress && typeof progress === 'object') {
    e.progress = {
      segIndex: clampInt(progress.segIndex, 0, 100000),
      segCount: clampInt(progress.segCount, 0, 100000)
    };
  }
  list[i] = normalizeShelfEntry(e);
  saveShelf(list);
  return list[i];
}

/** 最近练过的那份（没有则 null）——「继续上次材料」用 */
export function lastShelfEntry() {
  const list = loadShelf().filter(e => e.lastAt > 0);
  if (!list.length) return null;
  return list.reduce((a, b) => (b.lastAt > a.lastAt ? b : a));
}

/**
 * 旧数据迁移：把「单个可覆盖的 customText」放进书架。
 *
 * 触发条件刻意收得很窄：书架为空 **且** 设置里有文本 **且** 没迁移过。
 * settings.shelfMigrated 落盘后，用户就算把那条条目删了也不会再被塞回来 ——
 * 「删除」是一个明确的决定，迁移逻辑无权推翻它。
 *
 * 迁移**不**清空 settings.customText：它仍然表示「当前正要练的那份」，
 * textarea 与续练逻辑都认它。无损的含义是：文本原文进了书架，随时可删可改。
 *
 * @returns {{migrated:boolean, entry:object|null}}
 */
export function migrateCustomTextToShelf() {
  const settings = loadSettings();
  if (settings.shelfMigrated) return { migrated: false, entry: null };
  const text = String(settings.customText || '');
  if (!text.trim() || loadShelf().length > 0) {
    // 没有可迁的文本，也要把旗子立起来 —— 否则每次启动都白查一遍
    saveSettings(Object.assign({}, settings, { shelfMigrated: true }));
    return { migrated: false, entry: null };
  }
  const entry = addShelfEntry({ title: '我的文本', tags: ['迁移'], text });
  saveSettings(Object.assign({}, settings, { shelfMigrated: true }));
  return { migrated: !!entry, entry };
}

/* ============================================================
   新手引导课程进度
   ============================================================ */

/**
 * 课程进度。课程**内容**在 src/data/course.js（纯数据）；
 * 这里只存「学到哪了」：
 *   currentId   当前正在上的课（第一门未达标的课，由 core/course.js 推导）
 *   completed   已晋级的课 id 列表
 *   lessons     每门课的累计：{ attempts, bestAcc, bestInd, bestSpeed, bestChars, completedAt }
 */
export function loadCourseProgress() {
  const raw = readJSON(KEYS.course, {});
  const p = (raw && typeof raw === 'object') ? raw : {};
  const lessons = {};
  if (p.lessons && typeof p.lessons === 'object') {
    for (const [id, v] of Object.entries(p.lessons)) {
      if (!v || typeof v !== 'object') continue;
      lessons[id] = {
        attempts: clampInt(v.attempts, 0, 1000000),
        bestAcc: clampNum(v.bestAcc, 0, 100, 0),
        bestInd: clampNum(v.bestInd, 0, 100, 0),
        bestSpeed: Math.max(0, Number(v.bestSpeed) || 0),
        bestChars: clampInt(v.bestChars, 0, 1000000),
        completedAt: Number(v.completedAt) || 0
      };
    }
  }
  return {
    currentId: String(p.currentId || ''),
    completed: Array.isArray(p.completed) ? p.completed.map(String).slice(0, 100) : [],
    lessons,
    updatedAt: Number(p.updatedAt) || 0
  };
}

export function saveCourseProgress(p) {
  const cur = loadCourseProgress();
  const next = Object.assign({}, cur, p || {});
  next.completed = Array.isArray(next.completed) ? next.completed.slice(0, 100) : [];
  next.updatedAt = Date.now();
  return writeJSON(KEYS.course, next);
}

/* ============================================================
   备份导入导出
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
    keyErrors: loadKeyErrors(),
    keyTimings: loadKeyTimings(),
    // 书架与课程进度跟着走：用户整理好的材料清单和「学到第几课」
    // 与练习成绩同等重要，导出时丢掉任何一个都算数据丢失。
    shelf: loadShelf(),
    course: loadCourseProgress()
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
      const identity = r => r.id ? `id:${r.id}`
        : `legacy:${JSON.stringify([r.ts, r.mode, r.durationSec, r.totalChars, r.keystrokes, r.accuracy])}`;
      const seen = new Set(cur.map(identity));
      const add = payload.history.filter(r => {
        if (!r || typeof r !== 'object' || !Number.isFinite(Number(r.ts))) return false;
        const id = identity(r);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
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

    // 按来源合并单调计数器，同一来源取最大值，不同来源相加。
    // 排期以最新作答为准，保留重新答错后的短间隔。
    if (payload.weak && typeof payload.weak === 'object') {
      const cur = loadWeak();
      for (const [k, v] of Object.entries(payload.weak)) {
        if (!v || typeof v !== 'object') continue;
        if (!cur[k]) { cur[k] = normalizeWeakEntry(v, k); continue; }
        const a = normalizeWeakEntry(cur[k], k);
        const b = normalizeWeakEntry(v, k);
        const sources = a.countsBySource;
        for (const [id, value] of Object.entries(b.countsBySource)) {
          const old = sources[id] || { count: 0, correct: 0 };
          sources[id] = { count: Math.max(old.count, value.count), correct: Math.max(old.correct, value.correct) };
        }
        const aTime = Math.max(a.lastTs, a.reviewedAt);
        const bTime = Math.max(b.lastTs, b.reviewedAt);
        // 最新作答决定排期，同时间优先短间隔，避免掩盖重新答错。
        const ahead = bTime > aTime || (bTime === aTime && b.interval < a.interval) ? b : a;
        cur[k] = Object.assign({}, ahead, {
          countsBySource: sources,
          count: Object.values(sources).reduce((sum, value) => sum + value.count, 0),
          correct: Object.values(sources).reduce((sum, value) => sum + value.correct, 0),
          lastTs: Math.max(a.lastTs, b.lastTs)
        });
      }
      writeJSON(KEYS.weak, cur);
      n++;
    }

    // 键位错误：明细（recent）按会话时间戳去重合并；累计值（all）只接受
    // **新会话**带来的增量。
    //
    // 为什么不直接把备份里的 all 相加：all 是「全历史累计」，没有可判重的身份。
    // 同一份备份导两次，V 键 2 次会变成 4 次、6 次……热力图整体失真。
    // 而每个会话的 ts 是唯一身份 —— 只把「本地没见过的会话」的按键错误
    // 并进 all，重复导入时所有会话都已见过，什么都不加，天然幂等。
    //
    // 代价：备份里超出 recent 窗口（60 次会话）的更老历史无法参与合并
    // （宁可少算，不可重复）。老备份只有 all、没有 recent 明细时退回
    // 「本地为空则采用」的替换语义 —— 替换也是幂等的。
    if (payload.keyErrors && typeof payload.keyErrors === 'object') {
      const cur = loadKeyErrors();
      const incomingAll = payload.keyErrors.all && typeof payload.keyErrors.all === 'object'
        ? payload.keyErrors.all : {};
      const incomingRecent = Array.isArray(payload.keyErrors.recent)
        ? payload.keyErrors.recent.filter(s => s && typeof s === 'object')
        : [];

      const seenTs = new Set(cur.recent.map(s => s && s.ts));
      const fresh = incomingRecent.filter(s => s && Number(s.ts) > 0 && !seenTs.has(s.ts));

      // 按模式的累计要**跟着会话明细一起**合并，否则「按模式筛选」在导入后
      // 会莫名失效：all 增加了，byMode 没动。用与 all 完全相同的那次累加，
      // 幂等性由 seenTs 保证（同一批明细只进一次）。
      const addToMode = (mode, key, num) => {
        const modeKey = String(mode || '').trim();
        if (!modeKey) return;
        const bucket = (cur.byMode[modeKey] && typeof cur.byMode[modeKey] === 'object')
          ? cur.byMode[modeKey] : (cur.byMode[modeKey] = {});
        bucket[key] = (Number(bucket[key]) || 0) + num;
      };

      if (fresh.length) {
        for (const s of fresh) {
          const keys = (s.keys && typeof s.keys === 'object') ? s.keys : {};
          for (const [k, v] of Object.entries(keys)) {
            const key = String(k).toUpperCase();
            if (!/^[A-Z]$/.test(key)) continue;
            const num = Math.floor(Number(v)) || 0;
            if (num <= 0) continue;
            cur.all[key] = (Number(cur.all[key]) || 0) + num;
            addToMode(s.mode, key, num);
          }
          cur.recent.push(s);
          seenTs.add(s.ts);
        }
      } else if (!incomingRecent.length &&
                 Object.keys(incomingAll).length &&
                 !Object.keys(cur.all).length) {
        // 老备份只有累计没有明细，且本地也为空：直接采用（替换，幂等）
        for (const [k, v] of Object.entries(incomingAll)) {
          const key = String(k).toUpperCase();
          if (!/^[A-Z]$/.test(key)) continue;
          const num = Math.floor(Number(v)) || 0;
          if (num > 0) cur.all[key] = num;
        }
      }

      if (fresh.length) {
        cur.recent.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        if (cur.recent.length > KEY_ERROR_RECENT_MAX) {
          cur.recent = cur.recent.slice(cur.recent.length - KEY_ERROR_RECENT_MAX);
        }
        writeJSON(KEYS.keyErrors, cur);
        n++;
      } else if (Object.keys(cur.all).length) {
        // 没有新会话但可能有「老备份初始化」的写入
        writeJSON(KEYS.keyErrors, cur);
      }
    }

    /* 按键耗时：按 (ts, mode) 去重后并入样本池。
       样本是**可加的集合**（取并集后重算中位数），不像计数那样相加 ——
       把两份备份的同一次练习各加一遍，中位数不会翻倍，但会把
       「最近 N 次」的条数算错。所以仍然按时间戳去重。 */
    if (payload.keyTimings && typeof payload.keyTimings === 'object' && !Array.isArray(payload.keyTimings)) {
      const cur = loadKeyTimings();
      const incomingAll = normalizeKeyTimings(payload.keyTimings.all);
      const incomingRecent = Array.isArray(payload.keyTimings.recent)
        ? payload.keyTimings.recent.filter(s => s && typeof s === 'object') : [];
      const seenTs = new Set(cur.recent.map(s => `${s.ts}::${s.mode || ''}`));
      const fresh = incomingRecent.filter(s => {
        const id = `${s.ts}::${s.mode || ''}`;
        if (seenTs.has(id)) return false;
        seenTs.add(id);
        return true;
      });

      const merge = (bucket, src) => {
        for (const [k, rec] of Object.entries(src)) {
          const dst = bucket[k] || (bucket[k] = { lead: [], follow: [] });
          for (const b of ['lead', 'follow']) if (rec[b].length) dst[b] = sanitizeMsList(dst[b].concat(rec[b]));
        }
      };
      /* 累计样本池是**并集**，不能无条件并入 —— 同一份备份导两次会把
         样本数翻倍（中位数不变，但样本数会骗人）。
         判据用**备份指纹**：样本池内容和之前导入过的那几份完全相同，就是
         重复导入。只用「本地非空就跳过」会把另一份**不同**备份的数据也丢掉；
         只用「有新明细就并入」则对没有明细的老备份完全失效。 */
      const sig = sampleSignature(incomingAll);
      const alreadyMerged = cur.sigs.includes(sig);
      if (!alreadyMerged && (fresh.length > 0 || Object.keys(incomingAll).length)) {
        merge(cur.all, incomingAll);
        for (const [mode, src] of Object.entries(payload.keyTimings.byMode || {})) {
          const b = (cur.byMode[mode] && typeof cur.byMode[mode] === 'object') ? cur.byMode[mode] : {};
          merge(b, normalizeKeyTimings(src));
          cur.byMode[mode] = b;
        }
        cur.sigs.push(sig);
        if (cur.sigs.length > KEY_TIMING_SIG_MAX) {
          cur.sigs = cur.sigs.slice(cur.sigs.length - KEY_TIMING_SIG_MAX);
        }
      }
      for (const s of fresh) cur.recent.push(s);
      cur.recent.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (cur.recent.length > KEY_TIMING_RECENT_MAX) {
        cur.recent = cur.recent.slice(cur.recent.length - KEY_TIMING_RECENT_MAX);
      }
      writeJSON(KEYS.keyTimings, cur);
      n++;
    }

    /* 书架：按条目 id 判重。同 id 取「最近动过的」那份（lastAt / createdAt
       较新者），不同 id 直接并入 —— 两台设备各自加的材料都应该活下来。
       重复导入同一份备份时所有 id 都已见过、内容又一样，天然幂等。 */
    if (Array.isArray(payload.shelf)) {
      const cur = loadShelf();
      const byId = new Map(cur.map(e => [e.id, e]));
      let added = 0, updated = 0;
      for (const raw of payload.shelf) {
        if (!raw || typeof raw !== 'object') continue;
        const inc = normalizeShelfEntry(raw);
        const local = byId.get(inc.id);
        if (!local) { byId.set(inc.id, inc); added++; continue; }
        const newer = (inc.lastAt || inc.createdAt) > (local.lastAt || local.createdAt) ? inc : local;
        if (newer !== local) { byId.set(inc.id, newer); updated++; }
      }
      if (added || updated) {
        saveShelf([...byId.values()]);
        n += added + updated;
      }
    }

    /* 课程进度：取「更靠前」的学时 —— 已完成的课取并集（不会因为导入
       而退步重学），每门课的最好成绩取较大值；当前课取 updatedAt 较新的
       那份备份的记录。与练习成绩同理：导入是补全，不是倒退。 */
    if (payload.course && typeof payload.course === 'object') {
      const cur = loadCourseProgress();
      const inc = payload.course;
      const completed = new Set([...(cur.completed || []), ...((Array.isArray(inc.completed) ? inc.completed : []).map(String))]);
      const lessons = Object.assign({}, cur.lessons);
      for (const [id, v] of Object.entries(inc.lessons || {})) {
        if (!v || typeof v !== 'object') continue;
        const a = lessons[id];
        lessons[id] = a ? {
          attempts: Math.max(a.attempts || 0, clampInt(v.attempts, 0, 1000000)),
          bestAcc: Math.max(a.bestAcc || 0, clampNum(v.bestAcc, 0, 100, 0)),
          bestInd: Math.max(a.bestInd || 0, clampNum(v.bestInd, 0, 100, 0)),
          bestSpeed: Math.max(a.bestSpeed || 0, Math.max(0, Number(v.bestSpeed) || 0)),
          bestChars: Math.max(a.bestChars || 0, clampInt(v.bestChars, 0, 1000000)),
          completedAt: Math.max(a.completedAt || 0, Number(v.completedAt) || 0)
        } : {
          attempts: clampInt(v.attempts, 0, 1000000),
          bestAcc: clampNum(v.bestAcc, 0, 100, 0),
          bestInd: clampNum(v.bestInd, 0, 100, 0),
          bestSpeed: Math.max(0, Number(v.bestSpeed) || 0),
          bestChars: clampInt(v.bestChars, 0, 1000000),
          completedAt: Number(v.completedAt) || 0
        };
      }
      const curTime = cur.updatedAt || 0;
      const incTime = Number(inc.updatedAt) || 0;
      const currentId = incTime > curTime ? String(inc.currentId || '') : cur.currentId;
      saveCourseProgress({
        completed: [...completed],
        lessons,
        currentId,
        updatedAt: Math.max(curTime, incTime)
      });
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

/** 题量输入、导入与旧设置共用边界，0 表示不限。 */
export function normalizeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(5000, Math.floor(n))) : 20;
}

export function loadRecent(mode) {
  const data = readJSON(KEYS.recent, {});
  const list = data && data[mode];
  return Array.isArray(list) ? list.filter(x => typeof x === 'string').slice(-200) : [];
}

export function recordRecent(mode, text) {
  if (!text || typeof text !== 'string') return;
  const raw = readJSON(KEYS.recent, {});
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const limit = mode === 'passage' ? 30 : mode === 'phrase' ? 200 : 80;
  data[mode] = [...loadRecent(mode).filter(x => x !== text), text].slice(-limit);
  writeJSON(KEYS.recent, data);
}
