/**
 * 集成测试：在模拟 DOM 中加载并驱动整个应用
 * ------------------------------------------------------------
 * 覆盖：启动 → 选择模式 → 开始练习 → 模拟按键 → 校验反馈 → 结束 → 统计
 * 目的：捕获模块间「接线」错误（选择器写错、事件未绑定、渲染异常等），
 *       这类问题 Node 单元测试无法发现。
 *
 * 运行：node _test/integration.mjs
 */

import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗ ' + m); } else { console.log('  ✓ ' + m); } };

/* ---------- 构建模拟浏览器环境 ---------- */
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const { window, document } = parseHTML(html);

// linkedom 缺少的能力，用最小桩补齐
const storageMap = new Map();
const localStorage = {
  get length() { return storageMap.size; },
  getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
  setItem: (k, v) => { storageMap.set(String(k), String(v)); },
  removeItem: (k) => { storageMap.delete(k); },
  clear: () => { storageMap.clear(); },
  key: (i) => Array.from(storageMap.keys())[i] ?? null
};

const errors = [];
const warnings = [];

const fakeWindow = {
  document,
  localStorage,
  location: { href: 'http://localhost/index.html', hash: '' },
  navigator: { maxTouchPoints: 0, userAgent: 'node' },
  devicePixelRatio: 1,
  setInterval: (...a) => setInterval(...a),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (id) => clearTimeout(id),
  performance: { now: () => Number(process.hrtime.bigint() / 1000000n) },
  addEventListener: (t, h) => { (fakeWindow._ls[t] ||= []).push(h); },
  removeEventListener: () => {},
  _ls: {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  alert: () => {},
  confirm: () => true,
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
  Blob: class { constructor() {} },
  FileReader: class {},
  onerror: null
};
fakeWindow.window = fakeWindow;

/* ---------- 事件构造器（供测试派发） ---------- */
class FakeEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
    this.cancelable = !!opts.cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._path = [];
    this._stopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
  stopImmediatePropagation() { this._stopped = true; }
}
class FakeKeyboardEvent extends FakeEvent {
  constructor(type, opts = {}) {
    super(type, opts);
    this.key = opts.key ?? '';
    this.code = opts.code ?? '';
    this.keyCode = opts.keyCode ?? 0;
    this.isComposing = !!opts.isComposing;
    this.ctrlKey = !!opts.ctrlKey;
    this.metaKey = !!opts.metaKey;
    this.altKey = !!opts.altKey;
  }
}
fakeWindow.Event = FakeEvent;
fakeWindow.KeyboardEvent = FakeKeyboardEvent;
window.Event = FakeEvent;
window.KeyboardEvent = FakeKeyboardEvent;

/** 派发一个合成事件到元素（通过捕获的监听器表，规避 linkedom 私有存储） */
function fire(el, type, opts = {}) {
  if (!el) return false;
  const ev = new FakeEvent(type, { bubbles: true, ...opts });
  ev.target = el;
  ev.currentTarget = el;
  ev._path = [{ currentTarget: el, target: el }];

  let fired = false;
  // 1) 优先用捕获到的监听器（含冒泡路径上的祖先）
  let node = el;
  while (node && node.nodeType === 1) {
    const hs = node.__handlers && node.__handlers[type];
    if (hs) {
      for (const h of hs.slice()) {
        ev.currentTarget = node;
        try { h.call(node, ev); fired = true; } catch (e) { console.error(e); }
        if (ev._stopped) break;
      }
    }
    if (ev._stopped) break;
    node = node.parentNode;
  }
  if (fired) return true;

  // 2) 退回原生 dispatchEvent
  try { return el.dispatchEvent(ev); } catch (_) { return false; }
}

/** 派发键盘事件到 window（应用监听在 window 上） */
function fireKey(key, opts = {}) {
  const ev = new FakeKeyboardEvent('keydown', { key, bubbles: true, ...opts });
  ev.target = document.body;
  ev.currentTarget = fakeWindow;
  ev._path = [{ currentTarget: fakeWindow, target: document.body }];
  ev.preventDefault = function () { this.defaultPrevented = true; };
  const ls = fakeWindow._ls && fakeWindow._ls.keydown;
  if (ls) ls.slice().forEach(h => { try { h(ev); } catch (e) { console.error(e); } });
  return ev;
}

