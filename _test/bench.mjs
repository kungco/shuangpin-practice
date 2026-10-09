/**
 * 性能基准：renderSession 的每键开销
 * ------------------------------------------------------------
 * 目的：给「音节内推进不重写题干」这项优化立一条可复现的护栏。
 *
 * 为什么需要单独一份：全仓此前没有任何 performance 基准，
 * 而 renderSession 是打字场景里最高频的路径（8–15 键/秒）。
 * 没有基准的话，把「每键全量重绘」改成增量更新之后，
 * 无法证明真的变快了，也无法在将来被改回全量时告警。
 *
 * 【测什么】
 *   A. 音节内推进（一个音节打第 1 键 → 打第 2 键）：这是最频繁的一次 change，
 *      理论上只该更新「已达/当前」两个 class，不该重建题干。
 *   B. 换字（一个音节打完 → 下一个字）：需要重建 decode 块，但不该重建整段题干。
 *   C. 换题：允许全量重绘。
 *
 * 【怎么测】
 *   直接量「按键前后 DOM 被写入的次数」而不是墙钟毫秒 ——
 *   墙钟在 CI 上抖动大（共享 runner），写 DOM 的次数是确定性的结构指标，
 *   既是优化目标本身，也不会因为机器快慢而给出相反的结论。
 *   同时给一个毫秒数做参考（不设硬阈值，只打印）。
 *
 * 运行：node _test/bench.mjs
 */

import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗ ' + m); } else { console.log('  ✓ ' + m); } };

/* ---------- 模拟浏览器环境（与 integration.mjs 同构，按需裁剪） ---------- */
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const { window, document } = parseHTML(html);

const storageMap = new Map();
const localStorage = {
  get length() { return storageMap.size; },
  getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
  setItem: (k, v) => { storageMap.set(String(k), String(v)); },
  removeItem: (k) => { storageMap.delete(k); },
  clear: () => { storageMap.clear(); },
  key: (i) => Array.from(storageMap.keys())[i] ?? null
};

const fakeWindow = {
  document, localStorage,
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
  alert: () => {}, confirm: () => true,
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
  Blob: class {}, FileReader: class {},
  onerror: null
};
fakeWindow.window = fakeWindow;

class FakeEvent {
  constructor(type, opts = {}) {
    this.type = type; this.bubbles = !!opts.bubbles; this.cancelable = !!opts.cancelable;
    this.defaultPrevented = false; this.target = null; this.currentTarget = null;
    this._path = []; this._stopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
  stopImmediatePropagation() { this._stopped = true; }
}
class FakeKeyboardEvent extends FakeEvent {
  constructor(type, opts = {}) {
    super(type, opts);
    this.key = opts.key ?? ''; this.code = opts.code ?? ''; this.keyCode = opts.keyCode ?? 0;
    this.isComposing = !!opts.isComposing;
    this.ctrlKey = !!opts.ctrlKey; this.shiftKey = !!opts.shiftKey;
    this.metaKey = !!opts.metaKey; this.altKey = !!opts.altKey;
  }
}
fakeWindow.Event = FakeEvent;
fakeWindow.KeyboardEvent = FakeKeyboardEvent;
window.Event = FakeEvent;
window.KeyboardEvent = FakeKeyboardEvent;

const proto = Object.getPrototypeOf(document.createElement('div'));
if (!proto.animate) proto.animate = () => ({ finished: Promise.resolve(), cancel() {}, onfinish: null });
if (!proto.closest) {
  proto.closest = function (sel) {
    let el = this;
    while (el && el.nodeType === 1) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentNode;
      if (el && el.nodeType === 9) return null;
    }
    return null;
  };
}
if (!proto.matches) proto.matches = function () { return false; };
if (!proto.focus || typeof document.activeElement === 'undefined') {
  let active = null;
  proto.focus = function () { active = this; };
  proto.blur = function () { if (active === this) active = null; };
  Object.defineProperty(document, 'activeElement', { configurable: true, get() { return active || document.body || null; } });
}
if (!('offsetParent' in proto) || proto.offsetParent === undefined) {
  Object.defineProperty(proto, 'offsetParent', { configurable: true, get() { return this.parentNode || null; } });
}

/* select/input value 可写 */
function patchValueProperty(el) {
  if (!el || el.__valuePatched) return;
  el.__valuePatched = true;
  let v = '';
  try {
    const desc = Object.getOwnPropertyDescriptor(el, 'value');
    if (desc && desc.get) v = desc.get.call(el) || '';
  } catch (_) {}
  try {
    Object.defineProperty(el, 'value', { configurable: true, get() { return v; }, set(nv) { v = String(nv == null ? '' : nv); } });
  } catch (_) {}
}
Array.from(document.querySelectorAll('select, input, textarea')).forEach(patchValueProperty);

