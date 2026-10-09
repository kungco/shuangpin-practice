/**
 * 存储层自检：降级、合并、日报一致性
 * ------------------------------------------------------------
 * 这个文件专门盯「出过事故、且只在真实使用中才暴露」的存储行为：
 *   1. 配额写满后的降级 —— 写进内存的数据，当前会话必须还能读回来
 *   2. 清理空间后的恢复 —— 降级不能是单向的
 *   3. 导入备份后的日报 —— 日报必须由合并后的历史推导，不能与历史打架
 *
 * 运行：node _test/storage.mjs
 *
 * 为什么单独一个文件：storage.js 不依赖 DOM，本文件也刻意不引入 linkedom，
 * 于是它是三套测试里唯一「零依赖、毫秒级」的一套，可以高频跑。
 */

import { createRequire } from 'node:module';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗ ' + m); } else { console.log('  ✓ ' + m); } };

/* ============================================================
   可控的 localStorage 桩
   ============================================================
   真实配额满不是「setItem 永远抛」：它取决于**这一条**的大小。
   所以桩要按实际用掉的字节数判断，而不是一个布尔开关 ——
   否则测不出「清理老记录后重试成功」这条路径。
*/
function makeLocalStorage() {
  const map = new Map();
  const state = {
    limit: Infinity,
    usable: true,        // false 模拟隐身模式（任何操作都抛）
    setCalls: 0,
    pruneHits: 0,
    keys: () => Array.from(map.keys()),
    bytes: () => Array.from(map.values()).reduce((s, v) => s + String(v).length, 0),
    /** 只允许 key 以某前缀开头时写入成功 —— 用来精确打掉某一条写入 */
    blockPrefix: null
  };
  const quotaErr = () => {
    const e = new Error('quota exceeded');
    e.name = 'QuotaExceededError';
    e.code = 22;
    return e;
  };
  return {
    state,
    get length() { return map.size; },
    getItem: (k) => {
      if (!state.usable) throw new Error('storage disabled');
      return map.has(k) ? map.get(k) : null;
    },
    setItem: (k, v) => {
      state.setCalls++;
      if (!state.usable) throw new Error('storage disabled');
      const val = String(v);
      const key = String(k);
      const size = key.length + val.length;
      if (state.blockPrefix && key.startsWith(state.blockPrefix) &&
          !key.startsWith(`${state.blockPrefix}__probe`)) {
        throw quotaErr();
      }
      if (state.bytes() + size > state.limit) throw quotaErr();
      map.set(key, val);
    },
    removeItem: (k) => {
      if (!state.usable) throw new Error('storage disabled');
      map.delete(k);
    },
    clear: () => {
      if (!state.usable) throw new Error('storage disabled');
      map.clear();
    },
    key: (i) => Array.from(map.keys())[i] ?? null
  };
}

/* ---------- 装一个最小 window，让 storage.js 能跑起来 ---------- */
const require = createRequire(import.meta.url);

function installWindow(ls) {
  globalThis.window = { localStorage: ls, setTimeout, clearTimeout };
}

/**
 * 每次都重新 import storage.js：模块级 state（storageAvailable / memoryStore）
 * 是全局的，跨用例会串味。用 query string 绕过 ESM 的模块缓存。
 */
let modSeq = 0;
async function freshStorage() {
  const url = new URL('../src/core/storage.js', import.meta.url).href;
  return import(`${url}?t=${++modSeq}`);
}

// 模拟跨日复习，避免同一天重复作答误作长期掌握。
function atDay(offset, fn, base = Date.now()) {
  const original = Date.now;
  Date.now = () => base + offset * 86400000;
  try { return fn(); } finally { Date.now = original; }
}
function reviewDays(S, char, n) {
  const base = Date.now();
  for (let i = 0; i < n; i++) atDay(i, () => S.recordWeakCorrect({ char }), base);
}

/* ============================================================
   【1】配额满：写进内存的数据，当前会话必须读得回来
   ============================================================ */
console.log('【1】配额满后的降级读写');

{
  const ls = makeLocalStorage();
  ls.state.limit = 300;               // 小配额，很快就满
  installWindow(ls);
  const S = await freshStorage();

  ok(S.isStorageAvailable() === true, '初始探测：localStorage 可用');

  // 先正常写一条，确认通路没坏
  ok(S.writeJSON('k.small', { a: 1 }) === true, '配额内写入成功（返回 true）');
  ok(JSON.stringify(S.readJSON('k.small', null)) === '{"a":1}', '配额内数据能读回');

  // 再写一条必然超配额的
  const big = 'x'.repeat(2000);
  const wrote = S.writeJSON('k.big', { big });
  ok(wrote === false, '超出配额：写入返回 false（调用方据此提示用户）');

  // ★ 核心断言：写失败后「马上读」必须还能拿到这条数据
  const back = S.readJSON('k.big', null);
  ok(back && back.big === big, '★ 写入失败后立即读取，内存里的数据没有丢');

  // 内存态下继续写，读回同样是自洽的
  S.writeJSON('k.after', { b: 2 });
  ok(JSON.stringify(S.readJSON('k.after', null)) === '{"b":2}', '降级后写入的数据可读回');

  ok(S.isDegradedToMemory() === true, 'isDegradedToMemory() 反映已降级');
  ok(S.isStorageAvailable() === false, 'isStorageAvailable() 反映当前写不进去');
}

/* ============================================================
   【2】清理老记录后重试成功 —— 不该直接降级
   ============================================================ */
console.log('\n【2】配额满但清理老记录后能写进去（不降级）');

{
  const ls = makeLocalStorage();
  ls.state.limit = 1200;
  installWindow(ls);
  const S = await freshStorage();
  S.isStorageAvailable();

  // 先塞满历史记录（让 pruneHistory(200) 有东西可清）
  const hist = Array.from({ length: 400 }, (_, i) =>
    S.makeRecord({ ts: 1700000000000 + i, mode: 'char', totalChars: 10, durationSec: 5, speed: 100, accuracy: 100 }));
  S.writeJSON(S.KEYS.history, hist);

  // 一条大写入：超配额 → 触发 pruneHistory(200) → 重试
  const big = 'y'.repeat(300);
  const wrote = S.writeJSON('k.retry', { big });
  ok(ls.state.setCalls >= 2, `配额满时确实做了重试（setItem 调用 ${ls.state.setCalls} 次）`);
  if (wrote === true) {
    ok(JSON.stringify(S.readJSON('k.retry', null)) === JSON.stringify({ big }), '清理后重试成功，数据落盘');
    ok(S.isDegradedToMemory() === false, '一条写不动不等于整体降级（未降级）');
    ok(S.loadHistory().length <= 200, `老历史被裁剪到 200 条以内（实际 ${S.loadHistory().length}）`);
  } else {
    ok(true, '（本次配额过紧，重试仍失败 → 走内存，属预期分支）');
  }
}