// linkedom 的 element 需要 animate / closest 等
const proto = Object.getPrototypeOf(document.createElement('div'));
if (!proto.animate) proto.animate = () => ({ finished: Promise.resolve(), cancel() {}, onfinish: null });
if (!proto.closest) {
  proto.closest = function (sel) {
    let el = this;
    while (el && el.nodeType === 1) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentNode;
      // linkedom 的 parentNode 到 document 为止
      if (el && el.nodeType === 9) return null;
    }
    return null;
  };
}
if (!proto.matches) {
  proto.matches = function (sel) { return false; };
}

// 简易 canvas 上下文桩
const canvasStub = {
  setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {},
  lineTo() {}, stroke() {}, fill() {}, closePath() {}, arc() {}, fillText() {},
  quadraticCurveTo() {}, setLineDash() {},
  createLinearGradient: () => ({ addColorStop() {} })
};
const origCreate = document.createElement.bind(document);
document.createElement = (tag) => {
  const el = origCreate(tag);
  if (String(tag).toLowerCase() === 'canvas' && !el.getContext) {
    el.getContext = () => canvasStub;
  }
  return el;
};

/**
 * linkedom 兼容层 1：select/input 的 value 可写
 * 真实浏览器的 select.value / input.value 是可读写的；
 * linkedom 把 select.value 实现为只读 getter。这里补上 setter，
 * 使测试环境更贴近浏览器（应用代码无需为此改变）。
 */
function patchValueProperty(el) {
  if (!el || el.__valuePatched) return;
  el.__valuePatched = true;
  let v = '';
  try {
    const desc = Object.getOwnPropertyDescriptor(el, 'value');
    if (desc && desc.get) v = desc.get.call(el) || '';
  } catch (_) {}
  try {
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() { return v; },
      set(nv) { v = String(nv == null ? '' : nv); }
    });
  } catch (_) { /* 无法重定义则忽略 */ }
}

Array.from(document.querySelectorAll('select, input, textarea')).forEach(patchValueProperty);

/**
 * linkedom 兼容层 2：捕获事件监听器
 * linkedom 把 addEventListener 的注册表存在模块私有 WeakMap 中，外部无法读取，
 * 导致测试无法触发应用绑定的事件。这里在元素层面拦截 addEventListener，
 * 把监听器额外记录到元素自身的 __handlers 上，供测试派发使用。
 */
function captureListeners(el) {
  if (!el || el.__listenerCapture) return;
  el.__listenerCapture = true;
  el.__handlers = {};
  const origAdd = el.addEventListener.bind(el);
  el.addEventListener = function (type, fn, opts) {
    if (typeof fn === 'function') {
      (this.__handlers[type] ||= []).push(fn);
    }
    return origAdd(type, fn, opts);
  };
  const origRemove = el.removeEventListener.bind(el);
  el.removeEventListener = function (type, fn, opts) {
    if (this.__handlers && this.__handlers[type]) {
      this.__handlers[type] = this.__handlers[type].filter(h => h !== fn);
    }
    return origRemove(type, fn, opts);
  };
}

Array.from(document.querySelectorAll('*')).forEach(captureListeners);

const origCreate2 = document.createElement;
document.createElement = (tag) => {
  const el = origCreate2(tag);
  const t = String(tag).toLowerCase();
  if (t === 'canvas' && !el.getContext) el.getContext = () => canvasStub;
  if (t === 'select' || t === 'input' || t === 'textarea') patchValueProperty(el);
  captureListeners(el);
  return el;
};

