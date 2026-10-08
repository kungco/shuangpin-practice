/**
 * 测验评分模块
 * ------------------------------------------------------------
 * 为「能力测验」模式（exam）提供 0–100 的综合评分。
 *
 * 设计原则
 * ---------
 * 1. **正确率是主体，速度是加成，不是等价替换。**
 *    打错 10 个字通常比打慢 10 个字严重得多 —— 慢可以练，错说明键位没记住。
 *    因此正确率占 70 分，速度最多贡献 30 分，且速度分有「门槛」：
 *    正确率低于 60% 时速度分权重会被压低（见下），避免「狂按乱打」刷分。
 *
 * 2. **只用「独立正确率」，不用表面正确率。**
 *    测验模式本来就禁用提示，理论上两者相等；但为了在数据被导入 / 续练
 *    等边界情况下也站得住，这里统一取独立正确率（剔除了依赖提示的字符）。
 *    这条是硬约束 —— 分数绝不能因为提示而变高。
 *
 * 3. **样本量不足不形成有效成绩。**
 *    有效字符少于 20 个时，只展示练习数据，不给分数和等级。
 *
 * 4. **未完成要扣分，但按完成比例扣，不是一刀切。**
 *    限时测验没打完是正常的（时间到就交卷）；乱按结束则完成度很低。
 *    用完成度线性加权，既不惩罚「时间到」，也不放过「打了 3 题就退」。
 *
 * 5. **纯函数、无副作用、不碰 DOM / 存储。**
 *    方便单测和以后复用（例如做「历史最佳分」曲线）。
 */

import { LEVEL_MAP } from './questions.js';

/* ============================================================
   参数（集中在这里，方便以后调参）
   ============================================================ */

export const SCORE_CONFIG = {
  /* 分项满分 */
  accuracyWeight: 70,     // 正确率分
  speedWeight: 30,        // 速度分

  /* 速度分的「达标线」与「满分线」（字/分）
     低于 baseline 得 0 分，达到 full 得满分，中间线性插值。
     60 字/分 ≈ 全拼熟练水平，是双拼新手值得追求的第一目标；
     120 字/分 ≈ 双拼熟练使用者的水平。 */
  speedBaseline: 40,
  speedFull: 120,

  /* 正确率低于此值时，速度分按比例打折。
     理由：正确率很差时「打得快」没有意义，不该拿速度分。
     正确率 60% 时速度分只剩 40%，正确率 ≥80% 时速度分不打折。 */
  speedGateAccuracy: 60,
  speedGateFullAt: 80,

  /* 可信度：打满多少字之后分数才完全可信 */
  minReliableChars: 20,

  /* 等级阈值（闭区间下界） */
  grades: [
    { min: 95, name: '卓越', badge: 'S', desc: '键位已经形成稳定的肌肉记忆，速度与准确度俱佳。' },
    { min: 85, name: '优秀', badge: 'A', desc: '键位掌握扎实，可以开始追求速度了。' },
    { min: 70, name: '良好', badge: 'B', desc: '基本能独立打出，个别韵母还需要巩固。' },
    { min: 55, name: '及格', badge: 'C', desc: '能打出来，但正确率或速度还有明显提升空间。' },
    { min: 40, name: '待加强', badge: 'D', desc: '键位还没记牢，建议回到键位图与拆分模式再练。' },
    { min: 0,  name: '需重练', badge: 'E', desc: '建议先完成「键位熟悉 → 声韵拆分 → 单字」三步再回来测验。' }
  ]
};

/* ============================================================
   工具
   ============================================================ */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** 线性插值：x 在 [x0, x1] 之间 → [y0, y1]；超出则截断 */
function lerp(x, x0, x1, y0, y1) {
  if (x1 === x0) return x >= x1 ? y1 : y0;
  const t = clamp((x - x0) / (x1 - x0), 0, 1);
  return y0 + (y1 - y0) * t;
}

/**
 * 根据总分取等级
 * @param {number} score 0–100
 */
export function gradeOf(score) {
  const s = clamp(num(score), 0, 100);
  const list = SCORE_CONFIG.grades;
  for (const g of list) {
    if (s >= g.min) return Object.assign({ score: Math.round(s) }, g);
  }
  return Object.assign({ score: Math.round(s) }, list[list.length - 1]);
}

/* ============================================================
   主评分函数
   ============================================================ */

/**
 * 对一次测验打分
 *
 * @param {object} summary engine.summary() 的返回值（或结构相同的对象）
 *   - independentAccuracy  独立正确率（0–100）
 *   - accuracy             表面正确率（0–100）
 *   - speed                速度（字/分）
 *   - correctChars         打对的字符数
 *   - wrongChars           出错的字符数
 *   - totalChars           完成的字符数
 *   - hintedChars          依赖提示的字符数（测验模式应为 0）
 *   - doneQuestions        已完成的题数
 *   - questionCount        总题数
 *   - completed            是否全部完成
 *   - durationSec          用时（秒）
 * @param {object} [opts]
 *   - requireHintsZero: 是否要求无提示才算有效（默认 true）
 * @returns {{
 *   score: number, grade: string, badge: string, gradeDesc: string,
 *   parts: {accuracy:number, speed:number, completion:number},
 *   metrics: object, valid: boolean, warnings: string[]
 * }}
 */