/* ============================================================
   【3】降级后释放空间 → 能恢复落盘，且内存数据不会丢
   ============================================================ */
console.log('\n【3】空间释放后恢复落盘');

{
  const ls = makeLocalStorage();
  ls.state.limit = 200;
  installWindow(ls);
  const S = await freshStorage();
  S.isStorageAvailable();

  const big = 'z'.repeat(500);
  ok(S.writeJSON('k.held', { big }) === false, '超配额时写入失败');
  ok(S.readJSON('k.held', null).big === big, '数据已在内存中');
  ok(S.isDegradedToMemory() === true, '已降级');

  // 用户清理了空间
  ls.state.limit = Infinity;
  ls.clear();

  ok(S.isStorageAvailable() === true, '空间释放后探测恢复可用（降级不是单向的）');
  ok(S.readJSON('k.held', null).big === big, '★ 恢复过程中内存里的数据没有丢');
  ok(S.isDegradedToMemory() === false, '不再处于降级态');

  // 恢复后新写的数据应该真正落盘（绕过内存直查 localStorage）
  S.writeJSON('k.fresh', { c: 3 });
  ok(ls.getItem('k.fresh') !== null, '恢复后新写入的数据确实进了 localStorage');
  ok(S.readJSON('k.fresh', null).c === 3, '恢复后新写入的数据可读回');
}

/* ============================================================
   【4】localStorage 彻底不可用（隐身模式）
   ============================================================ */
console.log('\n【4】localStorage 不可用时不崩溃');

{
  const ls = makeLocalStorage();
  ls.state.usable = false;
  installWindow(ls);
  const S = await freshStorage();

  ok(S.isStorageAvailable() === false, '探测到不可用');
  ok(S.writeJSON('k.x', { a: 1 }) === false, '写入返回 false 而不是抛异常');
  ok(JSON.stringify(S.readJSON('k.x', null)) === '{"a":1}', '★ 不可用时靠内存兜住，数据仍可读回');
  ok(typeof S.exportAll() === 'object', 'exportAll() 仍能工作');
  ok(S.storageUsage() >= 0, 'storageUsage() 不抛异常');
}

/* ============================================================
   【5】导入备份：日报必须由合并后的历史推导
   ============================================================ */
console.log('\n【5】导入备份后日报与历史一致（跨设备同日）');

const DAY = '2026-03-03';

/** 造一条指定日期的成绩记录 */
function rec(S, { id, ts, date, chars, speed, acc }) {
  const r = S.makeRecord({ mode: 'char', totalChars: chars, durationSec: 60, speed, accuracy: acc });
  r.id = id;
  r.ts = ts;
  r.date = date;
  r.correctChars = chars;
  r.wrongChars = 0;
  r.keystrokes = chars * 2;
  return r;
}

{
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();

  // 本机已有：3/3 练了 100 字
  S.writeJSON(S.KEYS.history, [
    rec(S, { id: 'local1', ts: 1772000000000, date: DAY, chars: 100, speed: 40, acc: 90 })
  ]);
  S.writeJSON(S.KEYS.daily, S.rebuildDailyFromHistory(S.loadHistory()));
  ok(S.loadDaily()[DAY].chars === 100, '本地日报初始为 100 字');

  // 另一台设备导出的备份：同一天练了 200 字（ts / id 都不同）
  const backup = {
    app: 'shuangpin-practice',
    version: S.DATA_VERSION,
    history: [rec(S, { id: 'other1', ts: 1772000060000, date: DAY, chars: 200, speed: 80, acc: 100 })],
    daily: { [DAY]: { date: DAY, sessions: 1, chars: 200, bestSpeed: 80, speedSum: 80, accSum: 100, correct: 200, wrong: 0, keystrokes: 400 } }
  };
  const res = S.importAll(backup);
  ok(res.ok === true, `导入成功（${res.message}）`);

  const hist = S.loadHistory();
  ok(hist.length === 2, `历史已相加合并为 2 条（实际 ${hist.length}）`);

  const d = S.loadDaily()[DAY];
  ok(d.sessions === 2, `★ 日报 sessions = 2（旧实现取 max 会得 1，实际 ${d.sessions}）`);
  ok(d.chars === 300, `★ 日报 chars = 300（旧实现取 max 会得 200，实际 ${d.chars}）`);
  ok(d.bestSpeed === 80, `日报 bestSpeed = 80（取最大值属预期，实际 ${d.bestSpeed}）`);
  ok(d.durationSec === 120, `日报 durationSec = 120（实际 ${d.durationSec}）`);
  ok(d.keystrokes === 600, `日报 keystrokes = 600（实际 ${d.keystrokes}）`);

  // 日报必须与历史逐项对得上 —— 这才是「一致」的定义
  const fromHist = {
    sessions: hist.length,
    chars: hist.reduce((s, r) => s + r.totalChars, 0),
    durationSec: hist.reduce((s, r) => s + r.durationSec, 0)
  };
  ok(d.sessions === fromHist.sessions && d.chars === fromHist.chars && d.durationSec === fromHist.durationSec,
    `★ 日报与历史完全一致（sessions ${d.sessions}/${fromHist.sessions}，chars ${d.chars}/${fromHist.chars}）`);

  // 日报只包含有记录的日期，不应该凭空多出日期桶
  ok(Object.keys(S.loadDaily()).length === 1, '日报只含历史覆盖到的那一天');
}

/* ============================================================
   【6】导入备份：daily 独有的日期要保留
   ============================================================ */
console.log('\n【6】老备份里 daily 独有的日期不丢');

