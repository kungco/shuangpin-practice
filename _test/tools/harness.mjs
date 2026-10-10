/**
 * 模拟浏览器测试底座（共享）
 * ------------------------------------------------------------
 * integration.mjs 与 bench.mjs 原先各自抄了一份 ~140 行的 linkedom 引导代码，
 * 两份会各自漂移（早先 fakeWindow 的桩就补得不一样）。这里抽成一份。
 *
 * 除了去重，这个模块还负责一件更要紧的事：**可控时钟**。
 *
 * ── 为什么需要可控时钟 ──
 * 被测应用自己用了 setTimeout 表达「过一会儿」的语义：
 *   · 反馈条 3200ms 后自动消失（main.js clearFeedback）
 *   · 错误态闪烁 260ms（is-error-static）
 *   · 弹窗「点外部关闭」的监听在 setTimeout 里才挂上
 *   · 引擎的 ticker 是 setInterval(250ms)，提示/揭晓是 setInterval 到期触发
 * 旧测试靠 `await sleep(20)` 这种魔法数字去「赌」这些延迟已经发生：
 *   · 赌大了 → 慢；95 处累计 4.3 秒，而且 CI 忙时定时器仍可能没跑到
 *   · 赌小了 → 偶发红灯（这才是最难受的：本地绿、CI 红）
 *   · 赌错了 → 永远读不到东西
 * 现在把 setTimeout/setInterval/Date.now/performance.now 全部接到一个
 * **虚拟时钟**上：测试显式 `advance(3200)` 让时间前进，事件按到期顺序、
 * 在同一轮里同步执行。快（不用真等）、稳（与机器负载无关）、且能断言
 * 「到 3199ms 时还没消失，到 3200ms 才消失」这种边界。
 *
 * ── 用法 ──
 *   import { createHarness } from './tools/harness.mjs';
 *   const H = await createHarness();          // 默认用虚拟时钟
 *   H.fire('#btnStart', 'click');
 *   await H.settle();                          // 冲出微任务，不动虚拟时间
 *   H.advance(3200);                           // 让虚拟时间前进 3.2 秒
 *   await H.settle();
 *
 *   // 少数用例要验「真实定时器确实能跑」时，用真时钟模式：
 *   const R = await createHarness({ realTimers: true });
 *
 * 设计原则：**默认虚拟**。真实定时器只留给明确要验它的冒烟用例 ——
 * 否则「用了真时钟」这件事会悄悄扩散回 95 处。
 *
 * ── 一个刻意的例外：integration.mjs 用 realTimers: true ──
 * 集成测试要验证的是「真应用装到真 DOM 事件链上能不能跑通」，而应用自身的
 * 定时行为（8ms 按键防抖、250ms 心跳、反馈条 3200ms 自动清除）正是被测对象的
 * 一部分；把它们全换成虚拟时钟，测的就不再是应用本来的行为。
 * 所以那里的策略是：**等状态**（settle / waitFor），只保留两处确实依赖真实
 * 时长的等待（见文件内注释），而不是把时间整体虚拟化。
 * 需要精确时间边界的用例（提示/揭晓到期、暂停计时、倒计时结束）走虚拟时钟，
 * 它们要么是独立的裸引擎用例，要么单独借虚拟定时器。
 */

import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createVirtualClock, virtualizeWindowTimers, installVirtualWindow } from './vclock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/* ============================================================
   事件构造器
   ============================================================ */

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
    // 修饰键要齐。早先漏了 shiftKey，导致「Shift+Tab 反向循环焦点」这类
    // 依赖修饰键的逻辑在测试里恒走 else 分支（shiftKey === undefined），
    // 断言必然失败 —— 那是测试桩的缺陷，不是被测代码的问题。
    this.ctrlKey = !!opts.ctrlKey;
    this.shiftKey = !!opts.shiftKey;
    this.altKey = !!opts.altKey;
    this.metaKey = !!opts.metaKey;
    this.repeat = !!opts.repeat;
  }
}

