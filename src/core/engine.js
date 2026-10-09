/**
 * 练习引擎
 * ------------------------------------------------------------
 * 职责：
 *   - 维护练习会话状态（题目序列、当前位置、已输入字符）
 *   - 逐键校验：判断按键对错、推进位置、生成反馈信息
 *   - 统计：速度（字/分）、正确率、用时、连击
 *   - 事件通知：通过 on(event, handler) 向外广播状态变化
 *
 * 校验语义（重要）：
 *   - 单字/词组/拆分模式：以「音节」为推进单位。
 *     小鹤中每个音节恒为 2 键（zh/ch/sh 也只占一键，不额外加 H）。
 *     按键正确 → 记录并进入下一键；按错 → 计入错误，不推进（严格模式）
 *     或在整音节错误后允许重来。
 *   - 键位熟悉模式：单键作答，按下即判定。
 *   - 短文模式：标点自动跳过，汉字按音节推进。
 *
 * 【卡住自动提示】（learn 层能力，可整块关掉）
 *   学习者最常见的困境不是「按错」，而是「想不起来、盯着键盘发呆」。
 *   因此在 RUNNING 状态下，若某个键停留超过 hintDelayMs（默认 3 秒）：
 *     ① 先 emit('hint')，由 UI 让键位图上对应的键闪烁（只给位置，不给答案）；
 *     ② 再停留 revealDelayMs（默认 6 秒）后 emit('reveal')，直接给出答案。
 *   约束：
 *     - 任何一次按键（对/错都算）都会重置计时，从当前键重新开始数；
 *     - PAUSED / FINISHED / IDLE 状态一律不计时，暂停发呆不会刷出提示；
 *     - 【统计口径】提示过的字符计入 stats.hintedChars，summary() 另给
 *       independentAccuracy（独立正确率）—— 其分子**不含提示过的字符**。
 *
 * 3. 【考试模式】cfg.examMode = true（能力测验）时：
 *    提示被**硬关闭**（examMode 是独立于 hintEnabled 的闸门，
 *    即使外部把 hintEnabled 改成 true 也不生效），且 requestHint /
 *    自动提示都会直接返回 false。测验结束后由 score.js 折算 0–100 分。
 *       否则用户可以「等提示再按」把正确率刷满，指标就失去意义。
 *
 * 所有对外方法都做了空值与越界保护 —— 引擎不应因脏输入而抛异常。
 */

import {
  buildSyllables, splitSyllable, isKeyCorrect, expectedKey,
  acceptableKeys, minKeystrokes, highlightForSplit
} from './scheme.js';
import { isPunct } from './questions.js';
import { createTraining, observeTraining } from './training.js';

/**
 * 两次计时结算之间允许的最大间隔（秒）。
 *
 * 【为什么必须共用一个上限】引擎里有两个时间口径：elapsedSec（会话用时，
 * 速度的分母）和 activeSeconds()（尚未结算的零头，反应时间的来源）。
 * 历史上前者由 ticker 无上限累加、后者卡 5 秒，于是「后台挂起 5 分钟」这种
 * 场景会走成两套答案：ticker 先跑的话 elapsedSec 直接 +300，下一个
 * _unitStartedAt → activeSeconds() 的差值就是 300 秒，5 秒上限形同虚设，
 * 那个样本会把自适应档位静默降下去。结算顺序取决于两个回调谁先触发，
 * 所以这不是「概率问题」而是「行为不确定」。
 *
 * 反过来，无条件卡上限也会错：正常思考时两次 tick 只差 0.25 秒，
 * 只有标签页被节流（后台/遮挡窗口）、或主线程被长任务卡住时才会超过 5 秒
 * —— 那段时间用户并没有在练，不该计入。
 *
 * 所以：ticker、activeSeconds()、finish()、pause() 全部走这一个常量。
 */
const MAX_IDLE_GAP_SEC = 5;

/* ============================================================
   按键耗时（反应时间）
   ------------------------------------------------------------
   已有「哪些键按错」（热力图）与「哪些字不会」（易错表），
   这一层测的是第三种信号：**按对了，但按得慢** —— 还在犹豫、
   还没形成肌肉记忆。它比错误更早出现，所以补上它诊断才闭环。

   三条口径决定了它测的是什么，不搞清楚就会得到一个好看但没意义的数字：

   ① **只测「纯运动时间」**。小鹤双拼每个音节恒为两键：第 1 键是声母位，
      用户得先**读完这个字**再决定按哪个键；第 2 键是韵母位，上一键刚按完，
      手已经在动。若两种都收进来，声母键会系统性地显得比韵母键慢 ——
      那是「读字时间」混进了「按键时间」，列出来的「最慢的键」基本等于
      「所有声母键」，没有任何诊断价值。
      所以音节题只收 pos ≥ 1 的样本；单键题（键位练习、只听声母/韵母）
      整个单元就这一个键，它出现即是要按的键，全部收下 —— 同一模式内
      样本形状一致，彼此可比。

   ② **按错的目标不产生样本**。按错之后的那次「改对」测的是纠错耗时，
      不是这个键的熟练度；而从出错前就已经开始的那段等待里，
      又混进了「想不起来」的成分。两个信号都归错误热力图管。

   ③ **超过 maxMs 的样本直接丢弃，不做截断**。截断会让所有超时的样本
      堆在同一个值上，把中位数拽到上限，看起来像「一大片键都慢到上限」，
      比不显示更糟。超过这个量级已经不是「犹豫」，是「人不在」。

   maxMs 与 MAX_IDLE_GAP_SEC 取同一个 5 秒：那里的理由（标签页节流、
   主线程长任务 —— 那段时间用户并没有在练）在这里同样成立。
   另一个天然的上界来自提示：开着提示时，停留 3 秒就闪键位，
   那一刻起样本即作废，所以有效窗口本来就被压在 3 秒以内。
   ============================================================ */
export const KEY_TIMING = {
  maxMs: 5000,          // 单样本上限，超过即丢弃（见 ③）
  sessionPerBucket: 200, // 单次会话内每键每桶的样本上限（FIFO）
  storedPerBucket: 60    // 落盘时每键每桶的样本上限（FIFO，即「最近 60 次」）
};

/** 样本桶名。lead = 键一出现即唯一目标；follow = 同一音节内的第 2+ 键 */
export const KEY_TIMING_BUCKETS = ['lead', 'follow'];

/* 默认提示时间线（毫秒）。可在 config 里覆盖；设为 0 即关闭该级提示。 */
export const HINT_DEFAULTS = {
  hintDelayMs: 3000,     // 停留多久开始闪键位
  revealDelayMs: 6000,   // 停留多久直接给出答案（相对「开始计时」）
  enabled: true
};

/**
 * 定时器适配：优先用宿主窗口的 setInterval，
 * 在非浏览器环境（测试、SSR）回退到全局定时器。
 * 这样引擎不依赖 window 一定存在。
 */
const timers = {
  set(fn, ms) {
    try {
      if (typeof window !== 'undefined' && window && typeof window.setInterval === 'function') {
        return window.setInterval(fn, ms);
      }
    } catch (_) {}
    return setInterval(fn, ms);
  },
  clear(id) {
    if (id == null) return;
    try {
      if (typeof window !== 'undefined' && window && typeof window.clearInterval === 'function') {
        window.clearInterval(id);
        return;
      }
    } catch (_) {}
    clearInterval(id);
  }
};

/* 引擎状态枚举 */
export const STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  FINISHED: 'finished'
};

