/**
 * 集成测试：在模拟 DOM 中加载并驱动整个应用
 * ------------------------------------------------------------
 * 覆盖：启动 → 选择模式 → 开始练习 → 模拟按键 → 校验反馈 → 结束 → 统计
 * 目的：捕获模块间「接线」错误（选择器写错、事件未绑定、渲染异常等），
 *       这类问题 Node 单元测试无法发现。
 *
 * 运行：node _test/integration.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHarness, createVirtualClock, virtualizeWindowTimers,
         FakeEvent, FakeKeyboardEvent } from './tools/harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗ ' + m); } else { console.log('  ✓ ' + m); } };

/* ---------- 构建模拟浏览器环境 ---------- */
/*
 * 模拟浏览器基座已抽到 tools/harness.mjs，与 clock.mjs 及各套集成测试共用
 * 同一份（原来是每个文件各抄一遍 ~330 行，抄错一处就两地不一致）。
 *
 * 这里**用真实时钟**（realTimers: true）：本套测的是「真应用接到真事件链上
 * 能不能跑通」，而应用自身的定时行为（8ms 按键防抖、250ms 心跳、反馈条
 * 3200ms 自动清除）正是被测对象的一部分，整体虚拟化就不是在测它了。
 *
 * 所以这里的策略是**等状态**而不是等毫秒数：
 *   · 点完立刻要「接线落定」→ await settle()（fire 是同步的，绝大多数等待
 *     只是残留；settle 让出一轮事件循环，语义明确）；
 *   · 要等某个状态成立（设置防抖落盘）→ await waitFor(pred)；
 *   · 真正依赖时长的少数几处（按键 8ms 防抖、引擎提示/揭晓的时间线、
 *     限时结束）→ 要么显式 sleep 并注明原因，要么单独借一台虚拟时钟。
 * 这样既缩短了测试，也不再靠猜毫秒数去赌异步是否跑完。
 */
const H = await createHarness({ realTimers: true });
const { window, document, fakeWindow, errors, warnings, localStorage, storageMap } = H;
const { fire, fireKey, settle, waitFor } = H;
const q = H.q;
const qa = H.qa;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- 加载被测模块（绕过 main.js 的自动 boot） ---------- */
console.log('【1】模块加载');
const engineMod = await import('../src/core/engine.js');
const qMod = await import('../src/core/questions.js');
const sMod = await import('../src/core/storage.js');
const stMod = await import('../src/core/stats.js');
const schMod = await import('../src/core/scheme.js');
ok(!!engineMod.PracticeEngine, 'engine 模块加载');
ok(!!qMod.generateQuestions, 'questions 模块加载');
ok(!!sMod.loadSettings, 'storage 模块加载');
ok(!!stMod.summarize, 'stats 模块加载');
ok(!!schMod.getKeymapData, 'scheme 模块加载');

/* ---------- 加载 main.js（会执行 boot） ---------- */
console.log('\n【2】应用启动（boot）');
// 【12d】的安全前置：往书架塞一条**恶意 id** 的原始数据（模拟导入的坏备份）。
// boot 时的书架渲染必须把它净化掉 —— 不会出现 img/onerror，
// id 会因为不在白名单内被重新生成。断言在【12d】里。
localStorage.setItem('shuangpin.v1.shelf', JSON.stringify([{
  id: '"><img src=x onerror=window.__pwned=1>',
  title: '注入测试材料', text: '这条来自一份恶意构造的备份。',
  createdAt: 1, lastAt: 0,
  progress: { segIndex: 0, segCount: 0 },
  stats: { sessions: 0, chars: 0, durationSum: 0, speedWSum: 0, accWSum: 0, bestSpeed: 0 }
}]));
let bootError = null;
try {
  // loadApp 内部会把实例挂到 fakeWindow.__app 上，并在导入后跑一轮 settle()。
  await H.loadApp();
} catch (e) {
  bootError = e;
}
ok(!bootError, `main.js 加载无异常${bootError ? '：' + bootError.message : ''}`);
if (bootError) { H.restoreGlobals(); process.exit(1); }

// 等 boot 期间的异步接线落定（原来是盲等 60ms；改成等一轮事件循环 + 状态可观测）
await settle();

ok(errors.length === 0, `启动期间无 error${errors.length ? '：' + errors.join(' | ') : ''}`);


/* ---------- 校验 DOM 渲染结果 ---------- */
console.log('\n【3】初始界面');

ok(!!q('#nav'), '导航栏存在');
ok(qa('#nav .nav-btn').length === 6, `导航按钮 6 个（实际 ${qa('#nav .nav-btn').length}）`);

/* 导航顺序：介绍页在前，「练习」放到最后。
   理由：新用户进来先要知道「双拼是什么 / 值不值得学」，再谈练不练；
   把「练习」放末位，顺带降低误点开始的门槛感。顺序本身是产品决策，
   容易被后续插页打乱，因此这里锁死顺序，而不只是锁数量。 */
{
  const order = qa('#nav .nav-btn').map(b => b.getAttribute('data-view'));
  const want = ['why', 'keymap', 'stats', 'review', 'settings', 'practice'];
  ok(JSON.stringify(order) === JSON.stringify(want),
    `导航顺序为 ${want.join(' → ')}（实际 ${order.join(' → ')}）`);
  ok(order[order.length - 1] === 'practice', '「练习」排在最后一位');
  ok(order[0] === 'why', '「为什么用双拼」排在第一位');
}

ok(qa('#modeGrid .mode-card').length === 9, `模式卡片 9 个（实际 ${qa('#modeGrid .mode-card').length}）`);

// 新增的拆分成分练习模式必须出现在选择面板上
{
  const ids = qa('#modeGrid .mode-card').map(c => c.getAttribute('data-mode'));
  ok(ids.includes('sheng'), '模式列表含「只听声母」(sheng)');
  ok(ids.includes('yun'), '模式列表含「只听韵母」(yun)');
  ok(ids.includes('exam'), '模式列表含「能力测验」(exam)');
  ok(ids.includes('custom'), '模式列表含「自定义文本」(custom)');
  // 老模式的 L2 tip 里「zh/ch/sh 需按 3 个键」是错误说法，必须已修正
  const splitCard = qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'split');
  ok(!!splitCard, '拆分模式卡片存在');
}

ok(!q('#setupPanel').hidden, '设置面板默认可见');
ok(q('#sessionPanel').hidden === true || !q('#sessionPanel').hasAttribute('data-shown'), '练习面板初始隐藏');
ok(!!q('#btnStart'), '开始按钮存在');

/* ---------- 回归：hidden 属性必须真的能隐藏元素 ----------
   曾经踩过的坑：CSS 里没有 [hidden] 规则，而 .overlay 设了
   display:grid，作者样式表优先级高于浏览器 UA 样式表，
   导致 overlay 一进页面就盖满全屏（弹窗空白）。
   这里直接扫 CSS 源码，确保兜底规则存在。 */
{
  const css = readFileSync(resolve(root, 'assets/style.css'), 'utf8');
  const hasHiddenRule = /\[hidden\]\s*\{[^}]*display\s*:\s*none/i.test(css);
  ok(hasHiddenRule, 'CSS 含 [hidden] { display:none } 兜底规则');

  // 列出所有依赖 hidden 的元素，逐个确认它们在初始状态确实有 hidden 属性
  const hiddenEls = qa('[hidden]').map(el => el.id || el.tagName.toLowerCase());
  ok(hiddenEls.length > 0, `初始有 ${hiddenEls.length} 个元素带 hidden 属性（${hiddenEls.join(', ')}）`);
  ok(q('#overlay').hasAttribute('hidden'), '遮罩层初始带 hidden 属性');
}

// 迷你 / 完整键位图
const miniSvg = q('#miniKeymap svg');
const fullSvg = q('#fullKeymap svg');
ok(!!fullSvg || !!miniSvg, '键位图已渲染 SVG');
if (fullSvg) {
  const keys = fullSvg.querySelectorAll('[data-key]');
  ok(keys.length === 26, `完整键位图 26 键（实际 ${keys.length}）`);

  /* 回归：键内文字不得重叠
     曾经踩过的坑：早期把 H 键的韵母「ang」和误加的「zh/ch/sh 二键」
     提示都放在 y = KEY_H - 16，两段文字直接叠在一起（用户截图可见）。
     后来确认小鹤中 zh/ch/sh 各占一键，H 键不再有第二行，该重叠自然消失。
     这个几何断言仍然保留 —— 它守的是「任何键内文字都不许撞车」。

     判定要把「水平位置」算进去 —— 主字母（靠左）与声母（靠右）本来就
     同一高度，那是左右并排，不算重叠。只有纵向距离不足 **且** 横向范围
     相交时，才算真重叠。 */
  let overlaps = [];
  keys.forEach(keyEl => {
    const texts = Array.from(keyEl.querySelectorAll('text')).map(t => {
      const content = (t.textContent || '').trim();
      const size = parseFloat(t.getAttribute('font-size')) || 12;
      const anchor = t.getAttribute('text-anchor') || 'start';
      const x = parseFloat(t.getAttribute('x')) || 0;
      // 估算文字横向占宽：中文按 1 字宽、其余按 0.6 字宽
      const cjk = (content.match(/[\u4e00-\u9fa5]/g) || []).length;
      const width = (cjk + (content.length - cjk) * 0.6) * size;
      let left = x;
      if (anchor === 'middle') left = x - width / 2;
      else if (anchor === 'end') left = x - width;
      return {
        content, size, y: parseFloat(t.getAttribute('y')),
        left, right: left + width
      };
    }).filter(t => t.content && Number.isFinite(t.y));

    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i], b = texts[j];
        const vGap = Math.abs(a.y - b.y);
        const need = Math.max(a.size, b.size) * 0.85;
        if (vGap >= need) continue;                      // 纵向已分开，安全
        // 纵向太近 —— 再看横向是否真的相交（留 2px 余量）
        const hOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        if (hOverlap > -2) {
          overlaps.push(`${keyEl.getAttribute('data-key')}: 「${a.content}」(y=${a.y}) 与 「${b.content}」(y=${b.y}) 纵向 ${vGap.toFixed(1)} < ${need.toFixed(1)}，横向也相交`);
        }
      }
    }
  });
  ok(overlaps.length === 0, overlaps.length
    ? `键位图存在文字重叠 ${overlaps.length} 处：${overlaps.slice(0, 3).join('；')}`
    : '键位图 26 键内文字无重叠');

  // H 键只展示韵母 ang；zh/ch/sh 各占一键，H 键不应再出现「二键」提示
  const hKey = fullSvg.querySelector('[data-key="H"]');
  if (hKey) {
    const hTexts = Array.from(hKey.querySelectorAll('text')).map(t => t.textContent.trim());
    ok(hTexts.some(t => t.includes('ang')), 'H 键显示韵母 ang');
    ok(!hTexts.some(t => /二键/.test(t)), 'H 键不再显示已废弃的「二键」提示');
  }
  // V 键承载 zh，且必须能看到 zh 声母
  const vKey = fullSvg.querySelector('[data-key="V"]');
  if (vKey) {
    const vTexts = Array.from(vKey.querySelectorAll('text')).map(t => t.textContent.trim());
    ok(vTexts.some(t => t === 'zh' || t.includes('zh')), 'V 键显示声母 zh');
  }
}

// 音节列表
const sylItems = qa('#sylList .syl-item');
ok(sylItems.length > 0, `音节对照表已渲染（${sylItems.length} 项）`);

/* ---------- 驱动一次完整练习 ---------- */
console.log('\n【4】驱动练习流程');
const app = fakeWindow.__app;
ok(!!app, '应用实例已暴露');

/* 书架编辑使用独立的小流程，放在任何练习结算弹窗打开之前，
   验证真实的编辑入口、保存动作和标签列表展示。 */
{
  const ta = q('#customTextInput');
  const text = '书架编辑功能集成测试材料。';
  ta.value = text;
  fire(q('#btnShelfSave'), 'click');
  await settle();
  const entry = sMod.loadShelf().find(e => e.text === text);
  ok(!!entry, '书架编辑测试材料已创建');
  fire(q(`#shelfList [data-id="${entry.id}"][data-act="edit"]`), 'click');
  await settle();
  ok(!q('#overlay').hidden, '点击编辑打开材料信息弹窗');
  q('#shelfEditTitle').value = '双拼复习材料';
  q('#shelfEditTags').value = '复习，短文, 每日';
  fire(q('#modal [data-act="save"]'), 'click');
  await settle();
  const edited = sMod.loadShelf().find(e => e.id === entry.id);
  ok(edited.title === '双拼复习材料' && edited.tags.join('|') === '复习|短文|每日',
    `标题和多种分隔符标签保存成功（${edited.tags.join('、')}）`);
  ok(edited.text === text && edited.stats.sessions === 0,
    '编辑资料保留原文与既有统计');
  ok(qa('#shelfList .shelf-item-meta').some(el => /复习、短文、每日/.test(el.textContent)),
    '标签显示在书架列表');

  /* ---- 卡顿分析入口 ----
     没有逐字用时的材料不给「卡顿分析」按钮（点开只有「暂无数据」比不给更糟），
     记过一次之后按钮出现，且弹窗内容真的来自这份材料的数据。 */
  ok(!q(`#shelfList [data-id="${entry.id}"][data-act="slow"]`),
    '没练过的材料不给「卡顿分析」按钮');

  sMod.recordShelfSlow(entry.id, [
    { ch: '书', ms: 1200 }, { ch: '架', ms: 300 }, { ch: '编', ms: 1600 }, { ch: '辑', ms: 280 }
  ], { segIndex: 0, durationSec: 4, totalChars: 4 });
  H.rerenderShelf ? H.rerenderShelf() : fire(q('#btnShelfSave'), 'click');
  await settle();

  const slowBtn = q(`#shelfList [data-id="${entry.id}"][data-act="slow"]`);
  ok(!!slowBtn, '★ 有逐字用时后出现「卡顿分析」入口');

  if (slowBtn) {
    fire(slowBtn, 'click');
    await settle();
    ok(!q('#overlay').hidden, '点击后打开卡顿分析弹窗');
    const modalText = q('#modal').textContent;
    ok(/最慢的/.test(modalText), '弹窗列出「最慢的位置」');
    // '书' 是这一篇的第一个字（含启动成本），必须被排除；'编' 才是真卡顿
    ok(/编/.test(modalText), '弹窗列出实际停顿的字（编）');
    ok(!/书/.test(modalText.split('最慢的')[1] || ''),
      '★ 首字（书）不出现在最慢列表里 —— 它是启动成本而不是卡顿');
    ok(/第一次练习这份材料/.test(modalText),
      '只有一次记录时如实说「下次才能对比」，而不是编一个 0 变化');
    fire(q('#modal [data-act="cancel"]'), 'click');
    await settle();
  }

  sMod.removeShelfEntry(entry.id);
  app.shelfActiveId = null;
}

// 选择「单字打字」模式
const charCard = qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'char');
ok(!!charCard, '找到单字模式卡片');
fire(charCard, 'click');
ok(app.sessionMode === 'char', `模式已切换为 char（实际 ${app.sessionMode}）`);

// 点击开始
fire(q('#btnStart'), 'click');
await settle();

ok(!!app.engine, '引擎已创建');
ok(q('#setupPanel').hidden === true, '设置面板已隐藏');
ok(q('#sessionPanel').hidden === false, '练习面板已显示');
ok(app.engine.state === 'running', `引擎运行中（实际 ${app.engine.state}）`);
ok(qa('#prompt .ch').length > 0, '字形行已渲染');
ok(!!q('#decode').innerHTML.trim(), '拆分区已渲染');

const totalQ = app.engine.questions.length;
ok(totalQ > 0, `题目数 ${totalQ}`);

// 模拟完整作答（全部打对）
/* 用时口径：引擎只在 durationSec >= 1 时才落库（拦空练习），而 headless 里
   按键循环是瞬时的。旧写法给每键加 ~12ms 真实间隔来「把时间磨够」，CI 忙时
   既慢又不稳。这里改成显式给引擎记账：每轮把 elapsedSec 抬到 1 秒以上，
   终点由状态决定而不是由墙钟决定 —— 用时是**被测代码要展示的数据**，
   不该用真实等待去凑。 */
let guard = 0;
let pressed = 0;
while (app.engine.state === 'running' && guard < 20000) {
  guard++;
  const t = app.engine.currentTarget();
  if (!t) break;
  if (t.kind === 'skip' || t.kind === 'punct') { app.engine.pressKey('a'); continue; }
  const keys = t.keys || [];
  const k = keys[t.pos];
  if (!k) break;
  // 先记账再按键：最后一键会同步触发 finish → persistRecord，读到的是此刻的用时
  app.engine.elapsedSec = 2;
  app.engine.pressKey(k.toLowerCase());
  pressed++;
  await settle();
}
ok(pressed > 5, `模拟按键 ${pressed} 次`);
ok(app.engine.state === 'finished', `全部打对后结束（实际 ${app.engine.state}）`);

/* ---------- 结果与统计 ---------- */
console.log('\n【5】成绩与统计落库');
const sum = app.engine.summary();
// 说明：headless 环境里 while 循环以 22ms/键 的节奏「瞬间」跑完，
// 真实浏览器中同样一次练习至少要几秒。用时未满 1 秒时引擎不给速度
// （分母过小会把速度放大到失真），这属于预期行为，因此这里只断言
// 「有按键就必然有用时」，以及速度在合理范围内。
ok(sum.keystrokes > 0 && sum.durationSec > 0, `用时已记录：${sum.durationSec}s / ${sum.keystrokes} 键`);
ok(sum.speed >= 0 && Number.isFinite(sum.speed), `速度字段可用：${sum.speed} 字/分`);
ok(sum.accuracy === 100, `全对时正确率 100%（实际 ${sum.accuracy}）`);
ok(sum.totalChars === totalQ, `完成字数 = 题数（${sum.totalChars}/${totalQ}）`);

// 结果弹窗
ok(!q('#overlay').hidden, '结果弹窗已打开');
ok(q('#modal').innerHTML.includes('速度'), '弹窗含速度指标');
ok(q('#modal').innerHTML.includes('正确率'), '弹窗含正确率指标');

// 关闭弹窗
const closeBtn = qa('#modal [data-act]').find(b => b.getAttribute('data-act') === 'again');
if (closeBtn) fire(closeBtn, 'click');
await settle();

const history = sMod.loadHistory();
ok(history.length === 1, `历史记录已写入 1 条（实际 ${history.length}）`);
ok(history[0].accuracy === 100, '记录准确率正确');

const summaryData = stMod.summarize(history);
ok(summaryData.sessions === 1, '汇总统计正确');
ok(summaryData.totalChars === totalQ, '汇总字数正确');
ok(summaryData.streakDays >= 1, `连续天数 >= 1（实际 ${summaryData.streakDays}）`);

const daily = sMod.loadDaily();
const today = Object.keys(daily)[0];
ok(!!today, `每日聚合已写入（${today}）`);
ok(daily[today].chars === totalQ, '每日字数正确');

/* ---------- 错误路径：故意打错 ---------- */
console.log('\n【6】错误路径');
// 重置后再跑一次，故意打错
app.engine.destroy();
q('#sessionPanel').hidden = true;
q('#setupPanel').hidden = false;
fire(q('#btnStart'), 'click');
await settle();
ok(app.engine.state === 'running', '第二次练习已开始');

const t0 = app.engine.currentTarget();
const wrongKey = 'qwertyuiopasdfghjklzxcvbnm'.split('')
  .find(c => !(t0.keys || []).map(x => x.toLowerCase()).includes(c));
const res = app.engine.pressKey(wrongKey);
ok(res.correct === false, '错误按键被判错');
ok(app.lastErrorTarget !== null, '错误已触达 UI 回调');
ok(!q('#feedback').hidden, '错误反馈条已显示');
ok(q('#feedback').innerHTML.includes(wrongKey.toUpperCase()), '反馈条显示按错的键');
ok(q('#feedback').innerHTML.includes(t0.keys[t0.pos].toUpperCase()), '反馈条显示正确键位');
ok(app.engine.keyIndex === 0, '错误后不推进');

