/** Small lessons: coverage, independent evidence, retention and the complete UI flow. */
import assert from 'node:assert/strict';
import { createHarness } from './tools/harness.mjs';
const H = await createHarness();
const names = ['setTimeout','clearTimeout','setInterval','clearInterval'];
const timers = Object.fromEntries(names.map(n => [n, globalThis[n]]));
for (const n of names) globalThis[n] = H.timers[n];
const S = await import('../src/core/storage.js');
const L = await import('../src/core/learning.js');
const { KEY_COMPONENTS } = await import('../src/core/questions.js');
const { buildSyllables, primarySplit } = await import('../src/core/scheme.js');
const { PracticeEngine } = await import('../src/core/engine.js');
const session = (id = 'two-keys', phase = 'check') => L.normalizeLearningSession({ lessonId: id, phase });
const perfect = (s) => {
  for (const q of L.buildLearningQuestions(L.LEARNING_MAP[s.lessonId], s.phase, s.repairItems))
    L.observeLearning(s, q, true);
  return s;
};
const summary = { completed: true, independentAccuracy: 100 };
function complete(eng) {
  for (let i = 0; eng.state === 'running' && i < 2000; i++) {
    const t = eng.currentTarget(); eng.pressKey(t.keys[t.pos]);
  }
  assert.equal(eng.state, 'finished');
}
try {
  console.log('【小关卡】所有成分均匀出题，固定题量与别名覆盖');
  assert.equal(L.LEARNING_LESSONS.length, 16);
  const yun = [];
  for (const l of L.LEARNING_LESSONS) {
    const items = L.learningItems(l), qs = L.buildLearningQuestions(l);
    assert.equal(qs.length, items.length * 4);
    assert.equal(new Set(qs.map(q => q.id)).size, qs.length);
    for (const i of items) assert.equal(qs.filter(q => q.meta.learningItem === i.id).length, 4);
    for (const q of qs) assert.ok(q.kind === 'key' ? q.answerKeys.length : q.chars.every(c => c.syl?.candidates?.length));
    if (l.role === 'yun') yun.push(...l.parts);
  }
  assert.deepEqual(yun.slice().sort(), KEY_COMPONENTS.filter(c => c.role === 'yun').map(c => c.part).sort());
  assert.equal(L.normalizeLearningSession({lessonId:'constructor',phase:'check'}), null);
  assert.equal(L.normalizeLearningSession({lessonId:'two-keys',phase:'toString'}), null);
  assert.deepEqual(L.normalizeLearningSession({lessonId:'two-keys',phase:'check',evidence:{'你':{seen:1,independent:99}}}).evidence['你'], {seen:1,independent:1});
  for (const [py, normal, legacy] of [['an','AN','AJ'],['ai','AI','AD'],['en','EN','EF'],['ou','OU','OZ'],['ao','AO','AC'],['ei','EI','EW']]) {
    assert.equal(primarySplit(py).code, normal);
    for (const code of [normal, legacy]) {
      const e = new PracticeEngine({ questions:[{id:'zero',kind:'word',text:'安',
        chars:[{ch:'安',pinyin:py,syl:buildSyllables([py])[0]}]}],mode:'char',examMode:true });
      e.start(); for (const key of code) assert.equal(e.pressKey(key).correct, true);
      assert.equal(e.summary().independentAccuracy, 100); e.destroy();
    }
  }

  console.log('【小关卡】练过、小测通过和隔天掌握分别记录');
  S.clearAll();
  const today = new Date(2026, 9, 16, 23, 58).getTime();
  L.recordLearning(perfect(session('two-keys','guided')), summary, today);
  assert.ok(S.loadLearningProgress().lessons['two-keys'].practicedAt);
  assert.equal(S.loadLearningProgress().lessons['two-keys'].passedAt, 0);
  assert.equal(L.recommendedLearning(undefined, today).phase, 'check');
  const passed = perfect(session());
  L.recordLearning(passed, summary, today);
  assert.ok(S.loadLearningProgress().lessons['two-keys'].passedAt);
  assert.equal(L.recommendedLearning(undefined, today).lesson.id, 'special-sheng');
  const sameDay = L.recordLearning(perfect(session('two-keys','review')), summary, today + 1000);
  assert.ok(!sameDay.progress.lessons['two-keys'].masteredAt);
  assert.match(sameDay.reason, /隔天再回访/);
  const tomorrow = new Date(2026, 9, 17, 0, 1).getTime();
  assert.equal(L.recommendedLearning(undefined, tomorrow).phase, 'review');
  assert.equal(L.recommendedLearning(undefined, tomorrow).lesson.id, 'two-keys');
  L.recordLearning(perfect(session('two-keys','review')), summary, tomorrow);
  assert.ok(S.loadLearningProgress().lessons['two-keys'].masteredAt);

  console.log('【小关卡】完整覆盖、整体正确率、逐项正确率缺一不可');
  const weak = perfect(session()); weak.evidence['你'].independent = 2;
  assert.deepEqual(L.evaluateLearning(weak, summary).failedItems, ['你']);
  assert.equal(L.evaluateLearning(weak, summary).passed, false);
  assert.equal(L.evaluateLearning(passed, {...summary, independentAccuracy:89}).passed, false);
  assert.equal(L.evaluateLearning(passed, {...summary, completed:false}).passed, false);
  const missed = perfect(session()); missed.evidence['好'].seen = 3;
  assert.equal(L.evaluateLearning(missed, summary).passed, false);
  const repair = session('special-sheng','repair'); repair.repairItems = ['zh'];
  const rqs = L.buildLearningQuestions(L.LEARNING_MAP['special-sheng'], 'repair', repair.repairItems);
  assert.equal(rqs.length, 3); assert.ok(rqs.every(q => q.meta.learningItem === 'zh'));
  L.recordLearning(repair, summary, today);
  assert.equal(S.loadLearningProgress().lessons['special-sheng'].passedAt, 0, '补练不代替小测');

  console.log('【小关卡】旧进度迁移与备份合并不虚增掌握程度');
  S.clearAll();
  S.saveCourseProgress({completed:['c1-yun','c2-sheng','c3-split','c4-char','c5-phrase','c6-speed']});
  const migrated = L.learningProgress();
  assert.equal(Object.keys(migrated.lessons).length, 16);
  assert.ok(Object.values(migrated.lessons).every(r => r.practicedAt && !r.passedAt && !r.masteredAt));
  assert.deepEqual(L.learningProgress(), migrated);
  L.recordLearning(perfect(session()), summary, today);
  const backup = S.exportAll(); assert.equal(backup.version, 4);
  S.clearAll(); assert.equal(S.importAll(backup).ok, true);
  const restored = S.loadLearningProgress(); S.importAll(backup);
  assert.deepEqual(S.loadLearningProgress(), restored);
  assert.equal(S.importAll({app:'shuangpin-practice',version:3,course:{completed:['c1-yun']}}).ok, true);
  assert.equal(S.importAll({app:'shuangpin-practice',version:S.DATA_VERSION+1}).ok, false);

  console.log('【小关卡 UI】提示→无提示小测→薄弱补练→重新小测→下一关');
  S.clearAll(); await H.loadApp();
  const app = H.fakeWindow.__app;
  app.settings.charTier = 'progressive'; app.settings.hint = false; app.settings.showDecode = false;
  const fire = sel => H.fire(sel,'click');
  assert.ok(!H.q('#freePracticePanel').open);
  fire('#btnLearningPath'); assert.ok(H.q('#learningPath').open);
  fire('#btnCourseStart'); assert.equal(app.learningActive.phase, 'guided');
  assert.equal(app.engine.adaptive, false, '小关卡题目固定，不受自由模式渐进档位影响');
  assert.equal(app.engine.hintEnabled, true);
  assert.ok(!H.q('#decode').textContent.includes('凭记忆输入'), '提示练习始终从可见示例开始');
  await H.advance(1100); complete(app.engine);
  assert.equal(app.learningResult.passed, true);
  assert.equal(H.q('#modal .learning-result-grid').children.length, 2, '学习结算只突出正确率与完成进度');
  assert.ok(!S.loadLearningProgress().lessons['two-keys'].passedAt);
  fire('#modal [data-act="again"]'); assert.equal(app.learningActive.phase, 'check');
  assert.equal(app.engine.examMode, true); assert.equal(app.engine.requestHint(), false);
  assert.equal(app.engine.hintEnabled, false);
  assert.equal(H.q('#hudAccLabel').textContent, '独立正确率');
  // Two wrong answers to the same item cannot hide behind the other items' successes.
  const wrongItem = app.engine.currentQuestion().meta.learningItem;
  while (app.engine.state === 'running') {
    const t = app.engine.currentTarget();
    if (app.engine.currentQuestion().meta.learningItem === wrongItem && t.pos === 0)
      app.engine.pressKey(t.keys[t.pos].toLowerCase() === 'a' ? 'b' : 'a');
    app.engine.pressKey(t.keys[t.pos]);
  }
  assert.equal(app.learningResult.passed, false);
  fire('#modal [data-act="again"]');
  assert.equal(app.learningActive.phase, 'repair');
  assert.ok(app.engine.questions.every(q => q.meta.learningItem === wrongItem));
  complete(app.engine); fire('#modal [data-act="again"]');
  assert.equal(app.learningActive.phase, 'check');
  complete(app.engine); assert.equal(app.learningResult.passed, true);
  assert.equal(app.engine.summary().score, undefined, '关卡不冒充综合能力测验');
  fire('#modal [data-act="again"]');
  assert.equal(app.learningActive.lessonId, 'special-sheng');
  app.engine.finish('user'); fire('#modal [data-act="stats"]');

  console.log('【小关卡 UI】地图直达、直接小测、保存续练与自由模式');
  fire('[data-view="practice"]'); fire('[data-lesson="ia-ie"]');
  fire('#btnLearningTest'); assert.equal(app.learningActive.lessonId, 'ia-ie');
  app.engine.pressKey(app.engine.currentTarget().keys[0]);
  await H.advance(20); fire('#btnQuit'); fire('#modal [data-act="save"]');
  const evidence = S.loadResume().learning.evidence;
  fire('#btnCourseStart'); assert.equal(app.learningActive.phase, 'check');
  assert.deepEqual(app.learningActive.evidence, evidence);
  assert.equal(app.engine.examMode, true); complete(app.engine);
  assert.equal(app.learningResult.passed, true, '同键别名也分别计入覆盖');
  fire('#modal [data-act="stats"]'); fire('[data-view="practice"]');
  fire('#btnFreePractice'); assert.ok(H.q('#freePracticePanel').open);
  fire('#btnStart');
  assert.equal(app.engine.mode, app.settings.mode, '课程续练结束后，自由模式仍与用户选择一致');
  assert.equal(app.learningActive, null);
  assert.ok(!H.q('#sessionPanel').classList.contains('is-learning'));
  assert.equal(H.q('#hudAccLabel').textContent, '正确率');
  app.engine.destroy();
  console.log('✅ 小关卡自检全部通过');
} finally {
  H.restoreGlobals(); for (const n of names) globalThis[n] = timers[n];
}