/* 捕获监听器 */
const origAdd = proto.addEventListener;
const origRemove = proto.removeEventListener;
proto.addEventListener = function (type, handler, opts) {
  (this.__handlers ||= {});
  (this.__handlers[type] ||= []).push(handler);
  return origAdd ? origAdd.call(this, type, handler, opts) : undefined;
};
proto.removeEventListener = function (type, handler, opts) {
  if (this.__handlers && this.__handlers[type]) {
    this.__handlers[type] = this.__handlers[type].filter(h => h !== handler);
  }
  return origRemove ? origRemove.call(this, type, handler, opts) : undefined;
};

const canvasStub = {
  setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {},
  lineTo() {}, stroke() {}, fill() {}, closePath() {}, arc() {}, fillText() {},
  quadraticCurveTo() {}, setLineDash() {},
  createLinearGradient: () => ({ addColorStop() {} })
};
const origCreate = document.createElement.bind(document);
document.createElement = (tag) => {
  const el = origCreate(tag);
  if (String(tag).toLowerCase() === 'canvas' && !el.getContext) el.getContext = () => canvasStub;
  return el;
};

/* ---------- 安装全局（与 integration.mjs 同法） ---------- */
globalThis.window = fakeWindow;
globalThis.document = document;
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: fakeWindow.navigator, configurable: true, writable: true
  });
} catch (_) { /* Node 已有只读 navigator，忽略 */ }
globalThis.localStorage = localStorage;
globalThis.getComputedStyle = fakeWindow.getComputedStyle;
globalThis.matchMedia = fakeWindow.matchMedia;
globalThis.performance = fakeWindow.performance;
globalThis.requestAnimationFrame = fakeWindow.requestAnimationFrame;
globalThis.cancelAnimationFrame = fakeWindow.cancelAnimationFrame;
globalThis.Blob = fakeWindow.Blob;
globalThis.FileReader = fakeWindow.FileReader;
globalThis.devicePixelRatio = 1;
globalThis.HTMLCanvasElement = class {};

/* ---------- 加载被测模块（先引擎，再 main.js 触发 boot） ---------- */
const { PracticeEngine } = await import('../src/core/engine.js');
const qMod = await import('../src/core/questions.js');

await import('../src/main.js');
await new Promise(r => setTimeout(r, 40));

const app = fakeWindow.__app;

/* ---------- 统计 DOM 写入 ---------- */
/** 给一个节点树挂上写入计数器：innerHTML 赋值、textContent 赋值、classList 变更 */
function makeCounter() {
  const c = { innerHTML: 0, textContent: 0, classOps: 0, createdNodes: 0 };
  return c;
}

/**
 * 测量一次 pressKey 期间的 DOM 写入量。
 *
 * 要点：linkedom 把 innerHTML / textContent 的 setter 定义在 **Element.prototype**
 * （不是 HTMLElement.prototype —— 从 createElement('div') 拿到的 proto 上没有），
 * 所以必须显式定位到那一层，否则包装不到、计数恒为 0（这个坑我踩过一次）。
 */
const ElementProto = (() => {
  let p = Object.getPrototypeOf(document.createElement('div'));
  while (p) {
    if (Object.getOwnPropertyDescriptor(p, 'innerHTML')) return p;
    p = Object.getPrototypeOf(p);
  }
  return null;
})();

async function measure(fn) {
  const c = makeCounter();
  if (!ElementProto) throw new Error('未找到定义了 innerHTML 的原型层');

  const wrap = (key) => {
    const d = Object.getOwnPropertyDescriptor(ElementProto, key);
    if (!d || !d.set) return null;
    Object.defineProperty(ElementProto, key, {
      configurable: true,
      get: d.get,
      set(v) { c[key]++; return d.set.call(this, v); }
    });
    return d;
  };

  const savedInner = wrap('innerHTML');
  const savedText = wrap('textContent');

  // 统计「新建 DOM 节点」—— createElement 是重建题干的直接指标
  const origCreateEl = document.createElement;
  document.createElement = function (tag) {
    if (String(tag).toLowerCase() !== 'canvas') c.createdNodes++;
    return origCreateEl.call(document, tag);
  };

  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;

  document.createElement = origCreateEl;
  if (savedInner) Object.defineProperty(ElementProto, 'innerHTML', savedInner);
  if (savedText) Object.defineProperty(ElementProto, 'textContent', savedText);

  return { ...c, ms };
}

/* ---------- 起一局真实练习（必须走 UI，事件才接得上） ---------- */
console.log('\n【基准】renderSession 每键开销');
console.log('（指标：一次按键引发的 DOM 写入次数。毫秒仅作参考，CI 抖动大）\n');

const q = (sel) => document.querySelector(sel);
const qa = (sel) => Array.from(document.querySelectorAll(sel));
function fire(el, type) {
  if (!el) return false;
  const ev = new FakeEvent(type, { bubbles: true, cancelable: true });
  ev.target = el; ev.currentTarget = el;
  ev._path = [{ currentTarget: el, target: el }];
  let fired = false;
  let node = el;
  while (node && node.nodeType === 1) {
    const hs = node.__handlers && node.__handlers[type];
    if (hs) { for (const h of hs.slice()) { try { h(ev); fired = true; } catch (e) { console.error(e); } } }
    if (ev._stopped) break;
    node = node.parentNode;
  }
  return fired;
}

