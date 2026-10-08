/**
 * 引擎逻辑自检（Node 环境，用桩替代 window）
 */
globalThis.window = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id)
};

const { PracticeEngine, normalizeKey, STATE } = await import('../src/core/engine.js');
const { generateQuestions } = await import('../src/core/questions.js');
const { buildSyllables } = await import('../src/core/scheme.js');

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗ ' + m); } else { console.log('  ✓ ' + m); } };

console.log('【1】normalizeKey 归一化');
ok(normalizeKey('A') === 'a', '大写转小写');
ok(normalizeKey('z') === 'z', '小写保留');
ok(normalizeKey('1') === '', '数字被拒绝');
ok(normalizeKey('ab') === '', '多字符被拒绝');
ok(normalizeKey(null) === '', 'null 安全');
ok(normalizeKey(undefined) === '', 'undefined 安全');

console.log('\n【2】键位模式：单键作答');
{
  const qs = [{ id: 'k1', level: 1, kind: 'key', promptText: 'ang', answerKeys: ['H'], role: 'yun', explain: '' }];
  const eng = new PracticeEngine({ questions: qs, mode: 'keymap' });
  eng.start();
  let r = eng.pressKey('x');
  ok(r.correct === false, '按错被判错');
  ok(r.feedback.expected === 'H', '错误反馈给出正确键 H');
  r = eng.pressKey('h');
  ok(r.correct === true, '按对通过');
  ok(eng.state === STATE.FINISHED, '单题完成后自动结束');
  const s = eng.summary();
  ok(s.totalChars === 1 && s.correctChars === 0, `出错后不计入正确字符（实际 correct=${s.correctChars}）`);
  ok(s.wrongKeystrokes === 1 && s.keystrokes === 2, `按键统计正确（${s.keystrokes} 键 / ${s.wrongKeystrokes} 错）`);
}

console.log('\n【3】单字模式：音节输入推进');
{
  const qs = generateQuestions({ mode: 'char', count: 1 });
  const eng = new PracticeEngine({ questions: qs, mode: 'char' });
  eng.start();
  const t0 = eng.currentTarget();
  console.log(`    题目字符: ${qs[0].chars.map(c => c.ch + '(' + c.pinyin + ')').join(' ')}`);
  console.log(`    第 1 键应为: ${t0.split.code}`);
  // 按正确顺序输完整个音节
  const code = t0.split.code.toLowerCase();
  for (const k of code) eng.pressKey(k);
  ok(eng.charIndex === 1 || eng.state === STATE.FINISHED, '音节输入完成后推进');
  ok(eng.stats.correctChars === 1, `正确字符计数为 1（实际 ${eng.stats.correctChars}）`);
}

console.log('\n【3b】zh/ch/sh 音节只需 2 键（VH，不是 VHH）');
{
  const eng = new PracticeEngine({ questions: [
    { id: 1, level: 3, kind: 'word', label: '单字', promptText: '整', text: '整',
      chars: [{ ch: '整', pinyin: 'zheng', syl: buildSyllables(['zheng'], ['整'])[0] }] }
  ], mode: 'char' });
  eng.start();
  const t = eng.currentTarget();
  ok(t.split.code === 'VG', `整(zheng) 编码应为 VG，实际 ${t.split.code}`);
  ok(t.keys.length === 2, `整 应为 2 键，实际 ${t.keys.length}`);
  eng.pressKey('v');
  ok(eng.charIndex === 0, '只按 V 时不应完成整字');
  eng.pressKey('h');   // 故意按错：zheng 第二键是 g
  ok(eng.charIndex === 0, '按错第二键不应推进');
  eng.pressKey('g');
  ok(eng.charIndex === 1 || eng.state === STATE.FINISHED, 'V→G 两键后完成整字');
  console.log(`    整(zheng)：V→G 两键完成，中间的 H 被判错`);
}

