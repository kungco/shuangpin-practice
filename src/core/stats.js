/**
 * 统计聚合模块
 * ------------------------------------------------------------
 * 从原始成绩记录中派生出：
 *   - 总览卡片数据（累计练习、平均速度、最佳成绩、连续天数…）
 *   - 历史成绩曲线（速度 / 正确率）
 *   - 每日练习量柱状数据
 *   - 易错字词排行
 *   - 针对性复习建议
 */

import { loadHistory, loadDaily, getWeakList, dateStr, getKeyErrorTotals } from './storage.js';
import { LEVEL_MAP } from './questions.js';

/* ============================================================
   总览
   ============================================================ */

/**
 * @param {Array} history 可选，默认从存储读取
 */
export function summarize(history) {
  const list = Array.isArray(history) ? history : loadHistory();
  const empty = {
    sessions: 0, totalChars: 0, totalSeconds: 0,
    bestSpeed: 0, avgSpeed: 0, avgAccuracy: 0,
    bestAccuracy: 0, streakDays: 0, totalDays: 0,
    lastTs: 0, todayChars: 0, todaySessions: 0
  };
  if (!list.length) return empty;

  let totalChars = 0;
  let totalSeconds = 0;
  let bestSpeed = 0;
  let bestAccuracy = 0;
  let speedSum = 0;
  let accSum = 0;
  let lastTs = 0;

  for (const r of list) {
    totalChars += num(r.totalChars);
    totalSeconds += num(r.durationSec);
    bestSpeed = Math.max(bestSpeed, num(r.speed));
    bestAccuracy = Math.max(bestAccuracy, num(r.accuracy));
    speedSum += num(r.speed) * num(r.durationSec);
    accSum += num(r.accuracy) * num(r.totalChars);
    lastTs = Math.max(lastTs, num(r.ts));
  }

  // 连续练习天数
  const daySet = new Set(list.map(r => r.date).filter(Boolean));
  const totalDays = daySet.size;

  const today = dateStr(new Date());
  const todayRecs = list.filter(r => r.date === today);

  return {
    sessions: list.length,
    totalChars,
    totalSeconds,
    bestSpeed: round1(bestSpeed),
    avgSpeed: totalSeconds > 0 ? round1(speedSum / totalSeconds) : 0,
    avgAccuracy: totalChars > 0 ? round1(accSum / totalChars) : 0,
    bestAccuracy: round1(bestAccuracy),
    streakDays: computeStreak(daySet),
    totalDays,
    lastTs,
    todayChars: todayRecs.reduce((s, r) => s + num(r.totalChars), 0),
    todaySessions: todayRecs.length
  };
}

