/**
 * 语音朗读（SpeechSynthesis 封装）
 * ------------------------------------------------------------
 * 为什么需要它：L2 的两个模式**名字就叫「只听声母」「只听韵母」**，
 * 但在此之前它们的题目 `promptText` 是 "h" / "ou" 这样的**字母**，
 * 屏幕上显示拼音、全程没有任何声音 —— 名字承诺了听力训练，
 * 实际是看字母认键。这个模块把「听」这件事真正补上。
 *
 * 设计取舍：
 *
 * 1. **零依赖、零音频文件**。用浏览器原生的 `speechSynthesis`，
 *    与 sound.js 用 WebAudio 合成音效是同一条思路：能不塞资源就不塞。
 *
 * 2. **默认关闭**。理由与音效相同 —— 打字练习本来就有环境音，
 *    默认朗读很扰人。开关在设置页，与音效并列。
 *
 * 3. **必须处理「没有中文语音包」**。这是本模块最关键的一条：
 *    装了 en-US 语音的机器上，中文文本朗读出来是**英语口音念汉字**
 *    （或直接读不出），比不发声更糟。所以这里**主动探测 zh 语音**，
 *    探测不到就明确返回失败，由上层降级为「认键」语义并如实告知用户，
 *    而不是留一个按了没反应的哑巴按钮。
 *
 *    注意 `getVoices()` 在多数浏览器里**首次调用是空的**（异步加载），
 *    必须监听 `voiceschanged` 事件重新取，不能只判一次。
 *
 * 4. **朗读内容的选择**。「听声母」要读的是**声母的实际发音**，
 *    不是字母名。读 "h" 会被语音引擎念成英文 "aitch" 或字母 h，
 *    都不对。解决办法是给它一个**带元音的完整音节**（如 hē），
 *    让引擎按拼音规则发音 —— 这也是本模块对外暴露 `speak` 时
 *    接受完整读音而非单个字母的原因。
 */

/** 语音列表缓存。null = 尚未探测过。 */
let voiceCache = null;

/** 当前是否正在朗读（用于打断上一次，避免排队积压） */
let speaking = false;

/** 环境能力探测：没有 speechSynthesis 就整块静默降级 */
export function isSupported() {
  try {
    return typeof window !== 'undefined' && !!window.speechSynthesis;
  } catch (_) {
    return false;
  }
}

/**
 * 取中文语音。优先 zh-CN，其次任何 zh 开头。
 *
 * 为什么优先 zh-CN：zh-TW / zh-HK 的声调与用词和普通话有别，
 * 「双拼」这种教学场景应该用标准普通话。
 *
 * @returns {SpeechSynthesisVoice|null}
 */
function pickChineseVoice() {
  if (!isSupported()) return null;
  try {
    if (voiceCache === null) {
      voiceCache = window.speechSynthesis.getVoices() || [];
    }
    const list = voiceCache;
    if (!list.length) return null;      // 尚未加载完，调用方稍后重试
    return list.find(v => /^zh[-_]CN/i.test(v.lang)) ||
           list.find(v => /^zh/i.test(v.lang)) ||
           null;
  } catch (_) {
    return null;
  }
}

/**
 * 主动探测是否有可用中文语音，并等待语音列表加载完成。
 *
 * 这是异步的、且**可能永远等不到**（用户没装中文包）——
 * 所以带超时。上层拿到 false 就该走降级路径。
 *
 * @param {number} timeoutMs 等待 voiceschanged 的上限（默认 1200ms）
 * @returns {Promise<boolean>}
 */
export function hasChineseVoice(timeoutMs = 1200) {
  if (!isSupported()) return Promise.resolve(false);
  const found = pickChineseVoice();
  if (found) return Promise.resolve(true);

  return new Promise(resolve => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { window.speechSynthesis.removeEventListener('voiceschanged', onChange); } catch (_) {}
      clearTimeout(timer);
      resolve(ok);
    };
    const onChange = () => {
      voiceCache = null;                 // 列表变了，重新取
      if (pickChineseVoice()) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try { window.speechSynthesis.addEventListener('voiceschanged', onChange); } catch (_) {}
  });
}

/**
 * 朗读一段文本。
 *
 * 为什么每次都要 cancel：用户连点两次「重听」，若不清队列会先读完
 * 第一次再读第二次，听起来像卡住。朗读时长通常几百毫秒，打断是安全的。
 *
 * @param {string} text 要朗读的内容（请传完整读音，不要传单个字母，
 *                      原因见文件头第 4 条）
 * @param {object} [opts]
 *   - rate:  语速（0.1–10，默认 0.85 —— 教学场景略慢于常速）
 *   - pitch: 音高（默认 1）
 * @returns {boolean} 是否成功发起朗读（false 表示无语音可用或出错）
 */
export function speak(text, opts = {}) {
  if (!isSupported()) return false;
  const voice = pickChineseVoice();
  if (!voice) return false;            // 无中文语音：明确失败，交给上层降级
  const s = String(text || '').trim();
  if (!s) return false;

  try {
    window.speechSynthesis.cancel();   // 打断上一次，避免排队
    const u = new window.SpeechSynthesisUtterance(s);
    u.voice = voice;
    u.lang = voice.lang || 'zh-CN';
    u.rate = clampNum(opts.rate, 0.1, 10, 0.85);
    u.pitch = clampNum(opts.pitch, 0, 2, 1);
    u.volume = 1;
    u.onstart = () => { speaking = true; };
    u.onend = () => { speaking = false; };
    u.onerror = () => { speaking = false; };
    window.speechSynthesis.speak(u);
    return true;
  } catch (_) {
    return false;
  }
}

/** 停止朗读（切换题目 / 离开页面时调用，避免上一题的声音还在念） */
export function stop() {
  if (!isSupported()) return;
  try { window.speechSynthesis.cancel(); } catch (_) {}
  speaking = false;
}

/** 是否正在朗读 */
export function isSpeaking() { return speaking; }

/** 数值夹取；非有限数回落默认值 */
function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
