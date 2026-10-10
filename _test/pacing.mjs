/**
 * 卡顿分析自检
 * ------------------------------------------------------------
 * 覆盖「给书架材料记录逐字用时 → 标出停顿最长的字词 → 重练时对比」这条链路：
 *   1. 存储层  recordShelfSlow 的留档与裁剪（每篇最多 5 次）
 *   2. 分析层  shelfSlowAnalysis 的「最慢 N 个位置」口径
 *   3. 对比层  同一段之间才比、段号不同要如实说「不可比」
 *   4. 边界    首字排除、脏数据清洗、空快照不挤掉好数据
 *
 * 运行：node _test/pacing.mjs
 *
 * 为什么单独一个文件：这一层的核心风险是「口径悄悄变了却看着像正常」——
 * 比如首字没排除（于是第一名永远是第一个字）、或者跨段硬比（于是得出
 * 一堆假差异）。混进别的自检里，这类问题只会表现为「数字有点怪」。
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗ ' + m); } else { console.log('  ✓ ' + m); } };

const require = createRequire(import.meta.url);
let modSeq = 0;

function makeLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] ?? null,
    clear: () => map.clear()
  };
}

const base = new URL('../src/core/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fresh = (f) => import(`${pathToFileURL(base + f).href}?t=${++modSeq}`);

/* ============================================================
   【1】存储层：留档与裁剪
   ============================================================ */
console.log('【1】存储层：逐字用时快照的留档与裁剪');

const ls = makeLocalStorage();
globalThis.window = { localStorage: ls, setTimeout, clearTimeout };
const S = await fresh('storage.js');

{
  const e = S.addShelfEntry({ title: '测试材料', text: '今天天气很好我们出去走走吧。' });
  ok(!!e, '建了一份书架材料');
  ok(Array.isArray(e.slow) && e.slow.length === 0, '新材料的逐字快照为空数组');

  // 记第一次：最高 1200ms，超过默认门槛 900
  const chars = '今天天气很好'.split('').map((ch, i) => ({ ch, ms: 700 + i * 100 }));
  S.recordShelfSlow(e.id, chars, { segIndex: 0, durationSec: 4, totalChars: 6 });
  const a1 = S.shelfSlowAnalysis(e.id);
  ok(a1.hasData === true, '记完第一次后 hasData 为 true');
  ok(a1.sessions === 1, '会话数为 1');
  ok(a1.slowest.length > 0, '能算出最慢的位置');

  // ★ 首字必须被排除
  ok(!a1.slowest.some(s => s.index === 0),
    '★ 首字被排除（它含「进入状态」的启动成本，不排除永远是第一名）');
  // 700 + i*100 中 i=5 最大 → 1200；首字 700 不参与
  const maxChar = a1.slowest[0];
  ok(maxChar.ms === 1200, `最慢位置取到实际最大值（${maxChar.ms}ms，期望 1200）`);

  // 脏数据清洗
  S.recordShelfSlow(e.id, [
    { ch: 'A', ms: 700 },
    { ch: '', ms: 900 },        // 空字符
    { ch: 'B', ms: -5 },        // 负耗时
    { ch: 'C', ms: 'abc' },     // 非数字
    { ch: 'D', ms: 0 }          // 零耗时
  ], { segIndex: 0, durationSec: 1, totalChars: 1 });
  const raw = S.loadShelf().find(x => x.id === e.id).slow;
  const lastSnap = raw[raw.length - 1];
  ok(lastSnap.chars.length === 1 && lastSnap.chars[0].ch === 'A',
    `脏数据被清洗（保留 ${lastSnap.chars.length} 条，期望 1）`);

  // 空快照不留档
  const before = S.loadShelf().find(x => x.id === e.id).slow.length;
  const r = S.recordShelfSlow(e.id, [], { segIndex: 0, durationSec: 0, totalChars: 0 });
  ok(r === null, '★ 空快照不被记录（留了会把上一次的好数据挤掉）');
  ok(S.loadShelf().find(x => x.id === e.id).slow.length === before,
    '空快照不改变已有快照数量');

  // ★ 上限 5 次
  for (let i = 0; i < 8; i++) {
    S.recordShelfSlow(e.id, [{ ch: '字', ms: 1000 + i }], { segIndex: 0, durationSec: 1, totalChars: 1 });
  }
  const snaps = S.loadShelf().find(x => x.id === e.id).slow;
  ok(snaps.length === S.SHELF_SLOW_SNAPSHOTS,
    `★ 只留最近 ${S.SHELF_SLOW_SNAPSHOTS} 次（实际 ${snaps.length}）`);
  ok(snaps[snaps.length - 1].chars[0].ms === 1007,
    '保留的是最近的（最后一条 ms=1007）');
  ok(snaps[0].chars[0].ms === 1003,
    '最老的被裁掉（第一条 ms=1003，说明 1000/1001/1002 已淘汰）');
}

