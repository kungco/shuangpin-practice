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

import { loadHistory, loadDaily, getWeakList, dateStr, getKeyErrorTotals,
         getKeyTimings, getKeyConfusions, loadKeyConfusions, keyConfusionGrandTotal,
         median } from './storage.js';
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
    lastTs: 0, todayChars: 0, todaySessions: 0, todaySeconds: 0
  };
  if (!list.length) return empty;

  let totalChars = 0;
  let totalSeconds = 0;
  let bestSpeed = 0;
  let bestAccuracy = 0;
  let speedSum = 0;      // Σ(速度 × 时长)
  let accSum = 0;        // Σ(正确率 × 字数)
  let speedWeight = 0;   // Σ 时长，即 speedSum 的权重和
  let accWeight = 0;     // Σ 字数，即 accSum 的权重和
  let lastTs = 0;

  for (const r of list) {
    const dur = num(r.durationSec);
    const chars = num(r.totalChars);
    totalChars += chars;
    totalSeconds += dur;
    bestSpeed = Math.max(bestSpeed, num(r.speed));
    bestAccuracy = Math.max(bestAccuracy, num(r.accuracy));
    speedSum += num(r.speed) * dur;
    speedWeight += dur;
    accSum += num(r.accuracy) * chars;
    accWeight += chars;
    lastTs = Math.max(lastTs, num(r.ts));
  }

  /* 加权均值的权重来自记录自身，所以「权重全为 0」只可能是因为这批记录
     缺 durationSec / totalChars（老版本写入的数据）。这种情况下加权分母
     为 0，直接返回 0 会让总览凭空掉到零分 —— 那比口径不精确严重得多。
     退回无权重算术平均，至少数字还在（也仍与旧版本行为一致）。 */
  const avgSpeed = speedWeight > 0 ? speedSum / speedWeight
    : list.reduce((s, r) => s + num(r.speed), 0) / list.length;
  const avgAccuracy = accWeight > 0 ? accSum / accWeight
    : list.reduce((s, r) => s + num(r.accuracy), 0) / list.length;

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
    avgSpeed: round1(avgSpeed),
    avgAccuracy: round1(avgAccuracy),
    bestAccuracy: round1(bestAccuracy),
    streakDays: computeStreak(daySet),
    totalDays,
    lastTs,
    todayChars: todayRecs.reduce((s, r) => s + num(r.totalChars), 0),
    todaySessions: todayRecs.length,
    /* 今日已练时长（秒）。每日练习计划的进度按**时间**算而不是按题数 ——
       用户设的是分钟，进度就该用同一单位回报（理由见 core/daily.js）。 */
    todaySeconds: todayRecs.reduce((s, r) => s + num(r.durationSec), 0)
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
 * 能力测验成绩曲线。
 *
 * 分数在落库时就写进了记录（rec.score / rec.grade / rec.scoreValid，
 * 注释里也写着「统计页才能画历史分数曲线」），但统计页一直没有这张图，
 * 于是测验成绩存下来却无法回看趋势 —— 只能靠记忆。
 *
 * 口径上要当心两件事：
 *   - 只取**有效**分数（scoreValid）。样本不足 20 字的测验本来就不评分，
 *     把它们画成 0 分会让曲线出现毫无意义的深坑。
 *   - 等级是文字，不进曲线；需要时由 main.js 从 rec.grade 单独渲染。
 *
 * @param {object} opts
 *   - range: '20' | '50' | 'all'
 * @returns {{points:Array<{ts,date,score,grade,value,mode}>, min, max, avg, total, invalid}}
 */
export function scoreSeries(opts = {}) {
  const list = loadHistory()
    .filter(r => r.mode === 'exam' && r.scoreValid === true)
    .sort((a, b) => a.ts - b.ts);
  const range = opts.range || '20';
  const trimmed = range === 'all'
    ? list
    : list.slice(Math.max(0, list.length - Math.max(1, parseInt(range, 10) || 20)));
  const points = trimmed.map(r => ({
    ts: num(r.ts),
    date: r.date || '',
    score: num(r.score),
    grade: r.grade || '',
    mode: r.mode,
    value: num(r.score)
  }));
  const values = points.map(p => p.value);
  return {
    points,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    // 分数是绝对量（0–100），算术平均就是它该有的样子
    avg: values.length ? round1(values.reduce((a, b) => a + b, 0) / values.length) : 0,
    total: list.length,
    // 同一段历史里被判为无效的次数，用于如实说明「为什么点数比测验次数少」
    invalid: loadHistory().filter(r => r.mode === 'exam' && r.scoreValid !== true).length
  };
}

