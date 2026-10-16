/** Cross-feature regressions for the v1.6.1 release. Uses a deterministic clock. */
import assert from 'node:assert/strict';
import { createHarness } from './tools/harness.mjs';

const H = await createHarness();
// The app uses both window timers and bare timers; drive both with one clock.
const timerNames = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
const originalTimers = Object.fromEntries(timerNames.map(name => [name, globalThis[name]]));
for (const name of timerNames) globalThis[name] = H.timers[name];
const S = await import('../src/core/storage.js');
await H.loadApp();
const app = H.fakeWindow.__app;
const emit = key => H.fakeWindow._ls.storage.forEach(h => h({ key }));
const change = (sel, value) => { H.q(sel).value = String(value); H.fire(sel, 'change'); };
const closeResult = () => H.fire('#modal [data-act="stats"]', 'click');
function complete(eng) {
  for (let n = 0; eng.state === 'running' && n < 10000; n++) {
    const t = eng.currentTarget();
    eng.pressKey(t.keys[t.pos]);
  }
  assert.equal(eng.state, 'finished');
}
function startWord() {
  H.fire('[data-view="practice"]', 'click');
  H.fire('[data-mode="phrase"]', 'click');
  app.settings.count = 1;
  app.settings.trainingPolicy = 'independent';
  app.settings.hint = true;
  H.fire('#btnStart', 'click');
  const eng = app.engine;
  const word = eng.currentQuestion().text;
  S.recordWeak({ word });
  return { eng, word };
}