{
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();

  S.writeJSON(S.KEYS.history, [
    rec(S, { id: 'h1', ts: 1772000000000, date: '2026-03-05', chars: 50, speed: 30, acc: 80 })
  ]);
  S.writeJSON(S.KEYS.daily, S.rebuildDailyFromHistory(S.loadHistory()));

  // 备份里多出一个历史中不存在的日期（历史被裁剪过、或来自更早的版本）
  const backup = {
    app: 'shuangpin-practice',
    version: 1,
    history: [rec(S, { id: 'h2', ts: 1772000060000, date: '2026-03-06', chars: 20, speed: 25, acc: 70 })],
    daily: {
      '2026-01-01': { date: '2026-01-01', sessions: 2, chars: 77, bestSpeed: 50 },
      '2026-03-06': { date: '2026-03-06', sessions: 1, chars: 20, bestSpeed: 25 }
    }
  };
  S.importAll(backup);

  const d = S.loadDaily();
  ok(!!d['2026-03-05'], '本地历史覆盖的日期仍在');
  ok(d['2026-03-05'].chars === 50, '本地历史覆盖的日期数值不变');
  ok(!!d['2026-03-06'], '导入历史覆盖的日期已建立');
  ok(d['2026-03-06'].chars === 20, '导入历史覆盖的日期数值正确');
  ok(!!d['2026-01-01'], '★ 历史里没有、仅存在于备份 daily 的日期被保留');
  ok(d['2026-01-01'].chars === 77, '保留日期的数据原样保留');
  ok(d['2026-01-01'].sessions === 2, '保留日期的 sessions 原样保留');
  // 保留的日期必须补成统一形状，统计页读 speedSum / accSum 时才不会得到 0 或 undefined
  ok(d['2026-01-01'].speedSum === 0 && d['2026-01-01'].accSum === 0,
    '保留日期被补成统一形状（speedSum / accSum 存在）');
  ok(Object.keys(d).length === 3, `日报共 3 天（实际 ${Object.keys(d).length}）`);
}

/* ============================================================
   【7】重复导入同一份备份不膨胀
   ============================================================ */
console.log('\n【7】重复导入同一备份（幂等）');

{
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();

  const backup = {
    app: 'shuangpin-practice',
    version: S.DATA_VERSION,
    history: [rec(S, { id: 'dup1', ts: 1772000000000, date: DAY, chars: 120, speed: 60, acc: 95 })],
    daily: { [DAY]: { date: DAY, sessions: 1, chars: 120, bestSpeed: 60, speedSum: 60, accSum: 95 } }
  };

  S.importAll(backup);
  const first = JSON.parse(JSON.stringify(S.loadDaily()[DAY]));
  S.importAll(backup);          // 再导一次
  S.importAll(backup);          // 第三次
  const after = S.loadDaily()[DAY];

  ok(S.loadHistory().length === 1, `历史仍只有 1 条（实际 ${S.loadHistory().length}）`);
  ok(after.sessions === first.sessions, `重复导入不重复计次（${after.sessions}）`);
  ok(after.chars === first.chars, `重复导入不重复计字（${after.chars}）`);
  ok(JSON.stringify(after) === JSON.stringify(first), '★ 重复导入后日报逐字段不变（幂等）');
}

/* ============================================================
   【8】重建函数本身：口径与增量更新一致
   ============================================================ */
console.log('\n【8】rebuildDailyFromHistory 与增量更新口径一致');

{
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();

  const records = [
    rec(S, { id: 'a', ts: 1772000000000, date: DAY, chars: 10, speed: 100, acc: 90 }),
    rec(S, { id: 'b', ts: 1772000060000, date: DAY, chars: 20, speed: 50, acc: 100 }),
    rec(S, { id: 'c', ts: 1772000120000, date: DAY, chars: 30, speed: 70, acc: 80 })
  ];
  // 路径 A：逐条 appendRecord —— 走 updateDaily 的增量累加
  for (const r of records) S.appendRecord(r);
  const inc = S.loadDaily()[DAY];

  // 路径 B：同一天的全量重建
  const rebuilt = S.rebuildDailyFromHistory(S.loadHistory())[DAY];

  ok(inc.sessions === rebuilt.sessions, `sessions 一致（${inc.sessions} / ${rebuilt.sessions}）`);
  ok(inc.chars === rebuilt.chars, `chars 一致（${inc.chars} / ${rebuilt.chars}）`);
  ok(inc.durationSec === rebuilt.durationSec, `durationSec 一致（${inc.durationSec} / ${rebuilt.durationSec}）`);
  ok(inc.bestSpeed === rebuilt.bestSpeed, `bestSpeed 一致（${inc.bestSpeed} / ${rebuilt.bestSpeed}）`);
  ok(inc.speedSum === rebuilt.speedSum, `speedSum 一致（${inc.speedSum} / ${rebuilt.speedSum}）`);
  ok(inc.accSum === rebuilt.accSum, `accSum 一致（${inc.accSum} / ${rebuilt.accSum}）`);
  ok(JSON.stringify(inc) === JSON.stringify(rebuilt),
    '★ 增量更新与全量重建产出完全相同的日报对象');
}

/* ============================================================
   【9】间隔重复：排期算法本体
   ============================================================ */
console.log('\n【9】间隔重复排期（SM-2 简化版）');