/* ============================================================
   主题配色查询
   ------------------------------------------------------------
   图表是 Canvas，**读不到 CSS 变量**（getComputedStyle 拿不到 var() 的
   可靠展开值，而且这里只需要十来个色），所以 ui/chart.js 维护了与
   style.css 对应的一份配色，由 verify.mjs 交叉校验。

   曾经这里还导出过一个 cssVar() 给键位图用，但那是错的做法：SVG 的
   fill 属性是**表现属性**，优先级低于任何 CSS 声明，靠 JS 逐个
   setAttribute 上色迟早会漏（26 个键只换了第一个）。现在键位图的配色
   完全由 style.css 负责，CSS 是唯一真相源。
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
  /* 均值走 summarize()，与总览卡片同一口径（速度按时长加权、正确率按字数
     加权）。注意它**不等于**各点的算术平均：一条 1 秒的练习和一条 10 分钟的
     练习权重不同，曲线上的点仍是每轮原始值。所以图上那条均值线看起来
     「对不上」是正常的，avgWeighted 会让 UI 如实说明，别让人以为是 bug。 */
  const summary = summarize(trimmed);
  const avg = metric === 'acc' ? summary.avgAccuracy : summary.avgSpeed;
  const plainAvg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  return {
    points, min, max, avg: round1(avg), metric,
    avgWeighted: true,
    plainAvg: round1(plainAvg)
  };
}

/**
 * 每日练习量
 * @param {number} days 最近多少天（默认 14）
 */
export function dailySeries(days = 14, mode = 'all') {
  /* 数据源：优先用日报（loadDaily），回落到保留的成绩记录。
   *
   * 为什么不能只读 loadHistory()：成绩记录上限 2000 条（storage.js），
   * 日报却是按天长期累积的。只读历史的话，2000 条一过，最早那些天的
   * 每日练习量会静默变成 0 —— 数据没丢（还在日报里），但图表不再显示它，
   * 用户只会以为那天没练过。 */
  const fromDaily = loadDaily();
  const daily = {};
  const touch = date => daily[date] ||= {
    chars: 0, sessions: 0, durationSec: 0, bestSpeed: 0,
    speedSecSum: 0,   // Σ(速度 × 时长)，按模式过滤时才有
    speedSum: 0      // Σ速度，日报口径（跨模式，无法加权）
  };

  /* ① 日报优先：它按天长期累积，覆盖范围比成绩记录更早。 */
  if (mode === 'all') {
    for (const [date, rec] of Object.entries(fromDaily)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !rec || typeof rec !== 'object') continue;
      const day = touch(date);
      day.chars = num(rec.chars);
      day.sessions = num(rec.sessions);
      day.durationSec = num(rec.durationSec);
      day.bestSpeed = num(rec.bestSpeed);
      day.speedSum = num(rec.speedSum);
    }
  }

  /* ② 成绩记录补漏：只处理日报里没有的那几天，否则会重复计数
     （日报本身就是从同一批成绩记录累加出来的）。
     日报那天若写入曾失败，宁可少算也不与日报叠加 —— 宁可保守，
     不要把同一天算成两倍。
     按模式过滤时日报没有模式维度，全部走这条路径。 */
  for (const rec of loadHistory()) {
    if (mode !== 'all' && rec.mode !== mode) continue;
    if (!rec.date) continue;
    if (fromDaily[rec.date] && mode === 'all') continue;
    const day = touch(rec.date);
    const dur = num(rec.durationSec);
    day.chars += num(rec.totalChars);
    day.sessions += 1;
    day.durationSec += dur;
    day.bestSpeed = Math.max(day.bestSpeed, num(rec.speed));
    day.speedSecSum += num(rec.speed) * dur;
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
      // 按模式过滤时用时长加权（与总览同口径）；全模式走日报，
      // 那里只存了 Σ速度，除以场次即其原本的口径。
      avgSpeed: rec
        ? round1(num(rec.speedSecSum) > 0 ? num(rec.speedSecSum) / num(rec.durationSec)
          : num(rec.sessions) > 0 ? num(rec.speedSum) / num(rec.sessions) : 0)
        : 0
    });
  }
  return out;
}

/* ============================================================
   易错字词
   ============================================================ */

/* ============================================================
   每日目标
   ============================================================ */

/**
 * 今日目标的完成情况。
 *
 * 【为什么复用 summarize 而不是自己读日报】口径必须与统计页的
 * 「今日 N 字」完全一致 —— 两处显示同一个数字的来源，用户才不会看到
 * 「统计页说 120 字，练习页进度条说 90 字」这种自相矛盾。
 * summarize() 内部走 dateStr(new Date())，跨天自动归零，不用另写日期逻辑。
 *
 * 计算前必须先把 settings.count 之外的目标值传进来 —— 传 0 表示不设目标，
 * 此时 hasGoal 为 false，UI 不该画进度条（而不是画一条永远 0% 的）。
 *
 * @param {object} settings  应用设置（读 dailyGoalChars / dailyGoalSessions）
 * @param {object} [summary] 可选的 summarize() 结果，避免重复读取
 */
