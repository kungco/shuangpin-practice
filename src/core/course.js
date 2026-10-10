/**
 * 引导课程：进度与晋级判定
 * ------------------------------------------------------------
 * 课程**内容**在 src/data/course.js（纯数据）；这里是与存储、出题、
 * 判定有关的逻辑。拆开是为了让「改课程」和「改判定」互不牵连，
 * 也让判定本身可以脱离 DOM 单测。
 *
 * 晋级的两条硬规则（验收标准原文）：
 *   · 未达到条件时不会跳过关键基础 —— 判定不过，currentLesson 不前进；
 *   · 刷新或中断后能续课 —— 进度落盘在 KEYS.course，按课 id 记。
 */
import { COURSE, currentLesson } from '../data/course.js';
import { generateQuestions } from './questions.js';
import { loadCourseProgress, saveCourseProgress } from './storage.js';

export { COURSE, currentLesson };

/**
 * 判定一课是否达标。
 * @param {object} lesson COURSE 里的一课
 * @param {object} s      引擎 summary()（accuracy / speed / totalChars / keystrokes）
 * @returns {{passed:boolean, failed:Array<{label:string,got:string,need:string}>, summary:string}}
 */
export function evaluatePromotion(lesson, s) {
  const check = (lesson && lesson.check) || {};
  const failed = [];

  const acc = Math.max(0, Math.min(100, Number(s && s.accuracy) || 0));
  // 独立正确率：不含提示辅助的作答占比。summary 一定会带这个字段
  // （engine.summary() 恒输出），缺了按 0 算 —— 宁可严，不可把
  // 「全程看提示」误判成掌握。
  const ind = Math.max(0, Math.min(100, Number(s && s.independentAccuracy) || 0));
  const speed = Math.max(0, Number(s && s.speed) || 0);
  const chars = Math.max(0, Math.floor(Number(s && s.totalChars) || 0));

  if (check.minAccuracy != null && acc < check.minAccuracy) {
    failed.push({ label: '正确率', got: `${Math.round(acc)}%`, need: `≥ ${check.minAccuracy}%` });
  }
  if (check.minIndependent != null && ind < check.minIndependent) {
    failed.push({
      label: '独立正确率',
      got: `${Math.round(ind)}%`,
      need: `≥ ${check.minIndependent}%（不含提示辅助的作答）`
    });
  }
  if (check.minSpeed != null && speed < check.minSpeed) {
    failed.push({ label: '速度', got: `${Math.round(speed)} 字/分`, need: `≥ ${check.minSpeed} 字/分` });
  }
  if (check.minChars != null && chars < check.minChars) {
    failed.push({ label: '完成字数', got: `${chars} 字`, need: `≥ ${check.minChars} 字` });
  }

  const parts = [];
  if (check.minAccuracy != null) parts.push(`正确率 ≥${check.minAccuracy}%`);
  if (check.minIndependent != null) parts.push(`独立正确率 ≥${check.minIndependent}%`);
  if (check.minSpeed != null) parts.push(`速度 ≥${check.minSpeed} 字/分`);
  if (check.minChars != null) parts.push(`完成 ≥${check.minChars} 字`);
  const summary = parts.join(' 且 ');

  return { passed: failed.length === 0, failed, summary };
}

/**
 * 组一课的题目。参数由课程数据给出，出题完全走已有的 generateQuestions
 * （自适应档位、词组筛选、错词加权等机制原样复用）。
 */
export function buildLessonQuestions(lesson, opts = {}) {
  if (!lesson) return [];
  return generateQuestions({
    mode: lesson.mode,
    ...lesson.params,
    ...opts
  });
}

/**
 * 记一次练习并做晋级判定。
 *
 * 只在「有效练习」（至少 5 次按键）时计 attempts —— 拦空练习，
 * 否则误触开始又立刻退出也会留下一条记录，进度页全是噪音。
 *
 * @param {string} lessonId
 * @param {object} s 引擎 summary()
 * @returns {{attempted:boolean, promotion:{passed,failed,summary}, next:object|null, progress:object}}
 */
export function recordLessonAttempt(lessonId, s) {
  const keystrokes = Math.max(0, Math.floor(Number(s && s.keystrokes) || 0));
  const p = loadCourseProgress();
  const lesson = COURSE.find(l => l.id === lessonId) || null;

  if (!lesson || keystrokes < 5) {
    // 无效练习不动进度；currentId 也要校正到「第一门未完成的课」，
    // 防止手动改存储把 currentId 指到已完成的课上
    const next = currentLesson(p);
    const fixed = Object.assign({}, p, { currentId: next ? next.id : '' });
    saveCourseProgress(fixed);
    return { attempted: false, promotion: null, next, progress: fixed };
  }

  const acc = Math.max(0, Math.min(100, Number(s.accuracy) || 0));
  const ind = Math.max(0, Math.min(100, Number(s.independentAccuracy) || 0));
  const speed = Math.max(0, Number(s.speed) || 0);
  const chars = Math.max(0, Math.floor(Number(s.totalChars) || 0));
  const rec = p.lessons[lessonId] || {
    attempts: 0, bestAcc: 0, bestInd: 0, bestSpeed: 0, bestChars: 0, completedAt: 0
  };
  rec.attempts += 1;
  rec.bestAcc = Math.max(rec.bestAcc, acc);
  rec.bestInd = Math.max(rec.bestInd || 0, ind);
  rec.bestSpeed = Math.max(rec.bestSpeed, speed);
  rec.bestChars = Math.max(rec.bestChars, chars);

  const promotion = evaluatePromotion(lesson, s);
  if (promotion.passed && !p.completed.includes(lessonId)) {
    p.completed.push(lessonId);
    rec.completedAt = Date.now();
  }
  p.lessons[lessonId] = rec;
  p.updatedAt = Date.now();

  // currentId 由「第一门未完成的课」推导，而不是自己另存一份 —— 单一数据源，
  // 导入备份 / 手动清进度后都不会出现「currentId 与 completed 对不上」
  const next = currentLesson(p);
  p.currentId = next ? next.id : '';
  saveCourseProgress(p);
  return { attempted: true, promotion, next, progress: p };
}