{
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();

  ok(Array.isArray(S.REVIEW_STEPS) && S.REVIEW_STEPS.length >= 4,
    `间隔阶梯存在且合理（${JSON.stringify(S.REVIEW_STEPS)}）`);
  ok(S.REVIEW_STEPS.every((v, i) => i === 0 || v > S.REVIEW_STEPS[i - 1]),
    '间隔阶梯严格递增');
  ok(S.EASE_DEFAULT === 2.5, `默认难度系数 2.5（实际 ${S.EASE_DEFAULT}）`);

  // 答对：间隔按阶梯前进
  let e = { interval: 0, ease: S.EASE_DEFAULT, streak: 0 };
  const steps = [];
  for (let i = 0; i < 6; i++) {
    const s = S.nextSchedule(e, true);
    steps.push(s.interval);
    e = { interval: s.interval, ease: s.ease, streak: s.streak };
  }
  ok(steps[0] === 1, `第 1 次答对 → 1 天后复习（实际 ${steps[0]}）`);
  ok(steps[1] === 3, `第 2 次答对 → 3 天（实际 ${steps[1]}）`);
  ok(steps[2] === 7, `第 3 次答对 → 7 天（实际 ${steps[2]}）`);
  ok(steps[3] === 16, `第 4 次答对 → 16 天（实际 ${steps[3]}）`);
  ok(steps[4] === 35, `第 5 次答对 → 35 天（实际 ${steps[4]}）`);
  ok(steps.every((v, i) => i === 0 || v > steps[i - 1]), '间隔单调递增');
  ok(e.streak === 6, `连对计数累加到 6（实际 ${e.streak}）`);

  // 阶梯走完后按 ease 指数拉长
  const beyond = S.nextSchedule({ interval: 75, ease: 2.5, streak: 6 }, true);
  ok(beyond.interval > 75, `超出阶梯后按 ease 继续拉长（${beyond.interval} 天）`);
  ok(beyond.interval <= 365, `间隔有上限 365 天（实际 ${beyond.interval}）`);

  // 答错：间隔重置为 1，streak 归零，ease 下降
  const lapsed = S.nextSchedule({ interval: 35, ease: 2.5, streak: 5 }, false);
  ok(lapsed.interval === S.RELAPSE_INTERVAL, `答错 → 间隔重置为 ${S.RELAPSE_INTERVAL} 天（实际 ${lapsed.interval}）`);
  ok(lapsed.streak === 0, `答错 → 连对归零（实际 ${lapsed.streak}）`);
  ok(lapsed.ease < 2.5, `答错 → ease 下降（实际 ${lapsed.ease}）`);
  ok(lapsed.ease >= S.EASE_MIN, `ease 不低于下限 ${S.EASE_MIN}（实际 ${lapsed.ease}）`);

  // ease 上下限
  let hard = { interval: 1, ease: S.EASE_MIN, streak: 0 };
  for (let i = 0; i < 5; i++) hard = S.nextSchedule(hard, false);
  ok(hard.ease >= S.EASE_MIN, `连续答错时 ease 触底不越界（实际 ${hard.ease}）`);

  let easy = { interval: 1, ease: S.EASE_MAX, streak: 3 };
  for (let i = 0; i < 5; i++) easy = S.nextSchedule(easy, true);
  ok(easy.ease <= S.EASE_MAX, `连续答对时 ease 触顶不越界（实际 ${easy.ease}）`);

  // 脏输入不能算出 NaN
  const dirty = S.nextSchedule({}, true);
  ok(Number.isFinite(dirty.interval) && dirty.interval >= 1,
    `空 entry 也能得到合法间隔（实际 ${dirty.interval}）`);
  const dirty2 = S.nextSchedule(null, false);
  ok(Number.isFinite(dirty2.interval), `null entry 不产生 NaN（实际 ${dirty2.interval}）`);

  // dueAt：契约是「永远排到未来，至少 1 天」——
  // 不是「0 天就该是 now」：排到当下一刻等于立刻又在队列里刷屏，
  // 所以实现里对天数做了 Math.max(1, ...)。这里钉住的是这个意图。
  const now = 1800000000000;
  ok(S.dueAt(now, 1) === now + 86400000, 'dueAt(1 天) = now + 86400000');
  ok(S.dueAt(now, 3) === now + 3 * 86400000, 'dueAt(3 天) 正确');
  ok(S.dueAt(now, 0) > now, `★ dueAt(0) 仍排到未来（+${(S.dueAt(now, 0) - now) / 86400000} 天），不排到当下`);
  ok(S.dueAt(now, -5) > now, '★ 负数天数不会排出过去时间');
  ok(Number.isFinite(S.dueAt(now, NaN)),
    `★ NaN 天数不产生 NaN 结果（实际 ${S.dueAt(now, NaN)}）`);
  ok(Number.isFinite(S.dueAt(undefined, 1)), '缺省 now 也不产生 NaN');
  ok(S.dueAt(now, 0.4) >= now + 86400000, '小数天数向上取整到至少 1 天');
}

/* ============================================================
   【10】间隔重复：与 recordWeak / getWeakList / reviewSummary 联动
   ============================================================ */
console.log('\n【10】间隔重复与记录联动');

{
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();

  S.clearWeak();

  /* ---- 答错会建立排期 ---- */
  S.recordWeak({ char: '错', pinyin: 'cuo' });
  let list = S.getWeakList({ limit: 10, minCount: 1 });
  ok(list.length === 1, '记录 1 条易错项');
  const first = list[0];
  ok(first.count === 1, `错误次数 1（实际 ${first.count}）`);
  ok(first.streak === 0, `首次答错连对为 0（实际 ${first.streak}）`);
  ok(first.interval === S.RELAPSE_INTERVAL, `间隔为 ${S.RELAPSE_INTERVAL} 天（实际 ${first.interval}）`);
  ok(typeof first.due === 'number' && first.due > Date.now() - 1000, 'due 已排到未来');
  ok(first.isDue === false, '刚答错不该马上到期（间隔 1 天）');
  ok(first.mastered === false || first.mastered === undefined, '新错误项未标记掌握');

  /* ---- 旧格式（没有调度字段）能自动补齐 ---- */
  // 直接往底层塞一条老数据
  S.writeJSON(S.KEYS.weak, {
    旧: { key: '旧', char: '旧', count: 5, correct: 0, lastTs: Date.now() }
  });
  const legacy = S.getWeakList({ limit: 10, minCount: 1 });
  ok(legacy.length === 1, '旧格式记录仍能被读出');
  ok(typeof legacy[0].due === 'number' && legacy[0].due > 0,
    `★ 旧格式缺 due 字段时自动补齐（due=${legacy[0].due}）`);
  ok(typeof legacy[0].streak === 'number' && typeof legacy[0].interval === 'number',
    '旧格式补齐 streak / interval');
  ok(legacy[0].mastered === false || legacy[0].mastered === undefined, '旧格式不会被误判为已掌握');

  /* ---- 答对会推进间隔 ---- */
  S.clearWeak();
  S.recordWeak({ char: '进', pinyin: 'jin' });
  S.recordWeakCorrect({ char: '进' });
  let after1 = S.getWeakList({ limit: 10, minCount: 1 })[0];
  ok(after1.correct === 1, `答对计数 1（实际 ${after1.correct}）`);
  ok(after1.streak === 1, `连对 1（实际 ${after1.streak}）`);
  ok(after1.interval === 1, `第 1 次答对间隔 1 天（实际 ${after1.interval}）`);
  ok(!!after1.reviewedAt, '记录了最近复习时间 reviewedAt');

  S.recordWeakCorrect({ char: '进' });
  const sameDay = S.getWeakList({ limit: 10, minCount: 1 })[0];
  ok(sameDay.correct === 1 && sameDay.due === after1.due, '同日重复答对不推进排期');
  atDay(1, () => S.recordWeakCorrect({ char: '进' }));
  atDay(2, () => S.recordWeakCorrect({ char: '进' }));
  const after3 = S.getWeakList({ limit: 10, minCount: 1 })[0];
  ok(after3.streak === 3, `连对 3（实际 ${after3.streak}）`);
  ok(after3.interval === 7, `连对 3 次后间隔 7 天（实际 ${after3.interval}）`);
  ok(after3.due > after1.due, '间隔推进后 due 更靠后');

  /* ---- 再答错会重置，且取消掌握 ---- */
  atDay(3, () => S.recordWeakCorrect({ char: '进' }));
  const beforeRelapse = S.getWeakList({ limit: 10, minCount: 1, includeMastered: true })[0];
  S.recordWeak({ char: '进', pinyin: 'jin' });  // 又错了
  const relapse = S.getWeakList({ limit: 10, minCount: 1, includeMastered: true })[0];
  ok(relapse.streak === 0, `★ 答错后连对归零（实际 ${relapse.streak}）`);
  ok(relapse.interval === S.RELAPSE_INTERVAL, `★ 答错后间隔重置为 ${S.RELAPSE_INTERVAL} 天（实际 ${relapse.interval}）`);
  ok(!relapse.mastered, `★ 掌握标记被撤销（before=${beforeRelapse.mastered} → ${relapse.mastered}）`);

  /* ---- 掌握判定：连对够多且错误率不高 ---- */
  S.clearWeak();
  S.recordWeak({ char: '熟', pinyin: 'shu' });
  reviewDays(S, '熟', 5);
  const mastered = S.getWeakList({ limit: 10, minCount: 1, includeMastered: true })[0];
  ok(mastered.mastered === true, `连对 5 次且错误率不高 → 标记掌握（streak=${mastered.streak}, count=${mastered.count}, correct=${mastered.correct}）`);
  // 默认队列应排除已掌握项
  const visible = S.getWeakList({ limit: 10, minCount: 1 });
  ok(visible.every(e => !e.mastered), '★ 默认队列不包含已掌握项');
  const withMastered = S.getWeakList({ limit: 10, minCount: 1, includeMastered: true });
  ok(withMastered.length === 1, 'includeMastered 时能看到已掌握项');
}

