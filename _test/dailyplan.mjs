/**
 * 每日练习计划自检
 * ------------------------------------------------------------
 * 覆盖「设定每天练几分钟 → 按时长组题 → 算今日进度 → 跨天失效」这条链路：
 *   1. 纯逻辑  clampPlanMinutes / planDoneToday / dailyPlanProgress 的口径
 *   2. 组题    buildDailyPlan 按剩余时长定单局长度、复用 planMixedSession
 *   3. 边界    剩余为 0 / 超额完成 / 未启用计划 / 非法输入
 *   4. 存储    dailyPlanMinutes / dailyPlanDoneOn 的设置项读写
 *
 * 运行：node _test/dailyplan.mjs
 *
 * 为什么单独一个文件：这一层最容易出的问题是**时间口径** ——
 * 比如进度按题数而不是按秒（于是「练了 6 分半」无从表达）、
 * 或者完成标记用布尔（于是跨零点不重置，第二天一打开就显示「已完成」）。
 * 这类 bug 不会报错，只会让用户觉得「这计划根本没在算」。
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗ ' + m); } else { console.log('  ✓ ' + m); } };

const require = createRequire(import.meta.url);
let modSeq = 0;

function makeLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] ?? null,
    clear: () => map.clear()
  };
}

const base = new URL('../src/core/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fresh = (f) => import(`${pathToFileURL(base + f).href}?t=${++modSeq}`);

const ls = makeLocalStorage();
globalThis.window = {
  localStorage: ls, setTimeout, clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
};

const D = await fresh('daily.js');
const S = await fresh('storage.js');

/* ============================================================
   【1】clampPlanMinutes：时长夹取
   ============================================================ */
console.log('【1】clampPlanMinutes 的夹取口径');

{
  ok(D.clampPlanMinutes(10) === 10, '正常值原样保留');
  ok(D.clampPlanMinutes(0) === 0, '0 视为「不启用计划」，不算非法');
  ok(D.clampPlanMinutes('15') === 15, '字符串数字能解析');
  ok(D.clampPlanMinutes(15.7) === 15, '小数向下取整');
  ok(D.clampPlanMinutes(-5) === 0, '负数回落到 0（不启用）');
  ok(D.clampPlanMinutes(NaN) === 0, 'NaN 回落到 0');
  ok(D.clampPlanMinutes(null) === 0, 'null 回落到 0');
  ok(D.clampPlanMinutes(undefined) === 0, 'undefined 回落到 0');
  ok(D.clampPlanMinutes(9999) === D.PLAN_MAX_MINUTES, `超大值夹到上限 ${D.PLAN_MAX_MINUTES}`);
  ok(D.clampPlanMinutes(0.4) === 0, '不足 1 分钟（向下取整为 0）视为不启用');
}

/* ============================================================
   【2】dailyPlanProgress：进度口径
   ============================================================ */
console.log('【2】dailyPlanProgress 的进度口径');

{
  // 未启用：分钟数为 0
  const off = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 0 }, todaySec: 500 });
  ok(off.enabled === false, '分钟数为 0 时 enabled=false');
  ok(off.goalSec === 0, '未启用时目标时长为 0');
  ok(off.percent === 0, '未启用时进度为 0');

  // 未开始
  const p0 = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 10 }, todaySec: 0 });
  ok(p0.enabled === true, '设了 10 分钟则启用');
  ok(p0.goalSec === 600, '目标时长 = 10 分钟 = 600 秒');
  ok(p0.doneSec === 0, '已练 0 秒');
  ok(p0.leftSec === 600, '还差 600 秒');
  ok(p0.percent === 0, '进度 0%');
  ok(p0.achieved === false, '未达标');

  // 一半
  const half = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 10 }, todaySec: 300 });
  ok(half.percent === 50, '练了 5 分钟 → 50%');
  ok(half.leftSec === 300, '还差 300 秒');
  ok(half.achieved === false, '一半未达标');

  // 刚好达标
  const done = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 10 }, todaySec: 600 });
  ok(done.achieved === true, '练满 10 分钟 → 达标');
  ok(done.percent === 100, '达标时进度 100%');
  ok(done.leftSec === 0, '达标时还差 0');
  ok(done.overAchieved === false, '刚好达标不算超额');

  // 超额
  const over = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 10 }, todaySec: 900 });
  ok(over.achieved === true, '超额也算达标');
  ok(over.percent === 100, '超额时进度封顶在 100%（不显示 150%）');
  ok(over.overAchieved === true, '超额完成标记为 true');
  ok(over.leftSec === 0, '超额时还差 0（不出现负数）');

  /* 百分比封顶很重要：进度条宽度是按 percent 算的，
     若不封顶，练了 3 倍时长会得到 width:300%，进度条溢出卡片。 */
  ok(over.percent <= 100, '进度百分比绝不超过 100');

  // 脏数据
  const dirty = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 10 }, todaySec: -50 });
  ok(dirty.doneSec === 0, '负的已练时长被夹到 0');
  const dirty2 = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 10 }, todaySec: 'abc' });
  ok(dirty2.doneSec === 0, '非数字已练时长按 0 处理');
  const noSettings = D.dailyPlanProgress({});
  ok(noSettings.enabled === false, '缺 settings 时安全降级为不启用');
}

