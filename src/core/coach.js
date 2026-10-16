import { COACH_RULES, COACH_MAP, COACH_CHAR_POOL } from '../data/coach.js';
import { ALL_CHARS } from '../data/pinyin.js';
import { primarySplit } from './scheme.js';
import { questionFromCharChar, shuffle } from './questions.js';
export { COACH_RULES, COACH_MAP };
const ownRule = id => Object.hasOwn(COACH_MAP, id) ? COACH_MAP[id] : null;
const hanChars = text => Array.from(String(text || '')).filter(c => /\p{Script=Han}/u.test(c));
function partFor(rule, py) {
  const split = primarySplit(py);
  if (!split || split.zero) return null;
  // Keep the first u/ü lesson focused on the unambiguous n/l spellings.
  if (rule.id === 'u-v' && split.yun === 'v' && !['n','l'].includes(split.sheng)) return null;
  const part = rule.role === 'sheng' ? split.sheng : split.yun;
  return rule.parts.includes(part) ? part : null;
}

/** Match the observed position and key pair; never infer a user's intention from a random typo. */
export function diagnoseRule(feedback, question, target) {
  if (!feedback || !question) return null;
  const role = target?.role || feedback.role;
  const part = question.kind === 'key'
    ? question.keyDetail?.[role === 'sheng' ? 'shengmu' : 'yunmu'] || question.meta?.learningItem || question.promptText
    : feedback.part || target?.part2 || target?.part;
  const expected = String(feedback.expected || '').toUpperCase();
  const pressed = String(feedback.pressed || '').toUpperCase();
  if (!/^[A-Z]$/.test(pressed) || expected === pressed) return null;
  const rule = COACH_RULES.find(r => r.role === role && r.parts.includes(part) && r.keys[part] === expected &&
    !(r.id==='u-v' && part==='v' && target?.split && !['n','l'].includes(target.split.sheng)) &&
    (r.role === 'sheng' ? ['V','I','U','Z','C','S','H'].includes(pressed) : Object.values(r.keys).includes(pressed)));
  if (!rule) return null;
  const position = question.kind === 'key' || question.kind === 'part' ? '成分键位题'
    : role === 'sheng' ? '第一键（声母）' : '第二键（韵母）';
  return { ruleId: rule.id, text: `${feedback.char || question.promptText || ''} ${feedback.pinyin || ''}：${position}的 ${part === 'v' ? 'ü（v）' : part} 应用 ${expected}，本次按成了 ${pressed}。` };
}

export function normalizeCoachLog(raw) {
  const seen = [...new Set(hanChars(Array.isArray(raw?.seen) ? raw.seen.join('') : ''))].slice(0,6000);
  const issues = [];
  for (const entry of Array.isArray(raw?.issues) ? raw.issues : []) {
    if (!ownRule(entry?.ruleId) || issues.some(i=>i.ruleId===entry.ruleId)) continue;
    issues.push({ ruleId: entry.ruleId,
      marks: [...new Set((Array.isArray(entry.marks) ? entry.marks : []).filter(s=>typeof s==='string' && s.length<80))].slice(0,100),
      text: String(entry.text || '').slice(0,250) });
  }
  return { seen, issues };
}
export function observeCoachError(log, feedback, question, target, mark) {
  const diagnosis = diagnoseRule(feedback,question,target);
  if (!diagnosis) return null;
  let issue = log.issues.find(i=>i.ruleId===diagnosis.ruleId);
  if (!issue) { issue={...diagnosis,marks:[]};log.issues.push(issue); }
  if (!issue.marks.includes(mark) && issue.marks.length<100) issue.marks.push(mark);
  issue.text=diagnosis.text;
  return diagnosis;
}
export function observeCoachSeen(log, question) {
  for (const c of question?.chars || []) if (c.syl?.candidates?.length && !log.seen.includes(c.ch) && log.seen.length<6000) log.seen.push(c.ch);
}
export function coachRecommendations(log) {
  return (log?.issues || []).slice().sort((a,b)=>b.marks.length-a.marks.length).slice(0,2);
}