export function dailyGoalProgress(settings, summary) {
  const s = summary || summarize();
  const goalChars = Math.max(0, Math.floor(Number(settings && settings.dailyGoalChars) || 0));
  const goalSessions = Math.max(0, Math.floor(Number(settings && settings.dailyGoalSessions) || 0));

  const chars = Math.max(0, num(s.todayChars));
  const sessions = Math.max(0, num(s.todaySessions));

  // 两个维度分别算完成度，再取**较小**者作为整体完成度。
  // 取最小而不是平均：练了 300 字但只坐了 1 次和练了 100 字坐 3 次，
  // 前者是「一次练够了」，后者是「分次坚持」—— 但只要有任一维度没达标，
  // 就不该显示成「今天已完成」。目标的作用是推动，不是安慰。
  const charRatio = goalChars > 0 ? Math.min(1, chars / goalChars) : null;
  const sessionRatio = goalSessions > 0 ? Math.min(1, sessions / goalSessions) : null;

  const parts = [charRatio, sessionRatio].filter(r => r !== null);
  const ratio = parts.length ? Math.min(...parts) : 0;

  return {
    hasGoal: parts.length > 0,
    achieved: parts.length > 0 && ratio >= 1,
    ratio,
    percent: Math.round(ratio * 100),
    chars,
    sessions,
    goalChars,
    goalSessions,
    // 还差多少。任一目标未设时给 0，UI 据此决定要不要显示「还差 N 字」
    charsLeft: goalChars > 0 ? Math.max(0, goalChars - chars) : 0,
    sessionsLeft: goalSessions > 0 ? Math.max(0, goalSessions - sessions) : 0
  };
}

/* ============================================================
   同模式基线（本轮 vs 近 N 轮）
   ============================================================ */

/**
 * 结算页的「本轮对照」：拿最近若干轮同模式练习做基线，
 * 算出中位数，让本轮有个参照系。
 *
 * 【为什么不用平均值】单次走神或一次特别顺手的练习就能把均值拽走
 * 一大截，而用户看到的「比平时快还是慢」会被这个异常值误导。
 * 中位数只看「中间那个」，对离群值免疫 —— 这与 keySlowness() 的口径
 * 一致（那里也是「偶尔走神一次就能把均值拽高一倍」）。
 *
 * 【为什么要门槛】只有 1–2 轮历史时，中位数就是那 1–2 个值本身，
 * 「比中位数快 3」这种结论毫无统计意义。不足 MIN_SAMPLES 轮时
 * 返回 samples 供 UI 如实说明，而不是硬凑一个数字出来。
 *
 * 【为什么按模式分开】单字练习和短文跟打的速度天然不是一个量级
 * （短文有连贯语境，速度更高），混在一起算基线会让两个模式都失真。
 *
 * @param {object} opts
 *   - mode:    'char' | 'phrase' | ... ；'all' 或空表示不按模式过滤
 *   - exclude: 要排除的记录 id（本轮可能已经落库，不该把自己算进基线）
 *   - window:  取最近多少轮（默认 5）
 *   - min:     最少要几轮才给出基线（默认 3）
 * @returns {{
 *   samples:number, enough:boolean,
 *   speed:number, accuracy:number, speedDelta:number, accuracyDelta:number
 * }}
 */
export const BASELINE_MIN_SAMPLES = 3;
export const BASELINE_WINDOW = 5;

export function recentBaseline(opts = {}) {
  const window = Math.max(1, Math.floor(Number(opts.window)) || BASELINE_WINDOW);
  const min = Math.max(1, Math.floor(Number(opts.min)) || BASELINE_MIN_SAMPLES);
  const mode = opts.mode && opts.mode !== 'all' ? String(opts.mode) : '';
  const exclude = opts.exclude ? String(opts.exclude) : '';

  const list = loadHistory()
    .filter(r => (!mode || r.mode === mode) && (!exclude || r.id !== exclude))
    .sort((a, b) => num(a.ts) - num(b.ts));

  // 取最近 window 轮。测验模式题量固定、耗时较长，与日常练习不可比，
  // 但仍按模式隔离，所以不会互相污染。
  const recent = list.slice(Math.max(0, list.length - window));

  const empty = {
    samples: 0, enough: false,
    speed: 0, accuracy: 0, speedDelta: 0, accuracyDelta: 0
  };
  if (!recent.length) return empty;

  /* 百分比类指标要保留一位小数：中位数落在 96 和 97 之间时，
     取整会得到 97 或 96，而「本轮 96.5 vs 基线 97」的差值就失真了。
     速度同理。所以这里不用 storage.median()（它返回整数），
     单独算一次带小数的中位数。 */
  const med1 = (arr) => {
    const nums = arr.map(num).filter(Number.isFinite).sort((a, b) => a - b);
    if (!nums.length) return 0;
    const mid = nums.length >> 1;
    const v = nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
    return round1(v);
  };

  const speed = med1(recent.map(r => r.speed));
  const accuracy = med1(recent.map(r => r.accuracy));

  return {
    samples: recent.length,
    // 样本不足时上层必须如实说明，不能安静地给出一个不可靠的对照
    enough: recent.length >= min,
    min,
    speed,
    accuracy,
    speedDelta: round1(num(opts.curSpeed) - speed),
    accuracyDelta: round1(num(opts.curAccuracy) - accuracy)
  };
}

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
  const { counts, sessions, total, byMode } = getKeyErrorTotals(range, opts.mode || 'all');

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
    // 该模式下有没有专属数据。false = 老记录没带模式，这里退回的是全量，
    // UI 必须说明，否则「按模式筛选」看起来生效了其实没有。
    byMode,
    hottest: items.length ? items[0] : null
  };
}