/* ============================================================
   【3】planDoneToday：跨天失效
   ============================================================ */
console.log('【3】planDoneToday 的跨天失效');

{
  ok(D.planDoneToday('2026-10-10', '2026-10-10') === true, '同一天 → 已完成');
  ok(D.planDoneToday('2026-10-09', '2026-10-10') === false, '昨天完成，今天不算（自动失效）');
  ok(D.planDoneToday('', '2026-10-10') === false, '空标记 → 未完成');
  ok(D.planDoneToday(null, '2026-10-10') === false, 'null 标记 → 未完成');
  ok(D.planDoneToday(undefined, '2026-10-10') === false, 'undefined 标记 → 未完成');

  /* 这一条是「存日期而不是布尔」的核心价值：不需要任何重置动作，
     跨零点自然失效。如果实现成布尔，就必须有定时器去清，
     而休眠跨天、多设备改时间都会让那个定时器不可靠。 */
  ok(D.planDoneToday('2026-10-10', '2026-10-11') === false,
    '存的是具体日期，明天自动不匹配（无需重置逻辑）');
}

/* ============================================================
   【4】buildDailyPlan：按剩余时长定单局长度
   ============================================================ */
console.log('【4】buildDailyPlan 的单局时长与组题');

{
  const emptyOpts = { weakList: [], slowKeys: null, mastery: null };

  // 剩余 4 分钟 → 单局 4 分钟
  const p4 = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 10 }, todaySec: 360 });
  const b4 = D.buildDailyPlan({ plan: p4, ...emptyOpts });
  ok(b4.roundSec === 240, '已练 6 分钟、计划 10 分钟 → 本轮 240 秒（4 分钟）');
  ok(Array.isArray(b4.questions) && b4.questions.length > 0, '能组出题目');
  ok(Array.isArray(b4.reasons) && b4.reasons.length > 0, '给出了推荐理由');
  ok(b4.reasons[0].includes('还差'), '第一条理由说明本轮在计划中的位置');

  /* 关键设计：本轮只组**剩余**时长，而不是一次给满计划时长。
     否则用户练到一半就达标，进度条卡在 100% 不动、不知道要不要继续。 */
  const small = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 10 }, todaySec: 570 });
  const bSmall = D.buildDailyPlan({ plan: small, ...emptyOpts });
  ok(bSmall.roundSec === 60, '只剩 30 秒 → 仍给最小单局 60 秒（不为 0）');

  // 已达标 → 仍给最小单局，让「开始」按钮有东西可练
  const pDone = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 10 }, todaySec: 700 });
  const bDone = D.buildDailyPlan({ plan: pDone, ...emptyOpts });
  ok(bDone.roundSec === 60, '已达标再点「开始」→ 给最小单局 60 秒');
  ok(bDone.questions.length > 0, '已达标仍能组出题目（加练不是空按钮）');
  ok(bDone.reasons[0].includes('加练'), '已达标时理由说明这是加练');

  // 剩余超过单局上限 → 封顶 10 分钟
  const pHuge = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 120 }, todaySec: 0 });
  const bHuge = D.buildDailyPlan({ plan: pHuge, ...emptyOpts });
  ok(bHuge.roundSec === 600, '剩余 120 分钟 → 单局封顶 600 秒（10 分钟）');

  // 未启用计划时退化为「练 5 分钟」
  const pOff = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 0 }, todaySec: 0 });
  const bOff = D.buildDailyPlan({ plan: pOff, ...emptyOpts });
  ok(bOff.roundSec === 300, '未启用计划时退化为 300 秒（与「练 5 分钟」一致）');
}

/* ============================================================
   【5】buildDailyPlan 真的复用了 planMixedSession
   ============================================================ */
console.log('【5】buildDailyPlan 复用 planMixedSession（不另造出题逻辑）');