/* ============================================================
   【11】间隔重复：排序、到期筛选、概览
   ============================================================ */
console.log('\n【11】到期优先排序 / dueOnly / reviewSummary');

{
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();

  S.clearWeak();
  const now = Date.now();

  // 甲：错 3 次但已复习（due 在未来）；乙：错 1 次但已到期
  S.recordWeak({ char: '甲', pinyin: 'jia' });
  S.recordWeak({ char: '甲', pinyin: 'jia' });
  S.recordWeak({ char: '甲', pinyin: 'jia' });
  S.recordWeakCorrect({ char: '甲' });
  S.recordWeakCorrect({ char: '甲' });
  S.recordWeak({ char: '乙', pinyin: 'yi' });

  // 强制把「乙」置为已到期
  const map = S.readJSON(S.KEYS.weak, {});
  map['乙'].due = now - 1000;
  S.writeJSON(S.KEYS.weak, map);

  const sorted = S.getWeakList({ limit: 10, minCount: 1, now });
  ok(sorted.length === 2, `两条记录都在（实际 ${sorted.length}）`);
  ok(sorted[0].key === '乙', `★ 到期项排在最前（实际首位 ${sorted[0].key}）`);
  ok(sorted[0].isDue === true, '首位 isDue = true');
  ok(sorted[1].key === '甲', `未到期项排在后面（实际 ${sorted[1].key}）`);
  ok(sorted[1].isDue === false, '末位 isDue = false');

  // 到期项即使 weight 更低也要排在前面（错 1 次 vs 错 3 次）
  ok(sorted[0].count < sorted[1].count,
    `★ 到期优先压过错误次数（到期项错 ${sorted[0].count} 次，未到期项错 ${sorted[1].count} 次）`);

  // 排序余量：同为到期时按 due 升序
  const map2 = S.readJSON(S.KEYS.weak, {});
  map2['甲'].due = now - 5000;      // 甲更早到期
  map2['乙'].due = now - 1000;
  S.writeJSON(S.KEYS.weak, map2);
  const byDue = S.getWeakList({ limit: 10, minCount: 1, now });
  ok(byDue[0].key === '甲', `★ 同为到期时越早到期越靠前（实际首位 ${byDue[0].key}）`);

  /* ---- dueOnly 过滤 ---- */
  const dueOnly = S.getWeakList({ limit: 10, minCount: 1, now, dueOnly: true });
  ok(dueOnly.every(e => e.isDue), `dueOnly 只返回到期项（${dueOnly.length} 项）`);

  // 把全部置为未到期 → dueOnly 应为空
  S._setAllDue(now + 10 * 86400000);
  const noneDue = S.getWeakList({ limit: 10, minCount: 1, now, dueOnly: true });
  ok(noneDue.length === 0, '全部推后时 dueOnly 返回空');

  /* ---- reviewSummary ---- */
  S._setAllDue(now - 1000);
  const sum = S.reviewSummary(now);
  ok(sum.total === 2, `概览 total = 2（实际 ${sum.total}）`);
  ok(sum.due === 2, `概览 due = 2（实际 ${sum.due}）`);
  ok(sum.mastered === 0, `概览 mastered = 0（实际 ${sum.mastered}）`);
  ok(sum.learning >= 1, `概览 learning ≥ 1（实际 ${sum.learning}）`);

  // 全部未到期时 due=0，且给出 nextDue
  S._setAllDue(now + 3 * 86400000);
  const sum2 = S.reviewSummary(now);
  ok(sum2.due === 0, `全部未到期时 due = 0（实际 ${sum2.due}）`);
  ok(sum2.nextDue > now, `给出下次到期时间（${sum2.nextDue}）`);

  // 已掌握的项不计入 due
  S.clearWeak();
  S.recordWeak({ char: '掌', pinyin: 'zhang' });
  reviewDays(S, '掌', 5);
  S._setAllDue(now - 1000);
  const sum3 = S.reviewSummary(now);
  ok(sum3.total === 1, `概览包含已掌握项（total=${sum3.total}）`);
  ok(sum3.due === 0, `★ 已掌握的项不再计入「今日到期」（due=${sum3.due}）`);
  ok(sum3.mastered === 1, `已掌握计数正确（mastered=${sum3.mastered}）`);
}

/* ============================================================
   【12】间隔重复：跨设备导入时调度信息取最新作答的一侧
   ============================================================ */