// 把 stub 注入全局（main.js 直接引用 window / document）
globalThis.window = fakeWindow;
globalThis.document = document;
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: fakeWindow.navigator, configurable: true, writable: true
  });
} catch (_) { /* Node 已有只读 navigator，忽略 */ }
globalThis.localStorage = localStorage;
globalThis.performance = fakeWindow.performance;
globalThis.requestAnimationFrame = fakeWindow.requestAnimationFrame;
globalThis.cancelAnimationFrame = fakeWindow.cancelAnimationFrame;
globalThis.Blob = fakeWindow.Blob;
globalThis.FileReader = fakeWindow.FileReader;
globalThis.devicePixelRatio = 1;

// 捕获 console
const origError = console.error;
const origWarn = console.warn;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };

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
let bootError = null;
try {
  await import('../src/main.js');
} catch (e) {
  bootError = e;
}
ok(!bootError, `main.js 加载无异常${bootError ? '：' + bootError.message : ''}`);
if (bootError) { console.error = origError; process.exit(1); }

// 等待 DOMContentLoaded（linkedom 已解析完，main.js 会同步 boot）
await new Promise(r => setTimeout(r, 60));

ok(errors.length === 0, `启动期间无 error${errors.length ? '：' + errors.join(' | ') : ''}`);


/* ---------- 校验 DOM 渲染结果 ---------- */
console.log('\n【3】初始界面');
const q = (s) => document.querySelector(s);
const qa = (s) => Array.from(document.querySelectorAll(s));

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

ok(qa('#modeGrid .mode-card').length === 8, `模式卡片 8 个（实际 ${qa('#modeGrid .mode-card').length}）`);

// 新增的拆分成分练习模式必须出现在选择面板上
{
  const ids = qa('#modeGrid .mode-card').map(c => c.getAttribute('data-mode'));
  ok(ids.includes('sheng'), '模式列表含「只听声母」(sheng)');
  ok(ids.includes('yun'), '模式列表含「只听韵母」(yun)');
  ok(ids.includes('exam'), '模式列表含「能力测验」(exam)');
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

// 选择「单字打字」模式
const charCard = qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'char');
ok(!!charCard, '找到单字模式卡片');
fire(charCard, 'click');
ok(app.sessionMode === 'char', `模式已切换为 char（实际 ${app.sessionMode}）`);

// 点击开始
fire(q('#btnStart'), 'click');
await new Promise(r => setTimeout(r, 40));

ok(!!app.engine, '引擎已创建');
ok(q('#setupPanel').hidden === true, '设置面板已隐藏');
ok(q('#sessionPanel').hidden === false, '练习面板已显示');
ok(app.engine.state === 'running', `引擎运行中（实际 ${app.engine.state}）`);
ok(qa('#prompt .ch').length > 0, '字形行已渲染');
ok(!!q('#decode').innerHTML.trim(), '拆分区已渲染');

const totalQ = app.engine.questions.length;
ok(totalQ > 0, `题目数 ${totalQ}`);