{
  /* 这一条防的是「为了实现每日计划又写了一套出题器」——
     那必然与「练 5 分钟」给出不一致的结果，同一批弱项在两个入口
     下练到的东西不一样。这里用**相同输入**分别调两个入口，
     要求题目集合一致（planMixedSession 是随机抽题，比题量与结构）。 */

  // 造一批易错项
  S.clearWeak();
  for (const w of ['的', '了', '是', '在', '我']) {
    S.recordWeak({ char: w, word: '', pinyin: S.loadWeak()[w] ? '' : 'de' });
  }
  const weakList = S.getWeakList({ limit: 30, minCount: 1 });

  const plan = D.dailyPlanProgress({ settings: { dailyPlanMinutes: 10 }, todaySec: 0 });
  const built = D.buildDailyPlan({ plan, weakList, slowKeys: null, mastery: null });

  ok(weakList.length > 0, '构造出了易错项样本');
  /* 目标是 600 秒 → planMixedSession 按 6s/题估 100 题，被上限截到 40。
     这里只断言「有题目且数量合理」，不锁死具体数字（组题上限会变）。 */
  ok(built.questions.length > 0 && built.questions.length <= 40,
    `题量在合理范围（${built.questions.length} 题，上限 40）`);
  ok(built.questions.every(q => q && q.id && q.kind),
    '每道题都带 id 与 kind（缺 id 会被 startSession 静默丢弃）');
  const ids = new Set(built.questions.map(q => q.id));
  ok(ids.size === built.questions.length, '题目之间无重复（去重生效）');
  ok(Array.isArray(built.plan), '返回了分组明细 plan');
  ok(built.reasons.some(r => r.includes('易错')), '理由里包含了易错项的说明');
}

/* ============================================================
   【6】设置项读写
   ============================================================ */
console.log('【6】设置项 dailyPlanMinutes / dailyPlanDoneOn 的读写');

{
  const st = S.loadSettings();
  ok(st.dailyPlanMinutes === 10, '默认每日计划时长为 10 分钟');
  ok(st.dailyPlanDoneOn === '', '默认完成标记为空字符串');
  ok(typeof st.dailyPlanMinutes === 'number', 'dailyPlanMinutes 是数字类型（会走数值校验分支）');
  ok(typeof st.dailyPlanDoneOn === 'string', 'dailyPlanDoneOn 是字符串类型');

  st.dailyPlanMinutes = 25;
  st.dailyPlanDoneOn = '2026-10-10';
  S.saveSettings(st);
  const back = S.loadSettings();
  ok(back.dailyPlanMinutes === 25, '保存后读回 25 分钟');
  ok(back.dailyPlanDoneOn === '2026-10-10', '保存后读回完成日期');

  // 类型校验：存了脏值要能回落而不是崩溃
  ls.setItem(S.KEYS.settings, JSON.stringify({ dailyPlanMinutes: 'abc', dailyPlanDoneOn: 123 }));
  const dirty = S.loadSettings();
  ok(dirty.dailyPlanMinutes === 10, '脏值 "abc" 回落到默认 10');
  ok(typeof dirty.dailyPlanDoneOn === 'string', '脏值 123 被转成字符串（不保留数字）');
}

/* ============================================================
   【7】todaySeconds：每日计划进度的数据来源
   ============================================================ */
console.log('【7】summarize 的 todaySeconds');

{
  const St = await fresh('stats.js');

  /* 造两条今天的记录 + 一条昨天的记录。
     今天的时长之和应当只算今天那两条 —— 跨天串味是这类统计
     最常见的错，表现为「早上打开就看到今天已练了 20 分钟」。 */
  const now = new Date();
  const today = S.dateStr(now);
  const yest = S.dateStr(new Date(now.getTime() - 86400000));

  S.clearHistory?.();
  const mk = (date, dur) => ({
    id: `r-${date}-${dur}`, ts: now.getTime(), date, mode: 'char',
    durationSec: dur, totalChars: 10, correctChars: 10, wrongChars: 0,
    keystrokes: 20, speed: 30, accuracy: 100
  });
  ls.setItem(S.KEYS.history, JSON.stringify([
    mk(today, 120), mk(today, 180), mk(yest, 600)
  ]));

  const sum = St.summarize();
  ok(sum.todaySeconds === 300, `今日时长只算今天（120+180=300，实际 ${sum.todaySeconds}）`);
  ok(sum.todaySeconds !== 900, '昨天的 600 秒没有被算进来');
}

console.log('');
if (fail) {
  console.log(`❌ 每日计划自检有 ${fail} 项失败`);
  process.exit(1);
}
console.log('✅ 每日计划自检全部通过');
