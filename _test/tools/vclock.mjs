/**
 * 虚拟时钟与「把虚拟时钟接到 window 上」的小工具。
 * ------------------------------------------------------------
 * 与浏览器底座（tools/harness.mjs）分开，是为了让需要精确时间、
 * 但**不需要 DOM** 的测试（如 engine.mjs）也能用上它，
 * 而不必为了一个假时钟把 linkedom 整套拖进来。
 *
 * 零依赖：只用语言本身。
 */

/* ============================================================
   虚拟时钟
   ============================================================ */

/**
 * 一个只在前进一步时结算到期任务的时钟。
 *
 * 与 jest 的 fake timers 同类，但自己写、零依赖，且刻意做小：
 * 只需要支持本测试用到的 setTimeout / setInterval / clear* / now。
 *
 * 关键语义（这几条决定了它可不可信）：
 *   · 到期任务按 (时间, 插入序) 排序 —— 同一时刻的任务保持插入顺序，
 *     否则「先挂的监听器先跑」这类顺序依赖会随机翻车。
 *   · advance() 过程中新挂的定时器也会被考虑（只要它落在目标时间内），
 *     与真实事件循环一致。
 *   · setInterval 会重复到期，advance 到远处时必须循环触发而不是只触发一次。
 *   · 每个回调单独 try/catch：一个定时器抛错不该让整轮 advance 中断，
 *     但要记下来让测试能看见（真实浏览器里它同样不会中断其它定时器）。
 */
export function createVirtualClock(startMs = 1_000_000) {
  let now = startMs;
  let seq = 0;
  let nextId = 1;
  /** @type {Map<number, {at:number, seq:number, fn:Function, args:any[], interval:number|null, id:number}>} */
  const tasks = new Map();
  const errors = [];

  const schedule = (fn, ms, args, interval) => {
    const id = nextId++;
    const delay = Math.max(0, Number(ms) || 0);
    tasks.set(id, { at: now + delay, seq: seq++, fn, args, interval, id });
    return id;
  };

  const cancel = (id) => { tasks.delete(id); };

  /** 取出当前时刻最早到期的任务；同刻按插入序 */
  const takeNext = () => {
    let best = null;
    for (const t of tasks.values()) {
      if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    }
    return best;
  };

  const clock = {
    setTimeout: (fn, ms, ...args) => schedule(fn, ms, args, null),
    setInterval: (fn, ms, ...args) => schedule(fn, ms, args, Math.max(1, Number(ms) || 1)),
    clearTimeout: cancel,
    clearInterval: cancel,
    now: () => now,
    /** 高精度时钟。基于虚拟 now，避免和 Date.now 走出两套时间。 */
    performanceNow: () => now,

    /**
     * 让虚拟时间前进 delta 毫秒，把路上到期的任务全部执行。
     * 返回实际执行的定时器回调次数（便于断言「确实触发了」）。
     */
    advance(delta) {
      const target = now + Math.max(0, Number(delta) || 0);
      let ran = 0;
      // 加一个上限防止 setInterval(0) 之类的自激把测试挂死
      let guard = 0;
      const GUARD_MAX = 100000;
      for (;;) {
        const t = takeNext();
        if (!t || t.at > target) break;
        if (++guard > GUARD_MAX) {
          errors.push(new Error(`虚拟时钟 advance 超过 ${GUARD_MAX} 次回调，疑似定时器自激`));
          break;
        }
        now = t.at;
        if (t.interval == null) tasks.delete(t.id);
        else t.at = now + t.interval;    // 周期任务排到下一个周期
        ran++;
        try {
          t.fn(...t.args);
        } catch (err) {
          errors.push(err);
        }
      }
      now = target;
      return ran;
    },

    /** 当前挂着的定时器数量（含周期任务）。用于断言「没有泄漏的定时器」。 */
    pendingCount: () => tasks.size,
    /** 待执行的定时器快照，便于断言「暂停时 ticker 被清掉了」 */
    pending: () => Array.from(tasks.values())
      .map(t => ({ at: t.at, interval: t.interval, id: t.id }))
      .sort((a, b) => a.at - b.at),
    /** 取走并清空回调里捕获到的异常（供测试断言「没有定时器抛错」） */
    drainErrors: () => errors.splice(0, errors.length),
    reset() { tasks.clear(); now = startMs; seq = 0; errors.length = 0; }
  };

  return clock;
}

/**
 * 把给定虚拟时钟接到某个 window 的定时器与全局 Date.now 上，
 * 返回还原函数。
 *
 * 为什么不直接换掉整个 window：进程里通常已经有一个真实时钟的 harness
 * 在跑完整应用（document、事件表都在它身上）。某个用例只需要让**一个裸引擎**
 * 走虚拟时间时，只换定时器与 Date.now 就够了 —— 引擎的 timers 适配层通过
 * window.setInterval 取定时器、通过 Date.now 量 idle，换掉这两处即可精确
 * 控制提示/揭晓的到期时刻，而 document 等一概不动。
 *
 * @param {object} clock createVirtualClock() 的产物
 * @param {object} [win] 默认当前全局 window
 * @returns {() => void} 还原函数
 */
export function virtualizeWindowTimers(clock, win = globalThis.window) {
  const target = win || globalThis;
  const saved = {
    setInterval: target.setInterval,
    clearInterval: target.clearInterval,
    setTimeout: target.setTimeout,
    clearTimeout: target.clearTimeout,
    dateNow: globalThis.Date.now
  };
  target.setInterval = (fn, ms, ...a) => clock.setInterval(fn, ms, ...a);
  target.clearInterval = (id) => clock.clearInterval(id);
  target.setTimeout = (fn, ms, ...a) => clock.setTimeout(fn, ms, ...a);
  target.clearTimeout = (id) => clock.clearTimeout(id);
  globalThis.Date.now = () => clock.now();
  return () => {
    target.setInterval = saved.setInterval;
    target.clearInterval = saved.clearInterval;
    target.setTimeout = saved.setTimeout;
    target.clearTimeout = saved.clearTimeout;
    globalThis.Date.now = saved.dateNow;
  };
}

/**
 * 造一个「只有定时器」的假 window 装到 globalThis 上，并接管 Date.now。
 * 给不需要 DOM 的测试用（引擎的 timers 适配层会走 globalThis.window）。
 *
 * @param {object} clock createVirtualClock() 的产物
 * @returns {() => void} 还原函数
 */
export function installVirtualWindow(clock) {
  const stub = {
    setInterval: (fn, ms, ...a) => clock.setInterval(fn, ms, ...a),
    clearInterval: (id) => clock.clearInterval(id),
    setTimeout: (fn, ms, ...a) => clock.setTimeout(fn, ms, ...a),
    clearTimeout: (id) => clock.clearTimeout(id)
  };
  const hasPrev = 'window' in globalThis;
  const prevWin = globalThis.window;
  const prevNow = globalThis.Date.now;
  globalThis.window = stub;
  globalThis.Date.now = () => clock.now();
  return () => {
    if (hasPrev) globalThis.window = prevWin; else delete globalThis.window;
    globalThis.Date.now = prevNow;
  };
}
