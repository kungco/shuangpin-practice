/** Review: actual spacing, independent answers, lapse recovery and saved evidence. */
import assert from 'node:assert/strict';
import { createHarness } from './tools/harness.mjs';
const H = await createHarness();
const timerNames = ['setTimeout','clearTimeout','setInterval','clearInterval'];
const timers = Object.fromEntries(timerNames.map(n => [n,globalThis[n]]));
for (const n of timerNames) globalThis[n] = H.timers[n];
const S = await import('../src/core/storage.js');
const { generateReviewQuestions } = await import('../src/core/questions.js');
const { reviewTotals, normalizeReviewSession } = await import('../src/core/review.js');
await H.loadApp();
const app = H.fakeWindow.__app;
const fire = s => H.fire(s,'click');
const DAY = 86400000;
function at(now, fn) { const original=Date.now; Date.now=()=>now; try{return fn();}finally{Date.now=original;} }
function complete(e) {
  for(let i=0;e.state==='running' && i<2000;i++) {const t=e.currentTarget();e.pressKey(t.keys[t.pos]);}
  assert.equal(e.state,'finished');
}
function seed(key='你', pinyin='ni') {
  S.clearWeak(); const now=Date.now();
  const entry={key,char:Array.from(key)[0],word:Array.from(key).length>1?key:'',pinyin,
    count:20,correct:3,streak:3,interval:7,ease:2.5,due:now-1,
    reviewedAt:now-DAY,successDay:S.dateStr(new Date(now-DAY))};
  S.saveWeak({[key]:entry}); return entry;
}
function start() {fire('[data-view="review"]');fire('#btnReviewPractice');assert.ok(app.engine);return app.engine;}
function close() {fire('#modal [data-act="again"]');assert.ok(H.q('#view-review').classList.contains('is-active'));}
try {
  console.log('【注音修复】旧错题与旧备份修正豫/犹豫，保留原排期');
  const oldReading={key:'豫',char:'豫',pinyin:'lv',count:3,due:Date.now()+86400000};
  S.writeJSON(S.KEYS.weak,{'豫':oldReading,'犹豫':{...oldReading,key:'犹豫',word:'犹豫',pinyin:['you','lv']}});
  assert.equal(S.loadWeak()['豫'].pinyin,'yu');assert.equal(S.loadWeak()['豫'].due,oldReading.due);
  assert.deepEqual(S.loadWeak()['犹豫'].pinyin,['you','yu']);
  const migratedReadingBackup=S.exportAll();S.clearWeak();S.importAll(migratedReadingBackup);
  assert.equal(S.loadWeak()['豫'].pinyin,'yu');
  S.clearWeak();
  console.log('【复习】真实间隔、同日防刷、历史错误多也能重新掌握');
  S.clearWeak(); const base=Date.now();
  for(let n=0;n<20;n++) S.recordWeak({char:'你',pinyin:'ni'});
  at(base,()=>S.recordWeakCorrect({char:'你'}));
  at(base+DAY,()=>S.recordWeakCorrect({char:'你'}));
  const second=S.loadWeak()['你']; assert.equal(second.streak,2);assert.equal(second.interval,3);
  for(const now of [base+DAY+1,base+2*DAY,base+4*DAY-1])
    assert.equal(at(now,()=>S.recordWeakCorrect({char:'你'})).status,'practice');
  assert.deepEqual(S.loadWeak()['你'],second);
  at(base+4*DAY,()=>S.recordWeakCorrect({char:'你'}));
  at(base+11*DAY,()=>S.recordWeakCorrect({char:'你'}));
  const mastered=S.loadWeak()['你'];assert.equal(mastered.mastered,true);assert.equal(mastered.streak,4);
  assert.equal(S.getWeakList({now:base+11*DAY}).length,0);
  assert.equal(S.getWeakList({now:mastered.due}).length,1,'掌握后到期仍回访');
  assert.equal(S.reviewSummary(mastered.due).due,1);
  assert.equal(S.reviewSummary(base+11*DAY).waiting,1);
  const backup=S.exportAll();
  at(mastered.due,()=>S.recordWeakLapse({char:'你'},'helped'));
  const lapsed=S.loadWeak()['你'];assert.equal(lapsed.mastered,false);assert.equal(lapsed.count,20);
  assert.equal(lapsed.streak,0);assert.equal(lapsed.lapseReason,'helped');
  S.importAll(backup);S.importAll(backup);
  assert.equal(S.loadWeak()['你'].mastered,false,'旧备份不能覆盖较新的求助记录');
  assert.equal(S.loadWeak()['你'].lapsedAt,lapsed.lapsedAt);

  console.log('【复习】词组拼音字符串能正确出题，空范围不偷换随机内容');
  const qs=generateReviewQuestions([{word:'你好',pinyin:'ni hao'}],20,{fallback:false});
  assert.equal(qs.length,1);assert.equal(qs[0].text,'你好');
  assert.deepEqual(generateReviewQuestions([{word:'你好',pinyin:'bad'}],20,{fallback:false}),[]);
  const keyQuestions=generateReviewQuestions([{key:'ang',char:'ang'}],1,{fallback:false});
  assert.equal(keyQuestions[0].kind,'key');assert.deepEqual(keyQuestions[0].answerKeys,['H']);
  assert.equal(normalizeReviewSession([]),null);

  console.log('【复习 UI】不受普通模式提示、时长、严格模式和渐进档位影响');
  app.settings.trainingPolicy='full';app.settings.hint=false;app.settings.duration=60;
  app.settings.strict=false;app.settings.charTier='progressive';app.settings.reviewDueOnly=true;
  seed();let e=start();
  assert.equal(e.training.policy,'independent');assert.equal(e.durationSec,0);
  assert.equal(e.strict,true);assert.equal(e.hintEnabled,true);assert.equal(e.adaptive,false);
  assert.equal(e.hintDelayMs,0);assert.equal(e.revealDelayMs,0);
  assert.equal(H.q('#hudAccLabel').textContent,'独立正确率');
  assert.equal(H.q('#reviewBody .rc-keys'),null,'队列不提前展示答案编码');
  complete(e);assert.equal(S.loadWeak()['你'].mastered,true);
  assert.equal(reviewTotals(app.reviewActive).advanced,1);close();
  assert.ok(H.q('.review-rules'));

  console.log('【复习 UI】提前重复只是巩固，失败不会被本轮后续重复抵消');
  app.settings.reviewDueOnly=false;fire('[data-view="review"]');
  // 已掌握且未到期的内容默认收起；用另一个在学条目检查提前巩固。
  seed();e=start();complete(e);close();
  const early=S.loadWeak()['你'];early.mastered=false;S.saveWeak({'你':early});
  fire('[data-view="review"]');fire('.review-chip');e=app.engine;
  complete(e);assert.equal(reviewTotals(app.reviewActive).practice,1);
  assert.equal(S.loadWeak()['你'].due,early.due);assert.equal(S.loadWeak()['你'].streak,4);close();

  for(const reason of ['helped','skipped','wrong']) {
    seed();fire('[data-view="review"]');fire('.review-chip');e=app.engine;
    if(reason==='helped') assert.equal(e.requestHint(),true);
    else if(reason==='skipped') e.skipCurrent();
    else {const t=e.currentTarget();e.pressKey(t.keys[t.pos].toLowerCase()==='a'?'b':'a');}
    const first=S.loadWeak()['你'];assert.equal(first.streak,0);assert.equal(first.ease,2.3);
    complete(e);const after=S.loadWeak()['你'];
    assert.equal(after.streak,0);assert.equal(after.mastered,false);assert.equal(after.ease,2.3,'同轮只回落一次');
    assert.equal(after.count,reason==='helped'?20:21);
    assert.equal(after.lapseReason,reason);
    assert.equal(reviewTotals(app.reviewActive).repair,1);assert.equal(reviewTotals(app.reviewActive).advanced,0);close();
  }

  console.log('【复习 UI】先通过再遗忘会撤回本轮通过，保存续练保留求助证据');
  seed();fire('[data-view="review"]');fire('.review-chip');e=app.engine;
  const firstIndex=e.index;
  while(e.index===firstIndex){const t=e.currentTarget();e.pressKey(t.keys[t.pos]);}
  assert.equal(S.loadWeak()['你'].mastered,true);
  assert.equal(e.requestHint(),true);assert.equal(S.loadWeak()['你'].mastered,false);
  fire('#btnQuit');fire('#modal [data-act="save"]');
  assert.equal(S.loadResume().review.outcomes['你'].status,'helped');
  fire('#btnResume');e=app.engine;assert.equal(e.training.policy,'independent');
  complete(e);assert.equal(S.loadWeak()['你'].streak,0);assert.equal(reviewTotals(app.reviewActive).repair,1);close();

  console.log('【复习 UI】整词全部独立才通过，未作答项目保持原排期');
  seed('你好','ni hao');app.settings.reviewDueOnly=true;e=start();
  assert.equal(e.currentQuestion().text,'你好');complete(e);
  assert.equal(S.loadWeak()['你好'].mastered,true);close();
  seed('你好','ni hao');e=start();e.requestHint();complete(e);
  assert.equal(S.loadWeak()['你好'].streak,0);assert.equal(S.loadWeak()['你好'].count,20);close();
  seed('行行','xing hang');e=start();
  assert.equal(e.currentQuestion().chars[1].pinyin,'hang');
  e.pressKey('a');complete(e);assert.equal(S.loadWeak()['行行'].pinyin,'xing hang');close();
  seed('ang','');fire('[data-view="review"]');fire('.review-chip');e=app.engine;
  assert.equal(e.currentQuestion().kind,'key');assert.equal(e.currentTarget().keys[0],'H');
  complete(e);assert.equal(S.loadWeak().ang.mastered,true);close();
  seed();const map=S.loadWeak();map['好']={...map['你'],key:'好',char:'好',pinyin:'hao',due:Date.now()-2};S.saveWeak(map);
  const untouched={...S.loadWeak()['你']};e=start();
  assert.equal(e.currentQuestion().text,'好');
  while(e.index===0){const t=e.currentTarget();e.pressKey(t.keys[t.pos]);}
  e.finish('user');assert.deepEqual(S.loadWeak()['你'],untouched);close();
  console.log('✅ 复习判定自检全部通过');
} finally {if(app.engine)app.engine.destroy();H.restoreGlobals();for(const n of timerNames)globalThis[n]=timers[n];}