export class PracticeEngine {
  /**
   * @param {object} config
   *   - questions: Question[]
   *   - mode: string
   *   - durationSec: number (0 = 不限)
   *   - strict: boolean
   *   - skipPunct: boolean
   *   - hintDelayMs / revealDelayMs / hintEnabled: 卡住自动提示
   *   - sessionId / restored: 用于续练
   */
  constructor(config = {}) {
    const cfg = config || {};

    this.questions = Array.isArray(cfg.questions) && cfg.questions.length
      ? cfg.questions.slice()
      : [];
    if (!this.questions.length) {
      throw new Error(' PracticeEngine 需要至少一道题目');
    }

    this.questionSource = typeof cfg.questionSource === 'function' ? cfg.questionSource : null;
    this.unlimited = cfg.unlimited === true && cfg.examMode !== true;
    this.questionOffset = Math.max(0, Math.floor(Number(cfg.questionOffset) || 0));
    this.generation = cfg.generation || null;
    this.mode = String(cfg.mode || 'char');
    this.durationSec = Math.max(0, Number(cfg.durationSec) || 0);
    this.strict = cfg.strict !== false;
    this.skipPunct = cfg.skipPunct !== false;
    this.modeName = String(cfg.modeName || '');

    /* ---- 卡住自动提示配置 ---- */
    this.hintEnabled = cfg.hintEnabled !== false;
    this.hintDelayMs = normalizeMs(cfg.hintDelayMs, HINT_DEFAULTS.hintDelayMs);
    this.revealDelayMs = normalizeMs(cfg.revealDelayMs, HINT_DEFAULTS.revealDelayMs);

    /* ---- 考试模式（能力测验）----
       测验要测的是「脱离辅助后的真实水平」，所以提示必须彻底关闭。
       这里不只是把 hintEnabled 置 false，而是设一个**独立标志**：
       ① hintEnabled 是用户设置项，测验时会被临时覆盖，重叠语义容易出错；
       ② 有了 examMode，UI 层可以据此隐藏迷你键位图 / 帮助按钮，
          不必到处判断 mode === 'exam'；
       ③ 更重要的是**防篡改**：如果后续有人往设置里加「测试时也允许提示」，
          examMode 这层硬闸门能保证测验语义不被改坏。 */
    this.examMode = cfg.examMode === true;
    this.trainingEnabled = !!cfg.trainingPolicy || !!cfg.training;
    this.training = createTraining(cfg.trainingPolicy || cfg.training?.policy, cfg.training);
    this.adaptive = !this.examMode && this.mode === 'char' && this.generation?.charTier === 'progressive';
    this._unitStartedAt = 0;
    if (this.examMode) {
      // 硬约束：考试模式下一律无提示，且不再允许被外部打开
      this.hintEnabled = false;
      this.hintDelayMs = 0;
      this.revealDelayMs = 0;
    }

    // 两级时间线必须单调；否则「先闪键、后给答案」的语义会颠倒
    if (this.revealDelayMs > 0 && this.revealDelayMs < this.hintDelayMs) {
      this.revealDelayMs = this.hintDelayMs;
    }
    /* 已亮到哪一级：'' | 'hint' | 'reveal' —— 用于去重，同一级只广播一次 */
    this._hintLevel = '';
    this._hintTimer = null;
    this._idleSince = 0;

    /* ---- 运行时状态 ---- */
    this.state = STATE.IDLE;
    this.index = 0;           // 当前题号
    this.charIndex = 0;       // 当前题内字符下标
    this.keyIndex = 0;        // 当前音节内的按键下标
    this.typed = '';          // 当前音节已输入串
    this.elapsedSec = 0;
    this.startedAt = 0;

    /* ---- 统计 ---- */
    this.stats = {
      totalChars: 0,        // 已完成的可打字字符数
      correctChars: 0,      // 一次未错的字符数
      wrongChars: 0,        // 出过错的字符数
      hintedCorrectChars: 0,
      hintedChars: 0,       // 依赖过提示才打出的字符数（不计入独立正确率分子）
      keystrokes: 0,        // 总按键数
      wrongKeystrokes: 0,   // 错误按键数
      combo: 0,
      maxCombo: 0,
      perCharErrors: {},   // charKey -> 错误次数
      perWordErrors: {},   // 整条文本 -> 错误次数（词组/短文，供复习页分组）
      // 键 -> { lead: [ms], follow: [ms] }，按键耗时样本（见 KEY_TIMING）
      keyTimings: {}
    };

    /* ---- 按键耗时测量的运行态 ----
       _keyWaitSince 用 Date.now() 而不是 elapsedSec：后者每 250ms 才跳一次，
       而我们要分辨的正是 200–600ms 这一档，250ms 的量化误差比信号本身还大。
       代价是绕过了 ticker 的节流保护，所以这里显式在 pause() 里 disarm ——
       暂停期间的墙上时间不会混进样本。 */
    this._keyWaitSince = 0;      // 本次等待的起始墙上时刻；0 = 不在测量
    this._keyWaitKey = '';       // 本次等待对应的期望键
    this._keyWaitTainted = false;// 本次等待已作废（按错过 / 提示介入）
    this._keyWaitMeasured = 0;   // 已产出的**实测**样本数，用来丢掉会话第一个

    /* 已出错的字符集合（用于判定 correctChars） */
    this._erroredChars = new Set();

    /* 已用过提示的字符集合（用于判定 hintedChars） */
    this._hintedChars = new Set();

    /* 自动跳过（标点 / 未收录）的字符数，仅用于结果展示 */
    this._skippedCount = 0;

    /* 事件表 */
    this._handlers = {};

    /* 暂停期间累积（用于时间统计） */
    this._ticker = null;
    this._lastTickAt = 0;
  }

  /* ==========================================================
     事件
     ========================================================== */

  on(event, handler) {
    if (typeof handler !== 'function') return this;
    const e = String(event || '');
    if (!this._handlers[e]) this._handlers[e] = [];
    this._handlers[e].push(handler);
    return this;
  }

  off(event, handler) {
    const e = String(event || '');
    if (!this._handlers[e]) return this;
    if (!handler) { delete this._handlers[e]; return this; }
    this._handlers[e] = this._handlers[e].filter(h => h !== handler);
    return this;
  }

  /**
   * 派发事件。
   * @param {string} event
   * @param {*} payload
   * @param {...*} extra 透传给监听器的附加参数。
   *   目前只用于 change：第三个参数是重绘粒度（'key' | 'char' | 'question'），
   *   让 UI 能按粒度走增量路径。用 rest 而不是固定第三参，
   *   是为了将来加别的元信息时不必再改签名、也不必改所有监听器。
   *   （曾漏掉这一层 —— emit 只声明了两个形参，引擎里标好的粒度
   *   走到这里就被静默丢掉了，UI 永远收到 undefined。）
   */
  emit(event, payload, ...extra) {
    const list = this._handlers[String(event)];
    if (!list || !list.length) return;
    for (const h of list.slice()) {
      try { h(payload, ...extra); } catch (err) { console.error('[engine] 事件处理异常', event, err); }
    }
  }

  /* ==========================================================
     生命周期
     ========================================================== */

  start() {
    if (this.state === STATE.RUNNING) return this;
    if (this.state === STATE.PAUSED) return this.resume();
    this.state = STATE.RUNNING;
    this.startedAt = Date.now();
    this._lastTickAt = Date.now();
    this._startTicker();
    this._resetHintTimer();
    this._armKeyWait();
    this.emit('state', { state: this.state });
    this.emit('change', this.snapshot(), 'question');
    return this;
  }

  pause() {
    if (this.state !== STATE.RUNNING) return this;
    this.syncActiveTime();
    this.state = STATE.PAUSED;
    this._stopTicker();
    this._clearHintTimer();
    // 按键耗时走的是 Date.now()（见 KEY_TIMING），没经过 ticker 的节流保护，
    // 所以暂停必须显式 disarm —— 否则那段时间会被算进「等这个键等了多久」。
    this._disarmKeyWait();
    this.emit('state', { state: this.state });
    this.emit('pause', this.snapshot());
    return this;
  }

  resume() {
    if (this.state !== STATE.PAUSED) return this;
    this.state = STATE.RUNNING;
    this._lastTickAt = Date.now();
    this._startTicker();
    this._resetHintTimer();
    this._armKeyWait();
    this.emit('state', { state: this.state });
    this.emit('resume', this.snapshot());
    return this;
  }

  togglePause() {
    if (this.state === STATE.RUNNING) return this.pause();
    if (this.state === STATE.PAUSED) return this.resume();
    return this;
  }

  /** 结束练习（用户主动或完成） */
  finish(reason = 'user') {
    if (this.state === STATE.FINISHED) return this.summary();
    // 把「最后一次 tick 之后的零头」补进用时。
    // 计时器每 250ms 才跳一次，若用户刚好在两次 tick 之间打完最后一题，
    // 直接结束会让用时偏少（极端情况下为 0），速度指标失真。
    if (this.state === STATE.RUNNING) this.syncActiveTime();
    this._stopTicker();
    this._clearHintTimer();
    this._disarmKeyWait();
    this.state = STATE.FINISHED;
    const summary = this.summary();
    summary.reason = reason;
    this.emit('finish', summary);
    this.emit('state', { state: this.state });
    return summary;
  }