console.log('\n【4】错误不推进 + 提示拆分方式');
{
  const qs = generateQuestions({ mode: 'char', count: 1 });
  const eng = new PracticeEngine({ questions: qs, mode: 'char' });
  eng.start();
  const t = eng.currentTarget();
  const wrong = 'qwertyuiop'.split('').find(c => !t.keys.map(x => x.toLowerCase()).includes(c));
  const r = eng.pressKey(wrong);
  ok(r.correct === false, '错误按键被识别');
  ok(eng.keyIndex === 0, '错误后不推进键位');
  ok(!!r.feedback.splitText, `给出拆分方式: ${r.feedback.splitText}`);
  ok(!!r.feedback.explain, `给出解释: ${r.feedback.explain}`);
  ok(r.feedback.codeText === t.split.code, `给出完整编码 ${r.feedback.codeText}`);
}

console.log('\n【5】词组模式推进');
{
  const qs = generateQuestions({ mode: 'phrase', count: 2 });
  const eng = new PracticeEngine({ questions: qs, mode: 'phrase' });
  eng.start();
  const q = qs[0];
  console.log(`    词组: ${q.text} (${q.chars.length} 字)`);
  for (const c of q.chars) {
    for (const k of c.syl.split.code.toLowerCase()) eng.pressKey(k);
  }
  ok(eng.index === 1, `第一题完成后进入第二题（index=${eng.index}）`);
  ok(eng.stats.correctChars === q.chars.length, `正确字符数 ${eng.stats.correctChars} = 词组长度 ${q.chars.length}`);
}

console.log('\n【6】短文模式：标点自动跳过');
{
  const qs = generateQuestions({ mode: 'passage', count: 1 });
  const q = qs[0];
  const punctCount = q.chars.filter(c => c.punct).length;
  console.log(`    段落 ${q.chars.length} 字，其中标点 ${punctCount} 个`);
  const eng = new PracticeEngine({ questions: qs, mode: 'passage', skipPunct: true });
  eng.start();
  // 只输入汉字，标点应自动跳过
  let guard = 0;
  while (eng.state !== STATE.FINISHED && guard < 5000) {
    guard++;
    const t = eng.currentTarget();
    if (!t) break;
    if (t.kind === 'punct') { eng.pressKey('a'); continue; }
    if (t.kind !== 'syllable') break;
    eng.pressKey(t.keys[t.pos].toLowerCase());
  }
  const s = eng.summary();
  ok(eng.state === STATE.FINISHED, '短文全部输完后结束');
  const hanCount = q.chars.filter(c => !c.punct).length;
  ok(s.totalChars === hanCount, `统计字符数 ${s.totalChars} = 汉字数 ${hanCount}（标点未计入）`);
}

console.log('\n【7】暂停 / 恢复 / 时间统计');
{
  const qs = generateQuestions({ mode: 'char', count: 5 });
  const eng = new PracticeEngine({ questions: qs, mode: 'char', durationSec: 0 });
  eng.start();
  await new Promise(r => setTimeout(r, 350));
  const before = eng.elapsedSec;
  ok(before > 0.2, `运行中累计用时 ${before.toFixed(2)}s`);
  eng.pause();
  await new Promise(r => setTimeout(r, 350));
  const afterPause = eng.elapsedSec;
  ok(Math.abs(afterPause - before) < 0.15, `暂停期间不计时（${before.toFixed(2)} → ${afterPause.toFixed(2)}）`);
  const r = eng.pressKey('a');
  ok(r.reason === 'paused', '暂停时按键被忽略');
  eng.resume();
  ok(eng.state === STATE.RUNNING, '恢复成功');
  eng.destroy();
}

console.log('\n【8】限时模式自动结束');
{
  const qs = generateQuestions({ mode: 'char', count: 50 });
  const eng = new PracticeEngine({ questions: qs, mode: 'char', durationSec: 1 });
  let finished = null;
  eng.on('finish', s => { finished = s; });
  eng.start();
  await new Promise(r => setTimeout(r, 1600));
  ok(!!finished, '限时到自动触发完成');
  ok(finished && finished.reason === 'timeup', `结束原因为 timeup（实际 ${finished && finished.reason}）`);
  eng.destroy();
}