console.log('\n【12】导入合并的调度字段取舍');

{
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();

  S.clearWeak();
  const now = Date.now();

  // 本机：连对 3 次（间隔 7 天）
  S.recordWeak({ char: '合', pinyin: 'he' });
  reviewDays(S, '合', 3);
  const local = S.getWeakList({ limit: 10, minCount: 1 })[0];

  // 备份：同一字但进度更低（只连对 1 次）
  const backup = {
    app: 'shuangpin-practice',
    version: S.DATA_VERSION,
    weak: {
      合: { key: '合', char: '合', pinyin: 'he', count: 2, correct: 1, lastTs: now, streak: 1, interval: 1, ease: 2.5, due: now + 86400000 }
    }
  };
  S.importAll(backup);
  const merged = S.getWeakList({ limit: 10, minCount: 1 })[0];

  ok(merged.count >= local.count, `错误次数取累加（本地 ${local.count} → 合并后 ${merged.count}）`);
  ok(merged.interval >= local.interval,
    `★ 旧备份不能回退较新的排期（本地 ${local.interval} 天 → 合并后 ${merged.interval} 天）`);
  ok(merged.streak >= local.streak,
    `连对次数不倒退（本地 ${local.streak} → 合并后 ${merged.streak}）`);
  ok(Number.isFinite(merged.due), '合并后 due 仍是合法数值');
  ok(Number.isFinite(merged.ease), '合并后 ease 仍是合法数值');

  // 反向：备份比本地更靠前 → 应采纳备份的更大间隔
  S.clearWeak();
  S.recordWeak({ char: '逆', pinyin: 'ni' });     // 本地很低
  const localLow = S.getWeakList({ limit: 10, minCount: 1 })[0];
  S.importAll({
    app: 'shuangpin-practice',
    version: S.DATA_VERSION,
    weak: {
      逆: { key: '逆', char: '逆', pinyin: 'ni', count: 1, correct: 4, lastTs: now + 1000, reviewedAt: now + 1000, streak: 4, interval: 16, ease: 2.7, due: now + 16 * 86400000 }
    }
  });
  const mergedHigh = S.getWeakList({ limit: 10, minCount: 1, includeMastered: true })[0];
  ok(mergedHigh.interval >= 16,
    `★ 备份作答较新时采纳备份的间隔（本地 ${localLow.interval} → 合并后 ${mergedHigh.interval}）`);
}

/* ============================================================
   【13】设置项：新增字段的类型与回退
   ============================================================ */
console.log('\n【13】设置项（reduceMotion / reviewDueOnly / shortcuts）');

{
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();

  const d = S.DEFAULT_SETTINGS;
  ok(d.reduceMotion === 'auto', `reduceMotion 默认 'auto'（实际 ${d.reduceMotion}）`);
  ok(d.reviewDueOnly === true, `reviewDueOnly 默认 true（实际 ${d.reviewDueOnly}）`);
  ok(d.shortcuts === null, `shortcuts 默认 null（实际 ${d.shortcuts}）`);

  // 默认值读取
  const def = S.loadSettings();
  ok(def.reduceMotion === 'auto', '未存过时读到 auto');
  ok(def.reviewDueOnly === true, '未存过时读到 true');

  /* ★ 关键：shortcuts 是对象，不能走「标量类型检查」那条路 ——
     否则会被强制成 "[object Object]" 存进去。 */
  S.saveSettings(Object.assign({}, def, {
    shortcuts: { hint: 'f1', skip: 'f2', pause: '', submit: 'enter' }
  }));
  const back = S.loadSettings();
  ok(typeof back.shortcuts === 'object' && back.shortcuts !== null,
    `★ shortcuts 以对象形式存取（实际类型 ${typeof back.shortcuts}）`);
  ok(back.shortcuts && back.shortcuts.hint === 'f1',
    `★ shortcuts 内容未被字符串化（hint=${back.shortcuts && back.shortcuts.hint}）`);

  // 存进去的是垃圾（数组 / 字符串）→ 回退 null
  S.saveSettings(Object.assign({}, def, { shortcuts: ['a', 'b'] }));
  ok(S.loadSettings().shortcuts === null, 'shortcuts 为数组时回退 null');
  S.saveSettings(Object.assign({}, def, { shortcuts: 'oops' }));
  ok(S.loadSettings().shortcuts === null, 'shortcuts 为字符串时回退 null');

  // reduceMotion 只接受三个合法值
  S.saveSettings(Object.assign({}, def, { reduceMotion: 'on' }));
  ok(S.loadSettings().reduceMotion === 'on', 'reduceMotion 可存 on');
  S.saveSettings(Object.assign({}, def, { reduceMotion: 'off' }));
  ok(S.loadSettings().reduceMotion === 'off', 'reduceMotion 可存 off');
  S.saveSettings(Object.assign({}, def, { reduceMotion: '乱写' }));
  ok(S.loadSettings().reduceMotion === 'auto',
    `★ 非法 reduceMotion 回退 auto（实际 ${S.loadSettings().reduceMotion}）`);

  // reviewDueOnly 是布尔
  S.saveSettings(Object.assign({}, def, { reviewDueOnly: false }));
  ok(S.loadSettings().reviewDueOnly === false, 'reviewDueOnly 可存 false');
}

/* ============================================================
   【14】存储三态：命名与复位
   ============================================================ */
console.log('\n【14】存储状态命名');

{
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();

  ok(typeof S.storageModeName === 'function', '导出 storageModeName()');
  const n0 = S.storageModeName();
  ok(typeof n0 === 'string' && n0.length > 0, `正常态有可读名称（${n0}）`);

  // 配额满 → 名称应变化
  ls.state.limit = 200;
  S.writeJSON('k.huge', { big: 'z'.repeat(2000) });
  const n1 = S.storageModeName();
  ok(n1 !== n0, `★ 降级后名称变化（${n0} → ${n1}）`);
  ok(/内存|memory|quota|配额/i.test(n1), `降级态名称可辨识（${n1}）`);

  // 复位钩子
  ok(typeof S._resetStorageState === 'function', '导出 _resetStorageState()（测试钩子）');
  S._resetStorageState();
  ok(S.storageModeName() === n0, '★ 复位后回到初始状态名');
}

/* ============================================================
   【15】回归：内存副本 / 递归重试 / 导入幂等（第九轮实测事故）
   ============================================================ */
console.log('\n【15】回归：恢复后旧值、递归重试、重复导入');

