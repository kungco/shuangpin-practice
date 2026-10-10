/**
 * 错键辨析自检
 * ------------------------------------------------------------
 * 覆盖「目标键 → 误按键」这条新链路的四段：
 *   1. 存储层  recordKeyConfusions / getKeyConfusions 的累积、范围与模式筛选
 *   2. 引擎层  pressKey 按错时产生的有向组合恰好是「本该按的 → 实际按的」
 *   3. 统计层  confusionPairs 的双向合并、discriminationDrills 的成题
 *   4. 导入导出 备份合并的幂等性（重复导入不翻倍）
 *
 * 运行：node _test/confusion.mjs
 *
 * 为什么单独一个文件：这条链路横跨 storage / engine / stats 三个模块，
 * 且核心风险是「同一对键的两个方向被算重」这种只在数据积累后才显形的问题，
 * 混进别的自检里会看不出是哪一层出的错。
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗ ' + m); } else { console.log('  ✓ ' + m); } };

const require = createRequire(import.meta.url);
let modSeq = 0;

/* ---------- 最小 localStorage 桩（与 storage.mjs 同款思路） ---------- */
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

function fresh(url) {
  return import(`${pathToFileURL(url).href}?t=${++modSeq}`);
}

/* ============================================================
   【1】存储层：累积、有向性、范围与模式筛选
   ============================================================ */
console.log('【1】存储层：混淆组合的累积与筛选');

