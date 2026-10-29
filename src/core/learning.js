import { LEARNING_CHAPTERS, LEARNING_LESSONS, LEARNING_MAP } from '../data/learning.js';
import { KEY_COMPONENTS, questionFromPhrase, questionFromCharChar, shuffle, ALL_CHARS } from './questions.js';
import { primarySplit } from './scheme.js';
import { loadLearningProgress, saveLearningProgress, loadCourseProgress, dateStr } from './storage.js';
export { LEARNING_CHAPTERS, LEARNING_LESSONS, LEARNING_MAP };
export const LEARNING_PHASES = { guided: '提示练习', check: '独立小测', transfer: '换字验收', repair: '针对性补练', review: '到期回访' };
const REVIEW_DAYS=[1,3,7,30];
const ambiguous=new Set(Array.from('行长重得着还地的了为都数教乐觉便处更看好大将种和朝传弹藏称差参间角调薄省应发背空少强尽率单折恶血露似挣舍解结约降系落干划圈转只只会没难当分正中要度曾佛供相累兴盛量鲜论鲜和劲便谁给禁倒跑担处扁宁漂糊载钻缝旋铺钻塞咽泊数斗削拗屏模蒙柏壳'));
function itemPart(lesson,py){const s=primarySplit(py);return !s||(s.zero&&s.yun!=='er')?null:lesson.role==='sheng'?s.sheng:s.yun;}
export function chooseLearningTransfer(lesson,excluded=[]){
  if(!lesson?.parts)return [];
  const used=new Set(Array.from(excluded.join(''))),samples=[];
  for(const id of lesson.parts){
    const part=id==='ue'?'ve':id;
    const pool=Object.entries(ALL_CHARS).filter(([ch,py])=>!used.has(ch)&&!ambiguous.has(ch)&&itemPart(lesson,py)===part);
    const selected=shuffle(pool.slice(0,16)).slice(0,2);
    if(selected.length<2)throw Error('本轮换字材料不足，请先练其他关卡。');
    for(const [ch,py] of selected){used.add(ch);samples.push({id,ch,py});}
  }
  return samples;
}

export function learningItems(lesson) {
  if (!lesson) return [];
  if (lesson.parts) return lesson.parts.map(part => {
    const component = KEY_COMPONENTS.find(c => c.role === lesson.role && c.part === part);
    if (!component) throw new Error(`课程成分不存在：${lesson.id}/${part}`);
    return { id: part, label: part === 'v' ? 'ü（v）' : part, key: component.key };
  });
  return (lesson.samples || []).map(([text, pinyin]) => ({ id: text, label: text, pinyin }));
}

export function buildLearningQuestions(lesson, phase = 'guided', repairItems = [], transferSamples = []) {
  if(lesson.parts && ['transfer','review'].includes(phase) && transferSamples.length){
    return shuffle(transferSamples).map((s,index)=>{const q=questionFromCharChar(s.ch,s.py);
      q.id=`learn-${lesson.id}-${phase}-${index}`;q.meta={...q.meta,learningItem:s.id,learningLesson:lesson.id};return q;});
  }
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
  if (rec.failedAt && !rec.passedAt) return rec.repairedAt > rec.failedAt ? 'check' : 'repair';
  if (lesson.parts && rec.passedAt && !rec.transferAt) return 'transfer';
  if (rec.passedAt && rec.dueDay && rec.dueDay <= dateStr(new Date(now))) return 'review';
  return rec.practicedAt ? 'check' : 'guided';
}

