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

console.log('\n' + (fail === 0
  ? '✅ 存储层自检全部通过'
  : `❌ 存储层自检共 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