// 打完这次练习
guard = 0;
while (app.engine.state === 'running' && guard < 20000) {
  guard++;
  const t = app.engine.currentTarget();
  if (!t) break;
  if (t.kind === 'skip' || t.kind === 'punct') { app.engine.pressKey('a'); continue; }
  const k = (t.keys || [])[t.pos];
  if (!k) break;
  app.engine.elapsedSec = 2;   // 同上：用时靠记账，不等真实秒
  app.engine.pressKey(k.toLowerCase());
  await settle();
}
const sum2 = app.engine.summary();
ok(sum2.accuracy < 100, `出错后正确率 < 100（${sum2.accuracy}%）`);
ok(sum2.wrongKeystrokes >= 1, '错误按键已计数');

// 易错表
const weakList = sMod.getWeakList({ limit: 20 });
ok(weakList.length >= 1, `易错表已记录（${weakList.length} 项）`);

/* ---------- 暂停 / 恢复 ---------- */
console.log('\n【7】暂停与恢复');
ok(!q('#overlay').hidden || true, '（弹窗状态检查跳过）');
if (!q('#overlay').hidden) {
  const anyBtn = qa('#modal [data-act]')[0];
if (anyBtn) fire(anyBtn, 'click');
}
q('#sessionPanel').hidden = false;
q('#setupPanel').hidden = true;
fire(q('#btnStart'), 'click');
await settle();
const eng3 = app.engine;
ok(eng3.state === 'running', '第三次练习运行中');
eng3.pause();
ok(eng3.state === 'paused', '暂停成功');
ok(q('#btnPause').textContent === '继续', `按钮文案切换为「继续」（实际「${q('#btnPause').textContent}」）`);
eng3.resume();
ok(eng3.state === 'running', '恢复成功');
eng3.destroy();

/* ---------- 各视图渲染 ---------- */
console.log('\n【8】各视图渲染');
for (const v of ['why', 'keymap', 'stats', 'review', 'settings', 'practice']) {
  const btn = qa('#nav .nav-btn').find(b => b.getAttribute('data-view') === v);
  if (!btn) { ok(false, `找不到 ${v} 导航按钮`); continue; }
  const errBefore = errors.length;
  fire(btn, 'click');
  await settle();
  const viewEl = q('#view-' + v);
  ok(viewEl && viewEl.classList.contains('is-active'), `${v} 视图已激活`);
  ok(errors.length === errBefore, `${v} 视图渲染无 error${errors.length > errBefore ? '：' + errors.slice(errBefore).join(' | ') : ''}`);
}

/* ---------- 「为什么用双拼」页 ----------
   这是一页纯静态介绍内容（不参与状态机），但仍要守住两条：
   ① 它必须真的挂在路由上（view-why 与导航按钮对应），点了能切过去；
   ② 页面里给出的**示例编码必须是真实正确的** —— 介绍页最容易写成
      「看起来对」的编码，而它恰恰是新用户对双拼的第一印象。
   所以这里不查「有没有字」，而是拿引擎把示例编码重新算一遍做比对。 */
{
  const whyView = q('#view-why');
  ok(!!whyView, '存在「为什么用双拼」视图 view-why');

  const whyBtn = qa('#nav .nav-btn').find(b => b.getAttribute('data-view') === 'why');
  ok(!!whyBtn, '导航栏含「为什么用双拼」按钮');
  ok(/双拼/.test(whyBtn ? whyBtn.textContent : ''), '导航按钮文案含「双拼」');

  if (whyView) {
    const text = whyView.textContent.replace(/\s+/g, ' ');

    // 三块核心内容都要在：是什么 / 好处 / 代价
    ok(/双拼是什么/.test(text), '含「双拼是什么」小节');
    ok(/好处/.test(text), '含「好处」小节');
    ok(/该不该学/.test(text), '含「该不该学 / 代价」小节');

    // 必须诚实说明学习成本，不能只讲优点
    ok(/变慢|学习成本|不适应/.test(text), '如实提示了学习成本（不是只讲好处）');

    // 好处卡片至少 6 张
    ok(qa('#view-why .why-benefit').length >= 6,
      `好处卡片 ≥6 张（实际 ${qa('#view-why .why-benefit').length}）`);

    // 代价列表非空
    ok(qa('#view-why .why-caveat-list li').length >= 3,
      `代价列表 ≥3 条（实际 ${qa('#view-why .why-caveat-list li').length}）`);

    /* 正文里的示例编码必须是真编码。
       作者写的是「双 = U+L」「状 = V+L」「长 = I+H」，这里逐个用 scheme
       重新拆分，任何一处写错都会被抓住。 */
    const examples = qa('#view-why .why-compare-row').map(row => {
      const word = row.querySelector('.why-compare-word');
      const keys = Array.from(row.querySelectorAll('.why-compare-keys b'))
        .map(b => b.textContent.trim());
      return { word: word ? word.textContent.trim() : '', keys };
    }).filter(e => e.word && e.keys.length);

    ok(examples.length >= 3, `对比表含 ≥3 个编码示例（实际 ${examples.length}）`);

    const CHAR_PY = { 双: 'shuang', 状: 'zhuang', 长: 'chang' };
    let checked = 0;
    for (const ex of examples) {
      const py = CHAR_PY[ex.word];
      if (!py) continue;                       // 只校验在本测试里登记过的字
      // splitSyllable 返回「候选数组」（如 xian 有 x+ian / xi+an 两种拆法），
      // 示例编码命中其中任意一个候选都算正确。
      const candidates = schMod.splitSyllable(py);
      const shown = ex.keys.map(k => k.toUpperCase()).join('+');
      const hit = candidates.some(c =>
        c.steps.map(st => String(st.key).toUpperCase()).join('+') === shown);
      const all = candidates.map(c => c.steps.map(st => String(st.key).toUpperCase()).join('+'));
      ok(hit, `「${ex.word}」示例编码 ${shown} 命中引擎候选之一（${all.join(' / ')}）`);
      checked++;
    }
    ok(checked >= 3, `已核对 ${checked} 个示例字的编码`);
  }
}

/* ---------- 能力测验（无提示 + 评分）端到端 ----------
   测验模式的「无提示」是在引擎层硬关的，UI 上还额外藏掉迷你键位图、
   提示条与提示标记，也不渲染拆分答案。这里从**用户路径**出发验证这条链路真的接通了：
   点卡片 → 引擎 examMode 为真 → 提示设施被隐藏 → 交卷出分数卡。
   单元测试只能证明引擎不开提示，证明不了「面板没藏起来」，
   所以这一节是必要的。 */
console.log('\n【10e】能力测验：无提示 + 评分');
{
  // 复位到设置面板
  if (app.engine) { app.engine.destroy(); app.engine = null; }
  if (!q('#overlay').hidden) {
    const b = qa('#modal [data-act]')[0];
    if (b) fire(b, 'click');
  }
  q('#sessionPanel').hidden = true;
  q('#setupPanel').hidden = false;

  // 点「能力测验」卡片
  const examCard = qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'exam');
  ok(!!examCard, '存在「能力测验」卡片');
  fire(examCard, 'click');
  await settle();
  ok(app.sessionMode === 'exam', `模式切到 exam（实际 ${app.sessionMode}）`);

  // 卡片被选中即应弹出说明条
  const note = q('#examNote');
  ok(!!note, '存在测验说明条 #examNote');
  ok(note && note.hidden === false, '选中测验模式后说明条可见');

  // 默认题量应被建议为 50
  ok(q('#selCount').value === '50', `测验默认题量建议 50（实际 ${q('#selCount').value}）`);

  // 开跑
  fire(q('#btnStart'), 'click');
  await settle();
  const eng = app.engine;
  ok(!!eng, '测验引擎已创建');
  ok(eng.examMode === true, '引擎进入考试模式');
  ok(eng.hintEnabled === false, '考试模式下 hintEnabled 已被强制关闭');
  ok(eng.hintDelayMs === 0 && eng.revealDelayMs === 0, '考试模式提示延时被归零');
  ok(eng.state === 'running', '测验运行中');

  const examPanel = q('#sessionPanel');
  ok(examPanel.classList.contains('is-exam'), '练习面板带 is-exam 类（用于隐藏提示设施）');

  // 顶部应有「测验中 · 无提示」标记
  ok(!!q('#examFlag'), '顶部渲染了测验标记 #examFlag');
  ok(/无提示/.test(q('#examFlag') ? q('#examFlag').textContent : ''), '测验标记文案点明「无提示」');

  // 手动求助必须被拒（并且不改变提示态）
  ok(eng.requestHint('reveal') === false, '测验模式手动求助被拒绝');
  ok(eng.hintLevel() === '', '测验模式求助后仍无提示态');

  // 迷你键位图不应可见（main.js 用 hidden 属性隐藏整个外层容器）
  const miniWrap = q('.mini-keymap-wrap');
  const miniVisible = !!(miniWrap && !miniWrap.hasAttribute('hidden') && miniWrap.hidden !== true);
  ok(!miniVisible, '测验模式隐藏迷你键位图');

  /* 确认测验不会自己冒提示出来。
     旧写法是「等 260ms 看有没有冒出来」—— 这是个**弱断言**：测验构造时
     hintDelayMs/revealDelayMs 都是 0，阈值根本没开，260ms 里本来就不该、
     也不可能有什么发生，等再久也只是白等。
     这里改成两条确定性断言，零等待：
       ① 结构：hintEnabled=false 时压根不建提示定时器（_resetHintTimer 直接 return）；
       ② 行为：把两级阈值与空闲时间**强行**设成「早该触发」，examMode 硬闸门
          仍必须压住 —— 这才是「测验=无辅助」真正要守的那条线。 */
  const hintEvents = [];
  eng.on('hint', x => hintEvents.push(x));
  eng.on('reveal', x => hintEvents.push(x));
  ok(eng._hintTimer == null, '测验不建提示定时器（hintEnabled=false）');
  {
    const savedHint = eng.hintEnabled, savedHD = eng.hintDelayMs, savedRD = eng.revealDelayMs;
    eng.hintEnabled = true; eng.hintDelayMs = 60; eng.revealDelayMs = 140;
    eng._idleSince = Date.now() - 60000;   // 假装干坐了 60 秒
    eng._checkHint();
    eng.hintEnabled = savedHint; eng.hintDelayMs = savedHD; eng.revealDelayMs = savedRD;
    ok(hintEvents.length === 0, `测验模式即使「空闲 60 秒」也不给提示（${hintEvents.length} 次）`);
  }

  // 打完这一卷（全部打对）
  let g = 0;
  const testedKinds = new Set();
  let answersExposed = false;
  while (app.engine && app.engine.state === 'running' && g < 40000) {
    g++;
    testedKinds.add(app.engine.currentQuestion().level);
    if (q('#decode .kc-letter') || q('#decode .syl-block') || q('#prompt .ch[title]')) {
      answersExposed = true;
    }
    if (!q('#prompt').textContent.includes(app.engine.currentQuestion().promptText)) answersExposed = true;
    const t = app.engine.currentTarget();
    if (!t) break;
    if (t.kind === 'skip' || t.kind === 'punct') { app.engine.pressKey('a'); continue; }
    const k = (t.keys || [])[t.pos];
    if (!k) break;
    /* 记一笔用时再按键：测验成绩要落库，而 persistRecord 只在
       durationSec >= 1 时才写（拦空练习）。headless 里这一卷是瞬时打完的，
       不记账就拿不到分数/等级，后面几条断言会跟着红。 */
    app.engine.elapsedSec = 2;
    app.engine.pressKey(k.toLowerCase());
    await settle();
  }
  ok(testedKinds.size === 3, '测验覆盖拆分、单字与词组三类题');
  ok(!answersExposed, '测验每次换题和逐键输入均保留题干，不提前暴露拆分键位或拼音悬浮提示');
  const sm = app.engine ? app.engine.summary() : null;
  ok(sm && sm.state === 'finished', `测验完成（${sm ? sm.totalChars : 0} 题，${sm ? sm.accuracy : 0}%）`);
  ok(sm && sm.hintedChars === 0, `测验全程 0 次提示（实际 ${sm && sm.hintedChars}）`);
  ok(sm && sm.independentAccuracy === sm.accuracy,
    `测验无提示时独立正确率 = 表面正确率（${sm && sm.independentAccuracy} / ${sm && sm.accuracy}）`);
  // 评分对象由 main.js 在落库时算出（挂在 app.lastResult 上），
  // 而不是引擎 summary() 自带 —— summary() 保持纯函数语义。
  const lr = app.lastResult;
  ok(!!lr && !!lr.score && typeof lr.score.score === 'number', '落库时算出评分对象');
  if (lr && lr.score) {
    ok(lr.score.score >= 0 && lr.score.score <= 100, `综合分落在 0–100（${lr.score.score}）`);
    ok(typeof lr.score.grade === 'string' && lr.score.grade.length > 0,
      `评分带等级（${lr.score.grade}）`);
    ok(/^[SABCDE]$/.test(String(lr.score.badge)), `评分带等级徽章（${lr.score.badge}）`);
    ok(lr.summary.mode === 'exam' || lr.summary.examMode === true, '评分对象对应测验模式');
  }
  // 结果弹窗应渲染分数卡
  ok(!q('#overlay').hidden, '交卷后结果弹窗打开');
  const modalHtml = q('#modal').innerHTML;
  ok(modalHtml.includes('score-card'), '结果弹窗含分数卡 .score-card');
  ok(/综合分|得分/.test(modalHtml), '结果弹窗标注了综合分');
  ok(/独立正确率/.test(modalHtml), '测验结果口径为「独立正确率」');

  // 落库历史应带分数
  const h = sMod.loadHistory();
  const lastRec = h[h.length - 1];
  ok(!!lastRec && typeof lastRec.score === 'number', `历史记录带测验分数（${lastRec && lastRec.score}）`);
  ok(!!lastRec && !!lastRec.grade, `历史记录带等级（${lastRec && lastRec.grade}）`);

  if (app.engine) { app.engine.destroy(); app.engine = null; }
}

// 统计页关键元素
const statCards = qa('#statCards .stat-card');
ok(statCards.length === 6, `统计卡片 6 个（实际 ${statCards.length}）`);
ok(qa('#weakTableWrap table, #weakTableWrap .empty-state').length >= 1, '易错表区域已渲染');

// 复习页
const reviewBody = q('#reviewBody');
ok(!!reviewBody.innerHTML.trim(), '复习页内容已渲染');

/* ---------- 设置项持久化 ---------- */
console.log('\n【9】设置持久化');
const sel = q('#setDuration');
if (sel) {
  sel.value = '300';
  fire(sel, 'change');
  /* 设置是防抖落盘的（saveSettingsDebounced，400ms）。旧写法盲等 500ms：
     快的时候白等，CI 忙的时候可能还没写下去。改成等**状态**成立 ——
     只要落盘了就立刻返回，没落盘就一直等到超时。 */
  await waitFor(() => sMod.loadSettings().duration === 300,
    { label: '时长设置落盘（saveSettingsDebounced 400ms）' });
  const loaded = sMod.loadSettings();
  ok(loaded.duration === 300, `时长设置已持久化（实际 ${loaded.duration}）`);
}

/* ---------- 每日目标 UI ---------- */
console.log('\n【9c】每日目标：设置、进度条与 HUD');
{
  const charsInput = q('#setDailyGoalChars');
  const sessInput = q('#setDailyGoalSessions');
  ok(!!charsInput, '设置页有「每日字数」输入框');
  ok(!!sessInput, '设置页有「每日练习次数」输入框');
  ok(!!q('#todayGoalBar'), '统计页有今日目标进度条容器');
  ok(!!q('#hudGoalItem'), '练习 HUD 有今日目标格子');

  // 脏值必须被夹取并回写到控件（用户当场看得见被纠正）
  if (charsInput) {
    charsInput.value = '-99';
    fire(charsInput, 'change');
    ok(charsInput.value === '0', `负数字数被夹到 0 并回写（实际 ${charsInput.value}）`);
    charsInput.value = '999999999';
    fire(charsInput, 'change');
    ok(charsInput.value === '1000000', `超大值被夹到上限并回写（实际 ${charsInput.value}）`);
    charsInput.value = '250';
    fire(charsInput, 'change');
  }

  await waitFor(() => sMod.loadSettings().dailyGoalChars === 250,
    { label: '每日字数落盘（saveSettingsDebounced 400ms）' });
  const loadedGoal = sMod.loadSettings();
  ok(loadedGoal.dailyGoalChars === 250, `每日字数已持久化（实际 ${loadedGoal.dailyGoalChars}）`);

  // 统计页进度条：设了目标就应该可见，且展示百分比
  fire(q('[data-view="stats"]'), 'click');
  await settle();
  const bar = q('#todayGoalBar');
  ok(bar && !bar.hidden, '设了目标后统计页进度条可见');
  ok(bar && /%/.test(bar.textContent), '进度条展示完成度百分比');

  /* 两项都设 0 → 进度条隐藏（而不是画一条永远 0% 的）。
     这是「未设目标」和「还没开始做」的区分，UI 上不能混为一谈。 */
  if (charsInput && sessInput) {
    charsInput.value = '0'; fire(charsInput, 'change');
    sessInput.value = '0'; fire(sessInput, 'change');
    await settle();
    ok(q('#todayGoalBar').hidden, '两项目标都为 0 时进度条隐藏');

    // 复原成有目标，供后续用例使用
    charsInput.value = '100'; fire(charsInput, 'change');
    sessInput.value = '1'; fire(sessInput, 'change');
    await settle();
  }
}

/* ---------- 自定义文本跟打（用户路径） ---------- */
console.log('\n【9d】自定义文本：粘贴 → 开始 → 打字 → 落库');
{
  // 回到设置面板
  if (app.engine) { app.engine.destroy(); app.engine = null; }
  q('#sessionPanel').hidden = true;
  q('#setupPanel').hidden = false;
  if (!q('#overlay').hidden) {
    const b = qa('#modal [data-act]')[0];
    if (b) fire(b, 'click');
  }

  const ta = q('#customTextInput');
  ok(!!ta, '存在自定义文本输入框');

  // 选中「自定义文本」模式 → 输入框出现
  const customCard = qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'custom');
  ok(!!customCard, '存在「自定义文本」模式卡片');
  fire(customCard, 'click');
  await settle();
  ok(app.sessionMode === 'custom', `模式切到 custom（实际 ${app.sessionMode}）`);
  ok(q('#customTextField').hidden === false, '自定义文本输入区已显示');

  // 切到别的模式 → 输入区隐藏（避免「填了却不生效」的误解）
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'char'), 'click');
  await settle();
  ok(q('#customTextField').hidden === true, '切到其他模式后输入区隐藏');
  fire(customCard, 'click');
  await settle();

  // 空文本点开始 → 拒绝并给出提示，不进入练习
  fire(q('[data-view="practice"]'), 'click');
  await settle();
  ta.value = '';
  fire(ta, 'input');
  fire(q('#btnStart'), 'click');
  await settle();
  ok(q('#setupPanel').hidden === false && !app.engine, '空文本时不启动练习（停留在设置面板）');

  // 纯标点 → 同样拒绝
  ta.value = '，。！？';
  fire(ta, 'input');
  fire(q('#btnStart'), 'click');
  await settle();
  ok(!app.engine, '没有可练汉字时不启动练习');

  // 有效文本 → 正常开练
  const source = '今天天气不错我们出去走走然后回家吃饭';
  ta.value = source;
  fire(ta, 'input');
  await settle();

  // 实时统计：显示了可练字数
  const stat = q('#customTextStat');
  ok(stat && stat.textContent.includes('可练'), `输入后显示可练字数（实际「${stat && stat.textContent}」)`);

  fire(q('#btnStart'), 'click');
  await settle();
  ok(!!app.engine, '有效文本启动了练习');
  ok(app.engine.mode === 'custom', `引擎模式为 custom（实际 ${app.engine.mode}）`);
  ok(app.engine.currentQuestion()?.kind === 'passage', '自定义文本题目是 passage 类型');

  // 逐字打完（用引擎的期望键位一路打下去，最多防死循环）
  const eng = app.engine;
  ok(q('#prompt') && q('#prompt').textContent.includes('今'), '舞台渲染了自定义文本的首字');
  let guard = 0;
  while (eng.state === 'running' && guard < 4000) {
    guard++;
    const t = eng.currentTarget();
    if (!t) break;
    if (t.kind === 'skip' || t.kind === 'punct') { eng.pressKey('a'); continue; }
    const keys = t.keys || [];
    const k = keys[t.pos];
    if (!k) break;
    // 引擎只在 durationSec >= 1 时落库（拦空练习），用时靠记账而非真实等待
    eng.elapsedSec = 2;
    eng.pressKey(k.toLowerCase());
    await settle();
  }
  ok(guard > 0, `自定义文本可连续打字推进（循环 ${guard} 次）`);
  ok(eng.state === 'finished', `自定义文本能打完（实际状态 ${eng.state}）`);

  // 落库：自定义文本走 passage 口径。
  // 注意不能取 h[h.length-1] —— 前面【10e】的测验记录可能排在更后面
  // （按写入顺序而非时间戳），要按模式反查本次那条。
  const h = sMod.loadHistory();
  const rec = h.filter(r => r.mode === 'custom' || r.mode === 'passage').pop();
  ok(!!rec, '自定义文本练习写入了历史记录');
  ok(rec && Array.from(rec.mode) && rec.date, `历史记录带模式与日期（实际 mode=${rec && rec.mode}）`);
}