  destroy() {
    this._stopTicker();
    this._clearHintTimer();
    this._disarmKeyWait();
    this._handlers = {};
    this.state = STATE.IDLE;
  }

  _startTicker() {
    this._stopTicker();
    this._ticker = timers.set(() => {
      try {
        const now = Date.now();
        // 与 activeSeconds() 共用同一上限，避免两套时钟口径分叉。
        const delta = Math.min(MAX_IDLE_GAP_SEC, Math.max(0, (now - this._lastTickAt) / 1000));
        this._lastTickAt = now;
        if (this.state !== STATE.RUNNING) return;
        this.elapsedSec += delta;
        this.emit('tick', this.snapshot());
        // 时间到
        if (this.durationSec > 0 && this.elapsedSec >= this.durationSec) {
          this.elapsedSec = this.durationSec;
          this.finish('timeup');
        }
      } catch (err) {
        console.error('[engine] tick 异常', err);
      }
    }, 250);
  }

  _stopTicker() {
    if (this._ticker) {
      timers.clear(this._ticker);
      this._ticker = null;
    }
  }

  /* ==========================================================
     卡住自动提示
     ========================================================== */

  /**
   * 重新开始「这个键已停留多久」的计时。
   * 每次按键、每次推进（换字/换题）、以及恢复练习时都要调用。
   */
  _resetHintTimer() {
    this._clearHintTimer();
    this._idleSince = Date.now();
    this._hintLevel = '';
    if (!this.hintEnabled) return;
    if (this.state !== STATE.RUNNING) return;
    // 两级都关闭时不建计时器（纯练速度的场景）
    if (!(this.hintDelayMs > 0) && !(this.revealDelayMs > 0)) return;
    this._hintTimer = timers.set(() => {
      try { this._checkHint(); } catch (err) { console.error('[engine] hint 异常', err); }
    }, Math.max(80, Math.min(this.hintDelayMs || this.revealDelayMs, this.revealDelayMs || this.hintDelayMs)));
  }

  _clearHintTimer() {
    if (this._hintTimer) {
      timers.clear(this._hintTimer);
      this._hintTimer = null;
    }
  }

  /** 定时器回调：判断是否该亮一级提示（同一级只广播一次） */
  _checkHint() {
    if (this.examMode) return;            // 测验中不闪键、不给答案
    if (!this.hintEnabled) return;
    if (this.state !== STATE.RUNNING) return;
    if (!this._idleSince) return;

    const idle = Date.now() - this._idleSince;
    const want = (this.revealDelayMs > 0 && idle >= this.revealDelayMs) ? 'reveal'
      : (this.hintDelayMs > 0 && idle >= this.hintDelayMs) ? 'hint'
      : '';
    if (!want) return;

    const order = { '': 0, hint: 1, reveal: 2 };
    if (order[want] <= order[this._hintLevel || '']) return;   // 该级已亮过

    this._hintLevel = want;
    const target = this.currentTarget();
    if (!target || target.kind === 'skip' || target.kind === 'invalid' || !target.len) {
      // 没有可作答的目标（标点/异常）——不需要提示，重新计时即可
      this._idleSince = Date.now();
      this._hintLevel = '';
      return;
    }

    const expected = (target.keys || [])[target.pos] || '';
    const payload = {
      level: want,
      idleMs: idle,
      key: String(expected).toLowerCase(),
      pos: target.pos,
      keys: (target.keys || []).map(k => String(k).toLowerCase()),
      role: target.role,
      label: target.label,
      part: target.part,
      char: target.char,
      pinyin: target.pinyin,
      code: target.split ? target.split.code : '',
      text: target.split ? target.split.text : ''
    };

    // 亮过提示即视为「依赖提示」，该字符不计入独立正确率分子
    const mark = this._currentMarkKey(target);
    if (mark) this._hintedChars.add(mark);
    // 提示一介入，这次等待测的就不再是「自己要多久才能反应」，
    // 而是「被告知答案后多久动手」。作废，否则提示开着时慢键会被系统性高估。
    this._taintKeyWait();

    this.emit('hint', payload);
    if (want === 'reveal') this.emit('reveal', payload);
    // 提示只影响高亮/键位，不改变字符集 → 标为 'key'
    this.emit('change', this.snapshot(), 'key');
  }

  /** 当前作答目标对应的「字符标记」（与 _erroredChars 同一套键） */
  _currentMarkKey(target) {
    if (!target) return '';
    if (target.kind === 'key' || target.kind === 'part') return `key:${this.index}`;
    const ch = this.currentChar();
    if (!ch || this._isSkippable(ch)) return '';
    return `${this.index}:${this.charIndex}`;
  }

  /** 当前是否正亮着提示（UI 用来决定是否显示「答案已给出」样式） */
  hintLevel() {
    return this._hintLevel || '';
  }

  /** 最近一次「停留了多久」（毫秒），供 UI 显示 */
  idleMs() {
    if (!this._idleSince) return 0;
    return Math.max(0, Date.now() - this._idleSince);
  }

  /**
   * 主动请求提示（用户按 Tab）。
   * 与自动提示共用同一套事件，但立刻触发到 'reveal' 级。
   */
  requestHint(level) {
    if (this.examMode) return false;      // 测验中不提供任何求助
    if (!this.hintEnabled) return false;
    if (this.state !== STATE.RUNNING) return false;
    const target = this.currentTarget();
    if (!target || target.kind === 'skip' || target.kind === 'invalid' || !target.len) return false;

    const want = level === 'hint' ? 'hint' : 'reveal';
    const expected = (target.keys || [])[target.pos] || '';
    const payload = {
      level: want,
      idleMs: this.idleMs(),
      manual: true,
      key: String(expected).toLowerCase(),
      pos: target.pos,
      keys: (target.keys || []).map(k => String(k).toLowerCase()),
      role: target.role,
      label: target.label,
      part: target.part,
      char: target.char,
      pinyin: target.pinyin,
      code: target.split ? target.split.code : '',
      text: target.split ? target.split.text : ''
    };
    this._hintLevel = want;
    const mark = this._currentMarkKey(target);
    if (mark) this._hintedChars.add(mark);
    // 与 _checkHint 同样作废本次等待。手动求助和自动提示在这件事上没有区别：
    // 用户拿到答案了，接下来那一按测的就不是「自己要多久才能反应」。
    this._taintKeyWait();
    this.emit('hint', payload);
    if (want === 'reveal') this.emit('reveal', payload);
    // 同上：手动求助也是只改高亮
    this.emit('change', this.snapshot(), 'key');
    return true;
  }

  /* ==========================================================
     状态快照
     ========================================================== */

  currentQuestion() {
    return this.questions[this.index] || null;
  }

  /** 当前需要处理的字符（跳过标点） */
  currentChar() {
    const q = this.currentQuestion();
    if (!q) return null;
    if (q.kind === 'key') return null;
    const chars = q.chars || [];
    if (!chars.length) return null;
    return chars[this.charIndex] || null;
  }