console.log('\n【9】速度与正确率计算（含 finish 补时）');
{
  const qs = generateQuestions({ mode: 'char', count: 20 });
  const eng = new PracticeEngine({ questions: qs, mode: 'char' });
  eng.start();
  // 打对 10 个字符，打错 4 次
  let done = 0;
  let guard = 0;
  while (done < 10 && guard < 500) {
    guard++;
    const t = eng.currentTarget();
    if (!t || t.kind !== 'syllable') break;
    if (done < 6) {
      eng.pressKey(t.keys[t.pos].toLowerCase());
      if (eng.keyIndex === 0) done++;   // 音节完成
    } else {
      // 故意错一次再打对
      const wrong = 'qwertyuiop'.split('').find(c => !t.keys.map(x => x.toLowerCase()).includes(c));
      eng.pressKey(wrong);
      for (const k of t.split.code.toLowerCase()) eng.pressKey(k);
      done++;
    }
  }
  // 先给计时器两个 tick 的机会（250ms × 2），再结束。
  // 结束时引擎会把最后一次 tick 之后的零头补回用时，因此 durationSec 应 >= 1。
  await new Promise(r => setTimeout(r, 560));
  const s = eng.summary();
  console.log(`    用时 ${s.durationSec}s，正确字符 ${s.correctChars}，错误字符 ${s.wrongChars}，速度 ${s.speed} 字/分，正确率 ${s.accuracy}%`);
  ok(s.accuracy > 0 && s.accuracy <= 100, '正确率在 0–100 之间');
  ok(s.correctChars + s.wrongChars === s.totalChars, '正确+错误 = 总数');
  ok(s.speed >= 0, '速度非负');
  ok(s.durationSec >= 1, `finish 时补回零头，用时不为 0（实际 ${s.durationSec}s）`);
  eng.destroy();
}

console.log('\n【9b】零声母音节恒为 2 键（an → AJ，与 README 一致）');
{
  /* 回归要点
     ---------
     ① 本题**不再手工往 syl 上补 zero: true**。老写法是给测试数据打补丁，
        验的是「我自己造出来的结构」而非真实出题流程，一旦真实数据缺字段
        就完全测不出问题（事实上当时 syl 确实没有 zero 字段，
        引擎里那个 syl.zero 分支是死代码，测试却「通过」了）。
        现在改用 buildSyllables —— 与出题 / 引擎用的是同一条构造路径。
     ② 断言的是 **2 键**（AJ），不是 1 键。小鹤里零声母同样恒为 2 键：
        首字母占声母位 + 韵母键。README 与方案表都是这么写的。 */
  const CASES = [
    { ch: '安', py: 'an', code: 'AJ' },
    { ch: '啊', py: 'a', code: 'AA' },
    { ch: '昂', py: 'ang', code: 'AH' }
  ];

  for (const c of CASES) {
    const syl = buildSyllables([c.py])[0];
    // 结构化断言：顶层 zero 与 split.zero 必须一致（这次统一了数据结构）
    ok(syl.zero === true, `${c.py} 的 syl.zero 为 true（实际 ${syl.zero}）`);
    ok(syl.zero === syl.split.zero, `${c.py} 顶层 zero 与 split.zero 一致`);
    ok(syl.split.code === c.code, `${c.py} 编码为 ${c.code}（实际 ${syl.split.code}）`);

    const q = {
      id: 'z-' + c.py, level: 3, kind: 'char', label: '单字打字',
      chars: [{ ch: c.ch, pinyin: c.py, syl, punct: false, unknown: false }]
    };
    const eng = new PracticeEngine({ questions: [q], mode: 'char' });
    eng.start();
    const t = eng.currentTarget();
    ok(t && t.keys.length === 2, `${c.py} 要求 2 键（实际 ${t && t.keys.length}）`);
    ok(t && t.keys.join('') === c.code, `${c.py} 目标序列为 ${c.code}（实际 ${t && t.keys.join('')}）`);

    // 逐键按下，两键都能被接受，且要在第 2 键之后才算完成
    const r1 = eng.pressKey(t.keys[0].toLowerCase());
    ok(r1.correct === true, `${c.py} 第 1 键（首字母）正确`);
    const r2 = eng.pressKey(t.keys[1].toLowerCase());
    ok(r2.correct === true, `${c.py} 第 2 键（韵母）正确`);
    ok(eng.stats.correctChars === 1, `${c.py} 完整 2 键后计入 1 个正确字符（实际 ${eng.stats.correctChars}）`);
    eng.destroy();
  }

  // 反向断言：零声母**不能**被截成单键
  const sylAn = buildSyllables(['an'])[0];
  const qAn = {
    id: 'z-len', level: 3, kind: 'char',
    chars: [{ ch: '安', pinyin: 'an', syl: sylAn, punct: false, unknown: false }]
  };
  const engAn = new PracticeEngine({ questions: [qAn], mode: 'char' });
  engAn.start();
  const tAn = engAn.currentTarget();
  ok(tAn.len === 2, `an 的 len 为 2（不是被截断的 1，实际 ${tAn.len}）`);
  engAn.destroy();
}