/* ============================================================
   浏览器底座
   ============================================================ */


/**
 * 建一个模拟浏览器环境并加载应用。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.realTimers=false] true = 用真实 setTimeout（少数冒烟用）
 * @param {boolean} [opts.loadApp=true]     false = 只建环境，不 import 应用
 * @param {string}  [opts.htmlPath]         默认 index.html
 * @returns {Promise<object>} 底座句柄
 */
export async function createHarness(opts = {}) {
  const realTimers = !!opts.realTimers;
  const clock = realTimers ? null : createVirtualClock();

  const html = readFileSync(opts.htmlPath || resolve(ROOT, 'index.html'), 'utf8');
  const { window, document } = parseHTML(html);

  const storageMap = new Map();
  const localStorage = {
    get length() { return storageMap.size; },
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => { storageMap.set(String(k), String(v)); },
    removeItem: (k) => { storageMap.delete(k); },
    clear: () => { storageMap.clear(); },
    key: (i) => Array.from(storageMap.keys())[i] ?? null,
    /** 直接读到原始 Map，便于断言「确实落盘了」 */
    _map: storageMap
  };

  const errors = [];
  const warnings = [];

  /* 定时器：虚拟时钟模式下全部改道；真实模式下原样透传。
     之所以连 fakeWindow 上的 setTimeout 也要接管：应用走的是
     window.setTimeout（引擎的 timers 适配层优先取 window），漏掉它
     等于时钟只接管了一半，那另一半就会继续制造偶发红灯。 */
  const timers = realTimers ? {
    setTimeout: (fn, ms, ...a) => setTimeout(fn, ms, ...a),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms, ...a) => setInterval(fn, ms, ...a),
    clearInterval: (id) => clearInterval(id),
    now: () => Date.now(),
    performanceNow: () => Number(process.hrtime.bigint() / 1000000n)
  } : {
    setTimeout: (fn, ms, ...a) => clock.setTimeout(fn, ms, ...a),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: (fn, ms, ...a) => clock.setInterval(fn, ms, ...a),
    clearInterval: (id) => clock.clearInterval(id),
    now: () => clock.now(),
    performanceNow: () => clock.performanceNow()
  };

  const fakeWindow = {
    document,
    localStorage,
    location: { href: 'http://localhost/index.html', hash: '' },
    navigator: { maxTouchPoints: 0, userAgent: 'node' },
    devicePixelRatio: 1,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    performance: { now: timers.performanceNow },
    addEventListener: (t, h) => { (fakeWindow._ls[t] ||= []).push(h); },
    removeEventListener: () => {},
    _ls: {},
    /* getComputedStyle 要能读出 style.css 里的 CSS 自定义属性。
       linkedom 完全不解析样式表，getPropertyValue 恒返回 ''，于是
       main.js 画成绩曲线空态文案时拿不到 --text-3，只能走兜底色 ——
       深色主题下那句提示会变成浅灰配深底，几乎看不见。
       这里直接从 style.css 里解析出 :root / [data-theme="dark"] 两块，
       按当前 <html data-theme> 选对应那块。

       键位图的配色**不**走这条路：那是纯 CSS 规则（.kb-body 等用 var() 上色），
       所以这里读不到它，运行时也测不出来 —— verify.mjs 查源码守着。 */
    getComputedStyle(el) {
      const theme = (document.documentElement && document.documentElement.getAttribute('data-theme')) || 'light';
      const cache = {};
      const read = () => {
        if (cache[theme]) return cache[theme];
        const src = readFileSync(resolve(ROOT, 'assets/style.css'), 'utf8');
        const sel = theme === 'dark' ? '[data-theme="dark"]' : ':root';
        const at = src.indexOf(sel);
        const block = at < 0 ? '' : src.slice(at, src.indexOf('\n}', at));
        const out = {};
        for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
          out[m[1]] = m[2].trim();
        }
        cache[theme] = out;
        return out;
      };
      return {
        getPropertyValue(name) { return read()[name] || ''; }
      };
    },
    requestAnimationFrame: (fn) => timers.setTimeout(() => fn(timers.now()), 16),
    cancelAnimationFrame: (id) => timers.clearTimeout(id),
    alert: () => {},
    confirm: () => true,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    Blob: class { constructor() {} },
    FileReader: class {},
    /* a11y.js 的 prefersDark() / prefersReducedMotion() 走这里。
       恒返回 matches:false = 浅色 + 不减少动效，是测试里最稳定的默认。 */
    matchMedia: (query) => ({
      matches: false,
      media: String(query),
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
      onchange: null
    }),
    onerror: null
  };
  fakeWindow.window = fakeWindow;

  fakeWindow.Event = FakeEvent;
  fakeWindow.KeyboardEvent = FakeKeyboardEvent;
  window.Event = FakeEvent;
  window.KeyboardEvent = FakeKeyboardEvent;

  /* ---------- linkedom 缺的能力，用最小桩补齐 ---------- */

  /* Canvas：linkedom 不实现 2D 上下文。统计页的成绩曲线会 getContext('2d')
     并画线，没有这个桩就会在渲染时抛 "getContext is not a function"。
     桩只需要吞掉所有绘图调用 —— 我们在这里**不**验证画得对不对
     （那是真实浏览器冒烟的职责，见 browser.mjs）。 */
  const canvasStub = {
    setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {},
    lineTo() {}, stroke() {}, fill() {}, closePath() {}, arc() {}, fillText() {},
    quadraticCurveTo() {}, setLineDash() {},
    createLinearGradient: () => ({ addColorStop() {} })
  };

  /**
   * 兼容层：select/input 的 value 可写。
   * 真实浏览器里 select.value 可读可写；linkedom 实现成了只读 getter。
   * 不补这个，所有「选一个值然后触发 change」的用例都写不进去。
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

  /**
   * 兼容层：捕获事件监听器。
   * linkedom 把 addEventListener 的注册表存在模块私有 WeakMap 里，外部读不到，
   * 导致测试无法触发应用绑定的事件。这里在**元素自身**上额外记一份到
   * __handlers，供 fire() 使用。
   *
   * 注意：这里只拦元素，全局的 window 监听（keydown 等）由 fakeWindow._ls 负责，
   * 两条路分别在 fire() 与 fireKey() 里走。
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

  function patchAll(rootEl) {
    Array.from(rootEl.querySelectorAll('*')).forEach(captureListeners);
    Array.from(rootEl.querySelectorAll('select, input, textarea')).forEach(patchValueProperty);
  }
  patchAll(document);

  /* document.createElement 也要包一层：应用运行时新建的元素同样需要
     canvas 桩、value setter 和监听器捕获 —— 只处理初始 HTML 里的元素不够。 */
  const origCreate = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = origCreate(tag);
    const t = String(tag).toLowerCase();
    // 有的路径会自己带 getContext（比如 fakeWindow 上挂过），别覆盖
    if (t === 'canvas' && !el.getContext) el.getContext = () => canvasStub;
    if (t === 'select' || t === 'input' || t === 'textarea') patchValueProperty(el);
    captureListeners(el);
    return el;
  };

  /* ---------- 把 stub 注入全局 ---------- */
  /* main.js 是真正的 ES 模块，它在文件顶层就引用**裸的** document / window，
     所以必须挂到 globalThis —— 只挂在局部变量上，import 时会直接
     ReferenceError: document is not defined。 */
  const prevGlobals = {};
  const setGlobal = (name, value) => {
    // 只在第一次接管时记录原值：多次 useGlobals() 不该把「本 harness 的旧值」
    // 当成原值记下来，否则 restoreGlobals() 会还原成本 harness 自己。
    if (!(name in prevGlobals)) {
      prevGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    }
    try {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    } catch (_) { /* 只读全局无法覆盖，忽略 */ }
  };

  /**
   * 安装/重新安装本 harness 的全局 stub。
   *
   * 为什么需要「重新安装」：同一个进程里可能先后存在多个 harness
   * （比如主套用真实时钟跑应用，某个用例需要虚拟时钟跑一个裸引擎）。
   * 各自 installGlobals 时会把「上一个 harness 的全局」记成自己的原值，
   * 所以后创建的 harness restore 时会自动把上一个的全局还回来 —— 天然可嵌套。
   */
  function installGlobals() {
    setGlobal('window', fakeWindow);
    setGlobal('document', document);
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: fakeWindow.navigator, configurable: true, writable: true
      });
    } catch (_) { /* Node 已有只读 navigator，忽略 */ }
    setGlobal('localStorage', localStorage);
    // main.js 画图表空态文案时调的是**裸的** getComputedStyle（浏览器里
    // window 的属性同时就是全局），所以必须挂到 globalThis，只挂 fakeWindow 够不着。
    setGlobal('getComputedStyle', fakeWindow.getComputedStyle);
    setGlobal('matchMedia', fakeWindow.matchMedia);
    setGlobal('performance', fakeWindow.performance);
    setGlobal('requestAnimationFrame', fakeWindow.requestAnimationFrame);
    setGlobal('cancelAnimationFrame', fakeWindow.cancelAnimationFrame);
    setGlobal('Blob', fakeWindow.Blob);
    setGlobal('FileReader', fakeWindow.FileReader);
    setGlobal('devicePixelRatio', 1);
  }
  installGlobals();

  /* 原型级补丁：animate / closest。挂在原型上而不是逐个元素，
     因为应用会在运行时新建元素（反馈条、chip 等），逐个补必然漏。 */
  const proto = Object.getPrototypeOf(document.createElement('div'));
  if (!proto.animate) {
    proto.animate = () => ({ finished: Promise.resolve(), cancel() {}, onfinish: null });
  }
  if (!proto.closest) {
    proto.closest = function (sel) {
      let el = this;
      while (el && el.nodeType === 1) {
        try { if (el.matches && el.matches(sel)) return el; } catch (_) {}
        el = el.parentNode;
      }
      return null;
    };
  }
  if (!proto.matches) {
    proto.matches = function () { return false; };
  }

  /**
   * 兼容层：焦点
   * linkedom 既没有 document.activeElement，Element.prototype.focus 也是空实现，
   * 于是「打开弹窗把焦点送进去 / 关闭后还回来」这类逻辑在测试里**完全观测不到**。
   * 这里补一个最小可观测的焦点模型：focus() 记录 activeElement，blur() 清空。
   * 够测「焦点有没有被正确迁移」即可，不追求与浏览器完全一致。
   */
  const activeEl = { current: null };
  proto.focus = function () { activeEl.current = this; };
  proto.blur = function () { if (activeEl.current === this) activeEl.current = null; };
  try {
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get() { return activeEl.current || document.body || null; }
    });
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value() { return true; }
    });
  } catch (_) {}

  /**
   * 兼容层：offsetParent
   * trapModalTab 用 `offsetParent !== null` 过滤「可见」元素；linkedom 恒返回
   * undefined，会把所有候选都滤掉。这里统一返回一个非 null 值（视作可见），
   * 让 Tab 循环逻辑可被测。真实浏览器里隐藏元素的 offsetParent 才是 null。
   */
  if (!('offsetParent' in proto) || proto.offsetParent === undefined) {
    Object.defineProperty(proto, 'offsetParent', {
      configurable: true,
      get() { return this.parentNode || null; }
    });
  }

  /* ---------- microtask 之外还要能异步 flush ---------- */
  const flushMicrotasks = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  /* ---------- 事件派发 ---------- */
  function fire(el, type, o = {}) {
    if (typeof el === 'string') {
      const found = document.querySelector(el);
      if (!found) return false;
      el = found;
    }
    if (!el) return false;
    const ev = new FakeEvent(type, { bubbles: true, ...o });
    ev.target = el;
    ev.currentTarget = el;
    ev._path = [{ currentTarget: el, target: el }];

    let fired = false;
    let node = el;
    while (node && node.nodeType === 1) {
      const hs = node.__handlers && node.__handlers[type];
      if (hs) {
        for (const h of hs.slice()) {
          ev.currentTarget = node;
          try { h.call(node, ev); fired = true; } catch (e) { errors.push(e); }
          if (ev._stopped) break;
        }
      }
      if (ev._stopped) break;
      node = node.parentNode;
    }
    if (fired) return true;
    try { return el.dispatchEvent(ev); } catch (_) { return false; }
  }

  function fireKey(key, o = {}) {
    const ev = new FakeKeyboardEvent('keydown', { key, bubbles: true, ...o });
    ev.target = document.body;
    ev.currentTarget = fakeWindow;
    ev._path = [{ currentTarget: fakeWindow, target: document.body }];
    ev.preventDefault = function () { this.defaultPrevented = true; };
    const ls = fakeWindow._ls && fakeWindow._ls.keydown;
    if (ls) ls.slice().forEach(h => { try { h(ev); } catch (e) { errors.push(e); } });
    return ev;
  }

  /* 全局错误捕获要在应用加载前装好 */
  fakeWindow.onerror = (...a) => { errors.push(a[0]); };
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('error', (e) => errors.push(e && (e.error || e.message)));
    window.addEventListener('unhandledrejection', (e) => errors.push(e && e.reason));
  }

  const H = {
    window, document, fakeWindow, localStorage,
    errors, warnings,
    /** 虚拟时钟；realTimers 模式下为 null */
    clock,
    timers,
    realTimers,
    storageMap,

    /* ---------- 查询 ---------- */
    q: (sel) => document.querySelector(sel),
    qa: (sel) => Array.from(document.querySelectorAll(sel)),

    /* ---------- 派发 ---------- */
    fire,
    fireKey,

    /**
     * 等异步接线落定。
     *
     * 虚拟时钟下：把微任务跑干，并把**到期时间为 0** 的定时器也执行掉
     *   （Promise.resolve().then 会排在 0ms 定时器前面，但真实浏览器里
     *    两者顺序依规范；为了让「await 一下」的语义符合直觉，这里都跑）。
     * 真实时钟下：让出一轮事件循环（原来的 sleep(0) 语义）。
     */
    async settle({ rounds = 3 } = {}) {
      for (let i = 0; i < rounds; i++) {
        await flushMicrotasks();
        if (!realTimers) clock.advance(0);
      }
    },

    /**
     * 让虚拟时间前进 ms 毫秒（真实时钟下退化为真的 sleep）。
     * 返回虚拟时钟执行的回调次数。
     */
    async advance(ms) {
      if (realTimers) {
        await new Promise(r => setTimeout(r, ms));
        return 0;
      }
      const ran = clock.advance(ms);
      await flushMicrotasks();
      return ran;
    },

    /** 等待条件成立（真实时钟下最多等 timeoutMs；虚拟时钟下靠 advance 驱动） */
    async waitFor(pred, { timeoutMs = 2000, stepMs = 50, label = '条件' } = {}) {
      if (!realTimers) {
        // 虚拟：先试着立即满足，再按 step 推进虚拟时间直到满足或超时
        for (let t = 0; t <= timeoutMs; t += stepMs) {
          await flushMicrotasks();
          if (pred()) return true;
          if (t < timeoutMs) clock.advance(stepMs);
        }
      } else {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          await flushMicrotasks();
          if (pred()) return true;
          await new Promise(r => setTimeout(r, stepMs));
        }
      }
      await flushMicrotasks();
      if (pred()) return true;
      throw new Error(`waitFor 超时（${label}，${timeoutMs}ms）`);
    },

    /**
     * 加载应用。返回 { mod, app }。
     * 应用把实例挂在 fakeWindow.__app 上，这正是浏览器里的行为。
     */
    async loadApp() {
      const modUrl = new URL(`file://${resolve(ROOT, 'src/main.js').replace(/\\/g, '/')}`);
      /* 时间源也要跟着走虚拟时钟：应用里大量用 Date.now() 量时长
         （按键耗时、暂停计时、反馈条过期判断…）。只接管 setTimeout 而
         放过 Date.now，会出现「定时器在虚拟时间 3.2s 触发，但 Date.now
         还停在真实时刻」的错配 —— 那比不接管更难查。 */
      if (!realTimers) {
        const g = globalThis;
        H._realDateNow = g.Date.now;
        g.Date.now = () => clock.now();
      }
      const mod = await import(modUrl.href + `?t=${Date.now()}`);
      await H.settle();
      const app = fakeWindow.__app || (mod && mod.app) || null;
      return { mod, app };
    },

    /** 恢复被接管的全局时间源与浏览器 stub。测试结束务必调用。 */
    restoreGlobals() {
      if (H._realDateNow) {
        globalThis.Date.now = H._realDateNow;
        H._realDateNow = null;
      }
      for (const [name, desc] of Object.entries(prevGlobals)) {
        try {
          if (desc) Object.defineProperty(globalThis, name, desc);
          else delete globalThis[name];
        } catch (_) {}
      }
      // 还原被接管的 console（如果本进程里还挂着）
      if (H._origConsole) {
        console.error = H._origConsole.error;
        console.warn = H._origConsole.warn;
        H._origConsole = null;
      }
    },

    /**
     * 把本 harness 的虚拟定时器与 Date.now「借」给当前全局 window，
     * 返回一个还原函数。返回 null 表示本 harness 用的是真实时钟（无可借）。
     *
     * 适用场景：进程里已经有一个真实时钟的 harness 在跑完整应用，
     * 而某个用例只想让**一个裸引擎**跑虚拟时间。这时不必换掉整个全局环境
     * （document 等还留在原地），只把 window 上的定时器和 Date.now 换掉即可 ——
     * 引擎的 timers 适配层正是通过 window.setInterval 取定时器、通过
     * Date.now 量 idle，因此这样就能精确控制提示/揭晓的到期时刻。
     *
     * 注意：只影响 `window.setInterval/clearInterval/setTimeout/clearTimeout`
     * 与 `Date.now`；全局裸的 setTimeout 不动（应用的其他真实定时器保持原样）。
     */
    virtualizeTimers(win = globalThis.window) {
      if (realTimers) return null;
      return virtualizeWindowTimers(clock, win);
    },

    /**
     * 重新把本 harness 的 stub 装到全局。
     *
     * 用于「进程里存在多个 harness，要把控制权切回本 harness」的场景：
     * 例如主套用真实时钟跑完整应用，中间某段想用虚拟时钟跑一个裸引擎，
     * 那段结束后调 mainHarness.useGlobals() 把全局切回来即可
     * （虚拟 harness 的 restoreGlobals 已负责交还）。
     */
    useGlobals() {
      installGlobals();
      // 虚拟时钟模式下 Date.now 也要跟着接管，否则引擎用真实时间量时长。
      if (!realTimers) {
        if (!H._realDateNow) H._realDateNow = globalThis.Date.now;
        globalThis.Date.now = () => clock.now();
      }
    },

    /** 接管 console.error / console.warn 到 errors / warnings 数组 */
    captureConsole() {
      if (H._origConsole) return;
      H._origConsole = { error: console.error, warn: console.warn };
      console.error = (...a) => { errors.push(a.map(String).join(' ')); };
      console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
    }
  };

  return H;
}

export { FakeEvent, FakeKeyboardEvent };
export { createVirtualClock, virtualizeWindowTimers, installVirtualWindow };