/* ============================================================
   慢键诊断（按得慢，而不是按错）
   ============================================================ */

/**
 * 哪些键「按对了但按得慢」。
 *
 * 与 keyHeatmap 的关系：那张图量的是**错误次数**（红色填充），这张图量的是
 * **按键耗时中位数**。两者用不同的视觉通道（见 ui/keymap.js 的 setSlow ——
 * 独立的描边环，不碰 .kb-body 的 fill），所以同一张键盘图上可以同时看：
 * 红色填充 = 老按错，蓝环 = 按得慢。
 *
 * 归一化沿用 keyHeatmap 的思路，用 **P90** 而非最大值/最小值做分母：
 * 耗时分布同样长尾（某个键可能因为某次卡壳而极慢），用最大值会让所有键
 * 都压成同一档、失去分辨力；用最小值又会让一个异常快的键当分母、其余全部饱和。
 * P90 只让最慢的约 10% 键饱和。
 *
 * 样本太少的键会被剔除：2 个样本的中位数毫无意义，把它排进「慢键」等于
 * 报噪音。门槛与结算面板一致（见 KEY_SLOW_MIN_SAMPLES）。
 *
 * @param {object} opts
 *   - range: 'all' | '30' | '10'
 *   - mode:  'all' 或具体模式 id
 * @returns {{items:Array, overall:number, p90:number, thin:number, sessions:number, byMode:boolean}}
 */
export const KEY_SLOW_MIN_SAMPLES = 5;

export function keySlowness(opts = {}) {
  const range = ['all', '30', '10'].includes(String(opts.range)) ? String(opts.range) : 'all';
  const { items: raw, sessions, byMode } = getKeyTimings(range, opts.mode || 'all');

  const rows = raw
    .filter(r => r && /^[A-Z]$/.test(r.key) && r.samples >= KEY_SLOW_MIN_SAMPLES)
    .map(r => ({ key: r.key, samples: r.samples, medianMs: r.medianMs, leadMs: r.leadMs, followMs: r.followMs }));

  const medians = rows.map(r => r.medianMs).filter(n => n > 0).sort((a, b) => a - b);
  const overall = median(medians);
  let p90 = medians.length ? medians[medians.length - 1] : 0;
  if (medians.length) {
    const idx = Math.min(medians.length - 1, Math.ceil(medians.length * 0.9) - 1);
    p90 = Math.max(1, medians[Math.max(0, idx)]);
  }
  const scale = p90 || 1;

  const items = rows.map(r => {
    const ratio = r.medianMs / scale;
    return Object.assign(r, {
      ratio: Math.round(ratio * 100) / 100,
      level: r.medianMs >= scale ? 4 : ratio >= 0.6 ? 3 : ratio >= 0.3 ? 2 : 1,
      // 比整体中位数慢百分之多少。overall 为 0 时给 0 而不是 Infinity/NaN。
      overOverall: overall > 0 ? Math.round((r.medianMs / overall - 1) * 100) : 0
    });
  }).sort((a, b) => b.medianMs - a.medianMs);

  return {
    items,
    overall,
    p90: scale,
    sessions,
    byMode,
    // 样本不足而被剔除的键数：UI 要如实说「另有 N 个键样本太少未参与」，
    // 否则用户会把「没显示」当成「不慢」。
    thin: raw.filter(r => r && r.samples > 0 && r.samples < KEY_SLOW_MIN_SAMPLES).length,
    minSamples: KEY_SLOW_MIN_SAMPLES
  };
}

/* ============================================================
   键位掌握度（每个键「练到哪一步了」）
   ============================================================ */

/**
 * 每个键的掌握度：没碰过 / 在练 / 已掌握。
 *
 * 与热力图、慢键图的关系（三者共用同一张键盘，但回答不同问题）：
 *   keyHeatmap  —— 哪些键**按错**（红填充）
 *   keySlowness —— 哪些键**按得慢**（蓝环）
 *   keyMastery  —— 每个键**练够没有、稳不稳**（这一段的新问题）
 *
 * **数据来源不新增存储**。这里刻意复用已有的两张表：
 *   - `getKeyTimings().samples` —— 该键**按对**的样本数（引擎只在按键
 *     推进时才记耗时，所以样本数天然等于「这个键按对过几次」）
 *   - `getKeyErrorTotals().counts` —— 该键**按错**的次数
 * 二者合起来即可算出：
 *   practice = samples + errors          （共碰过多少次）
 *   accuracy = samples / (samples + errors)
 *
 * 判定为「已掌握」需要同时满足三条，缺一不可：
 *   1. 样本够多（>= minSamples，默认 12）—— 练得少不算数
 *   2. 错误率够低（<= maxErrorRate，默认 8%）—— 按对多但错得多不算数
 *   3. 不慢（有耗时可查时，中位数 <= slowFactor × 整体中位数）——
 *      「每次都要想一秒才按对」不是掌握，是还没形成肌肉记忆
 * 第 3 条是最容易漏的一条：只看错误率会把「慢而准」误判成掌握，
 * 而那恰恰是双拼最该继续练的状态（见 keySlowness 的注释）。
 *
 * 状态机（按优先级）：
 *   'untouched' 没碰过（practice 太少且一次没错）
 *   'learning'  在练（碰过，但未达掌握标准）
 *   'mastered'  已掌握（三条全满足）
 *
 * @param {object} opts
 *   - range: 'all' | '30' | '10'
 *   - mode:  'all' 或具体模式 id
 *   - minSamples:  判「已掌握」所需最少样本（默认 12）
 *   - maxErrorRate: 判「已掌握」允许的最高错误率（默认 0.08）
 *   - slowFactor:  判「不慢」允许的倍率（默认 1.3）
 * @returns {{items:Array, counts:Object, total:number, sessions:number,
 *           byMode:boolean, minSamples:number}}
 */