console.log('\n【10】边界与异常输入');
{
  // 空题目
  let threw = false;
  try { new PracticeEngine({ questions: [] }); } catch (e) { threw = true; }
  ok(threw, '空题目数组抛出明确错误');

  const qs = generateQuestions({ mode: 'char', count: 3 });
  const eng = new PracticeEngine({ questions: qs, mode: 'char' });
  ok(eng.pressKey('5').handled === false, '数字键被忽略');
  ok(eng.pressKey('').handled === false, '空键被忽略');
  ok(eng.pressKey(null).handled === false, 'null 键被忽略');
  ok(eng.state === STATE.RUNNING, 'IDLE 状态首次按键自动 start');

  // 完成后继续按键
  eng.finish('user');
  const r = eng.pressKey('a');
  ok(r.reason === 'finished', '结束后按键被安全忽略');

  // 重复 finish
  const s1 = eng.finish('again');
  ok(!!s1, '重复 finish 返回结果而不抛错');

  // 恢复现场
  const snap = eng.exportResume();
  const restored = PracticeEngine.restore(snap);
  ok(!!restored, '续练现场可恢复');
  const bad = PracticeEngine.restore({ questions: null });
  ok(bad === null, '损坏的现场安全返回 null');
  const bad2 = PracticeEngine.restore(null);
  ok(bad2 === null, 'null 现场安全返回 null');
  eng.destroy();
}

console.log('\n【11】skipCurrent 跳过');
{
  const qs = generateQuestions({ mode: 'char', count: 3 });
  const eng = new PracticeEngine({ questions: qs, mode: 'char' });
  eng.start();
  const before = eng.charIndex;
  const okSkip = eng.skipCurrent();
  ok(okSkip === true, '跳过成功');
  ok(eng.charIndex === before + 1 || eng.index === 1, '位置前进');
  ok(eng.stats.combo === 0, '跳过重置连击');
  eng.destroy();
}

/* ============================================================
   考试模式（examMode）：提示必须被彻底关闭
   ============================================================ */