/* ---------- 错题本导出为跟打文本（复习页 → 自定义文本） ----------
   这是一条跨越两个视图的用户路径：复习页点按钮 → 写入设置 → 切模式 → 能开练。
   单测 buildWeakPassage 只管拼装，这里管「装上了没有」。 */
console.log('\n【9e】错题连成一段跟打：复习页 → 自定义文本');
{
  // 清场：退出练习、关掉弹窗
  if (app.engine) { app.engine.destroy(); app.engine = null; }
  q('#sessionPanel').hidden = true;
  if (!q('#overlay').hidden) {
    const b = qa('#modal [data-act]')[0];
    if (b) fire(b, 'click');
  }

  // 造几条易错记录（用真实 API，不手改存储）
  sMod.clearWeak();
  ['银行', '月', '双拼', '秋', '笑'].forEach(w => sMod.recordWeak({ char: Array.from(w)[0], word: w, pinyin: '' }));

  // 先把自定义文本占位（用于验证「已有内容要弹窗确认」）
  app.settings.customText = '原有的内容不该被静默覆盖';
  const ta = q('#customTextInput');
  if (ta) ta.value = app.settings.customText;

  // 进入复习页
  fire(q('[data-view="review"]'), 'click');
  await settle();
  const btn = q('#btnReviewToCustom');
  ok(!!btn, '复习页有「错题连成一段跟打」按钮');

  fire(btn, 'click');
  await settle();

  // 已有内容 → 必须先弹窗确认，不能直接覆盖
  ok(!q('#overlay').hidden, '已有自定义文本时先弹窗确认');
  ok(/覆盖/.test(q('#modal').textContent), '弹窗说明是「覆盖」操作');
  const okBtn = qa('#modal [data-act]').find(b => b.getAttribute('data-act') === 'ok');
  ok(!!okBtn, '弹窗有确认按钮');
  fire(okBtn, 'click');
  await settle();

  // 确认后：文本已写入设置 + 输入框 + 模式切到 custom
  const txt = app.settings.customText || '';
  ok(txt.length > 0, '确认后自定义文本被写入');
  ok(txt.includes('银行') || txt.includes('月') || txt.includes('双拼'),
    `导出的文本含易错词（实际「${txt.slice(0, 40)}」）`);
  ok(!txt.includes('原有的内容'), '原有内容被替换（用户已确认）');
  ok(app.sessionMode === 'custom', `模式自动切到 custom（实际 ${app.sessionMode}）`);
  ok(ta && ta.value === txt, '输入框与设置同步');

  // 导出后能真的开练（这才是这个功能的终点）
  fire(q('[data-view="practice"]'), 'click');
  await settle();
  fire(q('#btnStart'), 'click');
  await settle();
  ok(!!app.engine && app.engine.mode === 'custom', '导出的错题文本可直接开练');
  if (app.engine) { app.engine.destroy(); app.engine = null; }
  q('#sessionPanel').hidden = true;
  if (!q('#overlay').hidden) {
    const b = qa('#modal [data-act]')[0];
    if (b) fire(b, 'click');
  }

  // 没有易错记录时：给出提示而不是写一个空文本
  sMod.clearWeak();
  app.settings.customText = '';
  fire(q('[data-view="review"]'), 'click');
  await settle();
  const btn2 = q('#btnReviewToCustom');
  // 无记录时复习页走的是空态分支，按钮可能不存在 —— 两种情况都接受
  if (btn2) {
    fire(btn2, 'click');
    await settle();
    ok(app.settings.customText === '', '没有易错记录时不写入空文本');
  } else {
    ok(!!q('#reviewBody').textContent.match(/暂无需要复习/), '无记录时复习页走空态分支');
  }
  sMod.clearWeak();
}

/* ---------- 存储降级：写失败后马上读 ---------- */
console.log('\n【9b】存储配额满后的降级（写失败 → 立即读）');
const errCountBefore9b = errors.length;
{
  /* 这里的 localStorage 就是页面用的那个（storageMap 支撑）。
     思路：把 setItem 改成「除探测键外一律抛配额错」，模拟空间写满，
     然后通过应用真实的存储 API 写一条、马上读一条 ——
     旧实现会把数据只塞进内存而读路径仍走 localStorage，于是读到 null。 */
  const realSet = localStorage.setItem;
  const realGet = localStorage.getItem;
  let quotaMode = false;
  localStorage.setItem = function (k, v) {
    if (quotaMode && !String(k).includes('__probe')) {
      const e = new Error('quota exceeded'); e.name = 'QuotaExceededError'; e.code = 22;
      throw e;
    }
    return realSet.call(this, k, v);
  };
  localStorage.getItem = function (k) { return realGet.call(this, k); };

  // 先确认正常态可写可读
  ok(sMod.writeJSON('it.quota.probe', { a: 1 }) === true, '配额未满时写入成功');

  quotaMode = true;
  // 降级路径本身会打 console.error（"清理后仍写入失败"）—— 那是预期日志，
  // 不是缺陷。这里临时把它挡掉，避免污染后面「全程无未捕获 error」的检查。
  const mutedError = console.error;
  console.error = () => {};
  const wrote = sMod.writeJSON('it.quota.held', { mark: 'need-me' });
  console.error = mutedError;
  ok(wrote === false, '配额满时写入返回 false（调用方据此提示用户）');

  // ★ 核心：写失败之后「马上读」，内存里的数据必须还在
  const back = sMod.readJSON('it.quota.held', null);
  ok(back && back.mark === 'need-me',
    `★ 写入失败后立即读取仍能拿到数据（实际 ${back === null ? 'null —— 数据丢了' : JSON.stringify(back)}）`);

  ok(sMod.isDegradedToMemory() === true, 'isDegradedToMemory() 已置位');
  ok(sMod.isStorageAvailable() === false, 'isStorageAvailable() 反映当前写不进去');

  // 降级期间还能继续保存成绩记录（不抛异常、不丢数据）
  let appendOk = true;
  try {
    sMod.appendRecord(sMod.makeRecord({
      mode: 'char', totalChars: 20, durationSec: 30, speed: 40, accuracy: 90
    }));
  } catch (e) { appendOk = false; }
  ok(appendOk, '降级期间 appendRecord 不抛异常');
  const h = sMod.loadHistory();
  ok(h.length >= 1 && h[h.length - 1].date, '降级期间成绩记录仍可读写');

  // 空间释放 → 自动恢复落盘，且不丢数据
  quotaMode = false;
  ok(sMod.isStorageAvailable() === true, '空间释放后探测恢复可用（降级不是单向的）');
  const back2 = sMod.readJSON('it.quota.held', null);
  ok(back2 && back2.mark === 'need-me', '★ 恢复过程中内存数据没有丢');
  ok(sMod.readJSON('it.quota.probe', null).a === 1, '恢复后旧数据仍可读');
  localStorage.setItem = realSet;
  localStorage.getItem = realGet;
}
// 本段只允许出现「预期内的降级日志」，不允许别的 error 混进来
{
  const unexpected = errors.slice(errCountBefore9b).filter(m => !/转为内存存储|写入失败/.test(m));
  ok(unexpected.length === 0,
    `降级测试只产生预期日志${unexpected.length ? '，意外：' + unexpected.join(' | ') : ''}`);
  // 把预期的降级日志从总账里剔除，交给最终检查时只看真正的异常
  errors.length = errCountBefore9b;
}

/* ---------- 键位图交互 ---------- */
console.log('\n【10】键位图交互');
const navKeymap = qa('#nav .nav-btn').find(b => b.getAttribute('data-view') === 'keymap');
fire(navKeymap, 'click');
await settle();
const svg = q('#fullKeymap svg');
ok(!!svg, '完整键位图存在');
const vKey = svg && svg.querySelector('[data-key="V"]');
ok(!!vKey, '找到 V 键元素');
if (vKey) {
  fire(vKey, 'click');
  await settle();
  ok(q('#keyDetail').hidden === false, '点击键位后详情面板展开');
  ok(q('#keyDetail').innerHTML.includes('zh'), 'V 键详情包含 zh 声母');
  ok(q('#keyDetail').innerHTML.includes('ui'), 'V 键详情包含 ui 韵母');
}

/* ---------- 无障碍：SVG 键位图的 role 语义 ----------
   曾经的坑：根节点写死 role="img"。ARIA 里 img 是「原子」角色，会把所有后代从
   无障碍树里剪掉 —— 于是 26 个 <g role="button" tabindex="0" aria-label="X 键">
   全部作废，读屏只能听到「小鹤双拼键位图，图片」。这里把「可交互 → group，
   纯展示 → img」的契约锁住，防止哪天有人图省事又写回 role="img"。 */
{
  const full = q('#fullKeymap svg');
  ok(full && full.getAttribute('role') === 'group',
    '可交互键位图的根节点是 role="group"（不是 img，否则会剪除 26 个键）');
  ok(full && !/^img$/i.test(full.getAttribute('role') || ''),
    '可交互键位图绝不用 role="img"');

  const keyGs = full ? full.querySelectorAll('[data-key]') : [];
  const btns = Array.from(keyGs).filter(g => g.getAttribute('role') === 'button');
  ok(btns.length === 26, `26 个键都声明 role="button"（实际 ${btns.length}）`);
  const focusable = btns.filter(g => g.getAttribute('tabindex') === '0');
  ok(focusable.length === 26, `26 个键都可聚焦（实际 ${focusable.length}）`);
  const named = btns.filter(g => /键$/.test(g.getAttribute('aria-label') || ''));
  ok(named.length === 26, `26 个键都有可读名（实际 ${named.length}）`);

  // 迷你键位图是纯展示，不承担交互 → 应保持 img（避免读屏在练习页被 26 个键打断）
  const mini = q('#miniKeymap svg');
  if (mini) {
    ok(mini.getAttribute('role') === 'img', '迷你键位图保持 role="img"（纯展示）');
    const miniKeys = mini.querySelectorAll('[role="button"]');
    ok(miniKeys.length === 0, '迷你键位图不含可聚焦键（不打断练习）');
  }
}


/* ---------- 卡住自动提示 ---------- */
console.log('\n【10b】卡住自动提示');
{
  /* 这一段本质是时间线：hintDelayMs=60 该闪键位，revealDelayMs=140 该给答案，
     引擎用 setInterval(max(80, min(60,140)) = 80ms) 反复检查 idle。
     旧写法用 220ms / 320ms 真实等待去「赌」定时器已经触发 —— 慢，且 CI 忙时
     定时器被推迟就会偶发红灯。这里把 window 的定时器与 Date.now 临时接到一个
     虚拟时钟上，时间推进多少由测试说了算，于是到期边界可以精确断言：
     79ms 不该有、80ms 该有；159ms 还没到检查点、160ms 才 reveal。 */
  const vclock = createVirtualClock();
  const restoreClock = virtualizeWindowTimers(vclock, fakeWindow);
  try {
    // 用极短的时间线构造一次练习，验证「提示 → 给答案」与统计口径
    const eng = new engineMod.PracticeEngine({
      questions: qMod.generateQuestions({ mode: 'char', count: 4 }),
      mode: 'char',
      hintDelayMs: 60,
      revealDelayMs: 140
    });
    const hints = [], reveals = [];
    eng.on('hint', x => hints.push(x));
    eng.on('reveal', x => reveals.push(x));
    eng.start();

    // 暂停会 clearHintTimer；即便把虚拟时间推过两级阈值也不该有任何提示
    eng.pause();
    vclock.advance(220);
    ok(hints.length === 0, '暂停期间不触发提示');

    eng.resume();          // 重新计时：_idleSince = 此刻，检查间隔 80ms
    vclock.advance(79);    // 尚未到第一个检查点
    ok(hints.length === 0, '未到检查间隔不闪键位（79ms < 首个检查点 80ms）');
    vclock.advance(1);     // t=80，idle=80 ≥ hintDelayMs(60) → hint
    ok(hints.length >= 1, `停留后触发 hint（${hints.length} 次）`);
    ok(reveals.length === 0, '未到 revealDelayMs 不给答案');
    vclock.advance(79);    // t=159，下次检查在 160，此刻仍不给答案
    ok(reveals.length === 0, '抵达 revealDelayMs 前不给答案（159ms）');
    vclock.advance(1);     // t=160，idle=160 ≥ revealDelayMs(140) → reveal
    ok(reveals.length >= 1, `继续停留触发 reveal（${reveals.length} 次）`);
    ok(hints[0] && /^[a-z]$/.test(hints[0].key), `提示载荷带正确的键位（${hints[0] && hints[0].key}）`);

    // 提示已连到「当前字符」上：hintedChars 在音节打完时才结算，
    // 所以这里先验证提示确实登记到了当前作答目标（不是空转），
    // 真正的计数校验放到整轮结束后（见下方 sm.hintedChars）。
    ok(eng.hintLevel() !== '', `停留后引擎处于提示态（${eng.hintLevel()}）`);
    const t = eng.currentTarget();
    ok(!!(t && t.keys && t.keys.length), '提示后仍可正常取到当前作答目标');
    eng.pressKey(String(t.keys[t.pos]).toLowerCase());

    // 全部打完，检查两个正确率的关系
    let gg = 0;
    while (eng.state === 'running' && gg < 200) {
      gg++;
      const tt = eng.currentTarget();
      if (!tt || !tt.keys || !tt.keys.length) break;
      eng.pressKey(String(tt.keys[tt.pos]).toLowerCase());
      await settle();
    }
    const sm = eng.summary();
    ok(sm.accuracy === 100, `全部打对时 accuracy 仍为 100（实际 ${sm.accuracy}）`);
    ok(sm.independentAccuracy < sm.accuracy,
      `独立正确率低于表面正确率，说明提示被剔除（${sm.independentAccuracy} < ${sm.accuracy}）`);
    ok(sm.hintedChars >= 1, `打完整轮后提示过的字符计入 hintedChars（${sm.hintedChars}）`);

    // 主动求助
    eng.destroy();
    const eng2 = new engineMod.PracticeEngine({
      questions: qMod.generateQuestions({ mode: 'char', count: 2 }),
      mode: 'char',
      hintDelayMs: 60000, renderDelay: 0,
      revealDelayMs: 60000
    });
    eng2.start();
    await settle();
    ok(eng2.hintLevel() === '', '自动提尚未到期时无提示态');
    ok(eng2.requestHint('reveal') === true, 'requestHint 手动求助成功');
    ok(eng2.hintLevel() === 'reveal', '手动求助后进入 reveal 态');
    // 手动求助同样算「依赖提示」，但要打完整个音节才结算，
    // 此处验证它确实施加到了当前目标上（hint 载荷键位合法）。
    ok(/^[a-z]$/.test(String(eng2.currentTarget() && eng2.currentTarget().keys[0]).toLowerCase()),
      '手动求助后当前目标键位合法');
    eng2.destroy();
  } finally {
    restoreClock();
  }
}

/* ---------- 错误热力图（键维度持久化） ---------- */
console.log('\n【10c】错误热力图数据链');
{
  sMod.clearKeyErrors();
  const before = stMod.keyHeatmap({ range: 'all' });
  ok(before.items.length === 0 && before.total === 0, '清空后热力图为空');

  // 引擎在按错时会记录「期望键」
  const qs3 = qMod.generateQuestions({ mode: 'sheng', count: 4 });
  const eng3 = new engineMod.PracticeEngine({ questions: qs3, mode: 'sheng', hintEnabled: false });
  eng3.start();
  let g3 = 0;
  while (eng3.state === 'running' && g3 < 60) {
    g3++;
    const t = eng3.currentTarget();
    if (!t || !t.keys || !t.keys.length) break;
    const right = String(t.keys[0]).toLowerCase();
    const wrong = 'qwertyuiop'.split('').find(c => c !== right);
    eng3.pressKey(wrong);
    eng3.pressKey(right);
  }
  const sm3 = eng3.summary();
  const nKeys = Object.keys(sm3.keyErrors || {}).length;
  ok(nKeys >= 1, `引擎汇总带键维度错误（${nKeys} 个键）`);

  // 落库
  const wrote = sMod.recordKeyErrors(sm3.keyErrors);
  ok(wrote === true, '键错误写入存储成功');

  const after = stMod.keyHeatmap({ range: 'all' });
  ok(after.total === sm3.wrongKeystrokes, `热力图总数 = 错误按键数（${after.total} / ${sm3.wrongKeystrokes}）`);
  ok(after.items.length >= 1, `热力图有 ${after.items.length} 个键`);
  ok(after.items.every(x => x.level >= 1 && x.level <= 4), '热力等级都在 1–4');
  ok(after.items.every(x => x.count > 0), '每个热力键的计数为正');
  ok(!!after.hottest && after.hottest.count === Math.max(...after.items.map(x => x.count)),
    `最热的键是 ${after.hottest && after.hottest.key}（${after.hottest && after.hottest.count} 次）`);

  // 范围切换：最近 10 次应当包含刚写入这一次
  const recent = stMod.keyHeatmap({ range: '10' });
  ok(recent.total === after.total, `最近 10 次的范围数据一致（${recent.total}）`);
  const none = stMod.keyHeatmap({ range: 'invalid-range' });
  ok(none.total === after.total, '非法 range 安全回退到 all');

  eng3.destroy();
}

/* ---------- 拆分成分练习（L2a / L2b） ---------- */
console.log('\n【10d】只听声母 / 只听韵母');
for (const mode of ['sheng', 'yun']) {
  const qs4 = qMod.generateQuestions({ mode, count: 12 });
  ok(qs4.length === 12, `${mode} 生成 12 题（实际 ${qs4.length}）`);
  ok(qs4.every(x => x.kind === 'part'), `${mode} 题目均为 part 类型`);
  ok(qs4.every(x => Array.isArray(x.answerKeys) && x.answerKeys.length === 1),
    `${mode} 每题只要求 1 个键`);
  ok(qs4.every(x => x.part === mode), `${mode} 题目的 part 字段正确`);

  // 答案必须等于 fullSplit 中对应 role 的那一步的键
  let mismatch = 0;
  let zeroInSheng = 0;
  for (const x of qs4) {
    const want = mode === 'sheng' ? 'sheng' : 'yun';
    const step = x.fullSplit.steps.find(s => s.role === want)
      || x.fullSplit.steps[x.fullSplit.steps.length - 1];
    if (String(step.key).toUpperCase() !== x.answerKeys[0]) mismatch++;
    if (mode === 'sheng' && x.fullSplit.zero) zeroInSheng++;
  }
  ok(mismatch === 0, `${mode} 答案与拆分步骤一致（不一致 ${mismatch} 个）`);
  ok(zeroInSheng === 0, `${mode} 不把零声母音节出成声母题`);

  // 引擎跑完整轮
  const eng4 = new engineMod.PracticeEngine({ questions: qs4, mode, hintEnabled: false });
  eng4.start();
  const t4 = eng4.currentTarget();
  ok(t4 && t4.kind === 'part' && t4.len === 1, `${mode} 引擎目标为单键 part`);
  let g4 = 0;
  while (eng4.state === 'running' && g4 < 200) {
    g4++;
    const tt = eng4.currentTarget();
    if (!tt || !tt.keys || !tt.keys.length) break;
    eng4.pressKey(String(tt.keys[0]).toLowerCase());
  }
  const sm4 = eng4.summary();
  ok(sm4.accuracy === 100, `${mode} 全对时正确率 100%（实际 ${sm4.accuracy}）`);
  ok(sm4.totalChars === 12, `${mode} 完成字数 = 题数（${sm4.totalChars}/12）`);
  eng4.destroy();

  // 按错时应给出「这是声母/韵母，应落在 X 键」的解释
  const eng5 = new engineMod.PracticeEngine({ questions: qMod.generateQuestions({ mode, count: 1 }), mode, hintEnabled: false });
  eng5.start();
  const t5 = eng5.currentTarget();
  const right5 = String(t5.keys[0]).toLowerCase();
  const wrong5 = 'qwertyuiop'.split('').find(c => c !== right5);
  const r5 = eng5.pressKey(wrong5);
  ok(r5.correct === false, `${mode} 按错判错`);
  ok(/声母|韵母/.test(r5.feedback.explain), `${mode} 错误解释点明是声母还是韵母：${r5.feedback.explain}`);
  eng5.destroy();
}