export const MASTERY_MIN_SAMPLES = 12;
export const MASTERY_MAX_ERROR_RATE = 0.08;
export const MASTERY_SLOW_FACTOR = 1.3;

export function keyMastery(opts = {}) {
  const range = ['all', '30', '10'].includes(String(opts.range)) ? String(opts.range) : 'all';
  const mode = opts.mode || 'all';
  const minSamples = Math.max(1, Math.floor(Number(opts.minSamples)) || MASTERY_MIN_SAMPLES);
  const maxErrorRate = Number.isFinite(Number(opts.maxErrorRate))
    ? Math.max(0, Math.min(1, Number(opts.maxErrorRate))) : MASTERY_MAX_ERROR_RATE;
  const slowFactor = Number.isFinite(Number(opts.slowFactor))
    ? Math.max(1, Number(opts.slowFactor)) : MASTERY_SLOW_FACTOR;

  const errRes = getKeyErrorTotals(range, mode);
  const timRes = getKeyTimings(range, mode);

  /* 「慢」的相对基准：整体中位数。
     只取**样本够多**的键来算这个基准 —— 一个只练过 1 次的键，其「中位数」
     就是那一次的值，可能极快也可能极慢，把它算进基准会把整条线带偏。
     （实践中真的踩到过：几个 1 样本的键恰好都很快，把基准压到 120ms，
     于是所有正常速度的键全被判成「慢」，掌握度永远是 0。）
     样本数为 0 的键本来就被排除在 items 之外，这里同理。 */
  const baselineSamples = Math.max(3, Math.min(minSamples, 8));
  const baseMedians = timRes.items
    .filter(r => r && r.samples >= baselineSamples)
    .map(r => num(r.medianMs))
    .filter(n => n > 0)
    .sort((a, b) => a - b);
  // 样本够多的键太少（刚开始练）时，退回全部键 —— 有基准总比没有强，
  // 但此时掌握判定会因为样本不足而天然保守，不会误报。
  const refMedians = baseMedians.length ? baseMedians
    : timRes.items.map(r => num(r.medianMs)).filter(n => n > 0).sort((a, b) => a - b);
  const overallMs = median(refMedians);
  const slowLine = overallMs > 0 ? overallMs * slowFactor : 0;

  // 以 timings 为主表（它代表「练过」），再把错误数并进来
  const byKey = {};
  for (const r of timRes.items) {
    if (!r || !/^[A-Z]$/.test(r.key)) continue;
    byKey[r.key] = {
      key: r.key,
      samples: Math.max(0, Math.floor(num(r.samples))),
      errors: 0,
      medianMs: num(r.medianMs)
    };
  }
  for (const [k, v] of Object.entries(errRes.counts || {})) {
    const K = String(k).toUpperCase();
    if (!/^[A-Z]$/.test(K)) continue;
    if (!byKey[K]) byKey[K] = { key: K, samples: 0, errors: 0, medianMs: 0 };
    byKey[K].errors += Math.max(0, Math.floor(num(v)));
  }

  const items = Object.values(byKey).map(r => {
    const practice = r.samples + r.errors;
    const accuracy = practice > 0 ? r.samples / practice : 0;
    const errorRate = practice > 0 ? r.errors / practice : 0;
    /* 「明确偏慢」才否决掌握。耗时为 0 表示没有数据（老记录、
       或该键只在 L2 这类不记耗时的场景练过）—— 不知道就不算慢，
       否则老用户一升级会发现所有键都「没掌握」。 */
    const slow = slowLine > 0 && r.medianMs > 0 && r.medianMs > slowLine;

    let state;
    if (practice === 0) {
      state = 'untouched';
    } else {
      const enough = r.samples >= minSamples;
      const clean = errorRate <= maxErrorRate;
      state = (enough && clean && !slow) ? 'mastered' : 'learning';
    }

    return {
      key: r.key,
      samples: r.samples,
      errors: r.errors,
      practice,
      accuracy: Math.round(accuracy * 1000) / 1000,
      errorRate: Math.round(errorRate * 1000) / 1000,
      medianMs: r.medianMs,
      slow,
      // 距离「已掌握」还差多少样本，UI 可给出「再练 N 次」的量化指引
      need: Math.max(0, minSamples - r.samples),
      state
    };
  }).sort((a, b) => {
    const rank = { learning: 0, untouched: 1, mastered: 2 };
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    // 同为「在练」：错误多的排前面（更该补）
    return b.errorRate - a.errorRate || a.key.localeCompare(b.key);
  });

  const counts = { untouched: 0, learning: 0, mastered: 0 };
  for (const it of items) counts[it.state]++;

  return {
    items,
    counts,
    total: items.length,
    sessions: timRes.sessions,
    // 与热力图同口径：false = 该模式下没有专属数据、退回的是全量
    byMode: errRes.byMode || timRes.byMode,
    overallMs,
    slowLine,
    minSamples
  };
}