  /**
   * 当前作答目标：统一抽象为 { kind, keys, role, ... }
   *   - 键位模式：目标 = 1 个键
   *   - 拆分成分模式（只听声母/只听韵母）：目标 = 该成分对应的 1 个键
   *   - 其它模式：目标 = 当前音节的 N 个键
   */
  currentTarget() {
    const q = this.currentQuestion();
    if (!q) return null;

    if (q.kind === 'key') {
      return {
        kind: 'key',
        keys: Array.isArray(q.answerKeys) ? q.answerKeys.slice() : ['A'],
        pos: this.keyIndex,
        role: q.role || 'yun',
        char: q.promptText || '',
        pinyin: '',
        syl: null,
        split: null,
        len: (Array.isArray(q.answerKeys) ? q.answerKeys.length : 1)
      };
    }

    /* ---- 只听声母 / 只听韵母 ---- */
    if (q.kind === 'part') {
      const part = q.part === 'sheng' ? 'sheng' : 'yun';
      const split = q.fullSplit || (q.chars && q.chars[0] ? q.chars[0].syl && q.chars[0].syl.split : null);
      if (!split || !Array.isArray(split.steps) || !split.steps.length) {
        return { kind: 'invalid', char: q.promptText || '', len: 0, pos: 0, keys: [] };
      }
      // 定位到要考的那一步：声母取 role==='sheng'，韵母取 role==='yun'。
      // 零声母音节的两步 role 是 'zero' + 'yun'，因此韵母仍能正确定位。
      let idx = split.steps.findIndex(st => st.role === part);
      if (idx < 0) idx = part === 'sheng' ? 0 : split.steps.length - 1;
      const step = split.steps[idx] || {};
      // 只用「那一步的键」组成目标序列，pos 恒为 0（一次按键即完成）
      const key = String(step.key || q.answerKeys && q.answerKeys[0] || '').toUpperCase();
      if (!key) return { kind: 'invalid', char: q.promptText || '', len: 0, pos: 0, keys: [] };
      return {
        kind: 'part',
        part,
        char: q.promptText || '',
        pinyin: q.pinyin || '',
        syl: q.chars && q.chars[0] ? q.chars[0].syl : null,
        split,
        stepIndex: idx,
        pos: 0,
        keys: [key],
        len: 1,
        role: part,
        label: part === 'sheng' ? '声母' : '韵母',
        part2: step.part || ''
      };
    }

    const ch = this.currentChar();
    if (!ch) return null;

    if (ch.punct || ch.unknown) {
      return { kind: 'skip', char: ch.ch, skip: true, len: 0, pos: 0, keys: [] };
    }

    const syl = ch.syl;
    if (!syl || !syl.candidates || !syl.candidates.length) {
      return { kind: 'invalid', char: ch.ch, len: 0, pos: 0, keys: [] };
    }

    /* 零声母音节（an / a / ang / en…）在这里**不做特殊处理**。
       曾有一个 `if (syl.zero) { ...slice(0,1) }` 分支，把零声母截成「只按一键」。
       那是错的：小鹤里零声母同样恒为 2 键，编码 = 首字母（占声母位）+ 韵母键，
       例如 an → AJ、a → AA、ang → AH（README「关于键位」一节写得很明确）。
       该分支当时是死代码（syl 上没有 zero 字段），但一旦有人补上该字段，
       就会开始逼用户少按一键 —— 属于埋雷，故直接删除。
       零声母与有声母共用下面同一套两键推进逻辑。 */
    const split = syl.split || syl.candidates[0];
    const pos = Math.min(this.keyIndex, split.keys.length - 1);
    return {
      kind: 'syllable',
      char: ch.ch,
      pinyin: ch.pinyin,
      syl,
      split,
      pos,
      keys: split.keys,
      len: split.keys.length,
      role: split.steps && split.steps[pos] ? split.steps[pos].role : 'yun',
      label: split.steps && split.steps[pos] ? split.steps[pos].label : '',
      part: split.steps && split.steps[pos] ? split.steps[pos].part : ''
    };
  }

  snapshot() {
    const q = this.currentQuestion();
    return {
      state: this.state,
      index: this.index,
      total: this.questions.length,
      questionOffset: this.questionOffset,
      unlimited: this.unlimited,
      charIndex: this.charIndex,
      keyIndex: this.keyIndex,
      typed: this.typed,
      elapsedSec: this.elapsedSec,
      durationSec: this.durationSec,
      question: q,
      target: this.currentTarget(),
      stats: this.visibleStats(),
      hintLevel: this._hintLevel || '',
      idleMs: this.idleMs(),
      hintEnabled: this.hintEnabled
    };
  }

  visibleStats() {
    const s = this.stats;
    const minutes = this.elapsedSec / 60;
    const speed = minutes > 0.02 ? s.correctChars / minutes : 0;
    const total = s.correctChars + s.wrongChars;
    // 正确率以「字符」为分母更贴近打字直觉；若还没打完任何字则按键算
    let accuracy;
    if (total > 0) {
      accuracy = (s.correctChars / total) * 100;
    } else if (s.keystrokes > 0) {
      accuracy = ((s.keystrokes - s.wrongKeystrokes) / s.keystrokes) * 100;
    } else {
      accuracy = 100;
    }

    /* 独立正确率：分子**剔除依赖过提示的字符**。
       提示 = 引擎替用户想出来了，不能算「会了」。
       若提示后仍然出错，则该字符本来就在 wrongChars 里，不受影响。 */
    const hinted = Number(s.hintedChars) || 0;
    const independentTotal = total;
    const independentCorrect = Math.max(0, s.correctChars - (s.hintedCorrectChars ?? Math.min(hinted, s.correctChars)));
    const independentAccuracy = independentTotal > 0
      ? (independentCorrect / independentTotal) * 100
      : accuracy;

    return {
      elapsedSec: this.elapsedSec,
      correctChars: s.correctChars,
      wrongChars: s.wrongChars,
      totalChars: s.totalChars,
      hintedChars: hinted,
      independentAccuracy: Math.round(Math.max(0, Math.min(100, independentAccuracy)) * 10) / 10,
      keystrokes: s.keystrokes,
      wrongKeystrokes: s.wrongKeystrokes,
      speed: Math.round(speed * 10) / 10,
      accuracy: Math.round(Math.max(0, Math.min(100, accuracy)) * 10) / 10,
      combo: s.combo,
      maxCombo: s.maxCombo,
      progress: this.unlimited ? `已完成 ${this.questionOffset + this.index} 题 · ∞` : `${Math.min(this.index + 1, this.questions.length)}/${this.questions.length}`
    };
  }

  /* ==========================================================
     按键耗时（反应时间）
     ========================================================== */

  /**
   * 开始测量「下一个正确键要等多久」。
   *
   * 调用时机统一为**期望键发生变化**的那些点：start / 恢复 / 换字 / 换题 /
   * 音节内推进到下一个键。不在每次 pressKey 之后调用 —— 按错时期望键并没有
   * 变，那种情况走 _taintKeyWait 作废本次样本。
   *
   * @param {object|null} [target] 已知目标则传入，省一次 currentTarget() 重建
   */
  _armKeyWait(target) {
    this._keyWaitSince = 0;
    this._keyWaitKey = '';
    this._keyWaitTainted = false;
    if (this.state !== STATE.RUNNING) return;
    const t = target || this.currentTarget();
    if (!t) return;
    // 只有「键一出现就是唯一要按的键」或「同音节内的第 2+ 键」才测，
    // 见 KEY_TIMING ①：音节首键含读字时间，混进来会让声母键系统性变慢。
    const measurable = (t.kind === 'key' || t.kind === 'part') || Number(t.pos) >= 1;
    if (!measurable) return;
    const key = String((t.keys && t.keys[t.pos]) || '').toUpperCase();
    if (!/^[A-Z]$/.test(key)) return;
    this._keyWaitSince = Date.now();
    this._keyWaitKey = key;
  }

  /** 停止测量并丢弃当前样本（换题/暂停/结束时调用） */
  _disarmKeyWait() {
    this._keyWaitSince = 0;
    this._keyWaitKey = '';
    this._keyWaitTainted = false;
  }

  /** 作废当前样本但保留测量窗口（按错、提示介入） */
  _taintKeyWait() {
    this._keyWaitTainted = true;
  }

  /**
   * 记录一次样本（仅在**按对**时调用）。
   * @param {string} expected 本次按对的键
   */
  _observeKeyWait(expected) {
    const key = String(expected || '').toUpperCase();
    const since = this._keyWaitSince;
    if (!since || this._keyWaitTainted) return;
    if (key !== this._keyWaitKey) return;      // 期望键与本次不符，说明窗口已错位
    const ms = Date.now() - since;
    // ③ 超过上限直接丢弃而非截断
    if (!(ms > 0) || ms > KEY_TIMING.maxMs) return;

    /* 会话第一个**实测**样本含「刚坐下、进入状态」的启动成本，天然偏大，丢掉。
     * 计数只在这里 +1 —— 音节首键那种「本来就不测量」的按压不该占掉这个名额，
     * 否则单字模式里第一个 follow 样本会被误删，而真正该丢的那个还在。 */
    if (this._keyWaitMeasured === 0) {
      this._keyWaitMeasured = 1;
      return;
    }
    this._keyWaitMeasured += 1;

    const bucket = this._timingBucket();
    if (!bucket) return;
    const store = this.stats.keyTimings;
    const rec = store[key] || (store[key] = { lead: [], follow: [] });
    rec[bucket].push(ms);
    if (rec[bucket].length > KEY_TIMING.sessionPerBucket) {
      rec[bucket] = rec[bucket].slice(rec[bucket].length - KEY_TIMING.sessionPerBucket);
    }
  }

