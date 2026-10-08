/**
 * 辅助功能与输入适配
 * ------------------------------------------------------------
 * 这个模块集中处理三类「不该散落在各处」的关切：
 *
 *   1. **减少动态效果**（prefers-reduced-motion）
 *   2. **快捷键配置**（可改键、可禁用，含「不用 Tab」的选项）
 *   3. **物理键位映射**（KeyboardEvent.code → 字母）
 *
 * 为什么单独一个文件：这三件事都要在「引擎之外」被复用 ——
 * 主控、键位图、提示条、测试都会碰。散在 main.js 里会变成
 * 「每个地方各写一遍」，然后慢慢长歪。
 */

/* ============================================================
   1. 减少动态效果
   ============================================================ */

/**
 * 是否应该减少动态效果。
 *
 * 遵循系统设置（Windows「显示动画」、macOS「减弱动态效果」等）。
 * 之所以要做：本应用的反馈里有抖动（stage 晃一下）和闪烁（键位图上闪），
 * 这些对前庭功能敏感的用户是真的会引起不适，不是「挑剔」。
 */
export function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

/**
 * 监听系统设置变化（用户可能中途改）。
 *
 * 注意：这个设置**不是**「记住一次就完事」的 —— 用户在系统里改了，
 * 应用应当立刻跟随，否则要刷新页面才生效，体验很怪。
 *
 * @param {(reduced:boolean)=>void} cb
 * @returns {() => void} 取消监听
 */
export function watchReducedMotion(cb) {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e) => { try { cb(!!e.matches); } catch (_) {} };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    // 老 Safari 只有 addListener
    if (typeof mq.addListener === 'function') {
      mq.addListener(handler);
      return () => mq.removeListener(handler);
    }
  } catch (_) {}
  return () => {};
}

/** 给 <html> 打的类名，供 CSS 直接分支（比逐个元素判断更省事） */
export function motionClass(reduced) {
  try {
    if (typeof document === 'undefined' || !document.documentElement) return;
    document.documentElement.classList.toggle('reduce-motion', !!reduced);
  } catch (_) {}
}

/* ============================================================
   2. 快捷键配置
   ============================================================ */

/**
 * 可配置的动作。
 *
 * 每个动作给一组**候选键**（键名用 KeyboardEvent.key 的规范化写法），
 * 用户可以在设置页里换。`'tab'` 允许被禁用 —— 这一点很重要：
 * Tab 是浏览器原生的焦点导航键，占用它会让纯键盘用户无法切换到
 * 页面其它控件。默认仍然用 Tab（历史行为），但给用户退路。
 */
export const SHORTCUT_ACTIONS = {
  hint:   { key: 'hint',   label: '看答案 / 求助', defaults: ['tab'] },
  skip:   { key: 'skip',   label: '跳过当前',      defaults: ['backspace'] },
  pause:  { key: 'pause',  label: '暂停 / 继续',   defaults: ['escape'] },
  submit: { key: 'submit', label: '提交（测验结束）', defaults: ['enter'] }
};

/** 默认快捷键映射：动作 → 键名（'' 表示不绑定） */
export const DEFAULT_SHORTCUTS = {
  hint: 'tab',
  skip: 'backspace',
  pause: 'escape',
  submit: 'enter'
};

/** 这些键不允许被占用：占掉会让页面基本不可用 */
export const RESERVED_KEYS = ['f5', 'f11', 'f12'];

/**
 * 判断一个键是否**禁止**被设为快捷键。
 *
 * 两类：
 *   1. 浏览器保留键（F5/F11/F12）—— 占掉影响基本操作；
 *   2. **单个字母 A–Z** —— 练习作答就靠字母键！把「看答案」绑到 A 上，
 *      练习里的 A 会被快捷键截走，「安」的第一键永远打不出来。
 *      快捷键和作答共享同一次按键，这是本应用特有的约束，
 *      通用的快捷键组件不会替你想到。
 *
 * 数字键、符号键不与作答冲突，允许绑定。
 */
export function isForbiddenShortcutKey(nk) {
  return RESERVED_KEYS.includes(nk) || /^[a-z]$/.test(nk);
}

/** 保留键 / 字母键被拒时的可读原因 */
function forbiddenReason(nk) {
  if (RESERVED_KEYS.includes(nk)) {
    return `${prettyKey(nk)} 是浏览器保留键，不能占用`;
  }
  return `${prettyKey(nk)} 是作答键，练习时要用来打字，不能当快捷键`;
}

