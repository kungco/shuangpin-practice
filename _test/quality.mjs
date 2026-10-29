import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHarness} from './tools/harness.mjs';
const H=await createHarness();
const names=['setTimeout','clearTimeout','setInterval','clearInterval'];
const real=Object.fromEntries(names.map(n=>[n,globalThis[n]]));
for(const n of names)globalThis[n]=H.timers[n];
const S=await import('../src/core/storage.js');
const L=await import('../src/core/learning.js');
const {recentBaseline}=await import('../src/core/stats.js');
const {normalizeComparison}=await import('../src/core/comparison.js');
const {annotatePassage,questionFromPhrase}=await import('../src/core/questions.js');
const {EXPANSION_PASSAGES}=await import('../src/data/practice-expansion.js');
const {PracticeEngine}=await import('../src/core/engine.js');
const {primarySplit}=await import('../src/core/scheme.js');
const click=s=>H.fire(s,'click');
const complete=e=>{for(let n=0;e.state==='running'&&n<5000;n++){const t=e.currentTarget();e.pressKey(t.keys[t.pos]);}assert.equal(e.state,'finished');};
function perfect(s){for(const q of L.buildLearningQuestions(L.LEARNING_MAP[s.lessonId],s.phase,s.repairItems,s.transferSamples))L.observeLearning(s,q,true);return s;}
const summary={completed:true,independentAccuracy:100},day=86400000;
try{
  console.log('【质量】语境读音独立预期、名词不误改、旧存档修正与题库可复现');
  execFileSync(process.execPath,['scripts/generate-corpus.mjs','--check'],{cwd:new URL('..',import.meta.url),stdio:'pipe'});
  execFileSync(process.execPath,['scripts/generate-chat.mjs','--check'],{cwd:new URL('..',import.meta.url),stdio:'pipe'});
  for(const [text,py] of [['安静地听','an jing de ting'],['放心地走','fang xin de zou'],['从容地走','cong rong de zou'],['安安稳稳地休息','an an wen wen de xiu xi'],['地图上的地方','di tu shang de di fang']]){
    assert.equal(annotatePassage(text).map(c=>c.pinyin).join(' '),py);
  }
  for(const word of ['安静地','放心地','妥当地','小心地','完整地','匆匆忙忙地','自然地','更快地','安安稳稳地','从容地']){
    const found=EXPANSION_PASSAGES.filter(p=>p.t.includes(word));assert.ok(found.length,word);
    for(const p of found)assert.equal(p.p[p.t.indexOf(word)+word.length-1],'de',p.title);
  }
  const old=questionFromPhrase('安静地听',['an','jing','di','ting']);const engine=new PracticeEngine({questions:[old],mode:'phrase'});
  engine.start();const saved=engine.exportResume();engine.destroy();const restored=PracticeEngine.restore(saved);
  assert.equal(restored.questions[0].chars[2].pinyin,'de');restored.destroy();

  console.log('【质量】比较训练条件，保留旧历史但不混用，提示正确不冒充独立');
  S.clearAll();
  const context=normalizeComparison({policy:'independent',source:'practice',material:'1',startStage:2,endStage:2});
  for(let n=0;n<3;n++)S.appendRecord(S.makeRecord({mode:'char',speed:100,accuracy:100,independentAccuracy:0}));
  assert.equal(recentBaseline({mode:'char',context}).samples,0,'没有条件的旧记录不参与新比较');
  for(let n=0;n<3;n++)S.appendRecord(S.makeRecord({mode:'char',speed:40,accuracy:100,independentAccuracy:90,comparison:context}));
  const b=recentBaseline({mode:'char',context,curSpeed:45,curAccuracy:95});
  assert.equal(b.samples,3);assert.equal(b.speedDelta,5);assert.equal(b.accuracy,90);
  for(const changed of [{policy:'full'},{material:'2'},{source:'studio:zen'},{endStage:1},{endTier:2}])
    assert.equal(recentBaseline({mode:'char',context:{...context,...changed}}).samples,0);
  const backed=S.exportAll();S.clearAll();S.importAll(backed);assert.equal(recentBaseline({mode:'char',context}).samples,3);

  console.log('【质量】所有键位关用不同字验收，掌握后 3/7/30 天回访与同日防刷');
  S.clearAll();const now=new Date(2026,9,29,10).getTime();
  for(const lesson of L.LEARNING_LESSONS.filter(l=>l.parts)){
    const samples=L.chooseLearningTransfer(lesson),next=L.chooseLearningTransfer(lesson,samples.map(s=>s.ch));
    assert.ok(next.every(s=>!samples.some(p=>p.ch===s.ch)));
    const check=L.normalizeLearningSession({lessonId:lesson.id,phase:'check'});
    L.recordLearning(perfect(check),summary,now);
    assert.equal(L.learningPhase(lesson,S.loadLearningProgress(),now),'transfer');
    const transfer=L.normalizeLearningSession({lessonId:lesson.id,phase:'transfer',transferSamples:samples});assert.ok(transfer);
    assert.ok(L.buildLearningQuestions(lesson,'transfer',[],samples).every(q=>q.kind!=='key'));
    assert.equal(L.evaluateLearning(transfer,summary).passed,false);
    L.recordLearning(perfect(transfer),summary,now+1);
    assert.ok(!S.loadLearningProgress().lessons[lesson.id].masteredAt);
    let at=now+day;
    for(const interval of [3,7,30]){
      const review=L.normalizeLearningSession({lessonId:lesson.id,phase:'review',transferSamples:next});
      L.recordLearning(perfect(review),summary,at);
      const rec=S.loadLearningProgress().lessons[lesson.id];assert.ok(rec.masteredAt);
      const date=new Date(at);date.setDate(date.getDate()+interval);assert.equal(rec.dueDay,S.dateStr(date));
      L.recordLearning(perfect(L.normalizeLearningSession({lessonId:lesson.id,phase:'review',transferSamples:samples})),summary,at+1000);
      assert.equal(S.loadLearningProgress().lessons[lesson.id].dueDay,rec.dueDay,'同日重复不拉长排期');
      at+=interval*day;
    }
    const backup=S.exportAll();
    L.recordLearning(L.normalizeLearningSession({lessonId:lesson.id,phase:'review',transferSamples:next}),{completed:true,independentAccuracy:0},at);
    S.importAll(backup);assert.equal(S.loadLearningProgress().lessons[lesson.id].masteredAt,0);
    assert.equal(L.learningPhase(lesson,S.loadLearningProgress(),at),'repair');
  }
  S.clearAll();await H.loadApp();const app=H.fakeWindow.__app;
  console.log('【质量 UI】三个页面独立；换一组避重、重练保留原题、歌单备份恢复');
  assert.equal(H.q('#practiceToday').hidden,false);assert.equal(H.q('#practiceFree').hidden,true);
  click('#btnNavFree');assert.equal(app.practicePage,'free');assert.equal(H.q('#practiceToday').hidden,true);
  click('#studioStart');const first=app.engine.questions.map(q=>q.text);await H.advance(1100);complete(app.engine);
  click('#modal [data-act="again"]');assert.deepEqual(app.engine.questions.map(q=>q.text),first);complete(app.engine);
  click('#modal [data-act="fresh"]');const fresh=app.engine.questions.map(q=>q.text);assert.ok(fresh.every(ch=>!first.includes(ch)));complete(app.engine);
  click('#modal [data-act="stats"]');click('[data-view="practice"]');click('#btnNavFree');click('#studioStart');
  assert.ok(app.engine.questions.every(q=>!first.includes(q.text)&&!fresh.includes(q.text)));app.engine.finish('user');click('#modal [data-act="stats"]');
  click('[data-view="practice"]');click('#btnNavFree');click('[data-studio-tab="playlist"]');
  H.q('#studioPlaylistTitle').value='我的通勤歌单';H.fire('#studioPlaylistTitle','input');H.q('#studioShuffle').checked=true;H.fire('#studioShuffle','change');click('#studioSavePlaylist');
  const playlist=S.loadPlaylist(),backup=S.exportAll();assert.equal(backup.version,5);assert.ok(playlist.randomOrder);
  S.clearAll();assert.equal(S.loadPlaylist(),null);S.importAll(backup);assert.deepEqual(S.loadPlaylist(),playlist);
  S.writeJSON(S.KEYS.playlist,{...playlist,title:'更新的歌单',updatedAt:playlist.updatedAt+100});S.importAll(backup);assert.equal(S.loadPlaylist().title,'更新的歌单');
  assert.equal(S.isAppKey(S.KEYS.playlist),true);
  click('#btnNavPath');assert.equal(H.q('#practicePath').hidden,false);assert.equal(H.q('#practiceFree').hidden,true);
  click('[data-lesson="an-ang"]');click('#btnLearningTest');complete(app.engine);
  click('#modal [data-act="again"]');assert.equal(app.learningActive.phase,'transfer');assert.ok(app.engine.examMode);assert.equal(app.engine.requestHint(),false);
  assert.equal(H.q('#coachTip').innerHTML,'');const t=app.engine.currentTarget();app.engine.pressKey(t.keys[0]);
  click('#btnQuit');click('#modal [data-act="save"]');const stored=S.loadResume();assert.ok(stored.learning.transferSamples.length);
  click('#btnResume');assert.deepEqual(app.learningActive.transferSamples,stored.learning.transferSamples);complete(app.engine);
  assert.ok(app.learningResult.passed);
  console.log('✅ 质量优化检查通过');
}finally{H.fakeWindow.__app?.engine?.destroy();H.restoreGlobals();for(const n of names)globalThis[n]=real[n];}