/** 计算连续练习天数（含今天或从昨天起算） */
export function computeStreak(daySet) {
  if (!daySet || !daySet.size) return 0;
  let streak = 0;
  const cursor = new Date();
  // 允许今天尚未练习：则从昨天开始算
  if (!daySet.has(dateStr(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!daySet.has(dateStr(cursor))) return 0;
  }
  let guard = 0;
  while (guard < 3650) {
    guard++;
    if (daySet.has(dateStr(cursor))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

/* ============================================================
   历史曲线
   ============================================================ */

/**
 * @param {object} opts
 *   - range: '20' | '50' | 'all'
 *   - metric: 'speed' | 'acc'
 * @returns {{points:Array<{ts,date,value,accuracy,speed,mode}>, min, max, avg}}
 */
export function historySeries(opts = {}) {
  const list = loadHistory().filter(r => !opts.mode || opts.mode === 'all' || r.mode === opts.mode).sort((a, b) => a.ts - b.ts);
  const range = opts.range || '20';
  let trimmed;
  if (range === 'all') trimmed = list;
  else {
    const n = Math.max(1, parseInt(range, 10) || 20);
    trimmed = list.slice(Math.max(0, list.length - n));
  }

  const metric = opts.metric === 'acc' ? 'acc' : 'speed';
  const points = trimmed.map(r => ({
    ts: num(r.ts),
    date: r.date || '',
    mode: r.mode || '',
    modeName: r.modeName || (LEVEL_MAP[r.mode] ? LEVEL_MAP[r.mode].name : r.mode),
    speed: num(r.speed),
    accuracy: num(r.accuracy),
    value: metric === 'acc' ? num(r.accuracy) : num(r.speed)
  }));

  const values = points.map(p => p.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const summary = summarize(trimmed);
  const avg = metric === 'acc' ? summary.avgAccuracy : summary.avgSpeed;

  return { points, min, max, avg: round1(avg), metric };
}

/**
 * 每日练习量
 * @param {number} days 最近多少天（默认 14）
 */
export function dailySeries(days = 14, mode = 'all') {
  // Use the same retained history for overview, trends and daily totals.
  const daily = {};
  for (const rec of loadHistory().filter(r => mode === 'all' || r.mode === mode)) {
    const day = daily[rec.date] ||= { chars: 0, sessions: 0, durationSec: 0, bestSpeed: 0, speedSum: 0 };
    day.chars += num(rec.totalChars); day.sessions++;
    day.durationSec += num(rec.durationSec);
    day.bestSpeed = Math.max(day.bestSpeed, num(rec.speed));
    day.speedSum += num(rec.speed) * num(rec.durationSec);
  }
  const n = Math.max(1, Math.min(365, Number(days) || 14));
  const out = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  // 从 n-1 天前排到今天
  const start = new Date(cursor);
  start.setDate(start.getDate() - (n - 1));

  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = dateStr(d);
    const rec = daily[key] || null;
    out.push({
      date: key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      weekday: '日一二三四五六'[d.getDay()],
      chars: rec ? num(rec.chars) : 0,
      sessions: rec ? num(rec.sessions) : 0,
      durationSec: rec ? num(rec.durationSec) : 0,
      bestSpeed: rec ? num(rec.bestSpeed) : 0,
      avgSpeed: rec && num(rec.durationSec) > 0 ? round1(num(rec.speedSum) / num(rec.durationSec)) : 0
    });
  }
  return out;
}

/* ============================================================
   易错字词
   ============================================================ */

export function weakRanking(limit = 30) {
  return getWeakList({ limit, minCount: 1 });
}

/** 按错误类型归类，用于复习页分组 */
export function groupWeakItems(items) {
  const groups = {
    char: [],     // 单字
    phrase: [],   // 词组
    other: []
  };
  for (const it of items || []) {
    if (it.word && Array.from(it.word).length >= 2) groups.phrase.push(it);
    else if (it.char && /\p{Script=Han}/u.test(it.char)) groups.char.push(it);
    else groups.other.push(it);
  }
  return groups;
}

/* ============================================================
   复习建议
   ============================================================ */

/**
 * 生成复习建议文本
 */
export function reviewAdvice(summary, weakItems) {
  const lines = [];
  const s = summary || {};
  const weak = Array.isArray(weakItems) ? weakItems : [];

  if (!s.sessions) {
    return ['还没有练习记录。建议从「键位熟悉」开始，先花 5 分钟认识韵母键，再做「声韵拆分」。'];
  }

  lines.push(`累计练习 ${s.sessions} 次，共 ${s.totalChars} 字，平均速度 ${s.avgSpeed} 字/分。`);

  if (s.streakDays >= 3) {
    lines.push(`已连续练习 ${s.streakDays} 天，节奏保持得不错。`);
  } else if (s.streakDays === 1) {
    lines.push('今天是新起点，连续练习 3 天以上效果会更明显。');
  }

  if (weak.length) {
    lines.push(`共记录 ${weak.length} 个易错项，其中「${weak.slice(0, 3).map(w => w.key).join('、')}」错误最多，建议优先专项突破。`);
  }

  // 按能力水平给出建议
  if (s.avgAccuracy < 85) {
    lines.push('正确率低于 85%，说明键位还不够熟。建议放慢速度，回到「声韵拆分」模式，先求准再求快。');
  } else if (s.avgAccuracy < 95) {
    lines.push('正确率在 85%–95% 之间，键位已基本掌握。可以多做「单字打字」，把易错字逐个消化。');
  } else if (s.avgSpeed < 30) {
    lines.push('正确率已经不错，接下来重点练速度。建议用「词组打字」和「短文跟打」，培养连打的肌肉记忆。');
  } else if (s.avgSpeed < 60) {
    lines.push('速度处于进阶阶段。可以尝试限时训练，每次 3 分钟，冲击更高的峰值速度。');
  } else {
    lines.push('速度已经相当可观。建议加大短文分量，并定期用错题复习保持准确率。');
  }

  if (weak.some(w => /^(zh|ch|sh)/.test(w.pinyin || ''))) {
    lines.push('注意 zh / ch / sh 开头的一类字：这三个声母分别映射到 V / I / U 三个键，整个音节仍是 2 键（如 zheng → VG），不要多按一个 H。');
  }

  // 用键位热力图补一条「键维度」的建议 —— 这比字词表更能定位问题
  try {
    const heat = keyHeatmap({ range: 'all' });
    if (heat.total >= 8 && heat.hottest) {
      const top3 = heat.items.slice(0, 3).map(it => `${it.key}(${it.count} 次)`).join('、');
      lines.push(`按错最集中的键位是 ${top3}。可在「统计 → 错误热力图」里查看分布，这几个键建议单独多按几遍建立肌肉记忆。`);
    }
  } catch (_) { /* 热力图不可用不影响主流程 */ }

  return lines;
}

/* ============================================================
   错误热力图
   ============================================================ */

/**
 * 把「键错误次数」整理成键位图可以直接吃的热力数据。
 *
 * 设计取舍：
 *   - 归一化用**分位数（P90）**而不是最大值。
 *     打字练习的错误分布长尾极重：某个键可能因为一道题连错 20 次，
 *     用最大值做分母会让其余所有键全部压成近乎全白，热力图失去信息量。
 *     P90 只让最强的约 10% 键饱和，其余键仍能拉开层次。
 *   - 只返回「被用过（USED_KEYS）」的键，未参与方案的键不给热力。
 *
 * @param {object} opts
 *   - range: 'all' | '30' | '10'
 * @returns {{items:Array<{key,count,level,percent}>, max, p90, total, sessions, hottest}}
 */
export function keyHeatmap(opts = {}) {
  const range = ['all', '30', '10'].includes(String(opts.range)) ? String(opts.range) : 'all';
  const { counts, sessions, total } = getKeyErrorTotals(range);

  const entries = Object.entries(counts)
    .map(([k, v]) => [String(k).toUpperCase(), Math.max(0, Math.floor(Number(v) || 0))])
    .filter(([k, v]) => /^[A-Z]$/.test(k) && v > 0);

  const values = entries.map(e => e[1]);
  const max = values.length ? Math.max(...values) : 0;

  // 分位数：values 升序后取 P90（最近秩法）
  let p90 = max;
  if (values.length) {
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1);
    p90 = Math.max(1, sorted[Math.max(0, idx)]);
  }

  const scale = p90 || 1;
  const items = entries.map(([key, count]) => ({
    key,
    count,
    percent: Math.round(Math.min(1, count / scale) * 100),
    level: count >= scale ? 4 : count / scale >= 0.6 ? 3 : count / scale >= 0.3 ? 2 : 1
  })).sort((a, b) => b.count - a.count);

  return {
    items,
    max,
    p90: scale,
    total,
    sessions,
    hottest: items.length ? items[0] : null
  };
}

/* ============================================================
   工具
   ============================================================ */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round1(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

/** 格式化时长 */
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(num(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h} 时 ${m} 分`;
  if (m > 0) return `${m} 分 ${ss} 秒`;
  return `${ss} 秒`;
}

/** mm:ss */
export function formatClock(sec) {
  const s = Math.max(0, Math.floor(num(sec)));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