console.log('\n【12】考试模式：无提示硬约束');
{
  const qs = generateQuestions({ mode: 'exam', count: 20 });

  // ---- 1. examMode 关掉提示，且能覆盖显式传入的 hintEnabled ----
  const eng = new PracticeEngine({
    questions: qs,
    mode: 'exam',
    examMode: true,
    hintEnabled: true,          // 故意传 true，必须仍被关掉
    hintDelayMs: 100,
    revealDelayMs: 200
  });
  ok(eng.examMode === true, 'examMode 已启用');
  ok(eng.hintEnabled === false, '考试模式下 hintEnabled 被强制关闭');
  ok(eng.hintDelayMs === 0, '考试模式下 hintDelayMs 归零');
  ok(eng.revealDelayMs === 0, '考试模式下 revealDelayMs 归零');

  // ---- 2. 主动求助必须无效 ----
  eng.start();
  ok(eng.requestHint('reveal') === false, '考试模式下 requestHint 返回 false');
  ok(eng.hintLevel() === '', '考试模式下不产生提示级别');

  // ---- 3. 即便挂上 hint 监听器，也不该收到任何提示事件 ----
  let hintEvents = 0;
  eng.on('hint', () => { hintEvents += 1; });
  eng.on('reveal', () => { hintEvents += 1; });

  // 手动调内部检查：应被 examMode 直接拦下
  if (typeof eng._checkHint === 'function') {
    eng._checkHint();
    eng._checkHint();
  }
  ok(hintEvents === 0, `考试模式下 _checkHint 不触发任何提示事件（实际 ${hintEvents} 次）`);

  // ---- 4. 时间流逝也不会刷出提示 ----
  // 直接把 idleSince 往前拨，模拟「卡住很久」
  eng._idleSince = Date.now() - 999999;
  if (typeof eng._checkHint === 'function') eng._checkHint();
  ok(hintEvents === 0, '停留 999 秒也不提示（考试模式无时间兜底）');

  // ---- 5. 提示过的字符数必须恒为 0（这是分数有效性的前提） ----
  // 走完整轮，中途穿插「胡乱按 + 求助」
  let guard = 0;
  while (eng.state === 'running' && guard < 4000) {
    guard += 1;
    eng.requestHint('reveal');                 // 每次先尝试求助
    const t = eng.currentTarget();
    if (!t) { if (eng.state !== 'running') break; continue; }
    if (t.kind === 'skip') { eng.skipCurrent(); continue; }
    const k = (t.keys || [])[t.pos] || '';
    if (k) eng.pressKey(k); else { eng.skipCurrent(); }
  }
  ok(eng.stats.hintedChars === 0,
    `考试模式全程 hintedChars 必须为 0（实际 ${eng.stats.hintedChars}）`);

  const sm = eng.summary();
  ok(sm.examMode === true, 'summary() 带回 examMode 标志');
  ok(sm.hintedChars === 0, 'summary().hintedChars 为 0');
  ok(Math.abs(sm.independentAccuracy - sm.accuracy) < 0.001,
    `无提示时独立正确率应等于表面正确率（${sm.independentAccuracy} / ${sm.accuracy}）`);
  eng.destroy();

  // ---- 6. 非考试模式不受影响（不能把普通练习也锁死） ----
  const normal = new PracticeEngine({
    questions: generateQuestions({ mode: 'char', count: 5 }),
    mode: 'char',
    hintEnabled: true,
    hintDelayMs: 100,
    revealDelayMs: 200
  });
  ok(normal.examMode === false, '普通练习 examMode 为 false');
  ok(normal.hintEnabled === true, '普通练习提示仍可用');
  normal.start();
  ok(normal.requestHint('reveal') === true, '普通练习下 requestHint 正常工作');
  normal.destroy();

  // ---- 7. 续练时必须保住 examMode（否则提示会「复活」） ----
  const rq = generateQuestions({ mode: 'exam', count: 8 });
  const src = new PracticeEngine({ questions: rq, mode: 'exam', examMode: true });
  src.start();
  src.pressKey((src.currentTarget().keys || ['a'])[0]);
  const snap = src.exportResume();
  ok(snap.settings.examMode === true, 'exportResume 保存了 examMode');
  src.destroy();

  const restored = PracticeEngine.restore(snap);
  ok(!!restored, 'restore 成功');
  if (restored) {
    ok(restored.examMode === true, '续练后 examMode 仍为 true（防止提示复活）');
    ok(restored.hintEnabled === false, '续练后提示仍被关闭');
    restored.destroy();
  }

  console.log(`  20 题测验跑完，hintedChars=0，无任何提示事件`);
}

console.log('\n【新增】独立作答与中断恢复');
for (const scenario of ['independent', 'wrong', 'hint']) {
  const eng = new PracticeEngine({ questions: generateQuestions({ mode: 'char', count: 2 }),
    mode: 'char', hintEnabled: true, hintDelayMs: 0, revealDelayMs: 0 });
  let unit;
  eng.on('unit', e => { unit = e; });
  eng.start();
  const target = eng.currentTarget();
  if (scenario === 'wrong') eng.pressKey(target.keys[0] === 'A' ? 'b' : 'a');
  if (scenario === 'hint') eng.requestHint('reveal');
  eng.pressKey(target.keys[0]);
  const saved = JSON.parse(JSON.stringify(eng.exportResume()));
  eng.destroy();
  const restored = PracticeEngine.restore(saved);
  ok(restored.keyIndex === 1 && restored.currentTarget().pos === 1,
    `${scenario}：续练从第二键恢复`);
  restored.on('unit', e => { unit = e; });
  restored.start();
  restored.pressKey(target.keys[1]);
  ok(unit && unit.independent === (scenario === 'independent'),
    `${scenario}：恢复后的独立作答状态准确`);
  ok(restored.stats.wrongChars === (scenario === 'wrong' ? 1 : 0),
    `${scenario}：恢复后错误字符统计保留`);
  ok(restored.stats.hintedChars === (scenario === 'hint' ? 1 : 0),
    `${scenario}：恢复后提示字符统计保留`);
  restored.destroy();
}