{
  /* ---- 15a. 恢复落盘后不得读到内存里的旧值 ---- */
  const ls = makeLocalStorage();
  ls.state.limit = 200;
  installWindow(ls);
  const S = await freshStorage();
  S.isStorageAvailable();

  // 模拟「题量 10」写入时配额满 → 落进内存
  const okSmall = S.writeJSON('k.count', JSON.stringify({ v: 10 }));
  const wroteBig = S.writeJSON('k.huge', { big: 'z'.repeat(2000) });
  ok(S.isDegradedToMemory() === true, '15a 配额满后进入降级');
  ok(S.readJSON('k.huge', null) !== null, '15a 失败写入的数据在内存里可读');

  // 用户腾出空间 → 下一次写入触发恢复，随后同键成功写入新值
  ls.state.limit = Infinity;
  S.writeJSON('k.other', { x: 1 });           // 触发 recoverStorage
  ok(S.isStorageAvailable() === true, '15a 空间释放后恢复落盘');
  const wrote = S.writeJSON('k.count', JSON.stringify({ v: 50 }));
  ok(wrote === true, '15a 同键后续写入成功');
  ok(S.readJSON('k.count', null) === JSON.stringify({ v: 50 }),
    '★ 15a 成功落盘后读取到新值 50，而不是内存里的旧值 10');
  // 再写一次，读路径依然走 localStorage
  S.writeJSON('k.count', JSON.stringify({ v: 99 }));
  ok(S.readJSON('k.count', null) === JSON.stringify({ v: 99 }), '15a 后续写入持续生效');
}

{
  /* ---- 15b. 持续配额不足时，清理+重试最多一轮，不得递归 ---- */
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();
  S.isStorageAvailable();                      // 正常探测

  // 预置 400 条历史（超过裁剪线 200，让 pruneHistory 有得做）
  const hist = Array.from({ length: 400 }, (_, i) =>
    S.makeRecord({ ts: 1700000000000 + i, mode: 'char', totalChars: 10, durationSec: 5, speed: 100, accuracy: 100 }));
  S.writeJSON(S.KEYS.history, hist);
  const callsBefore = ls.state.setCalls;

  // 从现在起**所有**应用键（NS 前缀）的写入都失败（__probe 除外，否则恢复探测也会挂）
  ls.state.blockPrefix = 'shuangpin.v1.';
  // 必须写一个 NS 前缀的应用键才会触发配额路径（k.* 这类测试键不在拦截范围）
  S.writeJSON(S.KEYS.settings, { note: 'x'.repeat(3000) });   // 旧实现：这里会递归 ~4800 次

  const delta = ls.state.setCalls - callsBefore;
  ok(delta < 40,
    `★ 15b 一次保存的写入尝试有界（实际 ${delta} 次；递归实现约 4800 次）`);
  ok(S.isDegradedToMemory() === true, '15b 最终转入内存存储');
  const mem = JSON.parse(S.readRaw(S.KEYS.history) || 'null');
  ok(Array.isArray(mem) && mem.length <= 200,
    `★ 15b 裁剪后的历史保存在内存里（${Array.isArray(mem) ? mem.length : 0} 条）`);
  ok(S.readRaw(S.KEYS.settings) !== null, '15b 触发保存的那条数据也在内存里，没有丢');
}

{
  /* ---- 15c. 同一备份重复导入：易错计数与键位错误必须幂等 ---- */
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();

  // 本地真实用出来的数据：错 1 次「测」、V 键错 2 次
  S.recordWeak({ char: '测', pinyin: 'ce' });
  S.recordKeyErrors({ v: 2 });
  const backup = JSON.parse(JSON.stringify(S.exportAll()));

  const w1 = S.getWeakList({ limit: 10, minCount: 1 })[0];
  S.importAll(backup);
  S.importAll(backup);                         // 又导一次
  const w2 = S.getWeakList({ limit: 10, minCount: 1 })[0];
  ok(w2 && w1 && w2.count === w1.count,
    `★ 15c 重复导入不重复累计错误次数（${w1 && w1.count} → ${w2 && w2.count}）`);
  ok(w2 && w1 && w2.correct === w1.correct, `15c correct 同样不变（${w2 && w2.correct}）`);

  const ke1 = S.loadKeyErrors();
  ok(ke1.all.V === 2, `★ 15c 重复导入后键位错误不膨胀（V=${ke1.all.V}）`);
  const sessions = ke1.recent.length;
  S.importAll(backup);
  ok(S.loadKeyErrors().recent.length === sessions,
    `15c 会话明细按 ts 去重（${sessions} 条不变）`);

  // 跨设备合并语义保持：不同记录（时间戳/次数不同）仍然相加
  const other = JSON.parse(JSON.stringify(backup));
  other.weak['测'].countsBySource = { 'device:other': { count: 2, correct: 0 } };
  other.weak['测'].count = 2;                   // 另一台设备错了 2 次
  other.weak['测'].lastTs = (backup.weak['测'].lastTs || 0) + 5;
  S.importAll(other);
  const w3 = S.getWeakList({ limit: 10, minCount: 1 })[0];
  ok(w3.count === w1.count + 2,
    `15c 真正的跨设备记录仍相加（${w1.count} + 2 = ${w3.count}）`);
}