/* ============================================================
   【2】分析层：最慢 N 个位置的口径
   ============================================================ */
console.log('\n【2】分析层：最慢位置的口径');

{
  const e = S.addShelfEntry({ title: '口径测试', text: '一二三四五六七八九十' });
  // 构造：第一个字故意很慢（应被排除），第 4 个字是真的卡
  S.recordShelfSlow(e.id, [
    { ch: '一', ms: 5000 },   // 首字，极慢 —— 不该进榜
    { ch: '二', ms: 200 },
    { ch: '三', ms: 250 },
    { ch: '四', ms: 4000 },   // 真卡顿，应排第一
    { ch: '五', ms: 220 },
    { ch: '六', ms: 3000 },   // 第二
    { ch: '七', ms: 240 }
  ], { segIndex: 0, durationSec: 13, totalChars: 7 });

  const a = S.shelfSlowAnalysis(e.id, { top: 5, minMs: 900 });
  ok(a.slowest[0].ch === '四', `第一名是真的卡顿的那个字（${a.slowest[0].ch}，不是首字）`);
  ok(a.slowest[1].ch === '六', '第二名是次慢的');
  ok(a.slowest.length === 2, `只列超过 minMs 的（${a.slowest.length} 个）`);
  // 正文用时（不含首字）：200 250 4000 220 3000 240 → 升序 200 220 240 250 3000 4000
  // 偶数个 → 中位数取中间两个的平均 (240 + 250) / 2 = 245
  ok(a.medianMs === 245, `中位数取正文的中位（${a.medianMs}，期望 245）`);
  ok(a.slowest[0].ratio === 16.33, `倍率 = 4000 / 245 ≈ 16.33（${a.slowest[0].ratio}）`);

  // minMs 门槛能过滤掉轻微停顿
  const a2 = S.shelfSlowAnalysis(e.id, { top: 5, minMs: 3500 });
  ok(a2.slowest.length === 1 && a2.slowest[0].ch === '四',
    '调高门槛后只剩真正的长停顿');

  // top 上限
  const a3 = S.shelfSlowAnalysis(e.id, { top: 1, minMs: 900 });
  ok(a3.slowest.length === 1, 'top=1 时只返回一个位置');

  // 全部很快：不给假卡顿
  const e2 = S.addShelfEntry({ title: '流畅材料', text: '一二三四五' });
  S.recordShelfSlow(e2.id, '一二三四五'.split('').map(ch => ({ ch, ms: 180 })),
    { segIndex: 0, durationSec: 1, totalChars: 5 });
  const a4 = S.shelfSlowAnalysis(e2.id, { top: 5, minMs: 900 });
  ok(a4.hasData === true && a4.slowest.length === 0,
    '每个字都很快时不硬凑「最慢位置」');
  ok(a4.medianMs === 180, '中位数照常给出（供 UI 说明「本篇都很顺」）');
}

/* ============================================================
   【3】对比层：同段才比
   ============================================================ */
console.log('\n【3】对比层：同段才比，跨段如实说不可比');