for (const mode of ['sheng', 'yun']) {
  const eng = new PracticeEngine({ questions: generateQuestions({ mode, count: 1 }), mode,
    hintEnabled: true, hintDelayMs: 0, revealDelayMs: 0 });
  let unit;
  eng.on('unit', e => { unit = e; });
  eng.start(); eng.requestHint('reveal');
  eng.pressKey(eng.currentTarget().keys[0]);
  ok(unit && !unit.independent && eng.stats.hintedChars === 1,
    `${mode}：提示过的单键成分不计独立作答`);
  eng.destroy();
}

console.log('【新增】不限量续题、统计与恢复');
{
  const batch = () => generateQuestions({ mode: 'char', count: 2, charTier: '1' });
  const eng = new PracticeEngine({ questions: batch(), mode: 'char', unlimited: true,
    questionSource: batch, generation: { mode: 'char', count: 2, charTier: '1' },
    hintDelayMs: 0, revealDelayMs: 0 });
  eng.start();
  eng.pressKey('x' === eng.currentTarget().keys[0].toLowerCase() ? 'z' : 'x');
  eng.requestHint('reveal');
  for (let i = 0; i < 25; i++) {
    const t = eng.currentTarget();
    for (const key of t.keys) eng.pressKey(key);
  }
  ok(eng.state === STATE.RUNNING && eng.summary().doneQuestions === 25, '完成多批后继续运行并累计题数');
  ok(eng.questions.length === 2 && eng.questionOffset === 24 && eng._erroredChars.size <= 2,
    '只保留当前批次及标记，不无限追加题目');
  ok(eng.stats.totalChars === 25 && eng.stats.wrongChars === 1 && eng.stats.hintedChars === 1,
    '换批后不复用错误和提示标记，累计统计正确');
  ok(eng.visibleStats().progress.includes('25') && eng.visibleStats().progress.includes('∞'), '不限量进度显示累计数');
  eng.pressKey(eng.currentTarget().keys[0]);
  eng.pause();
  const saved = eng.exportResume(); eng.destroy();
  const restored = PracticeEngine.restore(saved, batch);
  ok(restored.questionOffset === 24 && restored.keyIndex === 1 && restored.unlimited,
    '恢复累计题号、不限量模式和当前半个音节');
  restored.start();
  restored.pressKey(restored.currentTarget().keys[1]);
  ok(restored.summary().doneQuestions === 26 && restored.state === STATE.RUNNING,
    '恢复后跨批次仍自动续题');
  const summary = restored.finish('user');
  ok(summary.doneQuestions === 26 && !summary.completed && summary.questionCount === 0,
    '主动结束保留实际完成量，不把一批题数当成总题数');
  restored.destroy();
  const empty = new PracticeEngine({ questions: batch(), unlimited: true, questionSource: () => [] });
  empty.start();
  for (let i = 0; i < 2; i++) for (const key of empty.currentTarget().keys) empty.pressKey(key);
  ok(empty.state === STATE.FINISHED && empty.summary().doneQuestions === 2, '续题源失效时安全结束');
  empty.destroy();
  const timed = new PracticeEngine({ questions: batch(), unlimited: true, questionSource: batch,
    durationSec: 1, hintEnabled: false });
  let reason;
  timed.on('finish', s => { reason = s.reason; }); timed.start();
  timed._lastTickAt -= 1500;
  await new Promise(resolve => setTimeout(resolve, 280));
  ok(timed.state === STATE.FINISHED && reason === 'timeup', '不限量仍受倒计时限制');
  timed.destroy();
}

console.log('\n' + (fail === 0 ? '✅ 引擎全部自检通过' : `❌ 引擎共 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