export function recommendedLearning(p = learningProgress(), now = Date.now()) {
  const today = dateStr(new Date(now));
  const due = LEARNING_LESSONS.find(l => {
    const r = p.lessons[l.id];
    return r?.passedAt && (!l.parts||r.transferAt) && r.dueDay && r.dueDay <= today;
  });
  const repair = LEARNING_LESSONS.find(l => p.lessons[l.id]?.failedAt && !p.lessons[l.id]?.passedAt);
  const transfer=LEARNING_LESSONS.find(l=>l.parts && p.lessons[l.id]?.passedAt && !p.lessons[l.id]?.transferAt);
  const lesson = due || repair || transfer || LEARNING_LESSONS.find(l => !p.lessons[l.id]?.passedAt);
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
  const lesson=LEARNING_MAP[raw.lessonId];
  const transferSamples=(Array.isArray(raw.transferSamples)?raw.transferSamples:[]).filter(s=>s&&ids.includes(s.id)&&
    ALL_CHARS[s.ch]===s.py&&itemPart(lesson,s.py)===(s.id==='ue'?'ve':s.id)).slice(0,ids.length*2);
  if(raw.phase==='transfer' && (!lesson.parts || transferSamples.length!==ids.length*2 ||
    new Set(transferSamples.map(s=>s.ch)).size!==transferSamples.length || !ids.every(id=>transferSamples.filter(s=>s.id===id).length===2)))return null;
  return { lessonId: raw.lessonId, phase: raw.phase, evidence, transferSamples,
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
  const allItems = learningItems(lesson);
  const selected = session.phase === 'repair' ? allItems.filter(i => session.repairItems.includes(i.id)) : [];
  const items = selected.length ? selected : allItems;
  const assessment = ['check','review','transfer'].includes(session.phase);
  const transfer=session.transferSamples?.length>0 && ['review','transfer'].includes(session.phase);
  const rounds = transfer?2:session.phase === 'repair' ? 3 : 4;
  const failedItems = items.filter(item => {
    const e = session.evidence[item.id];
    return !e || e.seen < rounds || (assessment && e.independent / e.seen < (transfer?1:.75));
  }).map(item => item.id);
  const covered = items.every(item => (session.evidence[item.id]?.seen || 0) >= rounds);
  const passed = !!summary.completed && (assessment
    ? covered && !failedItems.length && Number(summary.independentAccuracy) >= (transfer?100:90)
    : covered);
  const reason = !summary.completed ? '本轮未完成，继续练完再做判定'
    : assessment && !covered ? '还有本关成分没有完整测到'
    : assessment && !passed ? '先补练薄弱项，再做一次独立小测'
    : !covered ? '还有目标没有实际练完；跳过不计为完成'
    : session.phase === 'guided' ? '提示练习完成，接下来试试独立输入'
    : session.phase === 'repair' ? '补练完成，回到整关小测检验'
    : session.phase === 'transfer' ? '换字全部独立答对，明天回访后确认掌握'
    : session.phase === 'review' ? '本轮独立回访通过'
    : lesson.parts ? '键位小测通过，接下来换字验收'
    : '小测通过；明天回访后再确认掌握';
  return { passed, failedItems: failedItems.length ? failedItems : items.map(i => i.id), reason };
}

export function recordLearning(session, summary, now = Date.now()) {
  const result = evaluateLearning(session, summary);
  const p = learningProgress();
  const old = p.lessons[session.lessonId] || {};
  const rec = { ...old, attempts: (old.attempts || 0) + 1, lastAt: now };
  if(session.transferSamples?.length)rec.lastTransfer=session.transferSamples.map(s=>s.ch).join('');
  if (result.passed && session.phase === 'guided') rec.practicedAt = old.practicedAt || now;
  if (result.passed && session.phase === 'repair') rec.repairedAt = Math.max(now, (old.failedAt || 0) + 1);
  if (['check','review','transfer'].includes(session.phase)) {
    rec.bestIndependent = Math.max(old.bestIndependent || 0, Number(summary.independentAccuracy) || 0);
    rec.lastCheckAt = now;
    if (result.passed) {
      rec.practicedAt = old.practicedAt || now;
      rec.passedAt = old.passedAt || Math.max(now, (old.failedAt || 0) + 1);
      rec.repairItems = [];
      if(session.phase==='transfer')rec.transferAt=Math.max(now,(old.failedAt||0)+1);
      // Same-day repeats never count as a delayed retention check.
      const today=dateStr(new Date(now));
      const due=old.dueDay && old.dueDay<=today && (!old.lastReviewAt||dateStr(new Date(old.lastReviewAt))<today);
      if(session.phase==='review' && old.passedAt && due && dateStr(new Date(now))>dateStr(new Date(old.passedAt))){
        rec.masteredAt=old.masteredAt||now;rec.lastReviewAt=now;rec.reviewStep=Math.min(3,(old.reviewStep||0)+1);
        const next=new Date(now);next.setDate(next.getDate()+REVIEW_DAYS[rec.reviewStep]);rec.dueDay=dateStr(next);
      }else if(!old.passedAt || session.phase==='transfer' || !old.dueDay){
        const next=new Date(now);next.setDate(next.getDate()+1);rec.dueDay=dateStr(next);
      }
    } else if (summary.completed) {
      rec.failedAt = Math.max(now, (old.failedAt || 0) + 1, (old.repairedAt || 0) + 1,
        (old.passedAt || 0) + 1, (old.masteredAt || 0) + 1);
      rec.passedAt = 0;
      rec.masteredAt = 0;
      rec.transferAt=0;rec.reviewStep=0;
      rec.dueDay = '';
      rec.repairItems = result.failedItems.slice();
    }
  }
  rec.lastAt = Math.max(now, rec.failedAt || 0, rec.passedAt || 0, rec.repairedAt || 0);
  p.lessons[session.lessonId] = rec;
  saveLearningProgress(p);
  if (result.passed && session.phase === 'review' && !rec.masteredAt)
    result.reason = '本轮小测通过；隔天再回访后确认掌握';
  else if(result.passed && session.phase==='review')result.reason=`独立回访通过；下次回访：${rec.dueDay}`;
  return { ...result, lesson: LEARNING_MAP[session.lessonId], phase: session.phase, progress: p };
}