/* ============================================================
   错题本导出为跟打文本
   ============================================================ */

/**
 * 把易错项拼成一段可以「短文跟打」的文本。
 *
 * 为什么要有这个：复习页的 chip 一次只练一个词（3 道题），适合攻克单个难点，
 * 但**不适合练连贯性**。而真实打字场景里，问题往往不是「这个字不会」，
 * 是「字与字之间的切换不顺」。把错题连成一段话，正好补上这一环。
 *
 * 组装规则（每一条都是为了生成出来的文本仍然「像人话」而不是乱码）：
 *   1. 词组优先、单字其次 —— 词组本身是多字的，更连贯
 *   2. 按权重（错误多 + 快忘了）排序，把最该练的放前面
 *   3. 用顿号「、」连接同类，句号「。」收尾 —— 让 splitPassageText
 *      能在标点处断句，且可打字数统计准确（标点会被自动跳过）
 *   4. 同一个字/词只出现一次（按 key 去重）
 *
 * 刻意**不**做「句子重组」：把「月」和「银行」硬拼成一个语法通顺的句子
 * 需要语言模型，而这是零依赖项目，做得出来也不可预测。
 * 现在这样是诚实的：一段错题清单，用户看得懂、练得到。
 *
 * @param {Array} items getWeakList 的返回值
 * @param {object} [opts]
 *   - maxItems: 最多收多少个（默认 40，太多了连不成可练的一段）
 *   - groupByPunctuation: 是否用顿号连接（默认 true）
 * @returns {{text:string, count:number, chars:number}}
 *   text 为用户可直接粘贴的文本；chars 为其中可练的汉字数（估算，仅收录字）
 */
export function buildWeakPassage(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const maxItems = Math.max(1, Math.floor(Number(opts.maxItems)) || 40);
  const punct = opts.groupByPunctuation !== false;

  const seen = new Set();
  const picked = [];
  for (const it of list) {
    if (!it) continue;
    const text = String(it.word || it.char || it.key || '').trim();
    if (!text) continue;
    // 只收纯汉字 / 汉字词：带英文、数字、标点的条目塞进来会让跟打文本变脏
    if (!/^[\p{Script=Han}]+$/u.test(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    picked.push(text);
    if (picked.length >= maxItems) break;
  }

  if (!picked.length) return { text: '', count: 0, chars: 0 };

  const sep = punct ? '、' : ' ';
  const text = picked.join(sep) + '。';
  const chars = picked.reduce((n, w) => n + Array.from(w).length, 0);

  return { text, count: picked.length, chars };
}

/* ============================================================
   错键辨析（「本想按 G，却按成了 K」）
   ------------------------------------------------------------
   与 keyHeatmap 的分工（两者共用键盘图，但回答不同问题）：
     keyHeatmap     —— 哪些键**错得多**（给处方：多练这个键）
     keyConfusions  —— 错成了**哪个键**（给处方：把这两个键拎出来辨析）
   前者只能推出「多练 K」，后者能推出「G/K 分不清，得成对练」。

   这一层的核心产出是 `discriminationDrills()`：把统计结果直接变成
   一选题组 —— 引擎照常跑，只是题目内容是「这两个键怎么区分」。
   ============================================================ */

/** 一组混淆至少出现过几次，才值得单独出题 */
export const CONFUSION_MIN_COUNT = 3;

/**
 * 混淆组合排行。
 *
 * 每个组合给一个 `share`（占全部混淆的比例）和一个 `pairKey`
 * （`G|K`，两个键按字母序，供 UI 去重 —— 「G→K」和「K→G」是同一对键
 * 的两个方向，出题时是一回事，但统计上要分开看方向）。
 *
 * @param {object} opts
 *   - range: 'all' | '30' | '10'
 *   - mode:  'all' 或具体模式
 *   - limit: 最多返回多少组
 *   - minCount: 至少出现几次（默认 CONFUSION_MIN_COUNT）
 * @returns {{items:Array, total:number, sessions:number, byMode:boolean,
 *           grandTotal:number, minCount:number}}
 */
export function keyConfusionRanking(opts = {}) {
  const range = ['all', '30', '10'].includes(String(opts.range)) ? String(opts.range) : 'all';
  const minCount = Math.max(1, Math.floor(Number(opts.minCount)) || CONFUSION_MIN_COUNT);
  const limit = Math.max(0, Math.floor(Number(opts.limit)) || 0);

  const res = getKeyConfusions(range, opts.mode || 'all', 0);
  const total = Math.max(0, num(res.total));

  const items = (res.pairs || []).map(p => {
    const target = String(p.target || '').toUpperCase();
    const actual = String(p.actual || '').toUpperCase();
    const count = Math.max(0, Math.floor(num(p.count)));
    return {
      target,
      actual,
      count,
      // 两个键按字母序拼，作为「这一对键」的稳定标识（方向无关）
      pairKey: [target, actual].sort().join('|'),
      share: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
      // 够不够格单独出题。UI 用它区分「主要问题」和「偶发手滑」
      eligible: count >= minCount
    };
  }).filter(it => /^[A-Z]$/.test(it.target) && /^[A-Z]$/.test(it.actual) && it.count > 0)
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target) || a.actual.localeCompare(b.actual));

  return {
    items: limit > 0 ? items.slice(0, limit) : items,
    total,
    sessions: Math.max(0, num(res.sessions)),
    byMode: res.byMode === true,
    // 全量总次数（不受当前 range/mode 影响），UI 用来判断「有没有数据可看」
    grandTotal: keyConfusionGrandTotal(),
    minCount
  };
}