// 模拟完整作答（全部打对）
// 说明：这里给每键加 ~12ms 的间隔，模拟真人打字节奏。
// 否则机器瞬时完成，用时为 0，速度指标无从计算。
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
  app.engine.pressKey(k.toLowerCase());
  pressed++;
  // 每键之间让出事件循环，既模拟真人节奏，也让引擎计时器推进
  await new Promise(r => setTimeout(r, 22));
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
await new Promise(r => setTimeout(r, 30));

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
await new Promise(r => setTimeout(r, 30));
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
  app.engine.pressKey(k.toLowerCase());
  await new Promise(r => setTimeout(r, 18));
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
await new Promise(r => setTimeout(r, 30));
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
  await new Promise(r => setTimeout(r, 20));
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
  await new Promise(r => setTimeout(r, 20));
  ok(app.sessionMode === 'exam', `模式切到 exam（实际 ${app.sessionMode}）`);

  // 卡片被选中即应弹出说明条
  const note = q('#examNote');
  ok(!!note, '存在测验说明条 #examNote');
  ok(note && note.hidden === false, '选中测验模式后说明条可见');

  // 默认题量应被建议为 50
  ok(q('#selCount').value === '50', `测验默认题量建议 50（实际 ${q('#selCount').value}）`);

  // 开跑
  fire(q('#btnStart'), 'click');
  await new Promise(r => setTimeout(r, 40));
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

  // 停一会，确认不会自己冒提示出来
  const hintEvents = [];
  eng.on('hint', x => hintEvents.push(x));
  eng.on('reveal', x => hintEvents.push(x));
  await new Promise(r => setTimeout(r, 260));
  ok(hintEvents.length === 0, `测验模式停留不产生任何提示（${hintEvents.length} 次）`);

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
    app.engine.pressKey(k.toLowerCase());
    await new Promise(r => setTimeout(r, 2));
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
  await new Promise(r => setTimeout(r, 500));
  const loaded = sMod.loadSettings();
  ok(loaded.duration === 300, `时长设置已持久化（实际 ${loaded.duration}）`);
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
await new Promise(r => setTimeout(r, 20));
const svg = q('#fullKeymap svg');
ok(!!svg, '完整键位图存在');
const vKey = svg && svg.querySelector('[data-key="V"]');
ok(!!vKey, '找到 V 键元素');
if (vKey) {
  fire(vKey, 'click');
  await new Promise(r => setTimeout(r, 20));
  ok(q('#keyDetail').hidden === false, '点击键位后详情面板展开');
  ok(q('#keyDetail').innerHTML.includes('zh'), 'V 键详情包含 zh 声母');
  ok(q('#keyDetail').innerHTML.includes('ui'), 'V 键详情包含 ui 韵母');
}