/** Pick two new characters per rule component; no silent reuse when the pool is exhausted. */
export function createCoachSession(ruleId, exclusions = [], returnView = 'practice') {
  const rule=ownRule(ruleId);if(!rule)return null;
  const excluded=new Set(exclusions.flatMap(hanChars));
  for(const [ch] of rule.samples)excluded.add(ch);
  const holdouts=[];
  for(const part of rule.parts){
    const candidates=(COACH_CHAR_POOL[part] || []).filter(([ch,py])=>ALL_CHARS[ch]===py && !excluded.has(ch) && partFor(rule,py)===part);
    const selected=shuffle(candidates).slice(0,2);
    if(selected.length<2)return null;
    for(const [ch,py] of selected){holdouts.push([ch,py]);excluded.add(ch);}
  }
  return {ruleId,phase:'guided',holdouts,evidence:{},repeat:false,returnView:returnView==='review'?'review':'practice'};
}
export function normalizeCoachSession(raw) {
  const rule=ownRule(raw?.ruleId);
  if(!rule || !['guided','transfer'].includes(raw.phase) || !Array.isArray(raw.holdouts))return null;
  const holdouts=raw.holdouts.filter(x=>Array.isArray(x) && x.length===2 && typeof x[0]==='string' && Array.from(x[0]).length===1 &&
    ALL_CHARS[x[0]]===x[1] && partFor(rule,x[1]) &&
    (COACH_CHAR_POOL[partFor(rule,x[1])] || []).some(([ch,py])=>ch===x[0] && py===x[1]) && !rule.samples.some(([ch])=>ch===x[0]));
  if(holdouts.length!==rule.parts.length*2 || new Set(holdouts.map(([ch])=>ch)).size!==holdouts.length ||
    !rule.parts.every(part=>holdouts.filter(([,py])=>partFor(rule,py)===part).length===2))return null;
  const samples=raw.phase==='guided'?rule.samples:holdouts;
  const evidence={};
  for(const [ch] of samples){const value=raw.evidence?.[ch];if(!value)continue;
    const seen=Math.max(0,Math.min(2,Math.floor(Number(value.seen)||0)));
    evidence[ch]={seen,independent:Math.max(0,Math.min(seen,Math.floor(Number(value.independent)||0)))};
  }
  return {ruleId:rule.id,phase:raw.phase,holdouts,evidence,repeat:raw.repeat===true,returnView:raw.returnView==='review'?'review':'practice'};
}
export function buildCoachQuestions(session) {
  const rule=ownRule(session.ruleId), samples=session.phase==='guided'?rule.samples:session.holdouts;
  const out=[];
  for(let round=0;round<(session.phase==='guided'?2:1);round++)for(const [ch,py] of shuffle(samples)){
    const q=questionFromCharChar(ch,py);q.id=`coach-${rule.id}-${session.phase}-${round}-${out.length}`;
    q.meta={...q.meta,coachRule:rule.id,coachChar:ch};out.push(q);
  }
  return out;
}
export function observeCoachAnswer(session,question,independent) {
  if(!session || question?.meta?.coachRule!==session.ruleId)return;
  const ch=question.meta.coachChar, rule=ownRule(session.ruleId);
  const samples=session.phase==='guided'?rule.samples:session.holdouts;
  if(!samples.some(([key])=>key===ch))return;
  const item=session.evidence[ch] ||= {seen:0,independent:0};item.seen++;if(independent)item.independent++;
}
export function evaluateCoach(session, summary) {
  const rule=ownRule(session?.ruleId);if(!rule)return {passed:false,reason:'规则不可用'};
  const samples=session.phase==='guided'?rule.samples:session.holdouts, rounds=session.phase==='guided'?2:1;
  const covered=samples.every(([ch])=>(session.evidence[ch]?.seen||0)>=rounds);
  const independent=samples.every(([ch])=>session.evidence[ch]?.independent===rounds);
  const passed=!!summary.completed && covered && (session.phase==='guided'||independent);
  return {passed,reason:!summary.completed?'本轮尚未完成，未作通过判定。'
    :session.phase==='guided'?(passed?'对照补练完成，接下来撤掉提示，换字检验。':'还有对照字没有练完。')
    :passed?(session.repeat?'这组字复测通过，可以继续日常练习。':'本轮未见字全部独立答对，规则换字验收通过。')
    :'有字未能独立答对，先看规则并补练，再复测这组字。'};
}