/** 展示用的键名（把 'tab' → 'Tab'、'backspace' → 'Backspace'） */
export function prettyKey(name) {
  if (!name) return '未设置';
  const map = {
    tab: 'Tab', escape: 'Esc', backspace: 'Backspace', enter: 'Enter',
    space: '空格', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→'
  };
  if (map[name]) return map[name];
  if (name.length === 1) return name.toUpperCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * 规范化一个按键名，用于快捷键比较。
 *
 * 为什么不用 e.code：快捷键是**语义**层面的（「我要看答案」），
 * 用户换布局后按的还是同一个物理位置，但 code 也跟着变了 —— 反而不直观。
 * 所以快捷键走 `key`（字符语义），而**练习作答**走 code（物理键位），
 * 详见下方 keyFromCode 的注释。
 */
export function normalizeShortcutKey(key) {
  if (!key) return '';
  const k = String(key);
  if (k === ' ' || k === 'Spacebar') return 'space';
  if (k === 'Esc') return 'escape';
  // 单字母统一小写，方便比较
  if (k.length === 1) return k.toLowerCase();
  return k.toLowerCase();
}

/**
 * 校验一组快捷键是否可用。
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateShortcuts(map) {
  const used = new Map();
  for (const [action, key] of Object.entries(map || {})) {
    if (!key) continue;                       // 未绑定是合法的
    const nk = normalizeShortcutKey(key);
    if (isForbiddenShortcutKey(nk)) {
      return { ok: false, reason: forbiddenReason(nk) };
    }
    if (used.has(nk)) {
      return { ok: false, reason: `${prettyKey(nk)} 被多个动作占用（${used.get(nk)} 与 ${action}）` };
    }
    used.set(nk, action);
  }
  return { ok: true };
}

/**
 * 合并用户配置与默认值，并丢弃非法项。
 * 用于读取存储时「脏数据不能把应用搞坏」。
 */
export function mergeShortcuts(saved) {
  const out = Object.assign({}, DEFAULT_SHORTCUTS);
  if (!saved || typeof saved !== 'object') return out;
  for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
    const v = saved[action];
    if (v === undefined) continue;
    if (v === '' || v === null) { out[action] = ''; continue; }  // 显式解绑
    if (typeof v === 'string' && v.length <= 12) {
      const nk = normalizeShortcutKey(v);
      // 单项非法（保留键 / 字母键）→ 该项回落默认，**不**整体作废：
      // 用户只是其中一项存了脏数据，不该连其它自定义好的键一起丢。
      out[action] = isForbiddenShortcutKey(nk) ? DEFAULT_SHORTCUTS[action] : nk;
    }
  }
  // 合并后仍要保证不冲突；冲突就整体退回默认，避免留下一个半坏的状态
  const check = validateShortcuts(out);
  return check.ok ? out : Object.assign({}, DEFAULT_SHORTCUTS);
}

/* ============================================================
   3. 物理键位映射（非 QWERTY 布局兼容）
   ============================================================ */

/**
 * 键盘上「字母区」的物理键位顺序。
 *
 * 这解决一个真实问题：双拼练习练的是**手指落在哪个键**，
 * 而不是「屏幕上打出什么字母」。
 *
 *   - QWERTY 用户按 Dvorak 布局：想按物理 D 键（左手左起第三指），
 *     浏览器给出的 e.key 是 'e'（Dvorak 上 D 键打 e），
 *     于是应用以为用户按了 E —— 完全错位。
 *   - 用 e.code（'KeyD'）就能拿到**物理键位**，与布局无关。
 *
 * 所以：练习作答一律走 code；只有「不是字母键」或「拿不到 code」
 * （老浏览器 / 部分软键盘）时才回退到 key。
 *
 * 注：这里不做 AZERTY 的特殊处理 —— AZERTY 的字母位置本身就不同，
 * 用户练的应该是「屏幕上显示的键位」，code 同样能正确对应。
 */
const CODE_TO_LETTER = {
  KeyA: 'a', KeyB: 'b', KeyC: 'c', KeyD: 'd', KeyE: 'e', KeyF: 'f',
  KeyG: 'g', KeyH: 'h', KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l',
  KeyM: 'm', KeyN: 'n', KeyO: 'o', KeyP: 'p', KeyQ: 'q', KeyR: 'r',
  KeyS: 's', KeyT: 't', KeyU: 'u', KeyV: 'v', KeyW: 'w', KeyX: 'x',
  KeyY: 'y', KeyZ: 'z'
};

/**
 * 从 KeyboardEvent 取出「用户实际想按的字母」。
 *
 * 优先级：code（物理键位）→ key（字符语义）→ 空。
 *
 * @param {{code?:string, key?:string}} e
 * @returns {string} 单个小写字母，取不到则 ''
 */
export function letterFromEvent(e) {
  if (!e) return '';
  const code = e.code;
  if (code && CODE_TO_LETTER[code]) return CODE_TO_LETTER[code];
  // 回退：有些环境（移动端软键盘、老浏览器、测试桩）没有 code
  const k = e.key;
  if (typeof k === 'string' && k.length === 1 && /^[a-zA-Z]$/.test(k)) {
    return k.toLowerCase();
  }
  return '';
}

/**
 * 判断事件是否命中某个快捷键。
 * @param {{key?:string}} e
 * @param {string} shortcut 已规范化的键名（'' 表示未绑定）
 */
export function matchesShortcut(e, shortcut) {
  if (!shortcut || !e) return false;
  return normalizeShortcutKey(e.key) === shortcut;
}

/* ============================================================
   4. 屏幕阅读器播报
   ============================================================ */

let liveRegion = null;

/**
 * 写入 aria-live 区域，让屏幕阅读器念出当前状态。
 *
 * 关键细节：**必须先清空再写入**，否则内容不变时屏幕阅读器不会重新播报
 * （浏览器认为「没有变化」）。这是 aria-live 最常踩的坑。
 *
 * @param {string} text
 * @param {'polite'|'assertive'} [priority] 错误用 assertive，其余用 polite
 */
export function announce(text, priority) {
  try {
    if (typeof document === 'undefined') return;
    if (!liveRegion) {
      liveRegion = document.getElementById('srLive');
      if (!liveRegion) return;
    }
    // 两个独立区域：polite 与 assertive 不能共用一个节点，
    // 否则 assertive 的插队会打断 polite 的朗读队列。
    const target = priority === 'assertive'
      ? (document.getElementById('srLiveAssertive') || liveRegion)
      : liveRegion;
    target.textContent = '';
    // 强制一次重排，确保「清空」被观察到
    void target.offsetHeight;
    target.textContent = String(text || '');
  } catch (_) {}
}