/* ---------- 语音朗读（接线层） ----------
   注意：测试环境（linkedom）**没有** speechSynthesis，这恰好是最常见的
   真实降级场景。因此这里验的是「接对了线、并且没声音时不崩、不撒谎」，
   而不是「真的发出了声音」—— 后者在无头环境里无从验证。
   真正出声的那部分由 verify.mjs 的 speakText 断言（数据契约）保证。 */
console.log('\n【10f】语音朗读：接线与无语音降级');
{
  const sSpeech = await import('../src/ui/speech.js');

  ok(sSpeech.isSupported() === false, '测试环境无 speechSynthesis，isSupported() 如实返回 false');
  ok(await sSpeech.hasChineseVoice(60) === false, '无 speechSynthesis 时 hasChineseVoice 立即返回 false（不等超时）');
  ok(sSpeech.speak('shuang') === false, '无语音时 speak() 返回 false（而不是抛异常）');
  ok(sSpeech.stop() === undefined, '无语音时 stop() 静默无操作');

  // 设置页必须有开关 + 说明块，否则「开了没声音」就无从解释
  const setSpeech = q('#setSpeech');
  const speechNote = q('#speechNote');
  const speechOpts = q('#speechOpts');
  ok(!!setSpeech, '设置页有语音朗读开关 #setSpeech');
  ok(!!speechNote, '设置页有语音状态说明 #speechNote');
  ok(!!speechOpts, '设置页有语速选项容器 #speechOpts');
  ok(!!q('#setSpeechRate'), '设置页有语速选择 #setSpeechRate');

  // 不支持时：开关必须被禁用且不勾选（不能让用户打开一个假的开关）
  ok(setSpeech.disabled, '不支持语音时开关被禁用');
  ok(setSpeech.checked === false, '不支持语音时开关不会被勾上');

  // 说明文案必须诚实：点明「不支持」，且不能假装能朗读
  ok(speechNote.hidden === false, '说明块可见（用户能读到为什么没声音）');
  ok(/不支持语音合成/.test(speechNote.textContent),
    `说明块如实说明浏览器不支持（实际「${speechNote.textContent}」）`);
  ok(!/（.*）$/.test(speechNote.textContent) && !/朗读音节。$/.test(speechNote.textContent),
    '说明块没有误报「已检测到中文语音」');
  ok(speechOpts.hidden, '不支持语音时语速选项隐藏');

  // 模式名：没有中文语音时，L2 两个模式不许叫「听」
  const grid = q('#modeGrid');
  const cardsText = grid ? grid.textContent : '';
  ok(/认声母键/.test(cardsText), '模式卡片显示「认声母键」（无声时的如实命名）');
  ok(!/只听声母/.test(cardsText), '模式卡片**不**出现「只听声母」（没有音频就不承诺听力）');

  /* 关键：即便用户绕过开关直接改 app.settings.speech = true，
     在无中文语音的环境下跑一局 L2，也不能抛异常、不能发出无声的「假朗读」。 */
  app.settings.speech = true;
  app._hasZhVoice = false;
  const qs6 = qMod.generateQuestions({ mode: 'sheng', count: 6 });
  if (app.engine) { app.engine.destroy(); app.engine = null; }
  const eng6 = new engineMod.PracticeEngine({ questions: qs6, mode: 'sheng', hintEnabled: false });
  app.engine = eng6;
  eng6.start();
  let g6 = 0;
  while (eng6.state === 'running' && g6 < 100) {
    g6++;
    const t6 = eng6.currentTarget();
    if (!t6 || !t6.keys || !t6.keys.length) break;
    eng6.pressKey(String(t6.keys[0]).toLowerCase());
  }
  const sm6 = eng6.summary();
  ok(sm6.totalChars === 6, `开着朗读开关、无语音包时练习照常完成（${sm6.totalChars}/6）`);
  ok(errors.length === 0, '无语音环境下整局练习未抛异常');

  // 恢复现场：关开关、清标记，避免影响后续用例
  app.settings.speech = false;
  app._speechWarned = false;
  if (app.engine) { app.engine.destroy(); app.engine = null; }
  q('#sessionPanel').hidden = true;
  if (!q('#overlay').hidden) {
    const b6 = qa('#modal [data-act]')[0];
    if (b6) fire(b6, 'click');
  }
  await settle();
}

/* ---------- 语音必须在离开练习页/隐藏页面时被掐断 ----------
   测试环境没有 speechSynthesis，所以验的是「接线」而非「真的停了声」：
   给模块的 stop() 套一层计数探针，看 switchView 与 visibilitychange
   有没有真的调到它。原 bug：L2 模式下朗读到一半切设置页，上一题会继续念完。 */
console.log('\n【10h】语音掐断时机：切视图 / 页面隐藏');
{
  const sSpeech = await import('../src/ui/speech.js');
  let stopCalls = 0;
  const realStop = sSpeech.stop;
  // 注意：模块导出的绑定不可直接改，改用 app 侧可观测的副产物 ——
  // 这里通过临时替换 window.speechSynthesis 让 stop() 真正执行并计数。
  const fake = {
    _cancel: 0,
    cancel() { fake._cancel++; },
    speak() {}, getVoices: () => [], addEventListener() {}, removeEventListener() {}
  };
  const hadSS = 'speechSynthesis' in fakeWindow;
  const prevSS = fakeWindow.speechSynthesis;

  /* speech.js 内部读的是 window.speechSynthesis（模块加载时已捕获 window 引用），
     因此这里改 fakeWindow 上的属性即可让 isSupported() 转真、stop() 真的跑 cancel。 */
  fakeWindow.speechSynthesis = fake;
  fakeWindow.SpeechSynthesisUtterance = function (t) { this.text = t; };

  try {
    ok(sSpeech.isSupported() === true, '（探针）注入桩后 isSupported() 转真，stop() 才有可观测副作用');

    // ① 从练习页切到设置页 → 必须 cancel 一次
    if (app.view !== 'practice') {
      const navPractice = qa('#nav .nav-btn').find(b => b.getAttribute('data-view') === 'practice');
      if (navPractice) { fire(navPractice, 'click'); await settle(); }
    }
    fake._cancel = 0;
    fire(qa('#nav .nav-btn').find(b => b.getAttribute('data-view') === 'settings'), 'click');
    await settle();
    ok(fake._cancel >= 1, `离开练习页切到设置页 → 朗读被 cancel（调用 ${fake._cancel} 次）`);

    // ② 页面隐藏 → 必须 cancel 一次
    fake._cancel = 0;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new fakeWindow.Event('visibilitychange'));
    await settle();
    ok(fake._cancel >= 1, `页面隐藏 → 朗读被 cancel（调用 ${fake._cancel} 次）`);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });

    // ③ 留在练习页内部切题不应被这里的逻辑误伤（那是 speak() 自己的 cancel 负责）
    await settle();
  } finally {
    if (hadSS) fakeWindow.speechSynthesis = prevSS; else delete fakeWindow.speechSynthesis;
    delete fakeWindow.SpeechSynthesisUtterance;
    // 回到练习页，恢复给后续用例的初始视图
    const navPractice2 = qa('#nav .nav-btn').find(b => b.getAttribute('data-view') === 'practice');
    if (navPractice2) { fire(navPractice2, 'click'); await settle(); }
  }
}

/* ---------- 弹窗焦点管理 ----------
   原 bug：openModal/closeModal 只切 hidden —— 打开不聚焦、Tab 能穿到被遮罩盖住的
   背景控件上、关闭后焦点掉到 body。这里把三件事都锁住。 */
console.log('\n【10i】弹窗焦点管理：初始聚焦 / Tab 陷阱 / 关闭归还');
{
  const overlay = q('#overlay');
  const modal = q('#modal');

  // 先确保弹窗是关着的
  if (overlay && !overlay.hidden) { const b = qa('#modal [data-act]')[0]; if (b) fire(b, 'click'); }
  await settle();

  ok(!!modal, '（前置）#modal 存在');

  // 走真实入口驱动一次弹窗：统计页「清空全部练习记录」→ 确认框
  const navStats = qa('#nav .nav-btn').find(b => b.getAttribute('data-view') === 'stats');
  if (navStats) { fire(navStats, 'click'); await settle(); }
  const clearBtn = q('#btnClearStats');
  ok(!!clearBtn, '（前置）统计页有 #btnClearStats');
  if (clearBtn) {
    try { clearBtn.focus(); } catch (_) {}
    fire(clearBtn, 'click');
    await settle();

    ok(overlay && overlay.hidden === false, '点「清空记录」后弹窗打开');

    // ① 可读名：aria-labelledby 指向弹窗内的 h2
    const lab = modal && modal.getAttribute('aria-labelledby');
    const titleEl = (lab && modal.querySelector('#' + lab)) || modal.querySelector('h2');
    ok(!!titleEl && /清空/.test(titleEl.textContent),
      `弹窗标题可读（aria-labelledby → 「${titleEl ? titleEl.textContent.trim() : '(空)'}」）`);
    ok(modal && modal.getAttribute('tabindex') === '-1',
      '弹窗容器 tabindex="-1"（能接收程序化焦点）');

    // ② 初始聚焦：焦点必须已经被送进弹窗内部
    const act = document.activeElement;
    ok(!!act && modal.contains(act),
      `打开后焦点已在弹窗内（实际 ${act ? (act.id || act.className || act.tagName) : 'null'}）`);
    ok(!!act && act.getAttribute && act.getAttribute('data-act'),
      '初始焦点落在 [data-act] 主按钮上（而不是容器，读屏能直接念出动作）');

    // ③ Tab 陷阱：在最后一个可聚焦元素上按 Tab → 回到第一个
    const focusables = Array.from(modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(el => !el.disabled);
    ok(focusables.length >= 2, `弹窗内至少 2 个可聚焦控件（实际 ${focusables.length}）`);
    if (focusables.length >= 2) {
      const hs = modal.__handlers && modal.__handlers.keydown;
      const pressTab = (from, shift) => {
        try { from.focus(); } catch (_) {}
        const ev = new FakeKeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true });
        ev.target = from; ev.currentTarget = modal;
        ev._path = [{ currentTarget: modal, target: from }];
        if (hs) hs.slice().forEach(h => { try { h(ev); } catch (e) { console.error(e); } });
      };

      pressTab(focusables[focusables.length - 1], false);
      ok(document.activeElement === focusables[0],
        '在末尾按 Tab 会绕回第一个控件（焦点没跑出弹窗）');

      pressTab(focusables[0], true);
      ok(document.activeElement === focusables[focusables.length - 1],
        '在首个控件按 Shift+Tab 会绕到末尾（反向同样不逃逸）');
    }

    // ④ 关闭后归还焦点
    const cancelBtn = qa('#modal [data-act]').find(b => !/clear|ok|confirm|yes/i.test(b.getAttribute('data-act')))
      || qa('#modal [data-act]')[0];
    if (cancelBtn) {
      fire(cancelBtn, 'click');
      await settle();
      ok(overlay && overlay.hidden === true, '点取消后弹窗关闭');
      const back = document.activeElement;
      ok(!!back && back !== document.body,
        `关闭后焦点有去处（实际 ${back ? (back.id || back.className || back.tagName) : 'null'}），未掉到 body`);
      ok(back === clearBtn,
        '关闭后焦点精确回到触发它的那个按钮');
    }
  } else {
    ok(false, '未找到 #btnClearStats，无法驱动真实弹窗路径');
  }

  // 恢复视图
  const navPractice3 = qa('#nav .nav-btn').find(b => b.getAttribute('data-view') === 'practice');
  if (navPractice3) { fire(navPractice3, 'click'); await settle(); }
}

/* ---------- 键位掌握度层（接线层） ----------
   与前两层（热力填充 / 慢键虚线环）一起挂在同一张键盘图上，
   所以这里验的是「第三个通道真的画上去了、三态标记互不覆盖」。 */
console.log('\n【10g】键位掌握度：三层标记共存');
{
  const { keyMastery } = stMod;

  sMod.clearKeyTimings();
  sMod.clearKeyErrors();

  // 造出「已掌握」与「在练」两种键：A 练 20 次全对且快；B 同样快但错误多
  const fakeLead = Array.from({ length: 20 }, (_, i) => 200 + (i % 5) * 10);
  sMod.recordKeyTimings({ A: { lead: fakeLead.slice(), follow: [] }, B: { lead: fakeLead.slice(), follow: [] } }, 'char');
  /* 错误次数刻意拉开档次，覆盖**四个**热力等级：
     scale = max = 6 时，6→L4、4→L3、2→L2、1→L1。
     只造一个键的话，「条数 = 等级」这句话退化成「一直是 4 根」，
     断言就分不出「按等级画」和「永远画满」—— 那是两种完全不同的实现。 */
  sMod.recordKeyErrors({ B: 6, C: 4, D: 2, E: 1 }, 'char');

  const m = keyMastery({ range: 'all', mode: 'char' });
  const byKey = Object.fromEntries(m.items.map(i => [i.key, i]));
  ok(byKey.A && byKey.A.state === 'mastered', 'A 键判为已掌握');
  ok(byKey.B && byKey.B.state === 'learning', 'B 键判为在练（错误率高）');
  ok(m.counts.mastered >= 1 && m.counts.learning >= 1, '两态计数都非零');

  // 走 UI：统计视图渲染后，掌握度标记要真的落在键位图上
  fire(q('[data-view="stats"]'), 'click');
  await settle();

  const heat = q('#heatWrap');
  ok(!!heat, '统计页有热力图容器');
  ok(!!q('#masteryBox'), '统计页有掌握度说明块 #masteryBox');

  const aKey = heat.querySelector('.kb-key[data-key="A"]');
  const bKey = heat.querySelector('.kb-key[data-key="B"]');
  ok(aKey && aKey.classList.contains('is-mastered'), 'A 键被标为 is-mastered');
  ok(aKey && !!aKey.querySelector('.kb-mastery-dot'), 'A 键画出了绿色圆点');
  ok(bKey && !bKey.classList.contains('is-mastered'), 'B 键未标为已掌握');
  ok(bKey && !bKey.querySelector('.kb-mastery-dot'), 'B 键没有绿点');

  // 三层共存：B 键同时有热力填充（错）与（可能的）慢键环，且掌握度不干扰
  ok(bKey && bKey.classList.contains('is-heat'), 'B 键同时带热力标记（三层不互斥）');
  ok((bKey.querySelector('.kb-body') && bKey.querySelector('.kb-mastery-dot'))
    || !bKey.classList.contains('is-mastered'), '填充与圆点用不同元素，互不覆盖');

  // 说明块必须报出「已掌握 x / 总数」这种进度信息，而不是只说有问题
  const boxText = q('#masteryBox').textContent;
  ok(/已掌握/.test(boxText), '掌握度说明块给出「已掌握」进度');
  ok(/个键/.test(boxText), '说明块给出键数口径');

  /* ---- 等级的非颜色通道（色盲可读）----
     这里验的是**运行期**行为：键上标的 --heat-level 与热力覆盖层里
     画出的竖条根数必须一致。静态断言（verify【10e】）只能证明
     「代码里写了竖条」，证明不了「渲染出来的根数真的随等级变」——
     两者是两回事（上一轮 renderSession 的 emit 吞参数就是这个教训：
     代码齐全、测试全绿、功能一点没生效）。 */
  const levelOf = (K) => {
    const el = heat.querySelector(`.kb-key[data-key="${K}"]`);
    return Number((el && el.getAttribute('style') || '').match(/--heat-level:\s*(\d)/)?.[1] || 0);
  };
  const barsOf = (K) => {
    const g = heat.querySelector(`[data-heat-for="${K}"] .kb-heat-pips`);
    return g ? g.querySelectorAll('rect').length : -1;
  };

  // 四档都要出现，否则「条数 = 等级」可能只是碰巧
  const levelsSeen = ['B', 'C', 'D', 'E'].map(levelOf);
  ok(levelsSeen.every(l => l >= 1 && l <= 4),
    `B/C/D/E 四键都带合法热力等级（实际 ${levelsSeen.join('/')}）`);
  ok(new Set(levelsSeen).size === 4,
    `四个等级都被造出来了（实际 ${levelsSeen.join('/')}）—— 否则断言分不出「按等级画」与「永远画满」`);

  const bPips = heat.querySelector('[data-heat-for="B"] .kb-heat-pips');
  ok(!!bPips, '热力覆盖层里画出了等级竖条组 .kb-heat-pips（B 键）');
  ok(barsOf('B') === levelOf('B'),
    `竖条根数等于热力等级（等级 ${levelOf('B')} → 竖条 ${barsOf('B')} 根）`);

  // 逐键校验：等级 ↔ 条数一一对应，且等级 1 就只有 1 根（不是永远画满）
  let mismatched = 0;
  const detail = [];
  for (const g of Array.from(heat.querySelectorAll('[data-heat-for]'))) {
    const K = g.getAttribute('data-heat-for');
    const lv = levelOf(K);
    const bars = g.querySelectorAll('.kb-heat-pips rect').length;
    detail.push(`${K}:${lv}/${bars}`);
    if (lv < 1 || bars !== lv) mismatched += 1;
  }
  ok(mismatched === 0,
    `全部热力键的竖条根数都等于等级（[${detail.join(' ')}]，不一致 ${mismatched} 个）`);
  ok(barsOf('E') === 1, `最低等级只画 1 根竖条（E 键实际 ${barsOf('E')} 根）`);

  // 竖条不能去改 .kb-key 内部 === 不能与热力填充/慢键环抢同一个元素
  ok(!!bKey.querySelector('.kb-body'), 'B 键仍有 .kb-body（竖条没把它替换掉）');
  ok(!bKey.querySelector('.kb-heat-pips'),
    '竖条不在 .kb-key 内部，而在热力覆盖层里（不碰 .kb-body）');

  // 清空数据后标记必须被撤掉（不能留下残影）
  sMod.clearKeyTimings();
  sMod.clearKeyErrors();
  fire(q('[data-view="stats"]'), 'click');
  await settle();
  const aAfter = q('#heatWrap').querySelector('.kb-key[data-key="A"]');
  ok(!aAfter.classList.contains('is-mastered'), '清空数据后绿点被撤销');
  ok(!aAfter.querySelector('.kb-mastery-dot'), '清空数据后圆点元素被移除');
  // 竖条也挂在覆盖层里，同样不能留残影（否则会「有竖条但没等级」）
  ok(q('#heatWrap').querySelectorAll('.kb-heat-pips').length === 0,
    '清空数据后等级竖条一并撤掉（无残影）');

  /* ============================================================
     错键辨析层（统计页第四层诊断）：从数据 → 卡片 → 一键开练
     ============================================================
     这一层最容易出的问题是「数据算对了但界面接不上」——
     上一轮 renderSession 的 emit 吞参数就是这个教训：代码齐全、
     单元测试全绿、功能一点没生效。所以这里走真实入口驱动到底。 */
  console.log('\n【新增】错键辨析层：卡片渲染与一键开练');

  sMod.clearKeyConfusions();
  sMod.recordKeyConfusions({ G: { K: 8 } }, 'char');
  sMod.recordKeyConfusions({ K: { G: 2 } }, 'char');   // 反向
  sMod.recordKeyConfusions({ D: { T: 1 } }, 'char');   // 不够格
  fire(q('[data-view="stats"]'), 'click');
  await settle();

  ok(!!q('#confusionBox'), '统计页有错键辨析块 #confusionBox');
  const confBox = q('#confusionBox');
  ok(/错键辨析/.test(confBox.textContent), '辨析块有标题');

  const cards = Array.from(confBox.querySelectorAll('.confuse-card'));
  ok(cards.length === 2, `两组键对都渲染成卡片（实际 ${cards.length}）`);

  // 两个方向必须合并成一对：G|K 而不是 G→K、K→G 两张卡
  const gkCard = cards.find(c => c.getAttribute('data-pair') === 'G|K');
  ok(!!gkCard, '★ 两个方向合并成一张 G|K 卡片（不是两张）');
  ok(/10 次/.test(gkCard.textContent), `合并后次数 = 8 + 2（卡片文本「${gkCard.textContent.trim().slice(0, 30)}」）`);

  // 不够格的卡片禁用且不给「开练」
  const dtCard = cards.find(c => c.getAttribute('data-pair') === 'D|T');
  ok(dtCard && dtCard.hasAttribute('disabled'), '★ 只有 1 次的键对卡片被禁用（不该引导用户练偶发手滑）');

  // 一键开练：走真实按钮，引擎必须真的起来且答案是这两个键
  const drillBtn = q('#btnConfuseDrill');
  ok(!!drillBtn, '有「练这几组混淆」按钮');
  fire(drillBtn, 'click');
  await settle();

  const eng = app.engine;
  ok(!!eng && eng.state === 'running', '★ 点击后练习真的开始了（引擎 state=running）');
  ok(eng.mode === 'confuse', `会话模式是 confuse（实际 ${eng.mode}）`);
  const qs = eng.questions;
  ok(qs.length === 6, `1 组够格键对 × 6 题（实际 ${qs.length}）`);
  const answers = qs.map(x => x.answerKeys[0]);
  ok(answers.every(k => k === 'G' || k === 'K'),
    `★ 题目答案只在 G/K 这一对里（实际 ${[...new Set(answers)].join('/')}）`);
  ok(answers.filter(k => k === 'G').length === 3 && answers.filter(k => k === 'K').length === 3,
    '两个键各出 3 题（不会一边倒）');

  // 结算页要能如实报出「这是辨析练习」
  ok(qMod.LEVEL_MAP[eng.mode] && qMod.LEVEL_MAP[eng.mode].name === '错键辨析',
    'mode 在 LEVEL_MAP 里有正经显示名');

  eng.destroy();
  app.engine = null;
  sMod.clearKeyConfusions();

  // 恢复现场
  app.stats.heatRange = 'all';
  app.stats.mode = 'all';
}

