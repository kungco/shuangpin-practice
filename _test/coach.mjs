/** Rule explanations, genuinely held-out characters, no leaks, and save/resume. */
import assert from 'node:assert/strict';
import {createHarness} from './tools/harness.mjs';
const H=await createHarness();
const names=['setTimeout','clearTimeout','setInterval','clearInterval'];
const timers=Object.fromEntries(names.map(n=>[n,globalThis[n]]));
for(const n of names)globalThis[n]=H.timers[n];
const C=await import('../src/core/coach.js');
const {COACH_CHAR_POOL}=await import('../src/data/coach.js');
const {ALL_CHARS}=await import('../src/data/pinyin.js');
const {primarySplit}=await import('../src/core/scheme.js');
const {questionFromCharChar}=await import('../src/core/questions.js');
const {PracticeEngine}=await import('../src/core/engine.js');
const S=await import('../src/core/storage.js');
const fire=s=>H.fire(s,'click');
function complete(e){for(let i=0;e.state==='running'&&i<3000;i++){const t=e.currentTarget();e.pressKey(t.keys[t.pos]);}assert.equal(e.state,'finished');}
function diagnose(ch,py,first,wrong){const q=questionFromCharChar(ch,py);const e=new PracticeEngine({questions:[q],mode:'char',strict:true});
  let result;e.on('error',fb=>{result={fb,q,target:e.currentTarget(),diagnosis:C.diagnoseRule(fb,q,e.currentTarget())};});e.start();
  if(first)e.pressKey(e.currentTarget().keys[0]);e.pressKey(wrong);e.destroy();return result;}
