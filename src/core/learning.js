import { LEARNING_CHAPTERS, LEARNING_LESSONS, LEARNING_MAP } from '../data/learning.js';
import { KEY_COMPONENTS, questionFromPhrase, questionFromCharChar, shuffle } from './questions.js';
import { loadLearningProgress, saveLearningProgress, loadCourseProgress, dateStr } from './storage.js';
export { LEARNING_CHAPTERS, LEARNING_LESSONS, LEARNING_MAP };
export const LEARNING_PHASES = { guided: '提示练习', check: '独立小测', repair: '针对性补练', review: '隔天回访' };

export function learningItems(lesson) {
  if (!lesson) return [];
  if (lesson.parts) return lesson.parts.map(part => {
    const component = KEY_COMPONENTS.find(c => c.role === lesson.role && c.part === part);
    if (!component) throw new Error(`课程成分不存在：${lesson.id}/${part}`);
    return { id: part, label: part === 'v' ? 'ü（v）' : part, key: component.key };
  });
  return (lesson.samples || []).map(([text, pinyin]) => ({ id: text, label: text, pinyin }));
}

export function buildLearningQuestions(lesson, phase = 'guided', repairItems = []) {
  let items = learningItems(lesson);
  if (phase === 'repair' && repairItems.length) {
    const filtered = items.filter(item => repairItems.includes(item.id));
    if (filtered.length) items = filtered;
  }
  const rounds = phase === 'repair' ? 3 : 4;
  const questions = [];
  for (let round = 0; round < rounds; round++) {
    for (const item of shuffle(items)) {
      let q;
      if (lesson.parts) q = {
        kind: 'key', level: 1, label: lesson.role === 'sheng' ? '声母键' : '韵母键',
        role: lesson.role, promptText: item.label, promptSub: '按出这一成分所在的键',
        answerKeys: [item.key], explain: `${item.label} → ${item.key}`,
        keyDetail: { key: item.key, shengmu: lesson.role === 'sheng' ? item.id : null,
          yunmu: lesson.role === 'yun' ? item.id : null }
      };
      else q = Array.from(item.label).length === 1
        ? questionFromCharChar(item.label, item.pinyin)
        : questionFromPhrase(item.label, item.pinyin.split(' '));
      if (!q) throw new Error(`课程题目无效：${lesson.id}/${item.id}`);
      q.id = `learn-${lesson.id}-${round}-${questions.length}`;
      q.meta = { ...q.meta, learningItem: item.id, learningLesson: lesson.id };
      questions.push(q);
    }
  }
  return questions;
}

/** Preserve old course evidence as "practised", without inventing independent passes. */
export function learningProgress() {
  const p = loadLearningProgress();
  const old = new Set(loadCourseProgress().completed);
  let changed = false;
  for (const lesson of LEARNING_LESSONS) {
    if (lesson.legacy?.some(id => old.has(id)) && !p.lessons[lesson.id]?.practicedAt) {
      p.lessons[lesson.id] = { ...p.lessons[lesson.id], practicedAt: Date.now(), legacy: true };
      changed = true;
    }
  }
  if (changed) { saveLearningProgress(p); return loadLearningProgress(); }
  return p;
}

export function learningPhase(lesson, p, now = Date.now()) {
  const rec = p.lessons[lesson.id] || {};
  if (rec.passedAt && !rec.masteredAt && rec.dueDay && rec.dueDay <= dateStr(new Date(now))) return 'review';
  return rec.practicedAt ? 'check' : 'guided';
}

export function recommendedLearning(p = learningProgress(), now = Date.now()) {
  const today = dateStr(new Date(now));
  const due = LEARNING_LESSONS.find(l => {
    const r = p.lessons[l.id];
    return r?.passedAt && !r.masteredAt && r.dueDay && r.dueDay <= today;
  });
  const lesson = due || LEARNING_LESSONS.find(l => !p.lessons[l.id]?.passedAt);
  return lesson ? { lesson, phase: due ? 'review' : learningPhase(lesson, p, now) } : null;
}