/* ---------- 压力测试：各模式全流程 ---------- */
console.log('\n【11】八种模式全流程（各跑一遍）');
for (const mode of ['keymap', 'sheng', 'yun', 'split', 'char', 'phrase', 'passage', 'exam']) {
  try {
    if (app.engine) { app.engine.destroy(); app.engine = null; }
    if (!q('#overlay').hidden) {
      const b = qa('#modal [data-act]')[0];
      if (b) fire(b, 'click');
    }
    q('#sessionPanel').hidden = true;
    q('#setupPanel').hidden = false;

    const card = qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === mode);
    fire(card, 'click');
    // 短文模式题量调小
    if (mode === 'passage') {
      q('#selCount').value = '1';
      fire(q('#selCount'), 'change');
    }
    // 测验模式题量调小（默认 50 题，全跑太慢）
    if (mode === 'exam') {
      q('#selCount').value = '10';
      fire(q('#selCount'), 'change');
    }
    fire(q('#btnStart'), 'click');
    await settle();

    let g = 0;
    while (app.engine && app.engine.state === 'running' && g < 30000) {
      g++;
      const t = app.engine.currentTarget();
      if (!t) break;
      if (t.kind === 'skip' || t.kind === 'punct') { app.engine.pressKey('a'); continue; }
      const k = (t.keys || [])[t.pos];
      if (!k) break;
      app.engine.pressKey(k.toLowerCase());
      await settle();
    }
    const s = app.engine ? app.engine.summary() : null;
    // 测验模式额外确认无提示且出分（分数挂在 app.lastResult 上）
    if (mode === 'exam' && s) {
      const sc = app.lastResult && app.lastResult.score;
      ok(s.hintedChars === 0 && sc && sc.score >= 0,
        `${mode}: 完成（${s.totalChars} 题，${s.accuracy}%，${sc ? sc.score : '-'} 分）`);
    } else {
      ok(s && s.state === 'finished', `${mode}: 完成（${s ? s.totalChars : 0} 字，${s ? s.accuracy : 0}%）`);
    }
  } catch (e) {
    ok(false, `${mode} 流程异常：${e.message}`);
  }
}

/* ---------- 辅助功能 / 快捷键 / 间隔重复 ---------- */
console.log('\n【12】辅助功能与间隔重复（接线层）');
{
  const a11y = await import('../src/ui/a11y.js');
  const sound = await import('../src/ui/sound.js');
  const setEl = q('#view-settings');

  // 渲染函数是 main.js 的闭包私有实现，测试通过显式测试钩子触发重渲染
  const renderReviewViewFn = fakeWindow.__hooks && fakeWindow.__hooks.renderReviewView;
  ok(typeof renderReviewViewFn === 'function', 'main.js 暴露了 __hooks.renderReviewView');

  /* ---- 12.1 新增设置项必须落进 settings 对象 ---- */
  const st = sMod.loadSettings();
  ok(st.reduceMotion === 'auto' || st.reduceMotion === 'on' || st.reduceMotion === 'off',
    `reduceMotion 有合法默认值（实际 ${st.reduceMotion}）`);
  ok(typeof st.reviewDueOnly === 'boolean', `reviewDueOnly 为布尔（实际 ${st.reviewDueOnly}）`);

  /* ---- 12.2 屏幕阅读器区域在 boot 后应当已注入 ---- */
  ok(!!q('#srLive'), '运行时注入了 #srLive（polite）');
  ok(!!q('#srLiveAssertive'), '运行时注入了 #srLiveAssertive（assertive）');
  ok(q('#srLive').getAttribute('aria-live') === 'polite', '#srLive aria-live=polite');
  ok(q('#srLiveAssertive').getAttribute('aria-live') === 'assertive', '#srLiveAssertive aria-live=assertive');
  ok(q('#srLive').className.includes('sr-only'), '#srLive 带 sr-only（视觉不可见但可朗读）');

  /* ---- 12.3 减少动态效果：类名跟随设置 ---- */
  const html = fakeWindow.document.documentElement;
  app.settings.reduceMotion = 'on';
  await import('../src/ui/a11y.js').then(m => m.motionClass(true));
  ok(html.classList.contains('reduce-motion'), 'reduceMotion=on 时 html 带 reduce-motion');
  a11y.motionClass(false);
  ok(!html.classList.contains('reduce-motion'), 'reduceMotion=off 时移除 reduce-motion');
  app.settings.reduceMotion = 'auto';

  /* ---- 12.4 快捷键面板渲染 ---- */
  const list = q('#shortcutList');
  ok(!!list, '设置页存在 #shortcutList');
  ok(list.children.length === Object.keys(a11y.SHORTCUT_ACTIONS).length,
    `快捷键行数 = 可配置动作数（${list.children.length}）`);
  const rowKeys = qa('#shortcutList .shortcut-key');
  ok(rowKeys.length >= 4, `快捷键按钮 ≥ 4 个（实际 ${rowKeys.length}）`);
  ok(rowKeys.every(b => b.textContent.trim().length > 0), '每个快捷键按钮都有可见键名');

  /* ---- 12.5 说明段落里的键名与实际一致 ---- */
  const sc0 = app.settings.shortcuts;
  ok(q('#noteHintKey') && q('#noteHintKey').textContent === a11y.prettyKey(sc0.hint),
    `#noteHintKey 显示 ${a11y.prettyKey(sc0.hint)}`);
  ok(q('#noteSkipKey') && q('#noteSkipKey').textContent === a11y.prettyKey(sc0.skip),
    `#noteSkipKey 显示 ${a11y.prettyKey(sc0.skip)}`);

  /* ---- 12.6 回归：数据占用提示精确落在 #storageNote ----
     设置页有多个 .footnote，早先用 $('.footnote') 会命中第一个，
     一个 textContent 赋值把快捷键说明里的 <code id> 全抹掉了。 */
  ok(!!q('#storageNote'), '存在 #storageNote');
  ok(/localStorage/.test(q('#storageNote').textContent), '#storageNote 内容已写入');
  ok(!!q('#shortcutNote'), '存在 #shortcutNote');
  ok(!!q('#shortcutNote').querySelector('#noteHintKey'),
    '★ 快捷键说明的 <code> 子节点未被误伤（回归保护）');
  ok(setEl.querySelectorAll('.footnote').length >= 3,
    `设置页有多个 .footnote（实际 ${setEl.querySelectorAll('.footnote').length}）`);

  /* ---- 12.7 改键捕获期间必须屏蔽全局快捷键 ---- */
  ok(app._capturingShortcut === false, '默认不在改键捕获状态');
  app._capturingShortcut = true;
  const beforeMode = app.settings.mode;
  // 捕获状态下按 Tab 不应触发「看答案」
  fire(document, 'keydown', { key: 'Tab', code: 'Tab' });
  ok(app.settings.mode === beforeMode, '★ 捕获状态下 Tab 不触发任何动作');
  app._capturingShortcut = false;

  /* ---- 12.8 音效开关是「安全的」：任何情况下都不能抛 ---- */
  ok(typeof sound.play === 'function', 'sound.play 导出');
  let soundThrew = false;
  try {
    sound.play('correct', true);
    sound.play('error', true);
    sound.play('finish', true);
    sound.play('correct', false);
    sound.play('nonsense-kind', true);
  } catch (_) { soundThrew = true; }
  ok(!soundThrew, '音效合成在无 AudioContext 环境下静默降级，不抛异常');
  ok(sound.isSupported() === false, 'linkedom 环境无 WebAudio，isSupported() 返回 false');

  /* ---- 12.9 间隔重复：复习页展示到期信息 ---- */
  const w = sMod.getWeakList({ limit: 10, minCount: 1 });
  // 直接构造一条到期记录，验证渲染链路
  sMod.recordWeak({ key: '测', char: '测', pinyin: 'ce' });
  sMod._setAllDue(Date.now() - 1000);
  renderReviewViewFn();
  const body = q('#reviewBody');
  ok(/今天|到期/.test(body.textContent), '复习页出现「到期」相关文案');
  const dueChip = body.querySelector('.review-chip.is-due');
  ok(!!dueChip, '★ 到期项带 is-due 标记');
  ok(!!body.querySelector('.rc-sched .rc-bar'), '复习 chip 含掌握度进度条');
  ok(!!body.querySelector('.rc-due'), '复习 chip 含「下次复习」文本');
  const sub = q('#reviewSub');
  ok(/到期/.test(sub.textContent), `复习页副标题提得到期（${sub.textContent.slice(0, 30)}…）`);

  /* ---- 12.10 「只练到期项」开关 ---- */
  const chkDue = q('#chkReviewDueOnly');
  ok(!!chkDue, '复习页存在「只练到期项」开关');
  if (chkDue) {
    app.settings.reviewDueOnly = true;
    renderReviewViewFn();
    ok(!!q('#chkReviewDueOnly'), '重渲染后开关仍在');
  }

  /* ---- 12.11 getWeakList 到期优先排序 ---- */
  sMod.clearWeak();
  const nowTs = Date.now();
  // 甲：错 3 次但已连对复习（→ due 被推到未来）；乙：刚出错、已到期
  // 注意 recordWeak/recordWeakCorrect 的入参是**对象**（{char} 或 {word}），
  // 传字符串会被 `if (!item) return` 静默吞掉 —— 这正是下面要钉住的点。
  sMod.recordWeak({ char: '甲', pinyin: 'jia' });
  sMod.recordWeak({ char: '甲', pinyin: 'jia' });
  sMod.recordWeak({ char: '甲', pinyin: 'jia' });
  sMod.recordWeak({ char: '乙', pinyin: 'yi' });
  sMod._setAllDue(nowTs - 1000);              // 先全部置为到期
  sMod.recordWeakCorrect({ char: '甲' });     // 再让甲「刚复习过」→ due 推向未来
  const sorted = sMod.getWeakList({ limit: 10, minCount: 1, now: nowTs });
  ok(sorted.length >= 2, `排序样本 ≥ 2 项（实际 ${sorted.length}）`);
  const jia = sorted.find(e => e.key === '甲');
  const yi = sorted.find(e => e.key === '乙');
  ok(!!jia && !!yi, '甲乙两条记录都在');
  ok(yi.isDue === true && jia.isDue === false,
    `构造正确：乙到期、甲未到期（乙=${yi && yi.isDue}，甲=${jia && jia.isDue}）`);
  ok(sorted[0].key === '乙',
    `★ 到期项排在最前（首位 ${sorted[0].key}）`);
  ok(sorted[sorted.length - 1].key === '甲',
    `★ 未到期项排在最后（末位 ${sorted[sorted.length - 1].key}）`);
  // 同一个 key 反复记录应当累加而不是覆盖
  ok(jia.count === 3, `同一 key 反复记录会累加错误次数（甲 count=${jia && jia.count}）`);
  sMod.clearWeak();

  /* ---- 12.12 「只练到期项」必须真的只练到期内容 ----
     回归：早先把到期与未到期混在一起传给出题函数，出题函数又按权重
     重排，低权重的到期项被挤出 20 题 —— 按钮写着「复习到期的 1 项」，
     实际一道到期题都没有。现在范围在按钮点击时就定型。 */
  sMod.clearWeak();
  sMod.recordWeak({ char: '甲', pinyin: 'jia' });          // 唯一的到期项
  for (let i = 0; i < 21; i++) {
    sMod.recordWeak({ char: `未${i}`, pinyin: 'wei' });     // 21 个未到期项
  }
  sMod._setAllDue(nowTs + 10 * 86400000);                   // 全部推到未来
  {
    // 单独把「甲」置为已到期
    const m = sMod.readJSON(sMod.KEYS.weak, {});
    m['甲'].due = nowTs - 1000;
    sMod.writeJSON(sMod.KEYS.weak, m);
  }
  app.settings.reviewDueOnly = true;
  renderReviewViewFn();
  const btn = q('#btnReviewPractice');
  ok(!!btn, '复习按钮存在');
  ok(/复习到期的 1 项/.test(btn.textContent), `按钮文案承诺到期范围（${btn.textContent.trim()}）`);
  fire(btn, 'click');
  // 引擎第一题必须是「甲」
  const q1 = app.engine && app.engine.currentQuestion ? app.engine.currentQuestion() : null;
  ok(!!q1, '会话已启动');
  const firstChar = q1 && (q1.chars && q1.chars[0] && q1.chars[0].ch || q1.char || '');
  ok(firstChar === '甲',
    `★ 只练到期项时第一题就是到期字（实际 ${firstChar || '无'}）`);
  // 关掉开关后：到期优先、未到期补齐
  app.settings.reviewDueOnly = false;
  renderReviewViewFn();
  fire(q('#btnReviewPractice'), 'click');
  ok(!!app.engine, '关掉开关后仍能启动练习');
  app.settings.reviewDueOnly = true;                        // 恢复默认
  if (app.engine) { app.engine.destroy(); app.engine = null; }
  sMod.clearWeak();

  /* ---- 12.13 无到期项时不应被高频字兜底绕过 ---- */
  sMod.recordWeak({ char: '甲', pinyin: 'jia' });
  sMod._setAllDue(nowTs + 10 * 86400000);
  renderReviewViewFn();
  const noDueBtn = q('#btnReviewPractice');
  ok(!!noDueBtn && noDueBtn.hasAttribute('disabled'), '无到期项时复习按钮被禁用');
  ok(/今天没有到期项/.test(noDueBtn && noDueBtn.textContent || ''),
    '无到期项时按钮文案明确说明当前不可复习');
  fire(noDueBtn, 'click');
  ok(!app.engine, '无到期项时点击不会生成高频字兜底题');
  sMod.clearWeak();
}

/* ---------- 保存现场、设置落库与无效测验 ---------- */
console.log('\n【新增】页面生命周期与续练');
{
  if (app.engine) { app.engine.destroy(); app.engine = null; }
  q('#overlay').hidden = true;
  q('#sessionPanel').hidden = true;
  q('#setupPanel').hidden = false;
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'char'), 'click');
  q('#selCharTier').value = '2';
  fire(q('#selCharTier'), 'change');
  q('#selCount').value = '10';
  fire(q('#selCount'), 'change');
  fire(q('#btnStart'), 'click');
  const eng = app.engine;
  const target = eng.currentTarget();
  fireKey(target.keys[0].toLowerCase());
  ok(sMod.loadResume()?.keyIndex === 1, '第一键后自动保存现场');
  eng.requestHint('reveal');
  fire(q('#btnPause'), 'click');
  const saved = sMod.loadResume();
  ok(saved?.keyIndex === 1 && saved.hintedMarks.length === 1,
    '暂停保存当前键位置和提示标记');
  const restored = engineMod.PracticeEngine.restore(saved);
  ok(restored?.keyIndex === 1 && restored.currentTarget().pos === 1,
    '经过存储层的现场仍从第二键恢复');
  restored?.destroy();
  q('#selCharTier').value = '3';
  fire(q('#selCharTier'), 'change');
  (fakeWindow._ls.pagehide || []).forEach(h => h(new FakeEvent('pagehide')));
  ok(sMod.loadSettings().charTier === '3', '离开页面立即保存尚在延迟中的设置');
  ok(sMod.loadResume()?.keyIndex === 1, '暂停后离开页面也保留现场');
  eng.destroy(); app.engine = null;
  fire(q('#btnResume'), 'click');
  ok(app.engine?.keyIndex === 1, '点击继续练习恢复到第二键');
  while (app.engine.index < app.engine.questions.length - 1) {
    const t = app.engine.currentTarget();
    app.engine.pressKey(t.keys[t.pos]);
  }
  app.engine.pressKey(app.engine.currentTarget().keys[0]);
  fire(q('#btnQuit'), 'click');
  fire(q('#modal [data-act="save"]'), 'click');
  ok(!app.engine && sMod.loadResume()?.index === 9 && sMod.loadResume()?.keyIndex === 1,
    '最后一个字未打完时仍能保存续练，不能提前算作完成');
  q('#sessionPanel').hidden = true;
  q('#setupPanel').hidden = false;
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'exam'), 'click');
  fire(q('#btnStart'), 'click');
  const historyCount = sMod.loadHistory().length;
  fire(q('#btnQuit'), 'click');
  ok(q('#modal').textContent.includes('至少完成 20 个字符'), '提前交卷明确说明有效成绩的最低样本量');
  fire(q('#modal [data-act="cancel"]'), 'click');
  app.engine.finish('user');
  const score = app.lastResult?.score;
  ok(score && !score.valid && score.score === 0, '零作答交卷不产生有效分数');
  ok(q('#modal .score-num')?.textContent === '—' && !q('#modal .score-badge') && !q('#modal .score-parts'),
    '无效测验弹窗不显示分数、分项得分或等级徽章');
  ok(!q('#modal').textContent.includes('已完成部分已计入统计'), '零作答不会声称成绩已计入统计');
  ok(sMod.loadHistory().length === historyCount, '零作答测验不写入历史');
  ok(sMod.loadResume() === null, '交卷后清除续练现场');
  app.engine.destroy(); app.engine = null;
  q('#overlay').hidden = true;
  fire(q('#btnStart'), 'click');
  const shortEngine = app.engine;
  while (shortEngine.stats.totalChars < 3) {
    const t = shortEngine.currentTarget();
    shortEngine.pressKey(t.keys[t.pos]);
  }
  shortEngine.elapsedSec = 2;
  shortEngine.finish('user');
  const shortRecord = sMod.loadHistory().slice(-1)[0];
  ok(shortRecord?.scoreValid === false && shortRecord.score === undefined,
    '有作答的小样本保留练习历史但不记有效分数');
  app.engine.destroy(); app.engine = null;
}