/**
 * 把混淆组合聚成「键对」—— 同一对键的两个方向合并。
 *
 * 为什么必须合并才能出题：
 *   统计上「想按 G 按成 K」和「想按 K 按成 G」是两个不同的信号
 *   （前者说明 G 的位置记成了 K，后者反过来），所以明细分开记、分开排。
 *   但**练习**的时候，这两个是同一件事 —— 都练「G 和 K 的区别」。
 *   给用户看「G/K 混淆 11 次」比拆成 8 + 3 更好懂，出的题也一样。
 *
 * @returns {Array<{a:string, b:string, pairKey:string, count:number,
 *                  forward:number, backward:number}>} 按总次数降序
 */
export function confusionPairs(opts = {}) {
  const rank = keyConfusionRanking(Object.assign({}, opts, { limit: 0 }));
  const byPair = new Map();
  for (const it of rank.items) {
    let rec = byPair.get(it.pairKey);
    if (!rec) {
      const [a, b] = it.pairKey.split('|');
      rec = { a, b, pairKey: it.pairKey, count: 0, forward: 0, backward: 0 };
      byPair.set(it.pairKey, rec);
    }
    rec.count += it.count;
    // 方向：a 是小字母序的那个，forward 表示 a→b
    if (it.target === rec.a) rec.forward += it.count;
    else rec.backward += it.count;
  }
  const minCount = Math.max(1, Math.floor(Number(opts.minCount)) || CONFUSION_MIN_COUNT);
  return Array.from(byPair.values())
    .map(r => Object.assign(r, { eligible: r.count >= minCount }))
    .sort((x, y) => y.count - x.count || x.pairKey.localeCompare(y.pairKey));
}

/** 输入是否像「同一声母/韵母类」的键 —— 用于给辨析题拟更贴切的提示语 */
function confusionHint(a, b) {
  return `这两个键容易混：${a} 和 ${b}。它们位置相近或形状相像，按错多半是手感问题，慢一点、看清楚再按。`;
}

/**
 * 生成「两键辨析」小练习。
 *
 * 产出的是标准的 Question 数组（与 questions.js 同构），可以直接喂给
 * PracticeEngine 跑 —— 不另造一套出题系统。每道题形如：
 *   { kind: 'key', answerKeys: ['G'], promptText: 'G', role: 'confuse', meta: {...} }
 *
 * 【为什么是「只考这两个键」】用户选择的口径就是只在这对键里辨析。
 * 加进第三个键会让「是不是混淆」变成「是不是不熟」，测不出真正的进步；
 * 而两个键二选一，正确率就直接反映这对键分不分得清。
 *
 * 【怎么保证两个键都被练到】只出「a→b 方向错得多」的那一侧会漏掉另一半。
 * 所以按键对里两个键**各出一半**的题，且顺序交替 —— 否则用户会发现
 * 「前一半全是 G」，靠位置猜。
 *
 * @param {Array} pairs confusionPairs() 的结果（或 keyConfusionRanking().items）
 * @param {object} [opts]
 *   - perPair: 每对键出多少题（默认 6）
 *   - maxPairs: 最多取几对（默认 3）
 *   - onlyEligible: 是否只取够格的（默认 true）
 * @returns {{questions:Array, pairs:Array, count:number}}
 */