{
  const ls = makeLocalStorage();
  globalThis.window = { localStorage: ls, setTimeout, clearTimeout };
  const S = await fresh(new URL('../src/core/storage.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

  ok(S.getKeyConfusions('all', 'all').total === 0, '初始为空：total 为 0');

  // 两个方向都记：G→K 三次，K→G 一次
  S.recordKeyConfusions({ G: { K: 3 } }, 'char');
  S.recordKeyConfusions({ K: { G: 1 } }, 'char');
  const r1 = S.getKeyConfusions('all', 'all');
  ok(r1.total === 4, `两个方向分别累计（total=${r1.total}，期望 4）`);
  const gk = r1.pairs.find(p => p.target === 'G' && p.actual === 'K');
  const kg = r1.pairs.find(p => p.target === 'K' && p.actual === 'G');
  ok(gk && gk.count === 3, `G→K 记到 3 次（实际 ${gk && gk.count}）`);
  ok(kg && kg.count === 1, `K→G 记到 1 次（实际 ${kg && kg.count}）`);
  ok(r1.pairs[0].count >= r1.pairs[r1.pairs.length - 1].count, '按次数降序排列');

  // 同一对键的另一个方向不该被算进对方
  ok(gk.count !== kg.count, '两个方向是独立计数，不互相污染');

  // 按模式筛选
  S.recordKeyConfusions({ D: { T: 5 } }, 'keymap');
  const byChar = S.getKeyConfusions('all', 'char');
  ok(!byChar.pairs.some(p => p.target === 'D'),
    '按模式筛选：char 模式的数据里没有 keymap 的 D→T');
  ok(byChar.byMode === true, '有专属数据时 byMode 为 true');
  const byKeymap = S.getKeyConfusions('all', 'keymap');
  ok(byKeymap.pairs.some(p => p.target === 'D' && p.count === 5), 'keymap 模式取到自己的 D→T');

  // 无专属数据的模式应退回全量（而不是返回空）
  S.recordKeyConfusions({ H: { J: 2 } }, 'phrase');   // phrase 只有这一条
  const byNone = S.getKeyConfusions('all', 'split');  // split 从没记过
  ok(byNone.pairs.length > 0, '没有该模式数据时退回全量，而不是显示空白');
  ok(byNone.byMode === false, '退回全量时 byMode 为 false（UI 据此说明）');

  // 范围筛选：recent 里最近几条
  const recent1 = S.getKeyConfusions('10', 'all');
  ok(recent1.sessions === Math.min(10, S.loadKeyConfusions().recent.length),
    `范围筛选只取最近 N 次会话（sessions=${recent1.sessions}）`);

  // 非法输入被丢弃
  S.recordKeyConfusions({ ZZ: { K: 3 }, G: { KK: 2 }, '': {} }, 'char');
  const after = S.getKeyConfusions('all', 'all');
  ok(!after.pairs.some(p => p.target === 'ZZ' || p.actual === 'KK'),
    '非法键名（多字符/空）被丢弃');
  S.recordKeyConfusions({ G: { G: 9 } }, 'char');
  ok(!S.getKeyConfusions('all', 'all').pairs.some(p => p.target === 'G' && p.actual === 'G'),
    '「按错成自己」不算混淆，被丢弃');

  // 清空
  S.clearKeyConfusions();
  ok(S.getKeyConfusions('all', 'all').total === 0, 'clearKeyConfusions 清空成功');
}

/* ============================================================
   【2】引擎层：按错时记录的方向必须正确
   ============================================================ */
console.log('\n【2】引擎层：按错时的有向记录');

{
  const ls = makeLocalStorage();
  globalThis.window = { localStorage: ls, setTimeout, clearTimeout };
  const { PracticeEngine } = await fresh(
    new URL('../src/core/engine.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

  // 造一道键位题：答案是 G
  const mk = (answer) => [{
    id: 'q1', kind: 'key', answerKeys: [answer], promptText: answer, role: 'yun'
  }];

  const eng = new PracticeEngine({ questions: mk('G'), mode: 'keymap', hintEnabled: false });
  eng.start();
  eng.pressKey('k');   // 本想按 G，按成了 K
  const conf = eng.stats.keyConfusions;
  ok(conf && conf.G && conf.G.K === 1,
    '★ 按错记录的是「本该按的 G → 实际按的 K」而不是反过来');

  // 按对不该产生混淆记录
  eng.pressKey('g');
  const conf2 = eng.stats.keyConfusions;
  ok(!conf2.K, '按对不产生任何混淆组合');
  ok(conf2.G && conf2.G.K === 1, '按对不会清掉已有的混淆记录');

  // summary 里带出来
  const sum = eng.summary();
  ok(sum.keyConfusions && sum.keyConfusions.G && sum.keyConfusions.G.K === 1,
    'summary() 带上 keyConfusions');
  ok(sum.keyConfusions !== eng.stats.keyConfusions,
    'summary() 返回的是拷贝，外部改动不会污染引擎内部状态');

  // 续练现场也带（否则中断一次前半程的混淆数据就丢了）
  const res = eng.exportResume();
  ok(res.stats.keyConfusions && res.stats.keyConfusions.G.K === 1,
    'exportResume() 带上 keyConfusions');

  const restored = PracticeEngine.restore(res);
  ok(restored && restored.stats.keyConfusions.G.K === 1,
    '★ 续练恢复后混淆样本还在');

  // 恢复后的脏数据要清洗
  const dirty = JSON.parse(JSON.stringify(res));
  dirty.stats.keyConfusions = { G: { K: 2, G: 5, '!!': 1 }, '': { K: 9 } };
  const r2 = PracticeEngine.restore(dirty);
  ok(r2.stats.keyConfusions.G && r2.stats.keyConfusions.G.K === 2
     && r2.stats.keyConfusions.G.G === undefined
     && r2.stats.keyConfusions[''] === undefined,
    '恢复时清洗非法键名与「按错成自己」');
}

/* ============================================================
   【3】统计层：双向合并与成题
   ============================================================ */
console.log('\n【3】统计层：键对合并与辨析题生成');

{
  const ls = makeLocalStorage();
  globalThis.window = { localStorage: ls, setTimeout, clearTimeout };
  const base = new URL('../src/core/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const S = await fresh(base + 'storage.js');
  const ST = await fresh(base + 'stats.js');
  const { LEVEL_MAP } = await fresh(base + 'questions.js');

  ok(LEVEL_MAP.confuse && LEVEL_MAP.confuse.name === '错键辨析',
    'LEVELS 里有 confuse（统计页模式筛选能选到它）');
  ok(LEVEL_MAP.confuse.hidden === true, 'confuse 不进模式卡片（由统计页入口进入）');

  S.recordKeyConfusions({ G: { K: 8 }, K: { G: 3 } }, 'char');

  const rank = ST.keyConfusionRanking({ range: 'all' });
  ok(rank.total === 11, `排行 total 合计两个方向（${rank.total}，期望 11）`);
  ok(rank.items[0].target === 'G' && rank.items[0].actual === 'K',
    '排行第一位是次数最多的那个方向（G→K）');
  ok(rank.items[0].pairKey === 'G|K', 'pairKey 按字母序拼，方向无关');
  ok(Math.abs(rank.items[0].share - 72.7) < 0.5,
    `share 是占全部混淆的百分比（${rank.items[0].share}%）`);

  const pairs = ST.confusionPairs({ range: 'all' });
  ok(pairs.length === 1, `两个方向合并成一对键（${pairs.length} 对）`);
  ok(pairs[0].count === 11, `合并后次数 = 8 + 3（${pairs[0].count}）`);
  ok(pairs[0].forward === 8 && pairs[0].backward === 3,
    `保留两个方向各自的次数（${pairs[0].forward} / ${pairs[0].backward}）`);
  ok(pairs[0].eligible === true, '11 次已够格单独开练');

  // 不够格的不给开练
  S.clearKeyConfusions();
  S.recordKeyConfusions({ D: { T: 1 } }, 'char');
  const thin = ST.confusionPairs({ range: 'all' });
  ok(thin[0] && thin[0].eligible === false,
    `只有 1 次时不够格（门槛 ${ST.CONFUSION_MIN_COUNT} 次）`);

  // 成题：交替出，两个键各一半
  S.clearKeyConfusions();
  S.recordKeyConfusions({ G: { K: 9 } }, 'char');
  S.recordKeyConfusions({ D: { T: 7 } }, 'char');
  const prs = ST.confusionPairs({ range: 'all' });
  const drill = ST.discriminationDrills(prs, { perPair: 6, maxPairs: 3 });
  ok(drill.count === 12, `两对键 × 6 题 = 12（${drill.count}）`);
  ok(drill.questions.every(q => q.kind === 'key' && q.answerKeys.length === 1),
    '每道题都是单键作答（键位题形态）');
  const answers = drill.questions.map(q => q.answerKeys[0]);
  const inPairs = answers.every(k => ['G', 'K', 'D', 'T'].includes(k));
  ok(inPairs, '★ 答案只落在混淆键对里（不会混进第三个键）');
  const gk = answers.filter(k => k === 'G' || k === 'K');
  const gCount = gk.filter(k => k === 'G').length;
  ok(gCount === 3 && gk.length === 6, `G/K 这一对各出 3 题（G 实际 ${gCount} 题）`);
  ok(drill.questions.every(q => q.meta && q.meta.confuse === true),
    '每题都带 confuse 标记（供 UI 显示辨析提示）');

  // 不够格的键对不进题
  S.clearKeyConfusions();
  S.recordKeyConfusions({ G: { K: 9 } }, 'char');
  S.recordKeyConfusions({ D: { T: 1 } }, 'char');
  const prs2 = ST.confusionPairs({ range: 'all' });
  const drill2 = ST.discriminationDrills(prs2, { perPair: 6 });
  const answers2 = drill2.questions.map(q => q.answerKeys[0]);
  ok(!answers2.includes('D'), '只有 1 次的键对不进练习（默认只取够格的）');
  ok(answers2.includes('G') && answers2.includes('K'), '够格的键对正常进题');

  // 趋势对比
  S.clearKeyConfusions();
  S.recordKeyConfusions({ G: { K: 6 } }, 'char');
  S.recordKeyConfusions({ G: { K: 1 } }, 'char');
  const trend = ST.confusionTrend('G|K', { window: 1 });
  ok(trend.recent === 1 && trend.previous === 6,
    `趋势：最近一段 1 次、上一段 6 次（${trend.recent} / ${trend.previous}）`);
  ok(trend.delta < 0 && trend.direction === -1,
    `混淆在减少，direction 为 -1（delta=${trend.delta}）`);
  ok(trend.comparable === true, '两侧都有该键对的数据时才可对比');

  // 没有该键对的数据：不能报「没变化」，更不能报「进步了」
  const trend2 = ST.confusionTrend('X|Y', { window: 1 });
  ok(trend2.comparable === false, '没有数据的键对不可对比（UI 不能当成「没变化」）');
  ok(trend2.isNew === false && trend2.isGone === false,
    '两侧都没有时不误报「新出现」或「已消除」');
  ok(trend2.recent === 0 && trend2.previous === 0, '没有数据时次数为 0 而不是 NaN');

  // 「上一段没有、这一段才有」= 新冒出来的混淆，不等于进步
  S.clearKeyConfusions();
  S.recordKeyConfusions({ H: { J: 3 } }, 'char');
  S.recordKeyConfusions({ H: { J: 4 } }, 'char');
  const trend3 = ST.confusionTrend('H|J', { window: 1 });
  ok(trend3.isNew === false, '上一段已出现过该键对，不算「新出现」');
  S.clearKeyConfusions();
  S.recordKeyConfusions({ H: { J: 1 } }, 'char');   // 只记一段
  S.recordKeyConfusions({ G: { K: 2 } }, 'char');   // 这对是新冒出来的
  const trend4 = ST.confusionTrend('G|K', { window: 1 });
  ok(trend4.isNew === true && trend4.comparable === false,
    '上一段没有、这一段才有的键对被标为「新出现」，不计入「减少」');
}

/* ============================================================
   【4】导入导出：合并幂等
   ============================================================ */
console.log('\n【4】备份合并：重复导入不翻倍');

{
  const ls = makeLocalStorage();
  globalThis.window = { localStorage: ls, setTimeout, clearTimeout };
  const S = await fresh(new URL('../src/core/storage.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

  S.recordKeyConfusions({ G: { K: 5 } }, 'char');
  const backup = S.exportAll();
  ok(backup.keyConfusions && backup.keyConfusions.all.G.K === 5,
    'exportAll() 带上 keyConfusions');

  // 清空后导入：数据回来
  S.clearKeyConfusions();
  ok(S.getKeyConfusions('all', 'all').total === 0, '导入前本地为空');
  S.importAll(backup);
  ok(S.getKeyConfusions('all', 'all').total === 5, '导入后数据恢复（5 次）');

  // ★ 再导一次：不该翻倍
  S.importAll(backup);
  ok(S.getKeyConfusions('all', 'all').total === 5,
    `★ 重复导入同一份备份不会翻倍（仍是 ${S.getKeyConfusions('all', 'all').total} 次）`);

  // 老备份（只有 all、没有 recent）在本地为空时采用
  S.clearKeyConfusions();
  const legacy = {
    app: 'shuangpin-practice',
    keyConfusions: { all: { H: { J: 4 } }, byMode: {}, recent: [] }
  };
  S.importAll(legacy);
  ok(S.getKeyConfusions('all', 'all').total === 4,
    '老备份（无 recent 明细）在本地为空时被采用');

  // clearAll 覆盖新键
  S.clearAll();
  ok(S.getKeyConfusions('all', 'all').total === 0,
    'clearAll() 覆盖 keyConfusions（因为它遍历 KEYS）');
}

console.log('\n' + (fail === 0
  ? '✅ 错键辨析自检全部通过'
  : `❌ 错键辨析自检共 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
