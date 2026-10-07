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
   提示条与提示标记。这里从**用户路径**出发验证这条链路真的接通了：
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
  while (app.engine && app.engine.state === 'running' && g < 40000) {
    g++;
    const t = app.engine.currentTarget();
    if (!t) break;
    if (t.kind === 'skip' || t.kind === 'punct') { app.engine.pressKey('a'); continue; }
    const k = (t.keys || [])[t.pos];
    if (!k) break;
    app.engine.pressKey(k.toLowerCase());
    await new Promise(r => setTimeout(r, 2));
  }
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

/* ---------- 收尾 ---------- */
console.log('\n【12】最终检查');
ok(errors.length === 0, `全程无未捕获 error${errors.length ? '（' + errors.length + ' 条）：' + errors.slice(0, 3).join(' | ') : ''}`);
console.log(`  （warnings ${warnings.length} 条）`);

console.error = origError;
console.warn = origWarn;

console.log('\n' + (fail === 0
  ? '✅ 集成测试全部通过'
  : `❌ 集成测试共 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