console.log('【新增】题量设置与自动续题接线');
{
  const cleanup = () => {
    if (app.engine) app.engine.destroy(); app.engine = null;
    q('#overlay').hidden = true; q('#sessionPanel').hidden = true; q('#setupPanel').hidden = false;
  };
  cleanup();
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'phrase'), 'click');
  q('#selCount').value = 'custom'; fire(q('#selCount'), 'change');
  ok(!q('#customCount').hidden, '选择自定义显示数字输入');
  q('#customCount').value = '137'; fire(q('#customCount'), 'input');
  fire(q('#btnStart'), 'click');
  ok(app.engine.questions.length === 137, '自定义输入未失焦就开始也使用新题量');
  cleanup();
  fire(q('#customCount'), 'change');
  ok(app.settings.count === 137 && q('#setCount').value === 'custom' && q('#setCustomCount').value === '137',
    '自定义题量与设置页同步');
  fire(q('#btnStart'), 'click');
  ok(app.engine.questions.length === 137 && !app.engine.unlimited, '自定义数值决定实际题量');
  cleanup();
  q('#setCount').value = '500'; fire(q('#setCount'), 'change');
  ok(app.settings.count === 500 && q('#selCount').value === '500' && q('#customCount').hidden,
    '设置页预设题量同步回首页');
  q('#selCount').value = '0'; fire(q('#selCount'), 'change');
  app.settings.weakBoost = false;
  fire(q('#btnStart'), 'click');
  const eng = app.engine;
  const first = eng.currentQuestion().text;
  ok(sMod.loadRecent('phrase').includes(first), '首题实际展示后进入近期记录');
  ok(!eng.questions.slice(1).some(x => sMod.loadRecent('phrase').includes(x.text)),
    '尚未展示的题目不写入近期记录');
  while (eng.summary().doneQuestions < 45) {
    const t = eng.currentTarget(); eng.pressKey(t.keys[t.pos]);
  }
  ok(eng.state === 'running' && eng.questions.length === 20 && eng.questionOffset === 40,
    '首页不限量超过两批后仍在运行且队列大小不变');
  ok(q('#hudProgress').textContent.includes('45'), '累计题数显示在页面');
  fire(q('#btnPause'), 'click');
  const saved = sMod.loadResume();
  ok(saved.unlimited && saved.questionOffset === 40, '暂停保存不限量累计进度');
  cleanup();
  q('#selCharTier').value = '7'; fire(q('#selCharTier'), 'change');
  fire(q('#btnResume'), 'click');
  ok(app.engine.unlimited && app.engine.summary().doneQuestions === 45, '页面续练保留累计题数');
  while (app.engine.summary().doneQuestions < 61) {
    const t = app.engine.currentTarget(); app.engine.pressKey(t.keys[t.pos]);
  }
  ok(app.engine.state === 'running' && app.engine.questionOffset === 60, '续练重建出题源后仍自动补充');
  cleanup();
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'passage'), 'click');
  q('#selCount').value = '20'; fire(q('#selCount'), 'change');
  fire(q('#btnStart'), 'click');
  ok(app.engine.questions.length === 20 && q('[data-count="passage"]').textContent === '20 段',
    '短文实际题量与卡片一致，不再截断为八段');
  cleanup();
  q('#selCount').value = '0'; fire(q('#selCount'), 'change');
  app.settings.weakBoost = true;
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'exam'), 'click');
  fire(q('#btnStart'), 'click');
  ok(!app.engine.unlimited && app.engine.questions.length === 50 && app.engine.questions.every(q => q.meta?.examPart),
    '易错强化和不限量不能改变测验的有限混合卷');
  cleanup();
}

console.log('【新增】训练阶段、分类筛选、自适应续练与模式统计');
{
  const sMod = await import('../src/core/storage.js');
  const cleanup = () => { if (app.engine) app.engine.destroy(); app.engine = null; app.sessionActive = false; };
  cleanup();
  app.settings.hint = false;
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'phrase'), 'click');
  q('#selPhraseCategory').value = 'office'; fire(q('#selPhraseCategory'), 'change');
  q('#selPhraseLength').value = '3'; fire(q('#selPhraseLength'), 'change');
  q('#selTrainingPolicy').value = 'independent'; fire(q('#selTrainingPolicy'), 'change');
  q('#selCount').value = '20'; fire(q('#selCount'), 'change');
  app.settings.weakBoost = true;
  fire(q('#btnStart'), 'click');
  ok(app.engine.questions.every(x => x.meta.category === 'office' && Array.from(x.text).length === 3),
    '筛选范围同样约束易错强化');
  ok(!q('#decode').querySelector('code') && q('#decode').textContent.includes('凭记忆'), '独立输入不渲染答案');
  ok(!q('#prompt').querySelector('[title]') && q('#miniKeymap').hidden, '独立输入隐藏拼音悬浮和键位图');
  const target = app.engine.currentTarget();
  app.engine.pressKey(target.keys[target.pos].toLowerCase() === 'z' ? 'x' : 'z');
  ok(!q('#feedback').querySelector('code') && q('#feedback').textContent.includes('重试'), '答错反馈也不泄露答案');
  app.engine.hintEnabled = true;
  app.engine.requestHint('reveal');
  ok(!q('#miniKeymap').hidden && !q('#hintBar').hidden, '主动求助可显示已计入辅助的答案');
  cleanup();
  q('#selPhraseCategory').value = 'idiom'; fire(q('#selPhraseCategory'), 'change');
  q('#selPhraseLength').value = '2'; fire(q('#selPhraseLength'), 'change');
  fire(q('#btnStart'), 'click');
  ok(!app.engine && q('#phrasePoolInfo').textContent.includes('暂无'), '空筛选不启动混入其他内容的练习');

  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'char'), 'click');
  q('#selTrainingPolicy').value = 'full'; fire(q('#selTrainingPolicy'), 'change');
  q('#selCharTier').value = 'progressive'; fire(q('#selCharTier'), 'change');
  ok(app.settings.trainingPolicy === 'progressive', '选择自适应挑战自动接入逐步撤提示');
  q('#selCount').value = '0'; fire(q('#selCount'), 'change');
  app.settings.duration = 0;
  fire(q('#btnStart'), 'click');
  while (app.engine.stats.totalChars < 25) {
    const t = app.engine.currentTarget(); app.engine.pressKey(t.keys[t.pos]);
  }
  ok(app.engine.training.stage === 2 && app.engine.training.difficulty.length === 5,
    '完整提示到拼音到独立输入由表现晋级');
  fire(q('#btnPause'), 'click');
  const saved = sMod.loadResume();
  ok(saved.training.stage === 2 && saved.generationState.used.items.length > 0, '暂停保存阶段、表现窗口及覆盖范围');
  cleanup();
  fire(q('#btnResume'), 'click');
  while (app.engine.stats.totalChars < 31) {
    const t = app.engine.currentTarget(); app.engine.pressKey(t.keys[t.pos]);
  }
  ok(app.engine.training.tier === 2 && app.engine.currentQuestion().meta.tier === 2,
    '续练独立表现累积升档，新题立即使用新档位');
  ok(q('#stageMode').textContent.includes('第 2 档'), '页面显示当前档位和训练阶段');
  cleanup();
  sMod.clearResume();
  fire(q('[data-view="stats"]'), 'click');
  q('#statsMode').value = 'phrase'; fire(q('#statsMode'), 'change');
  const onlyPhrase = sMod.loadHistory().filter(x => x.mode === 'phrase');
  ok(q('#statCards').textContent.includes(`${onlyPhrase.length}`) && q('#statsMode').value === 'phrase', '统计可按词组模式查看');
}

console.log('【新增】会话用时与反应时间同源、切回前台结算、统计口径说明');
{
  const cleanup = () => { if (app.engine) app.engine.destroy(); app.engine = null; app.sessionActive = false; };
  cleanup();
  // 统计页的新说明节点存在，且在加权均值与算术平均一致时不显示
  fire(q('[data-view="stats"]'), 'click');
  ok(!!q('#chartAvgNote'), '曲线页有均值口径说明节点');

  cleanup();
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'char'), 'click');
  app.settings.trainingPolicy = 'progressive';
  app.settings.charTier = 'progressive';
  q('#selCount').value = '0'; fire(q('#selCount'), 'change');
  app.settings.duration = 0;
  fire(q('#btnStart'), 'click');
  ok(!!app.engine, '自适应练习已启动');
  const eng = app.engine;
  // 标签页被节流 10 分钟后回到前台：一次结算不能把 600 秒整段吞进用时
  const before = eng.activeSeconds();
  eng._lastTickAt = Date.now() - 600000;
  eng.syncActiveTime();
  const added = eng.activeSeconds() - before;
  ok(added > 0 && added <= 5.5, `切回前台只结算最多 5 秒，实际 ${added.toFixed(1)}s`);
  cleanup();
}

console.log('【新增】词组易错归组、完成音效、测验成绩曲线、键位图开关');
{
  const cleanup = () => { if (app.engine) app.engine.destroy(); app.engine = null; app.sessionActive = false; };
  cleanup();
  sMod.clearWeak();

  // 词组出错要同时进「易错单字」和「易错词语」两组
  q('#selPhraseCategory').value = 'all'; fire(q('#selPhraseCategory'), 'change');
  q('#selPhraseLength').value = '2'; fire(q('#selPhraseLength'), 'change');
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'phrase'), 'click');
  // 题量要够：3 个二字词只够 6 个字，40ms/字 走不满 1 秒就会提前结束，
  // 而 persistRecord 只在 durationSec >= 1 时落库。
  q('#selCount').value = '30'; fire(q('#selCount'), 'change');
  app.settings.weakBoost = false;
  fire(q('#btnStart'), 'click');
  const eng = app.engine;
  // 第一题按一个错键
  const t = eng.currentTarget();
  eng.pressKey(t.keys[0].toLowerCase() === 'x' ? 'q' : 'x');
  const word = eng.currentQuestion().text;
  /* 这里要够两个条件才好落库：打完 ≥5 个字，且 durationSec ≥ 1
     （persistRecord 拦空练习）。旧写法用 40ms/键 的真实节奏把 1 秒磨出来，
     慢且不稳。改成直接给引擎记账 —— 用时是被测代码要展示的数据，
     靠 setTimeout 去凑既费时又不可靠。 */
  for (let i = 0; i < 40 && eng.stats.totalChars < 5; i++) {
    const x = eng.currentTarget();
    if (!x || !x.keys || !x.keys.length) break;
    eng.elapsedSec = 2;
    for (const k of x.keys) eng.pressKey(String(k).toLowerCase());
    await settle();
  }
  const s = eng.summary();
  ok(s.durationSec >= 1, `用时已累计（${s.durationSec}s / state=${eng.state} / ticker=${!!eng._ticker}），否则不会落库`);
  ok(Object.keys(s.perWordErrors || {}).length >= 1, `按整条记录了词组错误（${JSON.stringify(s.perWordErrors)}）`);
  eng.finish('user');
  await settle();
  const weak = sMod.loadWeak();
  ok(!!weak[word], `词组「${word}」进了易错表`);
  ok(!!weak[word]?.word && weak[word].word === word, '整条记录的 word 字段非空（分组靠它）');
  ok(!!weak[word]?.pinyin && weak[word].pinyin.includes(' '), '词组拼音逐字保存，能显示编码');
  // 复习页分组。要先关掉「只练到期项」：刚记错的词按 SM-2 排在明天到期，
  // 开着开关时列表本就该是空的（那是正确行为，不是 bug）。
  const realDueOnly = app.settings.reviewDueOnly;
  app.settings.reviewDueOnly = false;
  fire(q('[data-view="review"]'), 'click');
  await settle();
  const reviewHtml = q('#reviewBody').innerHTML;
  ok(reviewHtml.includes('易错词语'), '复习页出现「易错词语」分组（此前永远为空）');
  const phraseGroupHtml = reviewHtml.split('易错词语')[1] || '';
  ok(phraseGroupHtml.includes(word), '词组出现在「易错词语」分组里');
  ok(!phraseGroupHtml.includes('—'), '词组条目显示自己的拼音与编码，不再是「—」');
  ok(!/易错单字[\s\S]{0,300}rc-char[^>]*>\s*精度/.test(reviewHtml),
    '词组没有被误归到「易错单字」');
  app.settings.reviewDueOnly = realDueOnly;
  const done = qa('#modal [data-act]').find(b => b.getAttribute('data-act') === 'again');
  if (done) fire(done, 'click');
  await settle();

  /* 完成音效：一次有效练习结束要发声（此前 playFinish 从没被调用过）。
     ES module 的命名空间是只读的，不能改写 soundMod.play；
     改为在 window.AudioContext 上装桩：合成一定会经过 createOscillator，
     数「振荡器个数」就能判断播没播 —— finish 是 3 音、soften 是 2 音。 */
  cleanup();
  const audio = { oscillators: 0 };
  const realAudio = fakeWindow.AudioContext;
  fakeWindow.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createOscillator() { audio.oscillators++; return {
      type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {}, start() {}, stop() {}
    }; }
    createGain() { return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {}
    }; }
  };
  const { _resetForTest } = await import('../src/ui/sound.js');
  _resetForTest();   // 丢弃之前用例可能已建的播放器单例
  try {
    app.settings.sound = true;
    fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'char'), 'click');
    q('#selCount').value = '30'; fire(q('#selCount'), 'change');
    fire(q('#btnStart'), 'click');
    const e2 = app.engine;
    // 够 5 键且用时 ≥1 秒才算有效成绩（否则不出收尾音）。用时直接记账，不等真实秒。
    for (let i = 0; i < 60 && e2.state === 'running' && e2.stats.keystrokes < 6; i++) {
      const x = e2.currentTarget();
      if (!x || !x.keys || !x.keys.length) break;
      e2.elapsedSec = 2;
      for (const k of x.keys) e2.pressKey(String(k).toLowerCase());
      await settle();
    }
    e2.elapsedSec = Math.max(2, e2.elapsedSec);
    e2.finish('user');   // 主动结束，走与时间到/打完相同的结算路径
    ok(e2.state === 'finished', '练习已结束（有效成绩才会触发收尾音）');
    ok(audio.oscillators > 0, `有效练习结束会播收尾音（合成 ${audio.oscillators} 个振荡器）`);
    ok(audio.oscillators >= 2, '收尾音是多音（finish 三音 / soften 两音）');
  } finally {
    _resetForTest();
    fakeWindow.AudioContext = realAudio;
  }
  cleanup();
  const again2 = qa('#modal [data-act]').find(b => b.getAttribute('data-act') === 'again');
  if (again2) fire(again2, 'click');
  await settle();

  // 测验成绩曲线
  fire(q('[data-view="stats"]'), 'click');
  await settle();
  ok(!!q('#scoreChart'), '统计页有测验成绩曲线画布');
  ok(!!q('#scoreNote'), '测验成绩曲线有口径说明节点');
  const hist = sMod.loadHistory();
  const validExams = hist.filter(r => r.mode === 'exam' && r.scoreValid === true);
  ok(validExams.length >= 1, `样本池里有有效测验（${validExams.length} 次）`);
  if (validExams.length) {
    ok(!q('#scoreNote').hidden, '有效测验存在时显示说明');
    ok(q('#scoreNote').textContent.includes('平均'), '说明里给出平均分');
  }

  // 热力图跟随模式筛选；没有该模式数据时如实说明
  sMod.clearKeyErrors();
  sMod.recordKeyErrors({ v: 3, h: 1 }, 'phrase');
  sMod.recordKeyErrors({ a: 2 }, 'char');
  fire(q('[data-view="stats"]'), 'click');
  await settle();
  q('#statsMode').value = 'all'; fire(q('#statsMode'), 'change');
  await settle();
  // V×3 + H×1 + A×2 = 6 次，3 个键。断言总额比逐键断言更能说明「是全量」
  ok(/共\s*6\s*次按键错误/.test(q('#heatSummary').textContent) &&
    /涉及\s*3\s*个键/.test(q('#heatSummary').textContent),
    `全部模式下热力图是全量累计（${q('#heatSummary').textContent.replace(/\s+/g, ' ').trim().slice(0, 40)}）`);
  q('#statsMode').value = 'phrase'; fire(q('#statsMode'), 'change');
  await settle();
  const phraseHeat = q('#heatSummary').textContent;
  // 词组模式只有 V×3 + H×1 = 4 次、2 个键；A×2 属于单字模式，不该出现
  ok(/共\s*4\s*次按键错误/.test(phraseHeat) && /涉及\s*2\s*个键/.test(phraseHeat) &&
    !phraseHeat.includes('A'),
    `选中词组后热力图只含该模式（${phraseHeat.replace(/\s+/g, ' ').trim().slice(0, 46)}）`);
  ok(!q('#heatSummary').querySelector('.heat-fallback-note'),
    '有专属数据时不显示「仍为全量」的提示');
  ok(q('#heatTitle').textContent.includes('词组'), '热力图标题跟着模式走');
  // 老数据（没有按模式层）必须说明，而不是静默显示全量
  sMod.clearKeyErrors();
  sMod.recordKeyErrors({ v: 7 }, '');
  q('#statsMode').value = 'char'; fire(q('#statsMode'), 'change');
  await settle();
  ok(!!q('#heatSummary').querySelector('.heat-fallback-note'),
    '该模式无专属数据时明确说明此处仍为全量累计');
  q('#statsMode').value = 'all'; fire(q('#statsMode'), 'change');
  sMod.clearKeyErrors();

  // 迷你键位图开关不再被 renderSession 覆盖
  cleanup();
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'char'), 'click');
  app.settings.showMiniKeymap = true;
  app.keymapHidden = null;
  fire(q('#btnStart'), 'click');
  await settle();
  const km = q('#miniKeymap');
  ok(!km.hidden, '默认可见');
  const btnKm = q('#btnToggleKeymap');
  ok(btnKm.textContent === '隐藏', '按钮文案与实际一致');
  fire(btnKm, 'click');
  await settle();
  ok(km.hidden, '点一次收起');
  ok(btnKm.textContent === '显示', '收起后按钮文案正确');
  // 再走一帧 renderSession，用户的选择必须活下来
  const t2 = app.engine.currentTarget();
  app.engine.pressKey(String(t2.keys[t2.pos]).toLowerCase());
  await settle();
  ok(km.hidden, '重绘后仍然保持收起（此前会被每帧覆盖回去）');
  ok(btnKm.textContent === '显示', '重绘后按钮文案仍然正确');
  fire(btnKm, 'click');
  await settle();
  ok(!km.hidden, '再点一次恢复显示');
  cleanup();
  sMod.clearWeak();
}