  /** 本次样本该进 lead 还是 follow 桶 */
  _timingBucket() {
    const t = this.currentTarget();
    if (!t) return null;
    return (t.kind === 'key' || t.kind === 'part') ? 'lead' : 'follow';
  }

  /** 汇总本会话的按键耗时（给结算面板与落盘用） */
  keyTimings() {
    const out = {};
    const store = this.stats.keyTimings || {};
    for (const [k, rec] of Object.entries(store)) {
      const key = String(k || '').toUpperCase();
      if (!/^[A-Z]$/.test(key)) continue;
      const lead = sanitizeSamples(rec && rec.lead);
      const follow = sanitizeSamples(rec && rec.follow);
      if (!lead.length && !follow.length) continue;
      out[key] = { lead, follow };
    }
    return out;
  }

  /* ==========================================================
     核心：按键处理
     ========================================================== */

  /**
   * 处理一次按键
   * @param {string} rawKey 用户按下的键（任意大小写，非字母会被忽略）
   * @returns {object} 处理结果
   *   { handled, correct, advanced, feedback, ... }
   */
  pressKey(rawKey) {
    if (this.state === STATE.PAUSED) {
      return { handled: false, reason: 'paused' };
    }
    if (this.state === STATE.FINISHED) {
      return { handled: false, reason: 'finished' };
    }
    if (this.state === STATE.IDLE) this.start();

    const key = normalizeKey(rawKey);
    if (!key) return { handled: false, reason: 'invalid-key' };

    const target = this.currentTarget();
    if (!target) {
      this._advanceQuestion('empty-target');
      return { handled: false, reason: 'no-target' };
    }

    if (this.trainingEnabled && !this.examMode && this.assistanceLevel() === 0) {
      const mark = target.kind === 'key' || target.kind === 'part'
        ? `key:${this.index}` : `${this.index}:${this.charIndex}`;
      this._hintedChars.add(mark);
      // Full guidance also displays the next character's code. Remember that
      // assistance if this completion withdraws guidance mid-word/passage.
      const nextChar = this.currentQuestion()?.chars?.[this.charIndex + 1];
      if (target.kind !== 'key' && target.kind !== 'part' && nextChar?.syl)
        this._hintedChars.add(`${this.index}:${this.charIndex + 1}`);
    }

    // 标点 / 无拼音字符：自动跳过
    if (target.kind === 'skip' || target.kind === 'punct' || target.kind === 'invalid') {
      this._advanceChar();
      return { handled: true, correct: true, auto: true, feedback: null };
    }

    const expectedAll = target.keys.map(k => String(k).toLowerCase());
    const expected = expectedAll[target.pos];
    if (!expected) {
      // pos 越界，说明状态异常，直接推进
      this._advanceChar();
      return { handled: false, reason: 'bad-pos' };
    }

    this.stats.keystrokes += 1;

    // 任何一次按键都重置「停留计时」——即使按错，也说明用户在思考
    this._resetHintTimer();

    if (key === expected) {
      return this._onCorrectKey(target, key);
    }
    /* 严格模式（默认）：按错必须原地修正，不推进。
       键位练习要的就是「错了就停下来想清楚」，一路跳过去会掩盖真正不熟的键。
       非严格模式：按错等于「这个字我放弃了」，跳到下一个 ——
       等同于主动按一次跳过键（Backspace），适合已经熟练、只想刷通篇的情况。
       两种模式统计口径完全一致：错键都计入 wrongKeystrokes / perCharErrors，
       都清零连击，被跳过的字都不算「一次未错的正确字符」。
       测验强制严格 —— 分数是测量结果，放着错不改会让分数失去意义。 */
    const skipOnWrong = !this.strict && !this.examMode;
    return this._onWrongKey(target, key, expected, expectedAll, skipOnWrong);
  }

  /* ---- 按键正确 ---- */
  _onCorrectKey(target, key) {
    // 先取样再推进：一旦 keyIndex/charIndex 变了，期望键就换人了。
    this._observeKeyWait(target.keys[target.pos]);
    this.typed += key;
    this.stats.combo += 1;
    this.stats.maxCombo = Math.max(this.stats.maxCombo, this.stats.combo);

    const isLastKey = target.pos >= target.len - 1;

    if (isLastKey) {
      // 音节 / 键位题完成
      this._completeUnit(target);
      return {
        handled: true,
        correct: true,
        advanced: true,
        completedUnit: true,
        feedback: {
          type: 'ok',
          role: target.role,
          char: target.char,
          text: target.split ? target.split.text : ''
        }
      };
    }

    // 还没完成，移动到一个键
    this.keyIndex += 1;
    // 期望键变了，重新开一个测量窗口（此时 pos ≥ 1，属「纯运动时间」）
    this._armKeyWait();
    // 同一个音节里推进到下一键：字符集、题干都不变，只是高亮位移。
    // 这是打字场景里**最频繁**的一次 change（8–15 次/秒），标为 'key'
    // 让 UI 走增量路径，不重建题干。
    this.emit('change', this.snapshot(), 'key');
    return {
      handled: true,
      correct: true,
      advanced: false,
      feedback: {
        type: 'partial',
        role: target.role,
        nextKey: expectedKey(target.syl, this.keyIndex) || (target.keys[this.keyIndex] || ''),
        char: target.char
      }
    };
  }

  /* ---- 按键错误 ---- */
  /**
   * 记录「本次错误要算到哪个易错条目上」。
   *
   * 两种粒度：单字（练哪个字最容易错）与整条（词组/短文里这条内容整体不稳）。
   * 只记单字的话，复习页的「易错词语」那一组永远是空的 —— 因为分组靠 word
   * 字段且要求多字，而整条粒度才是词组练习真正该复习的对象。
   */
  _recordWrongItem(target, ch) {
    if (target.kind === 'key' || target.kind === 'part') {
      // 单键类题目：以「题目文本」作为易错条目
      const key0 = target.char || '';
      this._erroredChars.add(`key:${this.index}`);
      if (key0) {
        this.stats.perCharErrors[key0] = (this.stats.perCharErrors[key0] || 0) + 1;
      }
      return;
    }
    if (!ch || !ch.ch || this._isSkippable(ch)) return;
    this.stats.perCharErrors[ch.ch] = (this.stats.perCharErrors[ch.ch] || 0) + 1;
    this._erroredChars.add(`${this.index}:${this.charIndex}`);
    const q = this.currentQuestion();
    const text = q && typeof q.text === 'string' ? q.text : '';
    if (text && Array.from(text).length > 1) {
      this.stats.perWordErrors[text] = (this.stats.perWordErrors[text] || 0) + 1;
    }
  }

  /**
   * @param {boolean} skipOnWrong 非严格模式下是否顺带跳到下一单元
   * @returns {object} 反馈载荷（advanced 如实反映是否推进）
   */
  _onWrongKey(target, key, expected, expectedAll, skipOnWrong = false) {
    this.stats.wrongKeystrokes += 1;
    this.stats.combo = 0;
    // 按错 → 本次等待作废（见 KEY_TIMING ②）。
    // 不只是「不取这次的样」：从出错前就开始的那段等待里已经混进了
    // 「想不起来」的成分，继续留着会把纠错耗时当成这个键的熟练度。
    this._disarmKeyWait();

    // 记录易错的字 / 词
    this._recordWrongItem(target, this.currentChar());

    const split = target.split;
    const expectedDisplay = expectedAll.map(k => k.toUpperCase());
    // 拆分成分题里，pos 恒为 0，但步骤在 split.steps 里的下标是 stepIndex
    const stepIdx = target.kind === 'part'
      ? (Number.isInteger(target.stepIndex) ? target.stepIndex : 0)
      : target.pos;
    const step = split && split.steps ? split.steps[stepIdx] : null;

    const feedback = {
      type: 'err',
      pressed: key.toUpperCase(),
      expected: expected.toUpperCase(),
      expectedAll: expectedDisplay,
      char: target.char,
      pinyin: target.pinyin,
      pos: target.pos,
      role: target.role,
      part: step ? step.part : '',
      label: step ? step.label : '',
      splitText: split ? split.text : '',
      codeText: split ? split.code : '',
      explain: this._explainError(target, key, expected)
    };

    // 本次会话的键维度错误明细（错误热力图的数据来源）
    this.stats.keyErrors = this.stats.keyErrors || {};
    if (expected) {
      const ek = String(expected).toLowerCase();
      this.stats.keyErrors[ek] = (this.stats.keyErrors[ek] || 0) + 1;
    }

    this.emit('error', feedback);
    /* 非严格模式：按错即跳过。推进放在 emit('error') 之后 ——
       UI 的 error 处理器要靠 snapshot() 定位「刚才那个字」，
       先推进会让它算到下一个字头上。 */
    if (skipOnWrong) {
      feedback.skipped = true;
      // 被跳过的字必须**计入总数并算错**。不记的话它会从分母里消失，
      // 非严格模式下的正确率反而比严格模式更高 —— 跳得越多分越高，
      // 指标被彻底玩坏（这正是「独立正确率」要防的那类问题）。
      this._countSkippedCharAsWrong(target);
      this._advanceChar();
    }
    /* 粒度看有没有真的走字：严格模式停在原处（字符集不变 → 'key'），
       非严格模式上面已 _advanceChar()（字符集变了 → 'char'）。
       标错会导致 UI 少刷一次题干，眼睛看到的字和实际要求对不上。 */
    this.emit('change', this.snapshot(), skipOnWrong ? 'char' : 'key');
    return { handled: true, correct: false, advanced: !!skipOnWrong, feedback };
  }