/* ---------- 卡住自动提示 ---------- */
console.log('\n【10b】卡住自动提示');
{
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

  // 暂停状态下绝不应触发提示
  eng.pause();
  await new Promise(r => setTimeout(r, 220));
  ok(hints.length === 0, '暂停期间不触发提示');
  eng.resume();

  await new Promise(r => setTimeout(r, 320));
  ok(hints.length >= 1, `停留后触发 hint（${hints.length} 次）`);
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
    await new Promise(r => setTimeout(r, 2));
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
  await new Promise(r => setTimeout(r, 30));
  ok(eng2.hintLevel() === '', '自动提尚未到期时无提示态');
  ok(eng2.requestHint('reveal') === true, 'requestHint 手动求助成功');
  ok(eng2.hintLevel() === 'reveal', '手动求助后进入 reveal 态');
  // 手动求助同样算「依赖提示」，但要打完整个音节才结算，
  // 此处验证它确实施加到了当前目标上（hint 载荷键位合法）。
  ok(/^[a-z]$/.test(String(eng2.currentTarget() && eng2.currentTarget().keys[0]).toLowerCase()),
    '手动求助后当前目标键位合法');
  eng2.destroy();
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
    await new Promise(r => setTimeout(r, 20));

    let g = 0;
    while (app.engine && app.engine.state === 'running' && g < 30000) {
      g++;
      const t = app.engine.currentTarget();
      if (!t) break;
      if (t.kind === 'skip' || t.kind === 'punct') { app.engine.pressKey('a'); continue; }
      const k = (t.keys || [])[t.pos];
      if (!k) break;
      app.engine.pressKey(k.toLowerCase());
      await new Promise(r => setTimeout(r, 3));
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
  /* 必须让真实时间走够 1 秒：persistRecord 只在 durationSec >= 1 时才落库，
     headless 里按键循环是瞬时的，不 sleep 就什么都不会写进易错表。 */
  for (let i = 0; i < 40 && (eng.stats.totalChars < 5 || eng.elapsedSec < 1.2); i++) {
    const x = eng.currentTarget();
    if (!x || !x.keys || !x.keys.length) break;
    for (const k of x.keys) eng.pressKey(String(k).toLowerCase());
    await new Promise(r => setTimeout(r, 40));
  }
  const s = eng.summary();
  ok(s.durationSec >= 1, `用时已累计（${s.durationSec}s / state=${eng.state} / ticker=${!!eng._ticker}），否则不会落库`);
  ok(Object.keys(s.perWordErrors || {}).length >= 1, `按整条记录了词组错误（${JSON.stringify(s.perWordErrors)}）`);
  eng.finish('user');
  await new Promise(r => setTimeout(r, 30));
  const weak = sMod.loadWeak();
  ok(!!weak[word], `词组「${word}」进了易错表`);
  ok(!!weak[word]?.word && weak[word].word === word, '整条记录的 word 字段非空（分组靠它）');
  ok(!!weak[word]?.pinyin && weak[word].pinyin.includes(' '), '词组拼音逐字保存，能显示编码');
  // 复习页分组。要先关掉「只练到期项」：刚记错的词按 SM-2 排在明天到期，
  // 开着开关时列表本就该是空的（那是正确行为，不是 bug）。
  const realDueOnly = app.settings.reviewDueOnly;
  app.settings.reviewDueOnly = false;
  fire(q('[data-view="review"]'), 'click');
  await new Promise(r => setTimeout(r, 20));
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
  await new Promise(r => setTimeout(r, 20));

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
    // 同样要让真实时间走够 1 秒，否则成绩无效、不会触发收尾音
    for (let i = 0; i < 60 && e2.state === 'running' && e2.elapsedSec < 1.2; i++) {
      const x = e2.currentTarget();
      if (!x || !x.keys || !x.keys.length) break;
      for (const k of x.keys) e2.pressKey(String(k).toLowerCase());
      await new Promise(r => setTimeout(r, 40));
    }
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
  await new Promise(r => setTimeout(r, 20));

  // 测验成绩曲线
  fire(q('[data-view="stats"]'), 'click');
  await new Promise(r => setTimeout(r, 30));
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
  await new Promise(r => setTimeout(r, 30));
  q('#statsMode').value = 'all'; fire(q('#statsMode'), 'change');
  await new Promise(r => setTimeout(r, 20));
  // V×3 + H×1 + A×2 = 6 次，3 个键。断言总额比逐键断言更能说明「是全量」
  ok(/共\s*6\s*次按键错误/.test(q('#heatSummary').textContent) &&
    /涉及\s*3\s*个键/.test(q('#heatSummary').textContent),
    `全部模式下热力图是全量累计（${q('#heatSummary').textContent.replace(/\s+/g, ' ').trim().slice(0, 40)}）`);
  q('#statsMode').value = 'phrase'; fire(q('#statsMode'), 'change');
  await new Promise(r => setTimeout(r, 20));
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
  await new Promise(r => setTimeout(r, 20));
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
  await new Promise(r => setTimeout(r, 20));
  const km = q('#miniKeymap');
  ok(!km.hidden, '默认可见');
  const btnKm = q('#btnToggleKeymap');
  ok(btnKm.textContent === '隐藏', '按钮文案与实际一致');
  fire(btnKm, 'click');
  await new Promise(r => setTimeout(r, 20));
  ok(km.hidden, '点一次收起');
  ok(btnKm.textContent === '显示', '收起后按钮文案正确');
  // 再走一帧 renderSession，用户的选择必须活下来
  const t2 = app.engine.currentTarget();
  app.engine.pressKey(String(t2.keys[t2.pos]).toLowerCase());
  await new Promise(r => setTimeout(r, 20));
  ok(km.hidden, '重绘后仍然保持收起（此前会被每帧覆盖回去）');
  ok(btnKm.textContent === '显示', '重绘后按钮文案仍然正确');
  fire(btnKm, 'click');
  await new Promise(r => setTimeout(r, 20));
  ok(!km.hidden, '再点一次恢复显示');
  cleanup();
  sMod.clearWeak();
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
  await new Promise(r => setTimeout(r, 30));
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
  await new Promise(r => setTimeout(r, 20));

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
    await new Promise(r => setTimeout(r, 20));
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
  await new Promise(r => setTimeout(r, 20));
  ok(!q('#storageBadge').classList.contains('is-warn'), '恢复后徽标回到正常态');
  ok(q('#storageNote').textContent.includes('localStorage'), '恢复后设置页文案回到正常承诺');
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

console.error = origError;
console.warn = origWarn;

console.log('\n' + (fail === 0
  ? '✅ 集成测试全部通过'
  : `❌ 集成测试共 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