export function normalizeLearningSession(raw) {
  if (!raw || !Object.hasOwn(LEARNING_MAP, raw.lessonId) || !Object.hasOwn(LEARNING_PHASES, raw.phase)) return null;
  const ids = learningItems(LEARNING_MAP[raw.lessonId]).map(i => i.id);
  const evidence = {};
  for (const id of ids) {
    const item = raw.evidence?.[id];
    if (item) {
      const seen = Math.max(0, Math.min(100, Math.floor(Number(item.seen) || 0)));
      evidence[id] = { seen,
        independent: Math.max(0, Math.min(seen, Math.floor(Number(item.independent) || 0))) };
    }
  }
  return { lessonId: raw.lessonId, phase: raw.phase, evidence,
    repairItems: Array.isArray(raw.repairItems) ? raw.repairItems.filter(id => ids.includes(id)) : [] };
}

export function observeLearning(session, question, independent) {
  const id = question?.meta?.learningItem;
  if (!session || question?.meta?.learningLesson !== session.lessonId || !id) return;
  const evidence = session.evidence[id] ||= { seen: 0, independent: 0 };
  evidence.seen++;
  if (independent) evidence.independent++;
}

export function evaluateLearning(session, summary) {
  const lesson = Object.hasOwn(LEARNING_MAP, session?.lessonId) ? LEARNING_MAP[session.lessonId] : null;
  if (!lesson) return { passed: false, failedItems: [], reason: '关卡不存在' };
  const items = learningItems(lesson);
  const assessment = session.phase === 'check' || session.phase === 'review';
  const failedItems = items.filter(item => {
    const e = session.evidence[item.id];
    return !e || e.seen < 4 || e.independent / e.seen < .75;
  }).map(item => item.id);
  const covered = items.every(item => (session.evidence[item.id]?.seen || 0) >= 4);
  const passed = !!summary.completed && (assessment
    ? covered && !failedItems.length && Number(summary.independentAccuracy) >= 90
    : session.phase === 'repair' || covered);
  const reason = !summary.completed ? '本轮未完成，继续练完再做判定'
    : assessment && !covered ? '还有本关成分没有完整测到'
    : assessment && !passed ? '先补练薄弱项，再做一次独立小测'
    : session.phase === 'guided' ? '提示练习完成，接下来试试独立输入'
    : session.phase === 'repair' ? '补练完成，回到整关小测检验'
    : session.phase === 'review' ? '隔天仍能独立答对，已标记为掌握'
    : '小测通过；明天回访后再确认掌握';
  return { passed, failedItems: failedItems.length ? failedItems : items.map(i => i.id), reason };
}

export function recordLearning(session, summary, now = Date.now()) {
  const result = evaluateLearning(session, summary);
  const p = learningProgress();
  const old = p.lessons[session.lessonId] || {};
  const rec = { ...old, attempts: (old.attempts || 0) + 1, lastAt: now };
  if (result.passed && session.phase === 'guided') rec.practicedAt = old.practicedAt || now;
  if (['check','review'].includes(session.phase)) {
    rec.bestIndependent = Math.max(old.bestIndependent || 0, Number(summary.independentAccuracy) || 0);
    rec.lastCheckAt = now;
    if (result.passed) {
      rec.practicedAt = old.practicedAt || now;
      rec.passedAt = old.passedAt || now;
      // Same-day repeats never count as a delayed retention check.
      if (session.phase === 'review' && old.passedAt &&
          dateStr(new Date(now)) > dateStr(new Date(old.passedAt))) rec.masteredAt = now;
      const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
      rec.dueDay = dateStr(tomorrow);
    }
  }
  p.lessons[session.lessonId] = rec;
  saveLearningProgress(p);
  if (result.passed && session.phase === 'review' && !rec.masteredAt)
    result.reason = '本轮小测通过；隔天再回访后确认掌握';
  return { ...result, lesson: LEARNING_MAP[session.lessonId], phase: session.phase, progress: p };
}