try {
  console.log('【回归】整词复习：独立答对、错误、求助、跳过与中断');
  S.clearWeak();
  let { eng, word } = startWord();
  await H.advance(1100);
  complete(eng);
  assert.equal(S.loadWeak()[word].correct, 1);
  assert.equal(S.loadWeak()[word].streak, 1);
  closeResult();
  for (const action of ['wrong', 'hint', 'skip']) {
    S.clearWeak();
    ({ eng, word } = startWord());
    if (action === 'wrong') {
      const t = eng.currentTarget();
      eng.pressKey(t.keys[t.pos].toLowerCase() === 'a' ? 'b' : 'a');
    } else if (action === 'hint') assert.equal(eng.requestHint(), true);
    else eng.skipCurrent();
    await H.advance(1100);
    complete(eng);
    assert.equal(S.loadWeak()[word].correct, 0, action);
    closeResult();
  }
  S.clearWeak();
  ({ eng, word } = startWord());
  assert.equal(eng.requestHint(), true);
  eng.pressKey(eng.currentTarget().keys[0]);
  await H.advance(20);
  H.fire('#btnQuit', 'click'); H.fire('#modal [data-act="save"]', 'click');
  H.fire('#btnResume', 'click'); eng = app.engine;
  await H.advance(1100); complete(eng);
  assert.equal(S.loadWeak()[word].correct, 0, 'a hint before resuming still disqualifies the word');
  closeResult();

  console.log('【回归】重练保留课程、智能混合、今日计划与书架归属');
  H.fire('[data-view="practice"]', 'click');
  H.fire('#btnCourseStart', 'click');
  const lessonId = app.courseActiveId, lessonMode = app.engine.mode;
  app.engine.finish('user');
  assert.match(H.q('#modal [data-act="again"]').textContent, /重练本课/);
  H.fire('#modal [data-act="again"]', 'click');
  assert.equal(app.courseActiveId, lessonId);
  assert.equal(app.engine.mode, lessonMode);
  app.engine.finish('user'); closeResult();
  H.fire('[data-view="practice"]', 'click'); H.fire('#btnSmartMix', 'click');
  app.engine.finish('user'); H.fire('#modal [data-act="again"]', 'click');
  assert.equal(app.engine.mode, 'mix'); assert.equal(app.engine.durationSec, 300);
  app.engine.finish('user'); closeResult();
  H.fire('[data-view="practice"]', 'click'); H.fire('#btnDailyPlan', 'click');
  app.engine.finish('user'); H.fire('#modal [data-act="again"]', 'click');
  assert.equal(app.engine.mode, 'mix'); assert.equal(app.retrySession.options.retrySource, 'daily');
  app.engine.finish('user'); closeResult();
  H.fire('[data-view="practice"]', 'click'); H.fire('[data-mode="custom"]', 'click');
  H.q('#customTextInput').value = '你好世界。'; H.fire('#customTextInput', 'input');
  H.fire('#btnShelfSave', 'click'); const shelfId = app.shelfActiveId;
  H.fire('#btnStart', 'click'); await H.advance(1100); complete(app.engine);
  assert.equal(S.loadShelf().find(e => e.id === shelfId).stats.sessions, 1);
  H.fire('#modal [data-act="again"]', 'click');
  assert.equal(app.shelfActiveId, shelfId); await H.advance(1100); complete(app.engine);
  assert.equal(S.loadShelf().find(e => e.id === shelfId).stats.sessions, 2);
  closeResult();

  console.log('【回归】待保存的设置与外部修改按字段合并');
  H.fire('[data-view="settings"]', 'click'); await H.advance(500);
  change('#setDailyGoalChars', 555);
  S.saveSettings({ ...S.loadSettings(), duration: 300 }); emit(S.KEYS.settings);
  await H.advance(700);
  assert.equal(S.loadSettings().dailyGoalChars, 555);
  assert.equal(S.loadSettings().duration, 300);
  change('#setDailyGoalChars', 777);
  S.saveSettings({ ...S.loadSettings(), dailyGoalSessions: 4 });
  // Saving can run before a delayed storage notification arrives.
  await H.advance(450);
  assert.equal(S.loadSettings().dailyGoalChars, 777);
  assert.equal(S.loadSettings().dailyGoalSessions, 4);

  console.log('【回归】主题在恢复默认、导入和跨标签同步后立即生效');
  change('#setTheme', 'dark'); await H.advance(500);
  H.fire('#btnResetSettings', 'click'); H.fire('#modal [data-act="ok"]', 'click');
  assert.equal(H.q('html').getAttribute('data-theme'), 'light');
  assert.equal(H.q('#btnThemeToggle').getAttribute('aria-pressed'), 'false');
  S.saveSettings({ ...S.loadSettings(), theme: 'dark' }); emit(S.KEYS.settings);
  await H.advance(200);
  assert.equal(H.q('html').getAttribute('data-theme'), 'dark');
  assert.equal(H.q('#btnThemeToggle').getAttribute('aria-pressed'), 'true');
  app.settings.theme = 'light'; H.fakeWindow.__hooks.syncSettingsUI();
  assert.equal(H.q('html').getAttribute('data-theme'), 'light');
  await H.advance(500);

  console.log('【回归】练习结束和保存退出都补做延期的书架同步');
  for (const save of [false, true]) {
    S.saveShelf([{ id: 'deferred', title: '同步材料', text: '你好世界' }]);
    emit(S.KEYS.shelf); await H.advance(200);
    H.fire('[data-view="practice"]', 'click'); H.fire('#btnSmartMix', 'click');
    app.engine.pressKey(app.engine.currentTarget().keys[0]);
    S.saveShelf([]); emit(S.KEYS.shelf); await H.advance(200);
    assert.equal(H.qa('#shelfList .shelf-item').length, 1);
    if (save) { H.fire('#btnQuit', 'click'); H.fire('#modal [data-act="save"]', 'click'); }
    else { app.engine.finish('user'); closeResult(); }
    assert.equal(H.qa('#shelfList .shelf-item').length, 0);
  }

  console.log('【回归】主动结束一次只记一条成绩');
  H.fire('[data-view="practice"]', 'click'); H.fire('[data-mode="char"]', 'click');
  app.settings.count = 20; H.fire('#btnStart', 'click');
  await H.advance(1100);
  for (let i = 0; i < 6; i++) { const t = app.engine.currentTarget(); app.engine.pressKey(t.keys[t.pos]); }
  const records = S.loadHistory().length;
  H.fire('#btnQuit', 'click'); H.fire('#modal [data-act="end"]', 'click');
  assert.equal(S.loadHistory().length, records + 1);
  closeResult();
  assert.deepEqual(H.errors, []);
  console.log('✅ 跨功能回归全部通过');
} finally {
  app.engine?.destroy();
  H.restoreGlobals();
  Object.assign(globalThis, originalTimers);
}
