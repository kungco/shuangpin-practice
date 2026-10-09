/**
 * 辅助功能与输入适配 —— 自检
 * ------------------------------------------------------------
 * 覆盖 src/ui/a11y.js 与 src/ui/sound.js。这两块共同的坑是
 * 「在真实浏览器里才看得出问题」，所以这里用**构造事件对象**的方式
 * 把规则钉死，不依赖真实键盘或音频设备。
 *
 * 为什么不用 linkedom：这两个模块都不碰 DOM 结构（a11y.js 只在
 * announce 里查一个节点，且查不到会安全返回）。用手写的最小桩
 * 更可控，也让这套测试保持「零依赖、毫秒级」，适合改代码时高频单跑。
 *
 * 运行：node _test/a11y.mjs
 */

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label}（实际 ${JSON.stringify(a)}）`);
}
function section(title) { console.log(`\n【${title}】`); }

/* ---------- 最小浏览器桩 ---------- */
// a11y.js 在模块加载时会读 window / document，所以必须**先**装好桩。
const listeners = [];
let mqMatches = false;

const documentStub = {
  documentElement: {
    _attrs: {},
    style: {},
    classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; }
  },
  _nodes: {},
  _headChildren: [],
  getElementById(id) { return this._nodes[id] || null; },
  // createElement 的返回值要真的记住 setAttribute 的内容 ——
  // applyTheme 会新建 meta[name=theme-color] 并写入 color，
  // 桩里若丢弃它就测不到「地址栏颜色是否跟着变」。
  createElement() {
    const attrs = {};
    return {
      id: '', className: '',
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k] ?? null; },
      removeAttribute(k) { delete attrs[k]; },
      appendChild() {}
    };
  },
  // applyTheme 会先 querySelector 找已有的 meta，找不到才新建。
  // 桩若一律返回 null，每次调用都会新建一个 —— 那就测不出
  // 「第二次调用是否复用了同一个 meta」。
  querySelector(sel) {
    if (sel === 'meta[name="theme-color"]') {
      return this._headChildren.find(n => n.getAttribute && n.getAttribute('name') === 'theme-color') || null;
    }
    return null;
  },
  querySelectorAll() { return []; },
  head: { appendChild(n) { documentStub._headChildren.push(n); } },
  body: { appendChild(n) { if (n && n.id) this._owner._nodes[n.id] = n; }, _owner: null }
};
documentStub.body._owner = documentStub;

globalThis.document = documentStub;
globalThis.window = {
  matchMedia(q) {
    return {
      matches: mqMatches,
      media: q,
      addEventListener(type, cb) { listeners.push({ type, cb }); },
      removeEventListener() {}
    };
  }
};

const a11y = await import('../src/ui/a11y.js');
const sound = await import('../src/ui/sound.js');

/* ============================================================
   1. 减少动态效果
   ============================================================ */
section('1. 减少动态效果');

eq(a11y.prefersReducedMotion(), false, '媒体查询不匹配时返回 false');
mqMatches = true;
eq(a11y.prefersReducedMotion(), true, '媒体查询匹配时返回 true');

// 监听：系统设置变化能被感知
const seen = [];
a11y.watchReducedMotion(v => seen.push(v));
ok(listeners.length >= 1, '注册了 change 监听');
if (listeners.length) {
  listeners[listeners.length - 1].cb({ matches: true });
  listeners[listeners.length - 1].cb({ matches: false });
}
eq(seen.join(','), 'true,false', '回调收到 true → false 的变化');

// 类名切换
a11y.motionClass(true);
ok(documentStub.documentElement.classList.contains('reduce-motion'), 'motionClass(true) 加上类名');
a11y.motionClass(false);
ok(!documentStub.documentElement.classList.contains('reduce-motion'), 'motionClass(false) 移除类名');
a11y.motionClass(undefined);   // 不应抛
ok(true, 'motionClass(undefined) 不抛异常');

mqMatches = false;

/* ============================================================
   1b. 主题（明暗）
   ============================================================ */
section('1b. 主题（明暗）');

// 系统偏好探测
eq(a11y.prefersDark(), false, '系统不偏好深色时返回 false');
mqMatches = true;
eq(a11y.prefersDark(), true, '系统偏好深色时返回 true');

// 显式指定优先于系统：系统是深色但用户选了 light → 必须浅色
mqMatches = true;
eq(a11y.applyTheme('light'), 'light', '显式 light 覆盖系统的 dark');
eq(documentStub.documentElement.getAttribute('data-theme'), 'light', 'data-theme 写成 light');
eq(documentStub.documentElement.style.colorScheme, 'light', 'color-scheme 同步（让表单控件/滚动条跟随）');
mqMatches = false;
eq(a11y.applyTheme('dark'), 'dark', '显式 dark 覆盖系统的 light');
eq(documentStub.documentElement.getAttribute('data-theme'), 'dark', 'data-theme 写成 dark');
eq(documentStub.documentElement.style.colorScheme, 'dark', 'color-scheme 同步');

// auto = 跟随系统，两种系统设置都要跟
mqMatches = true;
eq(a11y.applyTheme('auto'), 'dark', 'auto 在系统深色时解析为 dark');
mqMatches = false;
eq(a11y.applyTheme('auto'), 'light', 'auto 在系统浅色时解析为 light');

// 非法值不能变成「无主题」——那会让整页退回 UA 默认样式
eq(a11y.applyTheme('nonsense'), 'light', '非法值安全回落（不会留下无 data-theme 的状态）');
eq(a11y.applyTheme(undefined), 'light', 'undefined 安全回落');
eq(a11y.applyTheme(null), 'light', 'null 安全回落');

// theme-color：地址栏/标签页要跟着变，否则深色页面配浅色标题栏很扎眼
mqMatches = true;
a11y.applyTheme('dark');
const meta = documentStub._headChildren[documentStub._headChildren.length - 1];
ok(!!meta, '注入了 meta[name=theme-color]');
eq(meta && meta.getAttribute('content'), '#14171d', '深色下的 theme-color 是深底色');
a11y.applyTheme('light');
eq(meta && meta.getAttribute('content'), '#f5f7fa', '浅色下的 theme-color 是浅底色');
mqMatches = false;

// 监听系统配色变化
const schemeSeen = [];
listeners.length = 0;
a11y.watchColorScheme(v => schemeSeen.push(v));
ok(listeners.length >= 1, '注册了配色 change 监听');
if (listeners.length) {
  listeners[listeners.length - 1].cb({ matches: true });
  listeners[listeners.length - 1].cb({ matches: false });
}
eq(schemeSeen.join(','), 'true,false', '回调收到系统配色变化');

/* ============================================================
   2. 快捷键规范化
   ============================================================ */
section('2. 快捷键规范化');

eq(a11y.normalizeShortcutKey('Tab'), 'tab', 'Tab → tab');
eq(a11y.normalizeShortcutKey('TAB'), 'tab', 'TAB → tab');
eq(a11y.normalizeShortcutKey('a'), 'a', '单字母 a → a');
eq(a11y.normalizeShortcutKey('A'), 'a', '大写 A → a（大小写不敏感）');
eq(a11y.normalizeShortcutKey('Escape'), 'escape', 'Escape → escape');
eq(a11y.normalizeShortcutKey('Esc'), 'escape', 'Esc 别名 → escape');
eq(a11y.normalizeShortcutKey(' '), 'space', '★ 空格（单空格）→ space');
eq(a11y.normalizeShortcutKey('Spacebar'), 'space', '★ Spacebar（老浏览器写法）→ space');
eq(a11y.normalizeShortcutKey(''), '', '空串 → 空串');
eq(a11y.normalizeShortcutKey(null), '', 'null → 空串');
eq(a11y.normalizeShortcutKey(undefined), '', 'undefined → 空串');
eq(a11y.normalizeShortcutKey('Backspace'), 'backspace', 'Backspace（含大写）→ backspace');
eq(a11y.normalizeShortcutKey('ArrowUp'), 'arrowup', 'ArrowUp → arrowup');

/* ---- 展示名 ---- */
eq(a11y.prettyKey('tab'), 'Tab', "prettyKey('tab') → 'Tab'");
eq(a11y.prettyKey('escape'), 'Esc', "prettyKey('escape') → 'Esc'");
eq(a11y.prettyKey('backspace'), 'Backspace', "prettyKey('backspace') → 'Backspace'");
eq(a11y.prettyKey('space'), '空格', "prettyKey('space') → '空格'");
eq(a11y.prettyKey('a'), 'A', '单字母大写展示');
eq(a11y.prettyKey(''), '未设置', '空值展示为「未设置」');
eq(a11y.prettyKey(null), '未设置', 'null 展示为「未设置」');
eq(a11y.prettyKey('arrowup'), '↑', 'arrowup 展示为箭头');

/* ============================================================
   3. 合并与校验
   ============================================================ */
section('3. 合并默认值 / 冲突校验');

const D = a11y.DEFAULT_SHORTCUTS;
eq(D.hint, 'tab', '默认「看答案」是 Tab');
eq(D.skip, 'backspace', '默认「跳过」是 Backspace');
eq(D.pause, 'escape', '默认「暂停」是 Esc');
eq(D.submit, 'enter', '默认「提交」是 Enter');

/* ---- 合并 ---- */
let m = a11y.mergeShortcuts(null);
eq(m.hint, 'tab', 'null → 全部默认（hint）');
eq(m.submit, 'enter', 'null → 全部默认（submit）');

m = a11y.mergeShortcuts({ hint: 'F1' });
eq(m.hint, 'f1', '用户值覆盖默认（且已规范化小写）');
eq(m.skip, 'backspace', '未提供的项保留默认');

m = a11y.mergeShortcuts({ hint: '' });
eq(m.hint, '', '★ 空串是「显式解绑」，不回落默认');
eq(m.skip, 'backspace', '解绑一项不影响其它项');

m = a11y.mergeShortcuts({ hint: null });
eq(m.hint, '', '★ null 也是「显式解绑」');

m = a11y.mergeShortcuts({ hint: 123 });
eq(m.hint, 'tab', '非字符串值被忽略，保留默认');

m = a11y.mergeShortcuts({ hint: 'x'.repeat(50) });
eq(m.hint, 'tab', '过长字符串被忽略');

m = a11y.mergeShortcuts('not-an-object');
eq(m.hint, 'tab', '非对象输入安全回落默认');

/* ---- 冲突：合并后不合法就整体退回默认 ---- */
m = a11y.mergeShortcuts({ hint: 'escape', pause: 'escape' });
eq(m.hint, 'tab', '★ 出现重复键时整体退回默认（hint）');
eq(m.pause, 'escape', '★ 出现重复键时整体退回默认（pause）');

m = a11y.mergeShortcuts({ hint: 'f5' });
eq(m.hint, 'tab', '★ 保留键 F5 被拒绝，退回默认');

/* ---- 直接校验 ---- */
eq(a11y.validateShortcuts({ hint: 'tab', skip: 'backspace' }).ok, true, '不冲突时 ok');
eq(a11y.validateShortcuts({ hint: '', skip: '' }).ok, true, '全解绑也 ok');
const bad = a11y.validateShortcuts({ hint: 'tab', skip: 'tab' });
eq(bad.ok, false, '重复键判定不合法');
ok(/占用/.test(bad.reason || ''), `给出可读原因：${bad.reason}`);
const bad2 = a11y.validateShortcuts({ hint: 'f11' });
eq(bad2.ok, false, 'F11 判定不合法');
ok(/保留键/.test(bad2.reason || ''), `给出保留键提示：${bad2.reason}`);
eq(a11y.RESERVED_KEYS.join(','), 'f5,f11,f12', '保留键表为 F5/F11/F12');

/* ---- 字母键是作答键，禁止绑为快捷键 ----
   练习作答靠 A–Z。把「看答案」绑到 A 上，练习里的 A 会被快捷键截走，
   「安」的第一键就永远打不出来。这是本应用特有的约束。 */
const letterBad = a11y.validateShortcuts({ hint: 'a' });
eq(letterBad.ok, false, '★ 字母键 a 判定不合法');
ok(/作答键/.test(letterBad.reason || ''), `给出可读原因：${letterBad.reason}`);
eq(a11y.validateShortcuts({ hint: 'Z' }).ok, false, '大写 Z 同样拒绝');
eq(a11y.validateShortcuts({ hint: '1' }).ok, true, '数字键不与作答冲突，允许');
eq(a11y.validateShortcuts({ hint: 'f1' }).ok, true, '功能键允许');

m = a11y.mergeShortcuts({ hint: 'a' });
eq(m.hint, 'tab', `★ 脏配置里的字母键回落默认（实际 ${m.hint}）`);
m = a11y.mergeShortcuts({ hint: 'a', skip: 'f2' });
eq(m.hint, 'tab', '字母键项单独回落默认');
eq(m.skip, 'f2', '★ 其它合法自定义键不受牵连（不整体作废）');
m = a11y.mergeShortcuts({ pause: 'q' });
eq(m.pause, 'escape', '任意字母（q）同样被拒');

/* ============================================================
   4. matchesShortcut
   ============================================================ */
section('4. matchesShortcut');

ok(a11y.matchesShortcut({ key: 'Tab' }, 'tab'), 'Tab 命中 tab');
ok(a11y.matchesShortcut({ key: 'TAB' }, 'tab'), '大小写不敏感');
ok(!a11y.matchesShortcut({ key: 'Tab' }, 'escape'), '不相关的键不命中');
ok(!a11y.matchesShortcut({ key: 'Tab' }, ''), '★ 空快捷键（未绑定）永不命中');
ok(!a11y.matchesShortcut({ key: 'Tab' }, null), '★ null 快捷键永不命中');
ok(!a11y.matchesShortcut({ key: 'Tab' }, undefined), '★ undefined 快捷键永不命中');
ok(!a11y.matchesShortcut(null, 'tab'), 'null 事件不命中');
ok(a11y.matchesShortcut({ key: ' ' }, 'space'), '空格能命中 space');

/* ============================================================
   5. letterFromEvent（非 QWERTY 布局兼容）
   ============================================================ */
section('5. letterFromEvent / 物理键位');

eq(a11y.letterFromEvent({ code: 'KeyA', key: 'a' }), 'a', 'QWERTY：KeyA → a');
eq(a11y.letterFromEvent({ code: 'KeyZ', key: 'z' }), 'z', 'QWERTY：KeyZ → z');
eq(a11y.letterFromEvent({ code: 'KeyQ' }), 'q', '只有 code 也能取到');

/* ---- Dvorak：物理键位优先 ---- */
// Dvorak 布局下，物理 KeyD 打出的是 'e'。练的是「手指落在哪」，所以应取 'd'。
eq(a11y.letterFromEvent({ code: 'KeyD', key: 'e' }), 'd',
  '★ Dvorak：按物理 D 键（打出 e）→ 取 d');
eq(a11y.letterFromEvent({ code: 'KeyE', key: '.' }), 'e',
  '★ Dvorak：物理 E 键打出 . → 仍取 e');
// Dvorak 的 'a' 在物理 KeyA 上、'm' 在物理 KeyM 上（这两个恰好对齐）
eq(a11y.letterFromEvent({ code: 'KeyM', key: 'm' }), 'm', 'Dvorak 巧合对齐的键仍正确');

/* ---- AZERTY ---- */
// AZERTY 下字母位置本就不同，用户练的应是「屏幕上显示的键」，
// code 同样给出正确的物理对应。
eq(a11y.letterFromEvent({ code: 'KeyQ', key: 'a' }), 'q',
  '★ AZERTY：物理 Q 位置（打出 a）→ 取 q');
eq(a11y.letterFromEvent({ code: 'KeyM', key: ',' }), 'm',
  '★ AZERTY：物理 M 位置 → 取 m');

/* ---- 回退到 key ---- */
eq(a11y.letterFromEvent({ key: 'b' }), 'b', '★ 没有 code 时回退到 key');
eq(a11y.letterFromEvent({ key: 'B' }), 'b', '回退时统一小写');
eq(a11y.letterFromEvent({ key: '1' }), '', '数字键不产生字母');
eq(a11y.letterFromEvent({ key: 'Enter' }), '', 'Enter 不产生字母');
eq(a11y.letterFromEvent({ key: 'Shift' }), '', 'Shift 不产生字母');
eq(a11y.letterFromEvent({ key: '中' }), '', '中文字符不产生字母');
eq(a11y.letterFromEvent({}), '', '空事件返回空串');
eq(a11y.letterFromEvent(null), '', 'null 返回空串');
eq(a11y.letterFromEvent({ code: 'F5', key: 'F5' }), '', 'F5 不产生字母');
eq(a11y.letterFromEvent({ code: 'Digit1', key: '1' }), '', 'Digit1 不产生字母');

/* ============================================================
   6. 屏幕阅读器播报
   ============================================================ */
section('6. 屏幕阅读器播报');

// 没有 live 节点时不应抛
let threw = false;
try { a11y.announce('测试'); } catch (_) { threw = true; }
ok(!threw, '缺少 aria-live 节点时静默返回，不抛异常');

// 装上两个区域
function makeLive(id, role) {
  const node = {
    id, role, className: '',
    _text: '',
    textContent: '',
    offsetHeight: 1,
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; }
  };
  documentStub._nodes[id] = node;
  return node;
}
const polite = makeLive('srLive', 'status');
const assertive = makeLive('srLiveAssertive', 'alert');
a11y._resetLiveRegionForTest && a11y._resetLiveRegionForTest();

a11y.announce('已完成 3 个', 'polite');
eq(polite.textContent, '已完成 3 个', 'polite 播报写入 #srLive');
eq(assertive.textContent, '', 'polite 播报不污染 assertive 区域');

a11y.announce('按错。应键入 M', 'assertive');
eq(assertive.textContent, '按错。应键入 M', 'assertive 播报写入 #srLiveAssertive');
eq(polite.textContent, '已完成 3 个', 'assertive 播报不动 polite 区域（互不打断）');

// 默认 priority 为 polite
a11y.announce('第二轮');
eq(polite.textContent, '第二轮', '不传 priority 时默认走 polite');

// 重复同一文本也必须重新写入（先清空再写）
const before = polite.textContent;
a11y.announce(before, 'polite');
eq(polite.textContent, before, '重复文本仍被写入（先清空再写，屏幕阅读器才会复读）');

// 非字符串安全
a11y.announce(null, 'polite');
eq(polite.textContent, '', 'null 播报写成空串');
a11y.announce(123, 'polite');
eq(polite.textContent, '123', '数字被转为字符串');
threw = false;
try { a11y.announce(undefined); } catch (_) { threw = true; }
ok(!threw, 'undefined 播报不抛异常');

/* ============================================================
   7. 音效合成
   ============================================================ */
section('7. 音效合成');

eq(sound.isSupported(), false, '无 WebAudio 环境时 isSupported() 为 false');

threw = false;
try {
  sound.play('correct', true);
  sound.play('error', true);
  sound.play('finish', true);
  sound.play('soften', true);
} catch (_) { threw = true; }
ok(!threw, '★ 无 WebAudio 时所有音效静默降级，不抛异常');

// 返回值契约：开关关掉 / 环境不支持 → false
eq(sound.play('correct', false), false, '开关关闭时不播放，返回 false');
eq(sound.play('correct', true), false, '环境不支持时返回 false');
eq(sound.play('nonsense', true), false, '未知类型返回 false');
eq(sound.play('correct'), false, '缺省 enabled 视为关闭');

// prime / reset 都不应抛
threw = false;
try { sound.prime(); sound.resetErrorFatigue(); } catch (_) { threw = true; }
ok(!threw, 'prime() 与 resetErrorFatigue() 安全');

/* ---- 假装有 WebAudio，验证「真的去合成了」 ---- */
section('7b. 有 WebAudio 时的合成行为');
{
  const created = [];   // 记录每个被创建的振荡器
  class FakeParam {
    constructor() { this.events = []; }
    setValueAtTime(v, t) { this.events.push(['set', v, t]); }
    exponentialRampToValueAtTime(v, t) { this.events.push(['ramp', v, t]); }
    linearRampToValueAtTime(v, t) { this.events.push(['lramp', v, t]); }
  }
  class FakeOsc {
    constructor() { this.frequency = new FakeParam(); this.gain = new FakeParam(); this.type = 'sine'; this._started = false; this._stopped = false; created.push(this); }
    connect() {} start() { this._started = true; } stop() { this._stopped = true; }
  }
  class FakeGain { constructor() { this.gain = new FakeParam(); } connect() {} }
  class FakeCtx {
    constructor() { this.state = 'running'; this.currentTime = 1.0; this.destination = {}; this._resumed = 0; }
    createOscillator() { return new FakeOsc(); }
    createGain() { return new FakeGain(); }
    resume() { this._resumed++; return Promise.resolve(); }
  }

  window.AudioContext = FakeCtx;
  sound._resetForTest();

  eq(sound.isSupported(), true, '装上桩后 isSupported() 为 true');

  created.length = 0;
  eq(sound.play('correct', true), true, 'correct 成功播放，返回 true');
  eq(created.length, 1, 'correct 合成 1 个振荡器');
  ok(created[0]._started && created[0]._stopped, '振荡器被正确 start/stop');
  ok(created[0].frequency.events.some(e => e[0] === 'ramp'), '★ 正确音带频率滑音（ramp）');
  eq(created[0].type, 'triangle', '正确音用三角波');

  created.length = 0;
  sound.play('error', true);
  eq(created.length, 1, 'error 合成 1 个振荡器');
  eq(created[0].type, 'sine', '错误音用正弦波（更闷）');

  created.length = 0;
  sound.play('finish', true);
  eq(created.length, 3, '★ finish 合成 3 个音（叮-咚-叮）');
  const delays = created.map(o => o.frequency.events[0][2]);
  ok(delays[0] < delays[1] && delays[1] < delays[2], `三个音依次错开：${delays.map(d => d.toFixed(2)).join(' < ')}`);

  /* ---- 连错降音（疲劳衰减） ----
     读不到 createGain 的引用，所以临时钩住原型方法把产出的 GainNode 收集起来，
     再从它的 gain.events 里取「第一个 ramp」＝峰值音量。 */
  const captureErrorPeak = () => {
    const g = [];
    const orig = FakeCtx.prototype.createGain;
    FakeCtx.prototype.createGain = function () { const gg = new FakeGain(); g.push(gg); return gg; };
    try { sound.play('error', true); } finally { FakeCtx.prototype.createGain = orig; }
    const ramps = g[0].gain.events.filter(e => e[0] === 'ramp');
    return ramps[0][1];
  };

  sound.resetErrorFatigue();
  const peaks = [];
  for (let i = 0; i < 6; i++) peaks.push(captureErrorPeak());

  ok(peaks[0] > peaks[5],
    `★ 连错时音量递减（第 1 次 ${peaks[0].toFixed(4)} → 第 6 次 ${peaks[5].toFixed(4)}）`);
  ok(peaks.every((v, i) => i === 0 || v <= peaks[i - 1] + 1e-9), '音量单调不增');
  ok(peaks[peaks.length - 1] >= 0.055 * 0.35 - 1e-9,
    `★ 音量有下限，不会退化到静音（最低 ${peaks[peaks.length - 1].toFixed(4)}）`);

  /* ---- 一次正确应清零连错计数 ---- */
  sound.play('error', true);
  sound.play('error', true);
  sound.play('correct', true);          // ← 这里应当把连错计数归零
  const afterCorrectPeak = captureErrorPeak();
  ok(Math.abs(afterCorrectPeak - peaks[0]) < 1e-9,
    `★ 答对一次后连错计数清零（音量回到 ${afterCorrectPeak.toFixed(4)}）`);

  // suspended 状态应被 resume
  {
    const c = new FakeCtx();
    c.state = 'suspended';
    let resumed = 0;
    sound._resetForTest();
    // 用 constructor 计数不方便，改为验证 resume 不漏：直接替换构造函数
    window.AudioContext = class extends FakeCtx {
      constructor() { super(); this.state = 'suspended'; }
      resume() { resumed++; return Promise.resolve(); }
    };
    sound.prime();
    ok(resumed >= 1, '★ suspended 状态下会调用 resume()（自动播放策略）');
    window.AudioContext = FakeCtx;
  }

  sound._resetForTest();
  delete window.AudioContext;
  eq(sound.isSupported(), false, '移除桩后 isSupported() 回到 false');
}

/* ---------- 收尾 ---------- */
console.log('\n' + (fail === 0
  ? `✅ 辅助功能自检全部通过（${pass} 项）`
  : `❌ 辅助功能自检共 ${fail} 项未通过（${pass} 通过）`));
if (fail) {
  console.log('未通过明细：');
  failures.forEach(f => console.log(`  · ${f}`));
}
process.exit(fail === 0 ? 0 : 1);