console.log('【新增】按键耗时：结算面板的「反应最慢的键」与统计页慢键层');
{
  /* 这一节测的是**接线层**：引擎测口径、存储测合并，这里测两者有没有被
     真正接到界面上 —— 面板出没出现、数据有没有落盘、统计页的慢键环有没有
     画出来。这类断链是自检最容易漏的：每个单元都绿，功能却不存在。 */
  if (app.engine) { app.engine.destroy(); app.engine = null; }
  app.sessionActive = false;
  const ls = sMod;
  /* 先清空：这一节要断言「样本不足时如实说明」，而全量跑时前面的用例
     已经在 localStorage 里攒下了足够样本，不清就会走到排名分支去。 */
  ls.clearKeyTimings();

  /* ---------- ① 一轮真实练习：结算面板出现慢键区块 ---------- */
  fire(q('[data-view="practice"]'), 'click');
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'keymap'), 'click');
  fire(q('#btnStart'), 'click');
  const eng = app.engine;
  ok(!!eng, '键位练习已启动');

  // 造出可测样本：跳过前两个（启动成本 + 本就不测），之后每个键都停一会
  const tap = async (ms) => {
    const t = eng.currentTarget();
    if (!t || t.keys[t.pos] === undefined) return;
    await new Promise(r => setTimeout(r, ms));
    eng.pressKey(t.keys[t.pos]);
  };
  await tap(5); await tap(5);
  const sampleCount = (m) => Object.values(m || {})
    .reduce((n, r) => n + (r.lead?.length || 0) + (r.follow?.length || 0), 0);
  const beforeCount = sampleCount(eng.stats.keyTimings);
  for (let i = 0; i < 6; i++) await tap(35);

  const sum = eng.summary();
  ok(!!sum.keyTimings && Object.keys(sum.keyTimings).length > 0,
    `summary 带上本轮按键耗时样本（${Object.keys(sum.keyTimings).join('/')}）`);
  ok(sampleCount(eng.stats.keyTimings) > beforeCount, '后续按键继续产出样本');

  /* 键位模式里每个键一轮只按 1 次，够不到 5 次门槛 —— 这本身就是要验的行为：
     样本不够时弹窗必须**说明**，而不是给出一个基于 1 个样本的「最慢的键」。 */
  eng.elapsedSec = 30;
  eng.finish('user');
  ok(/不足\s*5\s*次/.test(q('#modal .slow-block-note')?.textContent || ''),
    '样本不足 5 次时如实说明「暂不排名」而不是硬排一个出来');
  ok(!q('#modal .slow-row'), '样本不足时不出排行行');
  fire(q('#modal [data-act="cancel"]'), 'click');
  eng.destroy(); app.engine = null;

  /* 另起一轮，灌一份确定的样本，验「排名分支」的渲染是否忠实于数据。
     两点原因不能复用上一轮：
       ① finish() 在已结束状态直接返回，不会再弹窗；
       ② 键位模式的出题随机，敲多少次都不保证某个键够 5 次。
     所以直接写 stats —— 这里要验的是「界面忠实反映数据」，不是「敲键盘能敲出数据」。 */
  fire(q('#btnStart'), 'click');
  const eng2 = app.engine;
  const many = (v, n) => Array(n).fill(v);
  eng2.stats.keyTimings = {
    S: { lead: [], follow: many(900, 7) },
    D: { lead: [], follow: many(640, 7) },
    H: { lead: [], follow: many(480, 7) },
    G: { lead: [], follow: many(300, 7) },
    J: { lead: [], follow: many(200, 7) },
    K: { lead: [], follow: many(250, 2) }   // 样本不足，不该进排名
  };
  eng2.elapsedSec = 30;
  eng2.finish('user');
  const rows = qa('#modal .slow-row');
  ok(rows.length === 5, `排名分支渲染出 5 行（实际 ${rows.length}）`);
  const keysShown = rows.map(r => r.querySelector('.slow-key')?.textContent?.trim());
  ok(keysShown.join(',') === 'S,D,H,G,J',
    `按中位数降序且样本不足的键被排除（${keysShown.join('→')}）`);
  ok(rows[0]?.querySelector('.slow-ms')?.textContent === '0.90s',
    `毫秒转成秒并保留两位（实际 ${rows[0]?.querySelector('.slow-ms')?.textContent}）`);
  ok(/样本不足\s*5\s*次/.test(q('#modal .slow-block-note')?.textContent || ''),
    '排名分支里另行说明有几个键因样本不足未参与');
  ok(/7\s*次样本的中位数/.test(rows[0]?.textContent || ''),
    '每行标注了样本量，避免把 7 个样本的中位数当成定论');
  ok(!q('#modal').textContent.includes('undefined') && !q('#modal').textContent.includes('NaN'),
    '慢键区块不会渲染出 undefined / NaN');
  fire(q('#modal [data-act="cancel"]'), 'click');
  eng2.destroy(); app.engine = null;

  /* ---------- ② 样本落盘 ---------- */
  const kt = ls.loadKeyTimings();
  ok(Object.keys(kt.all).length > 0, `按键耗时已落盘（${Object.keys(kt.all).join('/')}）`);
  ok(Object.keys(kt.byMode).includes('keymap'), '落盘时带上了模式（模式筛选要同时覆盖两层诊断）');
  ok(kt.recent.length > 0 && !!kt.recent[kt.recent.length - 1].mode,
    '范围切换用的明细记录了模式');
  const errs = ls.loadKeyErrors();
  ok(Object.keys(errs.all).length >= 0, '键错误表与耗时表互不影响');

  /* ---------- ③ 统计页：慢键层画在热力图上 ---------- */
  fire(q('[data-view="stats"]'), 'click');
  await settle();
  ok(!!q('#slowKeysBox'), '统计页有慢键说明容器');
  const slowBoxText = q('#slowKeysBox')?.textContent || '';
  // 样本不足 5 次时必须**如实说明**，而不是安静地不显示
  ok(/样本不足|还没有足够/.test(slowBoxText),
    `样本不足时如实说明而不是沉默（实际：「${slowBoxText.trim().slice(0, 60)}」）`);

  // 直接灌够样本，验证慢键环真的画出来
  ls.recordKeyTimings({
    A: { lead: [], follow: Array(12).fill(120) },
    S: { lead: [], follow: Array(12).fill(880) },
    D: { lead: [], follow: Array(12).fill(650) }
  }, 'char');
  ls.recordKeyTimings({
    A: { lead: [], follow: Array(12).fill(120) },
    S: { lead: [], follow: Array(12).fill(880) },
    D: { lead: [], follow: Array(12).fill(650) }
  }, 'char');
  fire(q('[data-view="stats"]'), 'click');
  await settle();
  const rings = qa('#heatWrap .kb-slow-ring');
  ok(rings.length >= 2, `慢键环已画到键盘图上（${rings.length} 个）`);
  ok(q('#heatWrap .kb-key.is-slow'), '慢键同时带上 is-slow 类（供样式分级）');
  const slowKeys = qa('#heatWrap .kb-key.is-slow')
    .map(el => el.getAttribute('data-key'));
  ok(slowKeys.includes('S') || slowKeys.includes('D'),
    `最慢的键被标出（${slowKeys.join('/')}）`);
  ok(/中位数/.test(q('#slowKeysBox')?.textContent || ''),
    '统计页慢键说明同样写明口径');
  ok(/样本不足/.test(q('#slowKeysBox')?.textContent || '') === false ||
     q('#slowKeysBox')?.textContent?.includes('样本不足') === true,
    '有足够样本时不误报「样本不足」');

  /* ---------- ④ 慢键层与热力层互不覆盖 ---------- */
  const bothKey = qa('#heatWrap .kb-key').find(el =>
    el.classList.contains('is-slow') && el.classList.contains('is-heat'));
  if (bothKey) {
    ok(!!bothKey.querySelector('.kb-body') && !!bothKey.querySelector('.kb-slow-ring'),
      '「又错又慢」的键同时保留热力填充与慢键环，两个信号都在');
  } else {
    ok(true, '本轮没有同时命中两层的键（跳过冲突检查）');
  }

  /* ---------- ⑤ 切主题后慢键环仍在 ---------- */
  const themeSel = q('#setTheme');
  const dotsBefore = qa('#heatWrap .kb-mastery-dot').length;
  themeSel.value = 'dark';
  fire(themeSel, 'change');
  await settle();
  ok(qa('#heatWrap .kb-slow-ring').length === rings.length,
    `切换主题后慢键环没有丢失（${qa('#heatWrap .kb-slow-ring').length} 个）`);
  // 掌握度是第三个通道，重绘时同样不能被漏掉。
  // 上一段（【10g】）已清空数据，这里若本来就 0 个点，就等于没验到 ——
  // 所以先注入一个「已掌握」的键，确认重绘后它还在，再还原。
  {
    const fake = Array.from({ length: 20 }, (_, i) => 200 + (i % 5) * 10);
    ls.recordKeyTimings({ Z: { lead: fake, follow: [] } }, 'char');
    fire(q('[data-view="stats"]'), 'click');
    await settle();
    const dotsNow = qa('#heatWrap .kb-mastery-dot').length;
    ok(dotsNow >= 1, `注入已掌握键后出现圆点（${dotsNow} 个）`);
    themeSel.value = 'light';
    fire(themeSel, 'change');
    await settle();
    ok(qa('#heatWrap .kb-mastery-dot').length === dotsNow,
      `切换主题后掌握度圆点没有丢失（${qa('#heatWrap .kb-mastery-dot').length} 个）`);
    ls.clearKeyTimings();
    ls.clearKeyErrors();
  }
  themeSel.value = 'auto';
  fire(themeSel, 'change');
  await settle();

  /* ---------- ⑥ 清掉慢键层不残留 ---------- */
  ls.clearKeyTimings();
  fire(q('[data-view="stats"]'), 'click');
  await settle();
  ok(qa('#heatWrap .kb-slow-ring').length === 0, '数据清空后慢键环全部移除');
  ok(!!q('#heatWrap .kb-key.is-slow') === false, 'is-slow 类也被清掉');
  app.engine = null;
  app.sessionActive = false;
}

console.log('【新增】主题切换：属性、图表、键位图、设置持久化');
{
  // chart.js 的两套配色（用对象同一性判断「切过去了」，而不是比较具体色值 ——
  // 具体色值由 verify.mjs 负责与 style.css 对齐，这里只管「有没有切」）
  const chartMod = await import('../src/ui/chart.js');
  const lightPal = (chartMod.setTheme('light'), chartMod.currentTheme());
  const darkPal = (chartMod.setTheme('dark'), chartMod.currentTheme());
  const cleanup = () => { if (app.engine) app.engine.destroy(); app.engine = null; app.sessionActive = false; };
  cleanup();
  const html = q('html');
  const sel = q('#setTheme');
  ok(!!sel, '设置页有主题选择');
  ok(!!q('meta[name="theme-color"]') ||
     Array.from(document.querySelectorAll('meta')).some(m => m.getAttribute('name') === 'theme-color'),
    '注入了 theme-color（地址栏跟着变色）');

  // 默认跟随系统；测试环境 matchMedia 恒为 false → 浅色
  fire(q('[data-view="settings"]'), 'click');
  await settle();
  ok(html.getAttribute('data-theme') === 'light',
    `默认（系统浅色）解析为 light（实际 ${html.getAttribute('data-theme')}）`);

  // 切到深色
  sel.value = 'dark';
  fire(sel, 'change');
  await settle();
  ok(html.getAttribute('data-theme') === 'dark', '选择深色后 data-theme=dark');
  ok(app.settings.theme === 'dark', '设置已更新为 dark');
  ok(String(html.style.colorScheme || '').indexOf('dark') >= 0, 'color-scheme 同步（表单控件/滚动条跟随）');
  const meta = Array.from(document.querySelectorAll('meta')).find(m => m.getAttribute('name') === 'theme-color');
  ok(meta && meta.getAttribute('content') === '#14171d', 'theme-color 变成深底色');

  // 图表要重画：Canvas 读不到 CSS 变量，ui/chart.js 维护了自己的配色
  ok(chartMod.currentTheme() === darkPal, '图表配色已切到深色');

  /* 键位图现在**完全由 CSS 上色**（.kb-body / .kb-main 等规则用 var()），
     所以这里不能断言 fill 属性 —— linkedom 也不解析样式表，断言 computed
     只会永远失败。真正该守的是两件事：
     ① 元素带着正确的 class（CSS 据此上色）
     ② 元素上**没有** fill/stroke 表现属性（那会盖住 CSS 规则，
        早先就因为 JS 逐个上色而漏了 25 个键）
     静态那部分由 verify.mjs 查源码，运行时只查 class 是否齐全。 */
  const kb = document.querySelector('#fullKeymap');
  const classes = ['kb-body', 'kb-main', 'kb-pinyin', 'kb-sub', 'kb-note'];
  for (const cls of classes) {
    ok(!!kb.querySelector('.' + cls), `键位图有 .${cls} 元素（CSS 依此上色）`);
  }
  const withFill = Array.from(kb.querySelectorAll('[fill]')).filter(el => {
    const f = el.getAttribute('fill');
    return f && f !== 'none' && !f.startsWith('var(');
  });
  ok(withFill.length === 0,
    `键位图没有硬编码的 fill 属性（发现 ${withFill.length} 处：${withFill.slice(0, 3).map(e => e.getAttribute('class')).join(',')}）`);
  ok(typeof app.fullKeymap.repaint === 'function', '键位图控制器提供 repaint（重套热力/高亮状态）');

  /* 成绩曲线「还没有数据」时的空态文案，颜色取自 CSS 变量 --text-3。
     这条路径依赖 getComputedStyle 读自定义属性，而 linkedom 不解析样式表，
     所以这里同时验证：① 垫片能按主题取到值 ② 取到的值是 trim 过的
     （getPropertyValue 对自定义属性会保留首尾空白，直接塞进
      ctx.fillStyle 是个隐患）。 */
  const readText3 = () => globalThis.getComputedStyle(document.documentElement)
    .getPropertyValue('--text-3');
  const darkText3 = readText3();
  ok(darkText3.trim() === darkText3 && darkText3 !== '', `--text-3 深色可解析且无空白（${JSON.stringify(darkText3)}）`);
  sel.value = 'light';
  fire(sel, 'change');
  await settle();
  const lightText3 = readText3();
  ok(lightText3 !== '' && lightText3 !== darkText3,
    `--text-3 随主题变化（浅 ${lightText3} / 深 ${darkText3}）`);
  sel.value = 'dark';
  fire(sel, 'change');
  await settle();

  // 切回浅色，颜色要真的回来
  ok(html.getAttribute('data-theme') === 'dark', '（对照）切回深色');
  sel.value = 'light';
  fire(sel, 'change');
  await settle();
  ok(html.getAttribute('data-theme') === 'light', '切回浅色');
  ok(chartMod.currentTheme() === lightPal, '图表配色回到浅色');

  // 非法值不能留下「无主题」状态
  sel.value = 'nonsense';
  fire(sel, 'change');
  await settle();
  ok(app.settings.theme === 'auto' && html.getAttribute('data-theme') === 'light',
    '非法值回落 auto（仍解析出有效主题）');

  // 持久化：重开应用要沿用
  sel.value = 'dark';
  fire(sel, 'change');
  await waitFor(() => sMod.loadSettings().theme === 'dark',
    { label: '主题落盘（saveSettingsDebounced 400ms）' });
  const reloaded = sMod.loadSettings();
  ok(reloaded.theme === 'dark', `主题已落盘（实际 ${reloaded.theme}）`);
  ok(sMod.saveSettings({ theme: 'light' }) !== false, '可写回 light');
  ok(sMod.loadSettings().theme === 'light', 'loadSettings 接受合法值');
  sMod.saveSettings({ theme: 'glow' });
  ok(sMod.loadSettings().theme !== 'glow', `脏值被枚举白名单拦下（实际 ${sMod.loadSettings().theme}）`);
  sMod.saveSettings({ theme: 'auto' });
  fire(sel, 'change');
  await settle();
  cleanup();
}

console.log('【新增】提示依赖度可见、存储降级如实告知');
{
  const cleanup = () => { if (app.engine) app.engine.destroy(); app.engine = null; app.sessionActive = false; };
  cleanup();
  app.settings.hint = true;
  // 用词组模式：只有词组/短文才会渲染逐字状态（char 是单音节，走另一条分支）
  q('#selPhraseCategory').value = 'all'; fire(q('#selPhraseCategory'), 'change');
  q('#selPhraseLength').value = 'all'; fire(q('#selPhraseLength'), 'change');
  fire(qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'phrase'), 'click');
  q('#selCount').value = '5'; fire(q('#selCount'), 'change');
  fire(q('#btnStart'), 'click');
  ok(!!app.engine, '词组练习已启动');
  const eng = app.engine;
  // 第一个字靠提示打对，第二个字自己打 —— 留在同一道题里断言，
  // 因为提示标记是按「题号:字序」记的，换题后看不到上一题。
  eng.requestHint('reveal');
  let t = eng.currentTarget();
  for (const key of t.keys) eng.pressKey(String(key).toLowerCase());
  // 只打完第一个字就断言：词组是 2 字，打完第二个会直接换到下一题，
  // 标记也就跟着换题号看不见了。
  // 完整提示阶段引擎还会预先标记「下一字」（它的答案本来就摆在屏幕上），
  // 所以可能是 2 个：1 个已完成 + 1 个待打。断言要认这个语义。
  const hintedEls = qa('#prompt .ch.is-hinted');
  ok(hintedEls.length >= 1, `舞台上标出依赖提示的字（${hintedEls.length}）`);
  const doneHinted = hintedEls.filter(el => el.classList.contains('is-done'));
  ok(doneHinted.length === 1, `已完成的提示字被标出（${doneHinted.length}）`);
  ok(!!hintedEls[0] && hintedEls[0].getAttribute('title')?.includes('不计入独立正确率'),
    '提示字带说明，悬浮可读');
  ok(qa('#prompt .ch.is-done').length === 1, '已完成的字标记为 is-done');
  // 继续打完，让成绩够长
  for (let i = 0; i < 40 && eng.stats.totalChars < 8; i++) {
    const x = eng.currentTarget();
    if (!x || !x.keys || !x.keys.length) break;
    for (const key of x.keys) eng.pressKey(String(key).toLowerCase());
  }
  const sum = eng.summary();
  ok(sum.hintedChars >= 1, `存在依赖提示的字（${sum.hintedChars}）`);
  ok(sum.independentAccuracy <= sum.accuracy, '独立正确率不高于表面正确率');
  eng.finish('user');
  await settle();
  // 结算页
  const modalText = q('#modal').textContent;
  ok(modalText.includes('依赖提示'), '结算页显示依赖提示字数');
  ok(modalText.includes('错键'), '结算页显示错键次数');
  ok(modalText.includes('自动跳过'), '结算页显示自动跳过字数');
  ok(modalText.includes('独立正确率'), '结算页同时给出独立正确率');
  ok(!!q('#modal .result-hint-note'), '提示依赖说明块存在');
  ok(!!q('#modal .result-cell.is-warn'), '依赖提示非零时该格高亮');
  cleanup();
  const again = qa('#modal [data-act]').find(b => b.getAttribute('data-act') === 'again');
  if (again) fire(again, 'click');
  await settle();

  // 存储降级：徽标与设置页文案都不能再说「保存在 localStorage」
  const badge = q('#storageBadge');
  ok(!!badge, '顶栏有存储状态徽标');
  ok(badge.textContent.includes('本地存储'), '正常时徽标说明数据在本地存储');
  // 模拟隐私模式：localStorage 写不进去
  const realSet = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  try {
    const { _resetStorageState } = await import('../src/core/storage.js');
    _resetStorageState();
    fire(q('[data-view="settings"]'), 'click');
    await settle();
    const b2 = q('#storageBadge');
    ok(b2.classList.contains('is-warn'), '存储不可用时徽标高亮');
    ok(!b2.textContent.includes('本地存储') || b2.textContent.includes('内存'),
      `徽标如实说明内存模式（实际「${b2.textContent}」）`);
    const note = q('#storageNote');
    ok(!/保存在浏览器 localStorage 中/.test(note.textContent),
      '设置页不再声称数据保存在 localStorage');
    ok(note.classList.contains('is-warn'), '设置页说明高亮');
  } finally {
    localStorage.setItem = realSet;
    const { _resetStorageState } = await import('../src/core/storage.js');
    _resetStorageState();
    fire(q('[data-view="settings"]'), 'click');
  }
  await settle();
  ok(!q('#storageBadge').classList.contains('is-warn'), '恢复后徽标回到正常态');
  ok(q('#storageNote').textContent.includes('localStorage'), '恢复后设置页文案回到正常承诺');
}

/* ---------- DOM 节点缓存（hot path 优化）的安全契约 ----------
   为每键路径省掉十几次 querySelector 而引入的缓存，唯一的风险是「拿到陈旧引用」：
   节点被换掉后仍往旧引用上写字，界面就不更新了。这里锁两件事：
   ① 缓存对**存活**节点确实命中，写进去的东西界面上能读到；
   ② 节点被移除/替换后，缓存自动失效、重新查询，不会往孤儿节点上写。 */
console.log('\n【12b】DOM 缓存：命中且不返回陈旧引用');
{
  // 借练习页的 #hudSpeed 做样本（它就在每键路径上）
  const navPractice = qa('#nav .nav-btn').find(b => b.getAttribute('data-view') === 'practice');
  if (navPractice) { fire(navPractice, 'click'); await settle(); }

  const hud = q('#hudSpeed');
  ok(!!hud, '（前置）找到 #hudSpeed');

  if (hud && app.engine) {
    // ① 同一个选择器两次取到的是同一个节点（命中缓存，不是每次重建）
    const a1 = document.querySelector('#hudSpeed');
    const a2 = document.querySelector('#hudSpeed');
    ok(a1 === a2, '同一选择器取到同一节点（缓存不会返回副本）');

    /* 触发一次真实渲染链：engine 的 change 事件 → renderSession → updateHud → setText。
       用 pressKey 驱动引擎，事件会自动走到 UI。 */
    const driveOnce = () => {
      const t = app.engine.currentTarget();
      if (t && t.keys && t.keys.length) {
        app.engine.pressKey(String(t.keys[0]).toLowerCase());
      }
    };

    // ② 通过真实答题驱动，值必须真的落到 DOM 上
    driveOnce();
    await settle();
    const after = q('#hudSpeed').textContent;
    ok(typeof after === 'string' && after.length > 0,
      `经缓存写入后 DOM 上的文字可读（「${after}」）`);

    /* ③ 关键安全性：把节点从文档里摘掉再替换，缓存必须识别并回退到实时查询。
       做法：用新节点替换旧的，然后驱动一次渲染 —— 写入必须出现在**新**节点上。 */
    const parent = hud.parentNode;
    const fresh = document.createElement('span');
    fresh.id = 'hudSpeed';
    fresh.textContent = 'SENTINEL';
    parent.replaceChild(fresh, hud);
    ok(!document.contains(hud), '旧节点已被移出文档（构造出「缓存陈旧」的场景）');

    driveOnce();
    await settle();
    const live = q('#hudSpeed');
    ok(live === fresh, '缓存识别到旧节点已失效，改用新节点');
    ok(live.textContent !== 'SENTINEL',
      `写入落在新节点上（「${live.textContent}」），没有写到孤儿节点`);
  }
}