ok(!!app, '应用实例已暴露（fakeWindow.__app）');

// 选「词组」模式（多字，且有 2 键音节，最能体现分级重绘）
const phraseCard = qa('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'phrase');
ok(!!phraseCard, '找到词组模式卡片');
if (phraseCard) fire(phraseCard, 'click');
fire(q('#btnStart'), 'click');
await new Promise(r => setTimeout(r, 40));

const eng = app.engine;
ok(!!eng && eng.state === 'running', `练习已启动（state=${eng ? eng.state : 'null'}）`);
ok((q('#prompt') || {}).innerHTML && q('#prompt').innerHTML.length > 0, '题干已渲染');

/* 向前推进，直到当前目标是需要 2 键的音节（才是「音节内推进」的场景） */
let guard = 0;
let target = eng.currentTarget();
while (target && (target.len || 1) < 2 && guard++ < 500) {
  const t = eng.currentTarget();
  if (!t || !t.keys || !t.keys.length) break;
  // 把当前音节一次打对，推进到下一个
  for (const k of t.keys) eng.pressKey(String(k).toLowerCase());
  target = eng.currentTarget();
  if (target && target.keys && target.keys.length >= 2) break;
}
target = eng.currentTarget();
const desc = target ? `${target.char || ''} ${(target.keys || []).join('+')} (len=${target.len})` : '(无)';
console.log(`  当前目标：${desc}\n`);

if (target && target.len >= 2) {
  /* --- A. 音节内推进（非末键）：理论上只该重画解码区，不碰题干 --- */
  const promptEl = q('#prompt');
  const promptBefore = promptEl.innerHTML;
  const promptChildBefore = promptEl.firstElementChild;
  const A = await measure(async () => { eng.pressKey(String(target.keys[0]).toLowerCase()); });
  const promptAfterInA = promptEl.innerHTML;
  const promptChildAfter = promptEl.firstElementChild;
  console.log(`  A 音节内推进（第 1 键）：innerHTML×${A.innerHTML}  textContent×${A.textContent}  新建节点×${A.createdNodes}  ${A.ms.toFixed(2)}ms`);

  /* --- B. 完成音节（末键）：允许重建 decode，但不该重建整段题干 --- */
  const t2 = eng.currentTarget();
  let B = null;
  if (t2 && t2.keys && t2.keys.length >= 2) {
    const lastKey = String(t2.keys[t2.keys.length - 1]).toLowerCase();
    B = await measure(async () => { eng.pressKey(lastKey); });
    console.log(`  B 完成音节（末键）   ：innerHTML×${B.innerHTML}  textContent×${B.textContent}  新建节点×${B.createdNodes}  ${B.ms.toFixed(2)}ms`);
  }

  console.log('');
  console.log(`  ▸ 音节内推进时 #prompt 是否被重写：${promptAfterInA === promptBefore ? '否' : '是'}`);
  console.log(`  ▸ 该次按键 innerHTML 写入次数：${A.innerHTML}`);
  console.log(`  ▸ 该次按键新建 DOM 节点数：${A.createdNodes}`);

  /* ---- 护栏：音节内推进不得重建题干 ----
     题干（#prompt 里的字符 span）在「同一音节里按了第 1 键」时状态没变，
     重建它是纯粹的浪费 —— 这是本次优化要摘掉的那一项。
     需要注意「不重建题干」≠「零 innerHTML」：
     解码区（#decode）必须重画（高亮从第 1 键移到第 2 键），
     那是 renderDecode 的职责，也是下面 B 那条反向护栏保护的。
     所以这里断言的是「写入只剩解码区这一处」，而不是「没有写入」。
     注意：这里**不**断言 textContent（HUD 要更新，那是应该的）。 */
  ok(A.innerHTML <= 1,
    `音节内推进至多重绘一处区域（实际 innerHTML ${A.innerHTML} 次；题干已不在其中）`);
  ok(promptAfterInA === promptBefore,
    '音节内推进不改动 #prompt 的 HTML');
  ok(A.createdNodes === 0,
    `音节内推进不新建 DOM 节点（实际 ${A.createdNodes} 个）`);
  /* 直接盯住「题干」这个优化目标本身：它的节点身份必须保持不变。
     用 === 而不是比较 HTML 文本 —— 文本可能恰好相同，
     那就测不出「重写了一遍但内容没变」这种浪费。 */
  ok(promptChildBefore !== null && promptChildAfter === promptChildBefore,
    '音节内推进后 #prompt 的子节点仍是同一个对象（未重建）');

  /* ---- 反向护栏：换字/换题**必须**重绘解码区，别优化过头 ---- */
  if (B) {
    ok(B.innerHTML > 0, `完成音节仍会重绘解码区（innerHTML×${B.innerHTML}）`);
  }
} else {
  ok(false, '未能构造出 2 键目标，无法测量音节内推进');
}

eng.destroy();

console.log('\n' + (fail === 0 ? '✅ 性能基准通过' : `❌ 性能基准有 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