try{
  console.log('【规则教练】按声韵位置解释，随机错键不冒充规则混淆');
  assert.equal(diagnose('绿','lv',true,'U').diagnosis.ruleId,'u-v');
  assert.equal(diagnose('路','lu',true,'V').diagnosis.ruleId,'u-v');
  assert.equal(diagnose('书','shu',false,'V').diagnosis.ruleId,'zh-ch-sh');
  assert.equal(diagnose('水','shui',true,'Q').diagnosis.ruleId,'ui-iu');
  assert.equal(diagnose('山','shan',true,'H').diagnosis.ruleId,'an-ang');
  assert.equal(diagnose('正','zheng',true,'F').diagnosis.ruleId,'en-eng');
  assert.equal(diagnose('金','jin',true,'K').diagnosis.ruleId,'in-ing');
  assert.equal(diagnose('路','lu',true,'K').diagnosis,null);
  assert.equal(diagnose('安','an',true,'H').diagnosis,null,'零声母韵尾不是普通韵母键');
  assert.equal(diagnose('去','qu',true,'U'),undefined,'U 是正确编码，不产生错误解释');
  assert.equal(diagnose('去','qu',true,'V'),undefined,'V 兼容码也不产生错误解释');
  const log=C.normalizeCoachLog();const d=diagnose('绿','lv',true,'U');
  C.observeCoachError(log,d.fb,d.q,d.target,'0:0');C.observeCoachError(log,d.fb,d.q,d.target,'0:0');
  C.observeCoachError(log,d.fb,d.q,d.target,'1:0');assert.equal(log.issues[0].marks.length,2);
  assert.equal(C.coachRecommendations(log)[0].ruleId,'u-v');
  const keyQ={kind:'key',role:'yun',promptText:'ü（v）',keyDetail:{yunmu:'v'}};
  assert.equal(C.diagnoseRule({expected:'V',pressed:'U'},keyQ,{role:'yun'}).ruleId,'u-v');

  console.log('【规则教练】例字和题池逐字校验；两字一组、训练与验收不重合');
  for(const [part,pool] of Object.entries(COACH_CHAR_POOL))for(const [ch,py] of pool){
    assert.equal(ALL_CHARS[ch],py,`${ch} 注音一致`);assert.ok(primarySplit(py),part);
  }
  for(const rule of C.COACH_RULES){
    for(const [ch,py] of rule.samples)assert.equal(ALL_CHARS[ch],py);
    const excluded=['女','三','生'];const s=C.createCoachSession(rule.id,excluded);
    assert.ok(s);assert.ok(C.normalizeCoachSession(s));
    const q=C.buildCoachQuestions(s);assert.equal(q.length,rule.samples.length*2);
    assert.ok(s.holdouts.every(([ch])=>!excluded.includes(ch)&&!rule.samples.some(([x])=>x===ch)));
    assert.equal(s.holdouts.length,rule.parts.length*2);
    const eng=new PracticeEngine({questions:q,mode:'char',trainingPolicy:'full'});
    eng.on('unit',({independent})=>C.observeCoachAnswer(s,eng.currentQuestion(),independent));eng.start();complete(eng);
    assert.equal(C.evaluateCoach(s,eng.summary()).passed,true);eng.destroy();
    const check=C.normalizeCoachSession({...s,phase:'transfer',evidence:{}});
    const fresh=new PracticeEngine({questions:C.buildCoachQuestions(check),mode:'char',examMode:true});
    fresh.on('unit',({independent})=>C.observeCoachAnswer(check,fresh.currentQuestion(),independent));fresh.start();
    assert.equal(fresh.requestHint(),false);complete(fresh);assert.equal(C.evaluateCoach(check,fresh.summary()).passed,true);fresh.destroy();
  }
  assert.equal(C.createCoachSession('u-v',Object.values(COACH_CHAR_POOL).flat().map(([ch])=>ch)),null,'没有新字时不拿旧字冒充');
  assert.equal(C.normalizeCoachSession({ruleId:'constructor',phase:'guided',holdouts:[]}),null);
  const forged=C.createCoachSession('an-ang');forged.holdouts[0]=['上','shang'];assert.equal(C.normalizeCoachSession(forged),null);

  await H.loadApp();const app=H.fakeWindow.__app;
  console.log('【规则教练 UI】入口、解释、无提示换字、失败复测与原进度隔离');
  app.settings.trainingPolicy='independent';app.settings.hint=false;app.settings.showDecode=false;
  app.settings.charTier='progressive';app.settings.count=0;app.settings.duration=60;
  const oldProgress=S.loadLearningProgress();
  fire('#btnCoachLibrary');fire('#modal [data-act="u-v"]');let e=app.engine;
  assert.equal(app.coachActive.phase,'guided');assert.equal(e.durationSec,0);assert.equal(e.unlimited,false);assert.equal(e.adaptive,false);
  assert.ok(!H.q('#coachTip').hidden);assert.match(H.q('#coachTip').textContent,/ü/);
  fire('#btnToggleDecode');assert.equal(H.q('#coachTip').innerHTML,'');
  assert.match(H.q('#btnToggleDecode').textContent,/显示声韵讲解/);
  e.pressKey('a');assert.equal(H.q('#coachTip').innerHTML,'','隐藏讲解后按错也不重新露出答案');
  fire('#btnToggleDecode');assert.ok(!H.q('#coachTip').hidden);
  const held=app.coachActive.holdouts.map(([ch])=>ch);
  const tracked=app.coachActive.holdouts[0];
  S.recordWeak({char:tracked[0],pinyin:tracked[1]});S._setAllDue(Date.now()-1);
  const trackedBefore=S.loadWeak()[tracked[0]];
  assert.ok(e.questions.every(q=>!held.includes(q.text)),'验收字没有提前进入训练题');
  complete(e);assert.equal(app.coachResult.passed,true);
  assert.match(H.q('#modal [data-act="again"]').textContent,/开始换字验收/);
  fire('#modal [data-act="again"]');e=app.engine;
  assert.equal(app.coachActive.phase,'transfer');assert.equal(e.examMode,true);assert.equal(e.requestHint(),false);
  assert.ok(H.q('#coachTip').hidden);assert.equal(H.q('#coachTip').innerHTML,'');
  e.pressKey(e.currentTarget().keys[0]);const t=e.currentTarget();
  e.pressKey(t.keys[t.pos].toLowerCase()==='u'?'v':t.keys[t.pos].toLowerCase()==='v'?'u':'a');
  assert.equal(H.q('#coachTip').innerHTML,'','错误后也不泄露解释和例字');
  complete(e);assert.equal(app.coachResult.passed,false);assert.deepEqual(S.loadLearningProgress(),oldProgress);
  fire('#modal [data-act="again"]');assert.equal(app.coachActive.phase,'guided');assert.equal(app.coachActive.repeat,true);
  complete(app.engine);assert.match(H.q('#modal [data-act="again"]').textContent,/复测这组字/);
  fire('#modal [data-act="again"]');complete(app.engine);assert.equal(app.coachResult.passed,true);
  assert.equal(S.loadWeak()[tracked[0]].streak,trackedBefore.streak,'课堂验收不替其他到期错题推进排期');
  assert.match(app.coachResult.reason,/复测通过/);fire('#modal [data-act="again"]');assert.equal(app.view,'practice');

  console.log('【规则教练 UI】部分验收、跳过、保存续练与下一轮证据不串用');
  fire('#btnCoachLibrary');fire('#modal [data-act="an-ang"]');complete(app.engine);fire('#modal [data-act="again"]');e=app.engine;
  const ix=e.index;while(e.index===ix){const t=e.currentTarget();e.pressKey(t.keys[t.pos]);}
  fire('#btnQuit');fire('#modal [data-act="save"]');const saved=S.loadResume();
  assert.ok(saved.coach);assert.equal(saved.coach.phase,'transfer');assert.ok(saved.coachLog);
  fire('#btnResume');e=app.engine;assert.equal(e.examMode,true);assert.deepEqual(app.coachActive.evidence,saved.coach.evidence);
  assert.equal(H.q('#coachTip').innerHTML,'');
  fire('#btnQuit');fire('#modal [data-act="end"]');assert.equal(app.coachResult.passed,false);
  fire('#modal [data-act="again"]');e=app.engine;
  assert.equal(app.coachActive.phase,'transfer');assert.equal(app.coachActive.repeat,true,'中途结束后整轮重来也是复测');
  assert.deepEqual(app.coachActive.evidence,{});e.skipCurrent();complete(e);assert.equal(app.coachResult.passed,false);
  fire('#modal [data-act="stats"]');

  console.log('【规则教练 UI】普通练习即时解释，结算按错因接入小课堂');
  fire('[data-view="practice"]');fire('[data-mode="custom"]');app.settings.trainingPolicy='full';app.settings.showDecode=true;
  H.q('#customTextInput').value='绿路';fire('#btnStart');e=app.engine;e.pressKey('L');e.pressKey('U');
  assert.match(H.q('#coachTip').textContent,/第二键/);assert.match(H.q('#coachTip').textContent,/应.*V/);
  e.pressKey('V');assert.equal(H.q('#coachTip').innerHTML,'','换字后清理上题解释');
  complete(e);assert.ok(H.q('#modal [data-act="coach-u-v"]'));
  fire('#modal [data-act="coach-u-v"]');assert.equal(app.coachActive.ruleId,'u-v');complete(app.engine);
  fire('#modal [data-act="again"]');complete(app.engine);assert.equal(app.coachResult.passed,true);fire('#modal [data-act="again"]');

  console.log('【规则教练 UI】复习中不自动给答案，课堂不替原错题判为掌握');
  S.clearWeak();S.recordWeak({char:'绿',pinyin:'lv'});S._setAllDue(Date.now()-1);app.settings.reviewDueOnly=true;
  fire('[data-view="review"]');fire('#btnReviewPractice');e=app.engine;e.pressKey('L');e.pressKey('U');
  assert.equal(H.q('#coachTip').innerHTML,'');complete(e);assert.ok(H.q('#modal [data-act="coach-u-v"]'));
  fire('#modal [data-act="coach-u-v"]');assert.equal(app.coachActive.returnView,'review');complete(app.engine);
  fire('#modal [data-act="again"]');complete(app.engine);assert.equal(S.loadWeak()['绿'].streak,0);
  fire('#modal [data-act="again"]');assert.equal(app.view,'review');
  console.log('✅ 规则教练与换字验收全部通过');
}finally{if(H.fakeWindow.__app?.engine)H.fakeWindow.__app.engine.destroy();H.restoreGlobals();for(const n of names)globalThis[n]=timers[n];}