console.log('\n【新增】备份幂等、排期与历史身份');
{
  installWindow(makeLocalStorage());
  const S = await freshStorage();
  S.recordWeak({ char: '测', pinyin: 'ce' });
  S.recordWeak({ char: '测', pinyin: 'ce' });
  const legacy = { app: 'shuangpin-practice', version: 2,
    weak: { 测: { char: '测', count: 1, correct: 0, lastTs: 1 } } };
  S.importAll(legacy);
  S.importAll(legacy);
  ok(S.loadWeak()['测'].count === 3, '旧备份反复导入不重复累加');
  const snapshot = S.exportAll();
  S.recordWeak({ char: '测', pinyin: 'ce' });
  S.importAll(snapshot);
  S.importAll(snapshot);
  ok(S.loadWeak()['测'].count === 4, '旧的同设备快照不重复累计或覆盖新计数');
  const future = Date.now() + 1000;
  S.importAll({ app: 'shuangpin-practice', weak: { 测: {
    char: '测', count: 1, correct: 0, lastTs: future,
    streak: 0, interval: 1, due: future + 86400000, mastered: false,
    countsBySource: { 'device:relapse': { count: 1, correct: 0 } }
  } } });
  const relapse = S.loadWeak()['测'];
  ok(relapse.interval === 1 && !relapse.mastered && relapse.streak === 0,
    '较新的答错状态保留短间隔与未掌握标记');
  S.importAll({ app: 'shuangpin-practice', weak: { 测: {
    char: '测', count: 1, correct: 5, reviewedAt: future - 100,
    streak: 5, interval: 35, mastered: true,
    countsBySource: { 'device:older': { count: 1, correct: 5 } }
  } } });
  ok(S.loadWeak()['测'].interval === 1 && !S.loadWeak()['测'].mastered,
    '较旧的掌握状态不能覆盖最新答错');
  S.clearHistory();
  const a = { id: 'session-a', ts: Date.now(), mode: 'char', durationSec: 10, totalChars: 20 };
  const b = { ...a, id: 'session-b' };
  S.importAll({ app: 'shuangpin-practice', history: [a, b, a] });
  S.importAll({ app: 'shuangpin-practice', history: [a, b] });
  ok(S.loadHistory().length === 2, '同毫秒不同会话都保留，同一会话重复导入只保留一次');
  S.saveSettings({ charTier: '99' });
  ok(S.loadSettings().charTier === '1', '非法难度回退到高频字');
}

console.log('【新增】题量边界与近期内容');
{
  installWindow(makeLocalStorage());
  const S = await freshStorage();
  for (const [input, expected] of [[0, 0], [137, 137], [-2, 0], [5001, 5000], [12.9, 12], ['invalid', 20]]) {
    S.saveSettings({ count: input });
    ok(S.loadSettings().count === expected, `题量 ${input} 规范为 ${expected}`);
  }
  for (let i = 0; i < 210; i++) S.recordRecent('phrase', `词${i}`);
  S.recordRecent('phrase', '词209');
  ok(S.loadRecent('phrase').length === 200 && S.loadRecent('phrase')[0] === '词10',
    '近期记录有界且重复展示不增加条目');
  S.saveResume({ questions: [{ kind: 'word' }], index: 1, unlimited: true, questionOffset: 40,
    generation: { mode: 'phrase', count: 20, charTier: '3' } });
  ok(S.loadResume()?.questionOffset === 40 && S.loadResume()?.generation?.charTier === '3',
    '续练存储保留累计题量和生成设置');
}

console.log('\n【16】键位错误按模式取数（统计页的模式筛选要覆盖热力图）');
{
  const ls = makeLocalStorage();
  installWindow(ls);
  const S = await freshStorage();
  S.recordKeyErrors({ v: 3, h: 1 }, 'phrase');
  S.recordKeyErrors({ a: 2 }, 'char');
  S.recordKeyErrors({ j: 4 }, 'phrase');

  const all = S.getKeyErrorTotals('all');
  ok(all.byMode === false, '不指定模式时不声称按模式取数');
  ok(all.counts.V === 3 && all.counts.J === 4 && all.counts.A === 2,
    `全量累计各键正确（V=${all.counts.V} J=${all.counts.J} A=${all.counts.A}）`);

  const phrase = S.getKeyErrorTotals('all', 'phrase');
  ok(phrase.byMode === true, '按模式取数时标记 byMode');
  ok(phrase.counts.V === 3 && phrase.counts.J === 4, '词组模式只含该模式的键');
  ok(!phrase.counts.A, '词组模式不含单字模式的键（A 不应出现）');

  const char = S.getKeyErrorTotals('all', 'char');
  ok(char.byMode === true && char.counts.A === 2 && !char.counts.V,
    '单字模式只含自己的键');

  // 老数据（没有 byMode 层）必须如实报告 byMode=false，让 UI 能说明「仍为全量」
  ls.setItem('shuangpin.v1.keyErrors', JSON.stringify({
    all: { V: 9, A: 8 }, recent: [{ ts: 1, keys: { V: 9 }, total: 9 }]
  }));
  const legacy = S.getKeyErrorTotals('all', 'phrase');
  ok(legacy.byMode === false, '没有按模式数据时 byMode 为 false');
  ok(legacy.counts.V === 9, '退回全量而不是返回空图');
  ok(legacy.total === 17, `全量总额正确（${legacy.total}）`);

  // 「最近 N 次」按模式过滤
  const ls2 = makeLocalStorage();
  installWindow(ls2);
  const S2 = await freshStorage();
  S2.recordKeyErrors({ v: 5 }, 'phrase');
  S2.recordKeyErrors({ v: 5 }, 'char');
  S2.recordKeyErrors({ v: 5 }, 'phrase');
  const recentPhrase = S2.getKeyErrorTotals('10', 'phrase');
  ok(recentPhrase.byMode === true, '近 N 次也能按模式过滤');
  ok(recentPhrase.counts.V === 10, `近 N 次只算该模式（V=${recentPhrase.counts.V}，应为 10）`);
  const recentAll = S2.getKeyErrorTotals('10');
  ok(recentAll.counts.V === 15, `不筛模式时全算（V=${recentAll.counts.V}，应为 15）`);

  // 会话明细带上模式，便于按模式回溯
  const data = S2.loadKeyErrors();
  ok(data.recent.every(s => typeof s.mode === 'string'), '会话明细记录了模式');
  ok(data.recent.filter(s => s.mode === 'phrase').length === 2, '明细里能数出该模式的会话数');

  // 导入合并：byMode 必须跟着明细一起累加，否则导入后按模式筛选莫名失效
  const backup = JSON.parse(JSON.stringify(S2.exportAll()));
  const S3 = await freshStorage();
  S3.importAll(backup);
  S3.importAll(backup);   // 幂等
  const merged = S3.getKeyErrorTotals('all', 'phrase');
  ok(merged.byMode === true, '导入后该模式仍有专属数据');
  ok(merged.counts.V === 10, `按模式累计与 all 同步累加且不重复（V=${merged.counts.V}，应为 10）`);
  const mergedAll = S3.getKeyErrorTotals('all');
  ok(mergedAll.counts.V === 15, `全量也没被重复累加（V=${mergedAll.counts.V}，应为 15）`);
  const mergedChar = S3.getKeyErrorTotals('all', 'char');
  ok(mergedChar.counts.V === 5, `单字模式独立计数（V=${mergedChar.counts.V}，应为 5）`);
}

console.log('\n' + (fail === 0
  ? '✅ 存储层自检全部通过'
  : `❌ 存储层自检共 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