export function discriminationDrills(pairs, opts = {}) {
  const list = Array.isArray(pairs) ? pairs : [];
  const perPair = Math.max(2, Math.floor(Number(opts.perPair)) || 6);
  const maxPairs = Math.max(1, Math.floor(Number(opts.maxPairs)) || 3);
  const onlyEligible = opts.onlyEligible !== false;

  // 统一成键对形态：既接受 confusionPairs() 的 {a,b}，也接受 ranking 的 {target,actual}
  const normalized = list.map(p => {
    if (!p) return null;
    if (p.a && p.b) return { a: p.a, b: p.b, count: p.count || 0 };
    const t = String(p.target || '').toUpperCase();
    const c = String(p.actual || '').toUpperCase();
    if (!/^[A-Z]$/.test(t) || !/^[A-Z]$/.test(c) || t === c) return null;
    const [a, b] = [t, c].sort();
    return { a, b, count: p.count || 0 };
  }).filter(Boolean);

  const picked = (onlyEligible ? normalized.filter(p => p.count >= CONFUSION_MIN_COUNT) : normalized)
    .slice(0, maxPairs);

  const questions = [];
  const usedPairs = [];
  for (const p of picked) {
    usedPairs.push({ a: p.a, b: p.b, count: p.count, hint: confusionHint(p.a, p.b) });
    // 交替出题，保证两个键各练到、且不按位置成组
    for (let i = 0; i < perPair; i++) {
      const key = i % 2 === 0 ? p.a : p.b;
      questions.push({
        /* id 必须有：startSession() 用它判断「传进来的是不是题目数组」，
           缺失时预设会被静默丢弃、回落到通用出题器 —— 用户点了「练 G/K 辨析」，
           拿到的却是一套 50 题的单字练习，且看不出哪里不对。 */
        id: `confuse:${p.a}${p.b}:${i}`,
        kind: 'key',
        answerKeys: [key],
        promptText: key,
        role: 'confuse',
        meta: {
          confuse: true,
          pair: `${p.a}${p.b}`,
          peer: key === p.a ? p.b : p.a,
          hint: confusionHint(p.a, p.b)
        }
      });
    }
  }
  // 打散：上面是按对成块的，直接跑会让用户连续 3 题都在同一对键上
  shuffle(questions);

  return { questions, pairs: usedPairs, count: questions.length };
}

/** Fisher–Yates；用 Math.random 即可 —— 这里不追求可复现 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 对比「这组混淆有没有减少」：拿最近 N 次里涉及该键对的次数，
 * 与更早一段做对照。给结算面板和统计页用。
 *
 * 【为什么用「每场平均」而不是总次数】练习总量在变（某天练了 5 场、
 * 某天只练 1 场），直接比次数会把「练得多」读成「错得多」。
 * 除以场次得到「每场平均错几次」，才是可比的强度指标。
 *
 * @param {string} pairKey '|' 连接的键对（confusionPairs 的 pairKey）
 * @param {object} opts
 *   - window: 每侧取多少次会话（默认 10）
 * @returns {{recent:number, previous:number, recentPerSession:number,
 *           previousPerSession:number, delta:number, sessions:number}}
 */
export function confusionTrend(pairKey, opts = {}) {
  const key = String(pairKey || '');
  const window = Math.max(1, Math.floor(Number(opts.window)) || 10);
  const sessions = loadKeyConfusions().recent || [];

  const countIn = (list) => {
    let n = 0;
    for (const s of list) {
      const pairs = (s && s.pairs) || {};
      for (const [T, inner] of Object.entries(pairs)) {
        for (const [A, c] of Object.entries(inner || {})) {
          if ([T, A].sort().join('|') === key) n += Math.max(0, num(c));
        }
      }
    }
    return n;
  };

  const total = sessions.length;
  const cut = Math.max(0, total - window);
  const recentList = sessions.slice(cut);
  const prevList = sessions.slice(Math.max(0, cut - window), cut);

  const recent = countIn(recentList);
  const previous = countIn(prevList);
  const rPer = recentList.length ? recent / recentList.length : 0;
  const pPer = prevList.length ? previous / prevList.length : 0;

  return {
    recent,
    previous,
    // 与 delta 同为 -1 / 0 / +1 的语义：-1 变好、+1 变差、0 持平。
    // UI 直接用它决定文案，不必自己判断符号。
    direction: rPer < pPer ? -1 : rPer > pPer ? 1 : 0,
    recentSessions: recentList.length,
    previousSessions: prevList.length,
    recentPerSession: Math.round(rPer * 100) / 100,
    previousPerSession: Math.round(pPer * 100) / 100,
    /* 负数 = 变少了（好事）。
       两侧都要有**这一对键的**数据才叫「可比」。只判断「两侧都有会话」
       是不够的：上一段压根没出现过这一对键时（previous=0），
       谈「减少到 0」没有意义 —— 那只能说明这对键是最近才冒出来的，
       更该说的是「新出现的混淆」，而不是「你进步了」。
       会话数仍一并给出，UI 可据此区分「还没练够」和「确实消除了」。 */
    delta: Math.round((rPer - pPer) * 100) / 100,
    comparable: prevList.length > 0 && recentList.length > 0 && previous > 0 && recent > 0,
    // 上一段没出现过、这一段出现了 —— 新冒出来的混淆，值得点名
    isNew: previous === 0 && recent > 0,
    // 上一段出现过、这一段没有了 —— 消除掉了
    isGone: previous > 0 && recent === 0,
    sessions: recentList.length
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