  /** 生成人类可读的错误解释 */
  _explainError(target, pressed, expected) {
    const split = target.split;
    if (!split) return '';

    if (target.kind === 'part') {
      const stepIdx = Number.isInteger(target.stepIndex) ? target.stepIndex : 0;
      const step = (split.steps && split.steps[stepIdx]) || {};
      const cname = target.part === 'sheng' ? '声母' : '韵母';
      const val = step.part || '';
      return `${target.pinyin} 的${cname}是「${val}」，应落在 ${String(expected).toUpperCase()} 键（不是 ${String(pressed).toUpperCase()}）。完整编码 ${split.code}`;
    }

    const stepIdx = target.pos;
    const step = split.steps && split.steps[stepIdx];
    const roleName = step ? step.label : '该键';
    const part = step ? step.part : '';
    if (target.kind === 'key') {
      return `${part || target.char} 对应 ${expected.toUpperCase()} 键，不是 ${pressed.toUpperCase()} 键`;
    }
    const zh = ['zh', 'ch', 'sh'].includes(split.sheng);
    const parts = [];
    parts.push(`${this.currentChar() ? this.currentChar().ch : ''}（${target.pinyin}）`);
    if (zh) {
      parts.push(`应拆为「${split.sheng} + ${split.yun}」`);
      parts.push(`编码 ${split.code}`);
      parts.push(`第 ${target.pos + 1} 键（${roleName}=${part}）应是 ${expected.toUpperCase()}`);
    } else if (split.zero) {
      parts.push(`零声母音节，编码 ${split.code}`);
      parts.push(`第 ${target.pos + 1} 键（${roleName}）应是 ${expected.toUpperCase()}`);
    } else {
      parts.push(`应拆为「${split.sheng} + ${split.yun}」`);
      parts.push(`编码 ${split.code}`);
      parts.push(`第 ${target.pos + 1} 键（${roleName}=${part}）应是 ${expected.toUpperCase()}`);
    }
    return parts.join('，');
  }

  /* ==========================================================
     推进逻辑
     ========================================================== */

  /** 完成一个「作答单元」（一个音节 / 一个键位题 / 一个拆分成分题） */
  _completeUnit(target) {
    const unitSeconds = Math.max(0, this.activeSeconds() - this._unitStartedAt);
    // 统计字符
    if (target.kind === 'key' || target.kind === 'part') {
      // 单键类题目：以「一次正确作答」计 1 个字符
      this.stats.totalChars += 1;
      const mark = `key:${this.index}`;
      if (this._erroredChars.has(mark)) {
        this.stats.wrongChars += 1;
      } else {
        this.stats.correctChars += 1;
      }
      if (this._hintedChars.has(mark)) this.stats.hintedChars += 1;
    } else {
      const ch = this.currentChar();
      if (ch && !this._isSkippable(ch)) {
        this.stats.totalChars += 1;
        const mark = `${this.index}:${this.charIndex}`;
        if (this._erroredChars.has(mark)) {
          this.stats.wrongChars += 1;
        } else {
          this.stats.correctChars += 1;
        }
        if (this._hintedChars.has(mark)) this.stats.hintedChars += 1;
      }
    }

    const mark = target.kind === 'key' || target.kind === 'part'
      ? `key:${this.index}` : `${this.index}:${this.charIndex}`;
    const correct = !this._erroredChars.has(mark);
    const independent = correct && !this._hintedChars.has(mark);
    if (correct && this._hintedChars.has(mark)) this.stats.hintedCorrectChars++;
    observeTraining(this.training, { correct, independent, seconds: unitSeconds }, this.adaptive);
    this._unitStartedAt = this.activeSeconds();
    this.emit('unit', { target, stats: this.visibleStats(), independent, seconds: unitSeconds });

    if (target.kind === 'key' || target.kind === 'part') {
      // 单键类题目：推进到下一题
      this.keyIndex = 0;
      this.typed = '';
      this._advanceQuestion('key-done');
    } else {
      // 其它模式：推进到下一个字符
      this._advanceChar();
    }
  }

  /** 该字符是否无需打字（标点 / 未收录） */
  _isSkippable(c) {
    return !!c && (c.punct === true || c.unknown === true);
  }

  /** 推进到下一个字符（自动跳过标点与无拼音字符） */
  _advanceChar() {
    this.keyIndex = 0;
    this.typed = '';
    this._resetHintTimer();

    const q = this.currentQuestion();
    if (!q) { this._advanceQuestion('no-question'); return; }

    const chars = q.chars || [];

    if (q.kind === 'passage') {
      let next = this.charIndex + 1;
      if (this.skipPunct) {
        // 经过的标点/未收录字也要计入「已完成」，否则后面的 done 判定会错位
        let scan = this.charIndex;
        while (next < chars.length && this._isSkippable(chars[next])) {
          this._markCharDone(chars[next]);
          next++;
          scan++;
        }
      }
      this.charIndex = next;
      if (next >= chars.length) {
        this._advanceQuestion('passage-done');
        return;
      }
      this._armKeyWait();
      this.emit('change', this.snapshot(), 'char');
      return;
    }

    // 单字 / 词组 / 拆分：下一字符（同样跳过无拼音字符）
    let next = this.charIndex + 1;
    while (next < chars.length && this._isSkippable(chars[next])) {
      this._markCharDone(chars[next]);
      next++;
    }
    this.charIndex = next;
    if (next >= chars.length) {
      this._advanceQuestion('question-done');
    } else {
      this._armKeyWait();
      this.emit('change', this.snapshot(), 'char');
    }
  }

  /**
   * 非严格模式下被跳过的字：计入总字数并算作错误字符。
   *
   * 与 _markCharDone（标点/未收录字的自动跳过）相反 —— 那类字本来就不
   * 需要打字，不该进分母；这里是用户主动放弃了一个**本该会**的字，
   * 留着会让正确率虚高。
   */
  _countSkippedCharAsWrong(target) {
    if (target.kind === 'key' || target.kind === 'part') {
      this.stats.totalChars += 1;
      this.stats.wrongChars += 1;
      return;
    }
    const ch = this.currentChar();
    if (ch && !this._isSkippable(ch)) {
      this.stats.totalChars += 1;
      this.stats.wrongChars += 1;
    }
  }

  /**
   * 标记一个「无需打字」的字符已完成（供结果弹窗统计跳过数量）
   * 不影响 correctChars / wrongChars —— 跳过项不计入正确率分母。
   */
  _markCharDone(c) {
    if (!this._isSkippable(c)) return;
    if (typeof this._skippedCount !== 'number') this._skippedCount = 0;
    this._skippedCount += 1;
  }