{
  const e = S.addShelfEntry({ title: '对比测试', text: '一二三四五六七八' });

  // 第一次（第 1 段）：普遍较慢
  S.recordShelfSlow(e.id, [
    { ch: '一', ms: 900 },
    { ch: '二', ms: 1500 },
    { ch: '三', ms: 1600 },
    { ch: '四', ms: 1700 }
  ], { segIndex: 0, durationSec: 6, totalChars: 4 });
  const first = S.shelfSlowAnalysis(e.id);
  ok(first.compare === null, '只有一次记录时不做对比（不给 0 变化）');

  // 第二次（同为第 1 段）：整体变快
  S.recordShelfSlow(e.id, [
    { ch: '一', ms: 500 },
    { ch: '二', ms: 600 },
    { ch: '三', ms: 700 },
    { ch: '四', ms: 800 }
  ], { segIndex: 0, durationSec: 3, totalChars: 4 });
  const second = S.shelfSlowAnalysis(e.id);
  ok(second.compare && second.compare.comparable === true, '同段两次后可对比');
  ok(second.compare.deltaMs < 0, `变快时 deltaMs 为负（${second.compare.deltaMs}）`);
  ok(second.compare.segMismatch === false, '同段时 segMismatch 为 false');

  // 第三次（换到第 2 段）：段号不同，不能比
  S.recordShelfSlow(e.id, [
    { ch: '五', ms: 300 },
    { ch: '六', ms: 320 },
    { ch: '七', ms: 340 },
    { ch: '八', ms: 360 }
  ], { segIndex: 1, durationSec: 2, totalChars: 4 });
  const third = S.shelfSlowAnalysis(e.id);
  ok(third.compare && third.compare.segMismatch === true,
    '★ 段号不同时标为 segMismatch，UI 说明「位置对不上」');
  ok(third.compare.comparable === false, '★ 跨段不做对比（否则得出一堆假差异）');
  ok(third.compare.sameSpots.length === 0, '跨段时不给「同一位置更慢」的列表');

  // 同段内「某个位置明显变慢」能被点名
  const e3 = S.addShelfEntry({ title: '位置对比', text: '一二三四五' });
  S.recordShelfSlow(e3.id, [
    { ch: '一', ms: 500 }, { ch: '二', ms: 500 },
    { ch: '三', ms: 500 }, { ch: '四', ms: 500 }
  ], { segIndex: 0, durationSec: 2, totalChars: 4 });
  S.recordShelfSlow(e3.id, [
    { ch: '一', ms: 500 }, { ch: '二', ms: 500 },
    { ch: '三', ms: 1400 },   // 这个位置卡了
    { ch: '四', ms: 500 }
  ], { segIndex: 0, durationSec: 3, totalChars: 4 });
  const a = S.shelfSlowAnalysis(e3.id, { minMs: 900 });
  ok(a.compare && a.compare.sameSpots.length === 1,
    `点名「同一位置比上次更慢」的字（${a.compare && a.compare.sameSpots.length} 个）`);
  ok(a.compare.sameSpots[0].ch === '三', `点名的正是变慢的那个字（${a.compare.sameSpots[0].ch}）`);

  // 首字变慢不该被点名（它是启动成本）
  const e4 = S.addShelfEntry({ title: '首字测试', text: '一二三四' });
  S.recordShelfSlow(e4.id, [
    { ch: '一', ms: 400 }, { ch: '二', ms: 500 }, { ch: '三', ms: 500 }
  ], { segIndex: 0, durationSec: 2, totalChars: 3 });
  S.recordShelfSlow(e4.id, [
    { ch: '一', ms: 3000 },   // 首字慢了 7 倍
    { ch: '二', ms: 500 }, { ch: '三', ms: 500 }
  ], { segIndex: 0, durationSec: 4, totalChars: 3 });
  const a4 = S.shelfSlowAnalysis(e4.id, { minMs: 900 });
  ok(a4.compare.sameSpots.length === 0,
    '★ 首字变慢不被点名（它是启动成本，不是卡顿）');
}

/* ============================================================
   【4】续练现场：逐字用时不丢
   ============================================================ */
console.log('\n【4】续练现场：逐字用时随存档走');

{
  ok(typeof S.saveResume === 'function' && typeof S.loadResume === 'function',
    '续练存档接口存在');

  S.saveResume({
    mode: 'custom', questions: [{ id: 'q1', kind: 'key', answerKeys: ['A'], promptText: 'A' }],
    index: 0, charIndex: 0, keyIndex: 0, typed: '', elapsedSec: 1, stats: {},
    shelfId: 'mtest', shelfSegBase: 0,
    slowChars: [{ ch: '今', ms: 400 }, { ch: '天', ms: 500 }]
  });
  const back = S.loadResume();
  ok(Array.isArray(back.slowChars) && back.slowChars.length === 2,
    '★ 逐字用时随续练现场保存并读回');
  ok(back.slowChars[0].ch === '今' && back.slowChars[0].ms === 400, '内容保真');

  // 脏数据在存档入口就被挡掉
  S.saveResume({
    mode: 'custom', questions: [{ id: 'q1', kind: 'key', answerKeys: ['A'], promptText: 'A' }],
    index: 0, charIndex: 0, keyIndex: 0, typed: '', elapsedSec: 1, stats: {},
    slowChars: [{ ch: 'A', ms: 400 }, { ch: '', ms: 500 }, { ch: 'B', ms: -1 }]
  });
  const back2 = S.loadResume();
  ok(back2.slowChars.length === 1 && back2.slowChars[0].ch === 'A',
    '存档入口清洗逐字用时的脏数据');

  S.clearResume();
}

console.log('\n' + (fail === 0
  ? '✅ 卡顿分析自检全部通过'
  : `❌ 卡顿分析自检共 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
