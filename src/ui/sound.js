/**
 * 按键音效（WebAudio 合成）
 * ------------------------------------------------------------
 * 设计取舍：
 *
 * 1. **不用音频文件**。整个项目零依赖、零构建，为一个「正确/错误」提示音
 *    塞几个 .mp3 会破坏这个约束，还要处理加载失败、格式兼容、体积。
 *    WebAudio 的振荡器 + 增益包络几行就能合成，且天然可参数化。
 *
 * 2. **默认关闭**。设置页的 `sound` 默认 false —— 打字练习本来就吵，
 *    突然有声音很扰人。开关打开后才在第一次用户交互时创建 AudioContext。
 *
 * 3. **必须懒创建 + 显式 resume**。浏览器的自动播放策略要求
 *    AudioContext 在「用户手势」中创建或恢复；页面加载时直接 new 会被
 *    挂起（state === 'suspended'），表现为「开了开关却没声音」。
 *    所以这里在每次播放前都尝试 resume 一次。
 *
 * 4. **错误音要克制**。练打字本来就容易错，如果错误音刺耳或过长，
 *    连续出错时体验会迅速恶化。所以错误音用低音 + 极短（90ms），
 *    并且**连续出错时会降音量**（连错越多越轻），避免变成惩罚。
 *
 * 音量基准压得很低（0.06 左右），属于「听得见但不打扰」的量级。
 */

/** 播放器单例。null 表示尚未创建（还没在用户手势里初始化过）。 */
let ctx = null;

/** 连错计数：用于错误音的「疲劳降音」，任何一次正确都会清零 */
let consecutiveErrors = 0;

/** 主音量（合成音量基准，不是系统音量） */
const MASTER = 0.055;

/** 环境能力探测：没有 WebAudio 就整块静默降级 */
function hasWebAudio() {
  try {
    return typeof window !== 'undefined' &&
      !!(window.AudioContext || window.webkitAudioContext);
  } catch (_) {
    return false;
  }
}

/**
 * 懒创建 AudioContext，并在需要时 resume。
 * @returns {AudioContext|null} 不可用时返回 null（调用方直接跳过播放）
 */
function ensureCtx() {
  if (!hasWebAudio()) return null;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctor();
    }
    // 自动播放策略：suspended 时在用户手势里 resume
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  } catch (_) {
    return null;
  }
}

/**
 * 合成一个音符。
 *
 * @param {object} o
 *   - freq   起始频率（Hz）
 *   - freqTo 结束频率（Hz，做滑音；不传则恒定）
 *   - type   波形：'sine' | 'triangle' | 'square'（默认三角，比正弦更有「实体感」又不刺耳）
 *   - dur    时长（秒）
 *   - gain   峰值音量（0–1，会再乘 MASTER）
 *   - delay  相对现在延后多久播放（秒，用于拼出「叮-咚」两音）
 */
function tone(o) {
  const c = ensureCtx();
  if (!c) return;
  try {
    const t0 = c.currentTime + (o.delay || 0);
    const dur = Math.max(0.02, o.dur || 0.08);

    const osc = c.createOscillator();
    osc.type = o.type || 'triangle';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.freqTo && o.freqTo !== o.freq) {
      // 指数滑音听起来比线性自然得多
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqTo), t0 + dur);
    }

    const g = c.createGain();
    const peak = Math.max(0, Math.min(1, o.gain == null ? 1 : o.gain)) * MASTER;
    // 音头极快（8ms 攻击）避免「咔」的爆音；音尾指数衰减到接近 0
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g);
    g.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch (_) {
    /* 音效失败绝不影响练习主流程 */
  }
}

/* ============================================================
   对外音效
   ============================================================ */

/**
 * 正确按键：一声轻脆的「嗒」。
 * 频率偏高、极短 —— 符合「打字机」的直觉联想，又不抢注意力。
 */
export function playCorrect() {
  consecutiveErrors = 0;
  tone({ freq: 1180, freqTo: 1560, type: 'triangle', dur: 0.045, gain: 0.9 });
}

/**
 * 错误按键：一声低沉的「咚」。
 *
 * 连错降音：第 1 次错正常，之后每次减 15%，最低降到 35%。
 * 理由见文件头 —— 连续出错时不能让提示音变成惩罚。
 */
export function playError() {
  consecutiveErrors += 1;
  const fatigue = Math.max(0.35, 1 - (consecutiveErrors - 1) * 0.15);
  tone({ freq: 220, freqTo: 150, type: 'sine', dur: 0.09, gain: 1.0 * fatigue });
}

/** 重置连错计数（例如开始新一轮练习时） */
export function resetErrorFatigue() {
  consecutiveErrors = 0;
}

/**
 * 完成一轮练习：三音上行「叮-咚-叮」。
 * 三个音依次错开 90ms，用纯五度 + 八度构成一个小上行动机，听起来是「达成」而不是「警告」。
 */
export function playFinish() {
  tone({ freq: 660, type: 'triangle', dur: 0.10, gain: 0.85, delay: 0 });
  tone({ freq: 880, type: 'triangle', dur: 0.10, gain: 0.85, delay: 0.09 });
  tone({ freq: 1320, type: 'triangle', dur: 0.16, gain: 0.90, delay: 0.18 });
}

/**
 * 能力测验「分数不理想」时的收尾音：两音下行。
 * 刻意不做成「失败音效」—— 测验只是诊断，不该让用户觉得被责备。
 */
export function playSoften() {
  tone({ freq: 520, freqTo: 460, type: 'sine', dur: 0.12, gain: 0.75, delay: 0 });
  tone({ freq: 390, type: 'sine', dur: 0.18, gain: 0.70, delay: 0.11 });
}

/**
 * 统一的音效分发口。UI 只调这一个函数，便于：
 *   - 一处集中处理「设置开关」与「环境能力」
 *   - 测试时直接 stub 掉，不依赖真实音频环境
 *
 * @param {'correct'|'error'|'finish'|'soften'} kind
 * @param {boolean} enabled 设置里的 sound 开关
 */
export function play(kind, enabled) {
  if (!enabled) return false;
  if (!hasWebAudio()) return false;
  switch (kind) {
    case 'correct': playCorrect(); return true;
    case 'error': playError(); return true;
    case 'finish': playFinish(); return true;
    case 'soften': playSoften(); return true;
    default: return false;
  }
}

/**
 * 用户打开开关时「试听」一下 —— 同时也是在用户手势里初始化 AudioContext，
 * 避免后续第一次按键时因挂起而静音。
 */
export function prime() {
  const c = ensureCtx();
  return !!c;
}

/** 仅供测试：探测当前环境是否具备 WebAudio 能力 */
export function isSupported() {
  return hasWebAudio();
}

/** 仅供测试：把内部状态清空（连错计数、AudioContext） */
export function _resetForTest() {
  consecutiveErrors = 0;
  ctx = null;
}