  /** 推进到下一题 */
  _advanceQuestion(reason) {
    if (reason === 'skip') {
      observeTraining(this.training, { correct: false, independent: false,
        seconds: this.activeSeconds() - this._unitStartedAt }, this.adaptive);
    }
    this._unitStartedAt = this.activeSeconds();
    this.keyIndex = 0;
    this.charIndex = 0;
    this.typed = '';
    this._resetHintTimer();

    this.index += 1;

    if (this.index >= this.questions.length && this.unlimited) {
      let next = null;
      try { next = this.questionSource?.({ adaptiveTier: this.training.tier, keyWeights: this.stats.keyErrors }); } catch (err) { console.error('[engine] 续题失败', err); }
      if (Array.isArray(next) && next.length) {
        this.questionOffset += this.questions.length;
        this.questions = next.slice();
        this.index = 0;
        // 统计已累计；释放上一批的位置标记，防止编号重用污染统计。
        this._erroredChars.clear();
        this._hintedChars.clear();
      } else {
        this.finish('source-empty');
        return;
      }
    }
    if (this.index >= this.questions.length) {
      this.emit('question', { index: this.index, done: true, reason });
      this.finish('completed');
      return;
    }

    /* Already queued questions may belong to the previous adaptive tier.
       换题时必须把被顶掉的那道题的字符标记还回「未用」集合：
       生成器是靠 pickUnused 打标记来保证一轮全覆盖的，直接丢弃会让那个字
       整场都不出现 —— 七档来回切几次，题库的覆盖承诺就漏成筛子。 */
    if (this.adaptive && this.currentQuestion()?.meta?.tier !== this.training.tier && this.questionSource) {
      const displaced = this.questions[this.index];
      const next = this.questionSource({ count: 1, adaptiveTier: this.training.tier, weakBoost: false });
      if (next?.length) {
        this.questions[this.index] = next[0];
        try { this.questionSource.releaseQuestion?.(displaced); } catch (err) { console.error('[engine] 归还被替换题目失败', err); }
      }
    }
    // 新题目的起始位置：若开头是标点/无拼音字符，直接跳过
    const q = this.currentQuestion();
    if (q && Array.isArray(q.chars) && this.skipPunct) {
      let start = 0;
      while (start < q.chars.length && this._isSkippable(q.chars[start])) {
        this._markCharDone(q.chars[start]);
        start++;
      }
      this.charIndex = start;
    }

    this.emit('question', { index: this.index, done: false, reason });
    // 换题后 arm（必须放在 index/charIndex 都更新完之后 —— 放在
    // _resetHintTimer() 旁边会拿旧目标算，量到的键是上一题最后一个键）。
    // 提前 return 的两条路径（续题源枯竭 / 题量走完）由 finish() 里的
    // _disarmKeyWait() 兜底，state 已不是 RUNNING，arm 本身也会自动让开。
    this._armKeyWait();
    this.emit('change', this.snapshot(), 'question');
  }

  /* ==========================================================
     跳题 / 跳过当前字
     ========================================================== */

  /** 跳过当前音节（记为错误） */
  skipCurrent() {
    const target = this.currentTarget();
    if (!target) return false;
    if (target.kind === 'syllable') {
      // 跳键与按错走同一条记账路径，跳过的字同样该进易错表
      this._recordWrongItem(target, this.currentChar());
    } else if (target.kind === 'part' || target.kind === 'key') {
      // 单键类题目：整题记一次错，然后推进到下一题
      const mark = `key:${this.index}`;
      this._erroredChars.add(mark);
      if (target.char) {
        this.stats.perCharErrors[target.char] = (this.stats.perCharErrors[target.char] || 0) + 1;
      }
      this.stats.combo = 0;
      this.emit('skip', target);
      this._advanceQuestion('skip');
      return true;
    }
    this.stats.combo = 0;
    this.emit('skip', target);
    this._advanceChar();
    return true;
  }

  /* ==========================================================
     给 UI 的辅助数据
     ========================================================== */

  /** 跳过的字符也要参与展示，但不需要打字 */
  charStates() {
    const q = this.currentQuestion();
    if (!q || !Array.isArray(q.chars)) return [];
    return q.chars.map((c, i) => ({
      ch: c.ch,
      punct: !!c.punct,
      unknown: !!c.unknown,
      done: i < this.charIndex,
      current: i === this.charIndex,
      // 这个字是等提示才打出来的（键位图闪 / 亮了答案 / 按了 Tab）。
      // UI 要靠它把「靠猜的」和「真会的」区分开 —— 否则屏幕上
      // 一路 is-done 到底，独立正确率扣掉的那部分字根本看不出来。
      hinted: this._hintedChars.has(`${this.index}:${i}`),
      pinyin: c.pinyin || ''
    }));
  }

  /** 当前音节每个键的输入状态（供渲染键位小块） */
  keyStates() {
    const target = this.currentTarget();
    if (!target || target.kind === 'key') return [];
    if (target.kind === 'part') {
      // 只考其中一个成分：只展示那一步
      const stepIdx = Number.isInteger(target.stepIndex) ? target.stepIndex : 0;
      const step = target.split && target.split.steps ? target.split.steps[stepIdx] : null;
      if (!step) return [];
      return [{
        key: step.key,
        role: step.role,
        part: step.part,
        label: step.label,
        state: 'next',
        typed: ''
      }];
    }
    const split = target.split;
    if (!split) return [];

    const typedArr = this.typed.split('');
    return split.steps.map((step, i) => {
      let state = 'pending';
      if (i < typedArr.length) state = 'hit';
      else if (i === target.pos) state = 'next';
      return {
        key: step.key,
        role: step.role,
        part: step.part,
        label: step.label,
        state,
        typed: typedArr[i] || ''
      };
    });
  }

  /** 供键位图高亮：当前应关注的键 */
  keymapHighlight() {
    const target = this.currentTarget();
    if (!target) return [];
    if (target.kind === 'key') {
      const keys = target.keys || [];
      return keys.map((k, i) => ({
        key: k,
        role: target.role || 'yun',
        state: i === this.keyIndex ? 'next' : (i < this.keyIndex ? 'hit' : undefined)
      }));
    }
    if (target.kind === 'part') {
      const key = (target.keys || [])[0];
      if (!key) return [];
      return [{ key, role: target.part === 'sheng' ? 'sheng' : 'yun', state: 'next' }];
    }
    if (!target.split) return [];

    const typedCount = this.typed.length;
    return target.split.steps.map((step, i) => {
      let state;
      if (i < typedCount) state = 'hit';
      else if (i === target.pos) state = 'next';
      return { key: step.key, role: step.role, state };
    });
  }

  /** 汇总结果 */
  summary() {
    const s = this.visibleStats();
    const q = this.currentQuestion();
    return {
      mode: this.mode,
      modeName: this.modeName || this.mode,
      state: this.state,
      durationSec: Math.round(this.elapsedSec),
      totalChars: this.stats.totalChars,
      correctChars: this.stats.correctChars,
      wrongChars: this.stats.wrongChars,
      hintedChars: this.stats.hintedChars,
      keystrokes: this.stats.keystrokes,
      wrongKeystrokes: this.stats.wrongKeystrokes,
      speed: s.speed,
      accuracy: s.accuracy,
      independentAccuracy: s.independentAccuracy,
      maxCombo: this.stats.maxCombo,
      skipped: this._skippedCount || 0,
      questionCount: this.unlimited ? 0 : this.questions.length,
      doneQuestions: this.questionOffset + Math.min(this.index, this.questions.length),
      perCharErrors: Object.assign({}, this.stats.perCharErrors),
      perWordErrors: Object.assign({}, this.stats.perWordErrors || {}),
      keyErrors: Object.assign({}, this.stats.keyErrors || {}),
      keyTimings: this.keyTimings(),
      completed: !this.unlimited && this.index >= this.questions.length,
      unlimited: this.unlimited,
      examMode: this.examMode,
      unfinishedQuestion: q ? { index: this.index, charIndex: this.charIndex } : null
    };
  }

  /** 当前提示档位：0 完整提示 / 1 只显示拼音 / 2 独立输入。测验模式恒为 2。 */
  assistanceLevel() { return this.examMode ? 2 : this.training.stage; }

  /** 自上次结算以来「仍在练习」的时间。节流/休眠按 MAX_IDLE_GAP_SEC 截断。 */
  _pendingSeconds() {
    if (this.state !== STATE.RUNNING || !this._lastTickAt) return 0;
    return Math.min(MAX_IDLE_GAP_SEC, Math.max(0, (Date.now() - this._lastTickAt) / 1000));
  }

  activeSeconds() {
    return this.elapsedSec + this._pendingSeconds();
  }

  /**
   * 把「上次结算之后的零头」并入 elapsedSec 并重置基准。
   * 暂停、交卷、页面切后台都走这里，保证用时和反应时间永远同源。
   */
  syncActiveTime() {
    this.elapsedSec = this.activeSeconds();
    this._lastTickAt = Date.now();
    return this.elapsedSec;
  }