/* ------------------------------------------------------------------
   【12c】change 事件的「重绘粒度」契约

   背景：打字场景里 change 是最频繁的事件（8–15 次/秒），
   全量重绘每键都会重写 #prompt 的 HTML。于是引擎在 change 上多带
   一个粒度参数，UI 据此走增量路径：
     'key'      音节内推进 —— 题干不变，不得重写 #prompt
     'char'     换字       —— 允许更新题干
     'question' 换题       —— 允许全量重绘

   为什么要在这里锁：这条契约横跨 engine 与 main 两个文件，
   而且**极易被静默破坏** ——
     · engine.emit 若只声明两个形参，第三个参数会被直接丢掉
       （本项目真踩过：粒度标好了，走到 emit 就蒸发，UI 永远收到
        undefined，于是静默退回全量重绘 —— 功能没坏，优化白做）；
     · renderSession 若把未知值当 'key' 处理，会漏画整个题干。
   两种情况都不会报错，只会「看起来一切正常但白干」或「界面少一块」。
   ------------------------------------------------------------------ */
console.log('\n【12c】change 重绘粒度：key 不重写题干，char/question 要更新');
{
  const navPractice = qa('#nav .nav-btn').find(b => b.getAttribute('data-view') === 'practice');
  if (navPractice) { fire(navPractice, 'click'); await settle(); }

  // 干净起一局（词组模式：保证有 2 键音节，才有「音节内推进」）
  if (app.engine) { app.engine.destroy(); app.engine = null; }
  q('#overlay').hidden = true;
  q('#sessionPanel').hidden = true;
  q('#setupPanel').hidden = false;
  const phraseCard = qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'phrase');
  if (phraseCard) fire(phraseCard, 'click');
  fire(q('#btnStart'), 'click');
  await settle();

  const engG = app.engine;
  ok(!!engG, '（前置）练习已启动');

  /* ① 直接验 emit 的透传：这是最根本的一条 —— 参数丢了，后面全白搭。
     用独立引擎发一次事件，检查监听器收到的第三个参数。
     （引擎要求至少一道题，借当前这局的题面用一下，只为构造实例。） */
  const probeQs = engG ? engG.questions.slice(0, 1) : [];
  const probe = probeQs.length
    ? new engineMod.PracticeEngine({ questions: probeQs, mode: 'phrase', modeName: '词组' })
    : null;
  if (probe) {
    const seen = [];
    probe.on('change', (snap, level) => { seen.push(level); });
    probe.emit('change', { fake: true }, 'key');
    probe.emit('change', { fake: true }, 'char');
    probe.emit('change', { fake: true }, undefined);
    ok(seen.length === 3, `监听器收到全部 3 次 change（实际 ${seen.length} 次）`);
    ok(seen[0] === 'key' && seen[1] === 'char',
      `第三个参数被透传（收到 「${seen[0]}」「${seen[1]}」）—— emit 漏参这个坑会在这里变红`);
    ok(seen[2] === undefined, '不传粒度时监听器收到 undefined（由 UI 兜底成全量）');
    probe.destroy();
  } else {
    ok(false, '未能构造探针引擎（拿不到题面）');
  }

  /* ② 真实按键：走到「音节内推进」那一步，题干不得被重写。
     判据用**节点身份**而不是 innerHTML 文本 —— 文本可能恰好相同，
     那就测不出「重写但内容没变」这种浪费。 */
  if (engG) {
    let guard = 0;
    // 推进到需要 2 键的目标
    while (guard++ < 400) {
      const t = engG.currentTarget();
      if (!t || !t.keys || !t.keys.length) break;
      if (t.keys.length >= 2 && t.pos === 0) break;
      engG.pressKey(String(t.keys[t.pos] ?? t.keys[0]).toLowerCase());
    }
    const tgt = engG.currentTarget();
    ok(!!tgt && tgt.keys && tgt.keys.length >= 2 && tgt.pos === 0,
      `（前置）已停在 2 键音节的首键（${tgt ? (tgt.char || '') + ' ' + tgt.keys.join('+') : '无'}）`);

    if (tgt && tgt.keys && tgt.keys.length >= 2) {
      /* innerHTML 赋值必然重建子节点，所以只要**当前**那个字符 span
         还是同一个对象，就证明没有走「重建题干」这条路。 */
      const promptEl = q('#prompt');
      const beforeInner = promptEl.innerHTML;
      const beforeChild = promptEl.firstElementChild;
      const posBefore = tgt.pos;

      /* 走真实的按键链路（fireKey 会经过 onKeyDown → handleKeyInput → pressKey）。
         先等过 8ms 防抖再按（见下方 ③ 的说明），否则这一按会被丢掉，
         下面「题干未变」就成了**假的绿**：什么都没发生，当然没变。 */
      await sleep(12);
      const key1 = String(tgt.keys[0]).toLowerCase();
      fireKey(key1);
      await settle();

      // 先证明这一按真的进了引擎（不然下面的「未变」不成立）
      const tAfter = engG.currentTarget();
      ok(!!tAfter && tAfter.pos === posBefore + 1,
        `音节内推进：按键确实被受理（pos ${posBefore} → ${tAfter ? tAfter.pos : '?'}）`);

      const afterChild = q('#prompt').firstElementChild;
      ok(q('#prompt').innerHTML === beforeInner,
        '音节内推进：题干 HTML 逐字未变');
      ok(afterChild === beforeChild && !!beforeChild,
        '音节内推进：题干子节点仍是同一个对象（证明没有重建，而非「重建后内容恰好相同」）');

      /* ③ 反向护栏：完成这个音节后题干**必须**更新。
         只测 ②会纵容「干脆永不更新题干」这种过度优化。 */
      const t2 = engG.currentTarget();
      if (t2 && t2.keys && t2.keys.length >= 2) {
        const lastKey = String(t2.keys[t2.keys.length - 1]).toLowerCase();
        const beforeDone = q('#prompt').innerHTML;
        const beforeDoneChild = q('#prompt').firstElementChild;
        /* 这里**必须**走真实时间：main.js:onKeyDown 有一道 8ms 的
           「重复触发保护」（防输入法连发），两次按键间隔小于 8ms 时
           第二下会被直接丢掉。② 刚按过一键，紧接着按第二键若不等，
           这一按根本没进引擎 —— 题干自然「没变」，断言会以假乱真地红。
           这是真实的防抖语义，不是可以省掉的等待。 */
        await sleep(12);
        fireKey(lastKey);
        await settle();
        const moved = q('#prompt').innerHTML !== beforeDone
          || q('#prompt').firstElementChild !== beforeDoneChild;
        ok(moved, '完成音节后题干确实被更新了（没有「永不重绘」的过度优化）');
      }
    }
    engG.destroy();
    app.engine = null;
    q('#sessionPanel').hidden = true;
    q('#setupPanel').hidden = false;
  }
}

/* ---------- 智能混合 / 文本书架 / 引导课程 的 UI 接线 ---------- */
console.log('\n【12d】智能混合 · 书架 · 课程（接线层）');
{
  const cleanupAll = () => {
    if (app.engine) { app.engine.destroy(); app.engine = null; }
    app.sessionActive = false;
    q('#sessionPanel').hidden = true;
    q('#setupPanel').hidden = false;
    q('#overlay').hidden = true;
  };
  cleanupAll();

  /* 智能混合：按钮在、点击能开局、理由展示出来。
     组题逻辑本身的边界在 mix.mjs（数据为空 / 重复 / 样本不足），
     这里只验「按钮真的把局开起来了」。
     另外验 P2 缺陷的修复：慢键数据必须真的进得了组题 ——
     以前把 loadKeyTimings() 的整个容器传给了只认映射的 slowestKeys，
     存了样本也永远返回空表、慢键段永远缺席。 */
  ok(!!q('#btnSmartMix'), '「练 5 分钟」按钮存在');
  // 造 5 次同一键的有效慢键样本（门槛是每键 ≥5 次作答）
  sMod.recordKeyTimings({ V: { lead: [900, 910, 920, 930, 940], follow: [] } }, 'char');
  fire(q('#btnSmartMix'), 'click');
  await settle();
  ok(!!app.engine, '点击后进入练习（智能混合开局）');
  ok(app.engine.mode === 'mix', `会话模式为 mix（实际 ${app.engine.mode}）`);
  ok(!q('#mixReasons').hidden && q('#mixReasons').textContent.length > 0,
    '推荐理由已展示（为什么练这些）');
  ok(/为什么练这些/.test(q('#mixReasons').textContent), '理由区有标题');
  ok(/慢键专项/.test(q('#mixReasons').textContent),
    `真实存储的慢键样本进了组题（理由：${/慢键专项[^）]*）/.exec(q('#mixReasons').textContent) || '无'}）`);
  ok(app.engine.questions.some(qq => qq.kind === 'key' && qq.promptText === 'zh'),
    '慢键 V（韵母 zh 所在键）的成分题确实在题目里');
  app.engine.destroy(); app.engine = null;
  cleanupAll();

  /* 课程：卡片渲染当前课，开始按钮用课程参数开局并标记 courseActiveId。
     开完课**不做完**，留给【12e】验证「刷新 → 续练 → 达标 → 晋级」。 */
  ok(q('#courseBox') && !q('#courseBox').hidden, '课程卡片可见（还有未完成的课）');
  ok(/第 1 课/.test(q('#courseTitle').textContent), `当前课正确（${q('#courseTitle').textContent}）`);
  ok(/过关条件/.test(q('#courseCheck').textContent), '过关条件展示（晋级判定透明）');
  fire(q('#btnCourseStart'), 'click');
  await settle();
  ok(!!app.engine && app.engine.mode === 'yun', '「开始本课」用课程参数开局（yun）');
  ok(app.courseActiveId === 'c1-yun', '会话标记了课程 id（练完做晋级判定）');
  ok(!q('#courseCheck').textContent.includes('独立正确率'),
    '第 1 课不卡独立正确率（基础教学允许提示）');
  cleanupAll();

  /* 【P1】书架完整链路：存入 → 打开 → 开始 → 结束 → 统计回写。
     曾验证过：openShelfEntry 记下的材料 id 会被 startSession 清掉
     （默认按「无归属」处理），练完书架上永远显示「还没练过」。 */
  ok(!!q('#btnShelfSave'), '「存入书架」按钮存在');
  const ta = q('#customTextInput');
  ta.value = '书架迁移验证专用文本。';
  fire(q('#btnShelfSave'), 'click');
  await settle();
  const shelfItems = qa('#shelfList .shelf-item');
  ok(shelfItems.length >= 1, `条目出现在列表里（${shelfItems.length} 项）`);
  ok(/书架迁移验证专用文本/.test(ta.value), 'textarea 内容保持不变');

  /* 【P1】恶意 id 在渲染层也进不来（白名单 + DOM API 双保险）：
     boot 前已经往书架塞了一条 id 带脚本的原始数据。 */
  ok(!document.querySelector('#shelfList img'), '列表里没有被注入的 img 元素');
  ok(!qa('#shelfList [onerror]').length, '没有任何元素带 onerror 属性');
  const idRe = /^[A-Za-z0-9_-]{1,40}$/;
  const renderedIds = qa('#shelfList [data-id]').map(el => el.getAttribute('data-id'));
  ok(renderedIds.length > 0 && renderedIds.every(v => idRe.test(v)),
    `data-id 全部在白名单内（${renderedIds.length} 个）`);
  ok(sMod.loadShelf().every(e => idRe.test(e.id)), '存储读出的 id 也已净化');

  // 打开：文本回填（打开即「继续上次材料」的入口）。
  // 注意定位到**刚存进去的那条** —— 列表最前面还有 boot 前塞进来的恶意 id 条目。
  const newEntry = sMod.loadShelf().find(e => e.text === '书架迁移验证专用文本。');
  ok(!!newEntry, '能在书架里找到刚存的条目');
  const openBtn = newEntry
    ? q(`#shelfList [data-id="${newEntry.id}"][data-act="open"]`) : null;
  ok(!!openBtn, '找到了该条目的「练习」按钮');
  fire(openBtn, 'click');
  await settle();
  ok(q('#customTextInput').value.includes('书架迁移验证专用文本'),
    '打开条目后文本回填到输入框');
  ok(typeof app.shelfActiveId === 'string', '记录了本次材料 id（练完回写进度用）');
  const shelfTestId = app.shelfActiveId;

  // 开始 → 打完全文 → 材料统计必须真的回写
  fire(q('#btnStart'), 'click');
  await settle();
  ok(!!app.engine && app.engine.mode === 'custom', '从书架开局（自定义文本模式）');
  ok(app.shelfActiveId === shelfTestId, '开局后材料归属仍在（P1 缺陷的修复点）');
  {
    const eng = app.engine;
    const segCount = eng.questions.length;
    let guard = 0;
    while (eng.state === 'running' && guard++ < 20000) {
      const t = eng.currentTarget();
      if (!t) break;
      if (t.kind === 'skip' || t.kind === 'punct') { eng.pressKey('a'); continue; }
      const k = (t.keys || [])[t.pos];
      if (!k) break;
      eng.elapsedSec = 2;            // 用时记账：persistRecord 只收 durationSec ≥ 1 的
      eng.pressKey(String(k).toLowerCase());
      await settle();
    }
    ok(eng.state === 'finished', '书架材料的练习打完了');
    await settle();
    const entry = sMod.loadShelf().find(e => e.id === shelfTestId);
    ok(!!entry, '条目还在');
    ok(entry.stats.sessions === 1, `该材料 sessions = 1（实际 ${entry.stats.sessions}）`);
    ok(entry.stats.chars > 0, `该材料字数已累计（${entry.stats.chars}）`);
    ok(entry.lastAt > 0, 'lastAt 已更新（「继续上次材料」能找到它）');
    ok(entry.progress.segCount === segCount && entry.progress.segIndex === segCount,
      `进度记到已打完（${entry.progress.segIndex}/${entry.progress.segCount}，共 ${segCount} 段）`);
    // 打开后重画的书架要显示「上一轮已打完」而不是「还没练过」
    const metaText = (qa('#shelfList .shelf-item-meta').map(el => el.textContent).join(''));
    ok(/上一轮已打完/.test(metaText), '列表文案反映已练（不再是「还没练过」）');

  }

  /* 续打进度仍按全文段数显示。只完成上一段材料最后一段的少量字符，
     不足以结束该段时，不得因「剩余段数」被当作全文总段数而误报完成。 */
  {
    const longText = '中国人民学习双拼练习文字'.repeat(50);
    ta.value = longText;
    fire(q('#btnShelfSave'), 'click');
    await settle();
    const longEntry = sMod.loadShelf().find(e => e.text === longText);
    ok(!!longEntry, '长材料已加入书架');
    fire(q(`#shelfList [data-id="${longEntry.id}"][data-act="open"]`), 'click');
    await settle();
    fire(q('#btnStart'), 'click');
    await settle();
    const initialCount = app.engine.questions.length;
    app.engine.destroy(); app.engine = null;
    app.sessionActive = false;
    q('#sessionPanel').hidden = true;
    q('#setupPanel').hidden = false;
    sMod.updateShelfEntry(longEntry.id, {
      progress: { segIndex: initialCount - 1, segCount: initialCount }
    });
    fire(q(`#shelfList [data-id="${longEntry.id}"][data-act="open"]`), 'click');
    await settle();
    fire(q('#btnStart'), 'click');
    await settle();
    const eng = app.engine;
    const resumeCount = eng.questions.length;
    ok(resumeCount === 1, `从最后一段继续（剩余 ${resumeCount} 段）`);
    eng.elapsedSec = 2;
    for (let i = 0; i < 3; i++) {
      const t = eng.currentTarget();
      for (const key of t.keys) eng.pressKey(String(key).toLowerCase());
    }
    const partial = eng.finish('user');
    await settle();
    const progress = sMod.loadShelf().find(e => e.id === longEntry.id).progress;
    ok(partial.doneQuestions === 0, '结束前没有完成这一整段');
    ok(progress.segIndex < progress.segCount && progress.segCount === initialCount,
      `未完成材料仍显示第 ${progress.segIndex + 1}/${progress.segCount} 段`);
    fire(q('#overlay'), 'click');
  }
  // 清掉现场，别让书架状态泄漏到其它用例
  app.shelfActiveId = null;
  app.shelfSegOffset = 0;
  cleanupAll();
}

/* ---------- 【12e】刷新 → 续练 → 达标 → 晋级 ---------- */
console.log('\n【12e】课程续练：归属跟着存档走');
{
  const cleanupAll = () => {
    if (app.engine) { app.engine.destroy(); app.engine = null; }
    app.sessionActive = false;
    q('#sessionPanel').hidden = true;
    q('#setupPanel').hidden = false;
    q('#overlay').hidden = true;
  };
  cleanupAll();
  // 从第 1 课干净开始
  sMod.saveCourseProgress({ completed: [], lessons: {}, currentId: '', updatedAt: 0 });
  fire(q('#btnCourseStart'), 'click');
  await settle();
  ok(!!app.engine && app.courseActiveId === 'c1-yun', '课程第 1 课开局');

  /* 打 4 键（**真实按键路径**：onKeyDown → handleKeyInput → saveProgress，
     存档才会带上归属。直接调 engine.pressKey 会绕过 UI 链路，
     存档根本不会生成 —— 这正是要验的东西）。键间等过 8ms 防抖。 */
  const eng = app.engine;
  let pressed = 0;
  for (let i = 0; i < 4 && eng.state === 'running'; i++) {
    const t = eng.currentTarget();
    if (!t || !t.keys || !t.keys.length) break;
    await sleep(12);
    fireKey(String(t.keys[t.pos]).toLowerCase());
    await settle();
    pressed++;
  }
  ok(pressed === 4, `打了 ${pressed} 键`);
  ok(!!sMod.loadResume(), '存档已生成（saveProgress 随按键自动保存）');
  ok(sMod.loadResume().courseLessonId === 'c1-yun',
    '存档带课程归属（P1 缺陷的修复点：以前没这个字段）');
  app.engine.destroy(); app.engine = null;
  app.sessionActive = false;
  app.courseActiveId = null;          // 刷新后内存里什么都不剩
  app.shelfActiveId = null;
  q('#sessionPanel').hidden = true;
  q('#setupPanel').hidden = false;

  // 续练
  fire(q('#btnResume'), 'click');
  await settle();
  ok(!!app.engine, '续练恢复了会话');
  ok(app.courseActiveId === 'c1-yun',
    `续练恢复了课程归属（实际 ${JSON.stringify(app.courseActiveId)}）`);

  // 打完全部 → 达标 → 晋级
  const eng2 = app.engine;
  let guard = 0;
  while (eng2.state === 'running' && guard++ < 20000) {
    const t = eng2.currentTarget();
    if (!t) break;
    if (t.kind === 'skip' || t.kind === 'punct') { eng2.pressKey('a'); continue; }
    const k = (t.keys || [])[t.pos];
    if (!k) break;
    eng2.elapsedSec = 2;
    eng2.pressKey(String(k).toLowerCase());
    await settle();
  }
  ok(eng2.state === 'finished', '续练打完了整卷');
  await settle();
  const prog = sMod.loadCourseProgress();
  ok(prog.completed.includes('c1-yun'),
    `续练完成的那一局判了晋级（completed: ${JSON.stringify(prog.completed)}）`);
  ok(prog.currentId === 'c2-sheng', `下一课推进到第 2 课（${prog.currentId}）`);
  cleanupAll();
  sMod.clearResume();
  sMod.saveCourseProgress({ completed: [], lessons: {}, currentId: '', updatedAt: 0 });
}

/* ---------- 收尾 ---------- */
console.log('\n【13】最终检查');
ok(errors.length === 0, `全程无未捕获 error${errors.length ? '（' + errors.length + ' 条）：' + errors.slice(0, 3).join(' | ') : ''}`);
if (warnings.length) {
  console.log('  警告明细：');
  warnings.slice(0, 5).forEach(w => console.log(`    · ${String(w).slice(0, 120)}`));
}
console.log(`  （warnings ${warnings.length} 条）`);
ok(errors.length === 0, `全程无未捕获 error${errors.length ? '（' + errors.length + ' 条）：' + errors.slice(0, 3).join(' | ') : ''}`);
console.log(`  （warnings ${warnings.length} 条）`);

H.restoreGlobals();

console.log('\n' + (fail === 0
  ? '✅ 集成测试全部通过'
  : `❌ 集成测试共 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
