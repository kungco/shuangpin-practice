/**
 * 每日练习计划
 * ------------------------------------------------------------
 * 用户设定「每天练几分钟」，本模块把**到期错题 + 慢键 + 没练熟的键位**
 * 按这个时长组成当天的练习，并算出今日进度。
 *
 * 【为什么单独一个文件，而不是塞进 mix.js】
 *   mix.js 回答的是「给我凑一套 5 分钟的题」——一次性的、无状态的。
 *   每日计划多一层**跨天状态**：今天是否已完成、进度到哪、明天练什么。
 *   这层状态有独立的时间边界（跨零点失效）和独立的口径（按秒还是按题），
 *   混在一起会让 mix.js 从纯函数变成半个状态机。
 *
 * 【复用而非另造】组题本身**完全交给 planMixedSession** —— 它已经处理好了
 *   三类来源的权重分配（4:3:3）、单一来源不得超过 50%、产能约束、
 *   题目去重与交错排列。本模块只负责：
 *     ① 决定目标时长（用户设的 / 剩余待补的）；
 *     ② 组织三类数据源喂给它；
 *     ③ 算今日进度。
 *   绝不重新实现一遍出题逻辑 —— 那必然会与「练 5 分钟」给出不一致的结果。
 *
 * 【与 dailyGoalProgress 的关系】两者并存：
 *   - dailyGoalProgress（stats.js）看**结果**：今天练了多少字、坐了几次；
 *   - 本模块看**过程**：今天该练什么、还差多久。
 *   首页两块各自显示，互不覆盖。理由见 storage.js 里 dailyPlanMinutes 的注释。
 */
import { planMixedSession } from './mix.js';

/** 计划时长的合理区间（分钟）。上限 120：再长就不是「每日计划」而是马拉松。 */
export const PLAN_MIN_MINUTES = 1;
export const PLAN_MAX_MINUTES = 120;

/**
 * 把用户设的分钟数夹到合法区间。
 * 非法值（NaN / 负数 / 空）一律当 0（= 不启用计划）。
 */
export function clampPlanMinutes(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(PLAN_MAX_MINUTES, Math.max(PLAN_MIN_MINUTES, n));
}

/**
 * 今天是否已达成计划。
 *
 * 【为什么存日期而不是布尔】布尔需要有人去「每天重置一次」——
 * 那就要定时器、要处理休眠跨天、要处理用户在别的设备上过了零点。
 * 存日期字符串则天然自愈：昨天的 'DONE' 到了今天就对不上，
 * 不需要任何重置动作。
 *
 * @param {string} doneOn   settings.dailyPlanDoneOn
 * @param {string} today    dateStr(now)
 */
export function planDoneToday(doneOn, today) {
  return !!doneOn && String(doneOn) === String(today);
}

/**
 * 计算今日计划的进度。
 *
 * 【口径：按秒，不按题】为什么不用「计划 20 题，做了 8 题」：
 *   - 题目难度差异极大，一道 8 字的短文题和一道单键题不是一回事；
 *   - 中途被打断时，按题算会出现「做了半题」无法表达的状态；
 *   - 用户设的是**分钟**，进度就该用同一单位回报，否则「练了 6 分半」
 *     要换算成题数才能显示，反而绕。
 *   时长从日报的 durationSum 取（daily 里已有该字段，无需新增统计）。
 *
 * @param {object} opts
 *   - settings     当前设置（读 dailyPlanMinutes / dailyPlanDoneOn）
 *   - todaySec     今日已练时长（秒）
 *   - today        今日日期字符串（dateStr）
 * @returns {{
 *   enabled:boolean, minutes:number, goalSec:number,
 *   doneSec:number, leftSec:number, ratio:number, percent:number,
 *   achieved:boolean, overAchieved:boolean
 * }}
 */
export function dailyPlanProgress(opts = {}) {
  const settings = opts.settings || {};
  const minutes = clampPlanMinutes(settings.dailyPlanMinutes);
  const goalSec = minutes * 60;
  const doneSec = Math.max(0, Math.round(Number(opts.todaySec) || 0));

  const enabled = minutes > 0;
  const ratio = enabled && goalSec > 0 ? Math.min(1, doneSec / goalSec) : 0;
  const achieved = enabled && goalSec > 0 && doneSec >= goalSec;

  return {
    enabled,
    minutes,
    goalSec,
    doneSec,
    leftSec: enabled ? Math.max(0, goalSec - doneSec) : 0,
    ratio,
    percent: Math.round(ratio * 100),
    achieved,
    // 超额完成（今天练得比计划多）——首页文案会区分「刚好达标」与「超额」
    overAchieved: enabled && doneSec > goalSec
  };
}

/**
 * 组出今天这一局的题目。
 *
 * 【目标时长怎么定】取「计划剩余」与「单局上限」的较小者：
 *   - 已练 6 分钟、计划 10 分钟 → 本轮只组 4 分钟，避免一次给满 10 分钟
 *     却在中途达到目标，进度条卡在 100% 不动、用户不知道要不要继续；
 *   - 已练超目标 → 仍给一个最小单局（见 MIN_ROUND_SEC），
 *     而不是 0 题。用户既然点了「开始」，就该有东西可练。
 * 这与「练 5 分钟」的固定 300 秒是有意区分的：那个是快捷键，
 * 这个是按进度走的处方。
 *
 * @param {object} opts
 *   - plan          dailyPlanProgress() 的结果
 *   - weakList      weakRanking() 结果（到期优先的易错项）
 *   - slowKeys      slowestKeys() 结果
 *   - mastery       keyMastery() 结果
 * @returns {{questions:Array, reasons:string[], plan:Array, target:number, roundSec:number}}
 */
export function buildDailyPlan(opts = {}) {
  const plan = opts.plan || {};
  const MIN_ROUND_SEC = 60;   // 单局至少 1 分钟，不然进度条刚出来就结束
  const MAX_ROUND_SEC = 600;  // 单局至多 10 分钟，跟「练 5 分钟」同一量级

  const left = Number(plan.leftSec) || 0;
  const roundSec = plan.enabled
    ? Math.min(MAX_ROUND_SEC, Math.max(MIN_ROUND_SEC, left || MIN_ROUND_SEC))
    : 300;   // 没启用计划时（理论上不会走到这里）退化成「练 5 分钟」

  const mixed = planMixedSession({
    durationSec: roundSec,
    weakList: Array.isArray(opts.weakList) ? opts.weakList : [],
    slowKeys: opts.slowKeys || null,
    mastery: opts.mastery || null
  });

  /* 理由：planMixedSession 已经把「为什么练这些」讲清楚了，
     这里只在**前面**补一句本轮的定位，让用户知道这一局在计划中的位置 —
     否则同一套理由在「练 5 分钟」和「今日计划」下长得一样，
     用户分不清自己点的是哪个入口。 */
  const reasons = [];
  if (plan.enabled) {
    const leftMin = Math.max(0, plan.leftSec) / 60;
    reasons.push(
      plan.achieved
        ? `今日计划已完成（${Math.round(plan.doneSec / 60)} / ${plan.minutes} 分钟），这一局是加练`
        : `今日计划还差约 ${leftMin < 1 ? '不到 1' : Math.round(leftMin)} 分钟（已练 ${Math.round(plan.doneSec / 60)} / ${plan.minutes} 分钟），本轮组了 ${Math.round(roundSec / 60)} 分钟`
    );
  }
  reasons.push(...mixed.reasons);

  return { ...mixed, reasons, roundSec };
}