  /**
   * 导出可续练的现场。
   *
   * 与 summarize() 的分工：那个是「这一轮结果」（结算页展示、落库），
   * 这个是「还没做完的进度」（`_resume` 槽位，下次进来接着打）。
   * 注意 elapsedSec 取 activeSeconds() 而非 this.elapsedSec —— 后者只是
   * 上一次结算时的值，还要补上尚未结算的零头，否则续练会丢掉最后那一段。
   */
  exportResume() {
    return {
      training: this.trainingEnabled ? this.training : null,
      unitStartedAt: this._unitStartedAt,
      generationState: this.questionSource?.exportState?.(),
      createdAt: Date.now(),
      questionOffset: this.questionOffset,
      unlimited: this.unlimited,
      generation: this.generation,
      mode: this.mode,
      modeName: this.modeName,
      questions: this.questions,
      index: this.index,
      charIndex: this.charIndex,
      keyIndex: this.keyIndex,
      typed: this.typed,
      erroredChars: Array.from(this._erroredChars),
      hintedMarks: Array.from(this._hintedChars),
      skipped: this._skippedCount || 0,
      elapsedSec: this.activeSeconds(),
      stats: {
        totalChars: this.stats.totalChars,
        correctChars: this.stats.correctChars,
        wrongChars: this.stats.wrongChars,
        hintedChars: this.stats.hintedChars,
        hintedCorrectChars: this.stats.hintedCorrectChars,
        keystrokes: this.stats.keystrokes,
        wrongKeystrokes: this.stats.wrongKeystrokes,
        combo: this.stats.combo,
        maxCombo: this.stats.maxCombo,
        perCharErrors: this.stats.perCharErrors,
        perWordErrors: this.stats.perWordErrors || {},
        keyErrors: this.stats.keyErrors || {},
        keyTimings: this.keyTimings()
      },
      settings: {
        durationSec: this.durationSec,
        strict: this.strict,
        skipPunct: this.skipPunct,
        examMode: this.examMode,
        hintEnabled: this.hintEnabled,
        hintDelayMs: this.hintDelayMs,
        revealDelayMs: this.revealDelayMs
      }
    };
  }

  /** 从续练现场恢复 */
  static restore(saved, questionSource = null) {
    if (!saved || !Array.isArray(saved.questions) || !saved.questions.length) return null;
    try {
      const eng = new PracticeEngine({
        questions: saved.questions,
        training: saved.training,
        unlimited: saved.unlimited === true,
        questionOffset: saved.questionOffset,
        generation: saved.generation,
        questionSource,
        mode: saved.mode,
        modeName: saved.modeName,
        durationSec: saved.settings ? saved.settings.durationSec : 0,
        strict: saved.settings ? saved.settings.strict !== false : true,
        skipPunct: saved.settings ? saved.settings.skipPunct !== false : true,
        // 测验中断后续练时，必须仍然是测验（否则提示会「复活」，分数失去意义）
        examMode: saved.settings ? saved.settings.examMode === true : false,
        hintEnabled: saved.settings ? saved.settings.hintEnabled !== false : true,
        hintDelayMs: saved.settings ? saved.settings.hintDelayMs : undefined,
        revealDelayMs: saved.settings ? saved.settings.revealDelayMs : undefined
      });
      eng.index = clampInt(saved.index, 0, saved.questions.length - 1);
      eng.charIndex = clampInt(saved.charIndex, 0, 9999);
      eng._erroredChars = new Set(Array.isArray(saved.erroredChars) ? saved.erroredChars : []);
      eng._hintedChars = new Set(Array.isArray(saved.hintedMarks) ? saved.hintedMarks : []);
      eng._skippedCount = Math.max(0, Number(saved.skipped) || 0);
      eng.elapsedSec = Math.max(0, Number(saved.elapsedSec) || 0);
      eng._unitStartedAt = Math.max(0, Math.min(eng.elapsedSec, Number(saved.unitStartedAt) || 0));
      if (saved.stats && typeof saved.stats === 'object') {
        const st = saved.stats;
        eng.stats.totalChars = Math.max(0, Number(st.totalChars) || 0);
        eng.stats.correctChars = Math.max(0, Number(st.correctChars) || 0);
        eng.stats.wrongChars = Math.max(0, Number(st.wrongChars) || 0);
        eng.stats.hintedChars = Math.max(0, Number(st.hintedChars) || 0);
        eng.stats.hintedCorrectChars = st.hintedCorrectChars == null
          ? Math.min(eng.stats.hintedChars, eng.stats.correctChars) : Math.max(0, Number(st.hintedCorrectChars) || 0);
        eng.stats.keystrokes = Math.max(0, Number(st.keystrokes) || 0);
        eng.stats.wrongKeystrokes = Math.max(0, Number(st.wrongKeystrokes) || 0);
        eng.stats.combo = Math.max(0, Number(st.combo) || 0);
        eng.stats.maxCombo = Math.max(0, Number(st.maxCombo) || 0);
        if (st.perCharErrors && typeof st.perCharErrors === 'object') {
          eng.stats.perCharErrors = Object.assign({}, st.perCharErrors);
        }
        if (st.perWordErrors && typeof st.perWordErrors === 'object') {
          eng.stats.perWordErrors = Object.assign({}, st.perWordErrors);
        }
        if (st.keyErrors && typeof st.keyErrors === 'object') {
          eng.stats.keyErrors = Object.assign({}, st.keyErrors);
        }
        // 按键耗时样本同样要跟着现场走，否则中断续练会丢掉前半程的数据，
        // 结算面板的「反应最慢的键」只反映续练之后那一段 —— 看起来像
        // 「一续练就变慢了」。逐样本清洗，不信任存档里的任何数字。
        if (st.keyTimings && typeof st.keyTimings === 'object' && !Array.isArray(st.keyTimings)) {
          const timings = {};
          for (const [k, rec] of Object.entries(st.keyTimings)) {
            const key = String(k || '').toUpperCase();
            if (!/^[A-Z]$/.test(key) || !rec || typeof rec !== 'object') continue;
            const lead = sanitizeSamples(rec.lead);
            const follow = sanitizeSamples(rec.follow);
            if (lead.length || follow.length) timings[key] = { lead, follow };
          }
          eng.stats.keyTimings = timings;
          // 续练的第一个样本同样含「刚回来、进入状态」的启动成本
          eng._keyWaitMeasured = Object.values(timings)
            .reduce((n, rec) => n + rec.lead.length + rec.follow.length, 0) || 1;
        }
      }
      // 修正 charIndex 越界
      const q = eng.questions[eng.index];
      if (q && Array.isArray(q.chars) && eng.charIndex >= q.chars.length) {
        eng.charIndex = 0;
        eng.index = Math.min(eng.index + 1, eng.questions.length - 1);
      }
      const target = eng.currentTarget();
      eng.keyIndex = clampInt(saved.keyIndex, 0, Math.max(0, (target && target.len || 1) - 1));
      eng.typed = typeof saved.typed === 'string' ? saved.typed.slice(0, eng.keyIndex) : '';
      return eng;
    } catch (err) {
      console.error('[engine] 恢复现场失败', err);
      return null;
    }
  }
}

/* ============================================================
   工具
   ============================================================ */

/** 归一化按键：只接受单个字母；其余返回空串 */
export function normalizeKey(raw) {
  if (raw == null) return '';
  const s = String(raw);
  if (s.length !== 1) return '';
  const ch = s.toLowerCase();
  return /^[a-z]$/.test(ch) ? ch : '';
}

/**
 * 清洗一组毫秒样本。
 *
 * 这份数据要经过 localStorage 往返，也要经过用户手动导入的 JSON，
 * 所以不能假定它是干净的：非数字、NaN、负数、超上限的混在里面都可能被算进
 * 中位数，把整张表带歪。宁可少一个样本也不要一个坏样本。
 *
 * @param {any} list
 * @returns {number[]} 升序、只含 (0, maxMs] 的整数毫秒
 */
export function sanitizeSamples(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0 || n > KEY_TIMING.maxMs) continue;
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * 归一化一个毫秒配置：
 *   - undefined / null → 用默认值
 *   - 0 或负数 → 0，表示「关闭这一级」
 *   - 其它非法值 → 默认值
 * 上限 60 秒，防止把提示时间设成天文数字（那样永远不触发，等同关闭）。
 */
function normalizeMs(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  return Math.min(60000, Math.round(n));
}

export { isPunct };