export function scoreExam(summary, opts = {}) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const cfg = SCORE_CONFIG;
  const warnings = [];

  /* ---------- 1. 取数与健壮性 ---------- */
  const correctChars = Math.max(0, num(s.correctChars));
  const wrongChars = Math.max(0, num(s.wrongChars));
  const totalChars = Math.max(0, num(s.totalChars));
  const hintedChars = Math.max(0, num(s.hintedChars));
  const speed = Math.max(0, num(s.speed));
  const durationSec = Math.max(0, num(s.durationSec));
  const doneQuestions = Math.max(0, num(s.doneQuestions));
  const questionCount = Math.max(0, num(s.questionCount));

  // 独立正确率优先；缺失时才退回表面正确率
  let accuracy = s.independentAccuracy !== undefined && s.independentAccuracy !== null
    ? num(s.independentAccuracy)
    : num(s.accuracy);
  accuracy = clamp(accuracy, 0, 100);

  /* ---------- 2. 是否「有效测验」 ---------- */
  // 测验的有效前提是「没有依赖提示」。若引擎被外部改动导致有提示，
  // 分数仍会计算，但标记为无效并给出警告（UI 可选择不记录该成绩）。
  const requireHintsZero = opts.requireHintsZero !== false;
  let valid = !(requireHintsZero && hintedChars > 0);
  if (!valid) {
    warnings.push(`本次有 ${hintedChars} 个字符依赖了提示，成绩不作为有效测验分。`);
  }

  /* ---------- 3. 正确率分（满分 accuracyWeight） ---------- */
  // 直接用正确率百分比，线性映射到 0–accuracyWeight。
  const accuracyPart = (accuracy / 100) * cfg.accuracyWeight;

  /* ---------- 4. 速度分（满分 speedWeight），带正确率闸门 ---------- */
  const rawSpeedRatio = lerp(speed, cfg.speedBaseline, cfg.speedFull, 0, 1);
  // 闸门：正确率 <60% 时速度分大幅缩水，≥80% 不打折
  const gate = lerp(accuracy, cfg.speedGateAccuracy, cfg.speedGateFullAt, 0.4, 1);
  const speedPart = rawSpeedRatio * cfg.speedWeight * gate;

  /* ---------- 5. 完成度分（只从正确率分里按比例扣，不新增分项） ---------- */
  // 完成度 = 已做题数 / 总题数；不限题量（questionCount 为 0）时视为已完成。
  // 注：这里刻意**不**把「时间到」当成未完成惩罚 —— 限时测验打不完是正常的，
  //     时间到交卷的完成度就是它真实的完成度。
  const completion = questionCount > 0
    ? clamp(doneQuestions / questionCount, 0, 1)
    : 1;

  /* ---------- 6. 样本量检查 ---------- */
  // 用「有效字符数」而不是题数衡量：短文的题数少但字数多，按题数会误判。
  const sample = Math.max(0, totalChars);
  const confidence = clamp(sample / cfg.minReliableChars, 0, 1);
  const sampleWarn = confidence < 1;
  if (sampleWarn) {
    valid = false;
    warnings.push(`本次只完成了 ${sample} 个字符，样本不足；至少完成 ${cfg.minReliableChars} 个字符后才形成有效成绩。`);
  }

  /* ---------- 7. 合成总分 ---------- */
  // 基础分：正确率分 + 速度分（0–100）
  const base = accuracyPart + speedPart;
  // 完成度线性加权：没打完就按比例拿分
  const earned = base * completion;
  // 保留实际计算值；无效成绩由 valid 标识，界面不展示其分数。
  const score = clamp(earned, 0, 100);

  const g = gradeOf(score);

  return {
    score: Math.round(score * 10) / 10,
    grade: valid ? g.name : '未形成有效成绩',
    badge: valid ? g.badge : '',
    gradeDesc: valid ? g.desc : '请在无提示的情况下完成足够的题目后再评定等级。',
    valid,
    warnings,
    parts: {
      accuracy: Math.round(accuracyPart * 10) / 10,
      speed: Math.round(speedPart * 10) / 10,
      completion: Math.round(completion * 1000) / 10   // 百分比，一位小数
    },
    metrics: {
      accuracy,                 // 独立正确率
      rawAccuracyPart: cfg.accuracyWeight,
      speed,
      rawSpeedRatio: Math.round(rawSpeedRatio * 1000) / 10,
      speedGate: Math.round(gate * 1000) / 10,
      sample,
      confidence: Math.round(confidence * 1000) / 10,
      completion: Math.round(completion * 1000) / 10,
      correctChars,
      wrongChars,
      totalChars,
      hintedChars,
      durationSec,
      doneQuestions,
      questionCount,
      completed: !!s.completed
    }
  };
}

/**
 * 便捷：直接给「等级徽章 + 颜色档位」用的小工具。
 * 颜色档位用于 UI（1 最好 → 4 最差），与 gradeBadge 无关。
 */
export function gradeTier(score) {
  const s = clamp(num(score), 0, 100);
  if (s >= 85) return 1;
  if (s >= 70) return 2;
  if (s >= 55) return 3;
  return 4;
}

/** 测验模式的说明文案（UI 与 README 共用，避免两处不一致） */
export function examModeBrief() {
  const name = LEVEL_MAP && LEVEL_MAP.exam ? LEVEL_MAP.exam.name : '能力测验';
  return `${name}：全程无提示、无求助，独立完成。完成后给出 0–100 的综合分。`;
}
