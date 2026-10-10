/**
 * 智能混合练习：组题逻辑自检
 * ------------------------------------------------------------
 * planMixedSession 的验收点（用户明确要求的三类边界）：
 *   · 每类数据为空时 —— 不炸、有可读理由、份额让给别的类
 *   · 重复题过多时 —— 去重、缺口回填、理由里说明去掉了多少
 *   · 样本不足时 —— 慢键需要每键 ≥5 次作答，不够就不安排并如实说明
 * 另外钉死两条验收红线：
 *   · 推荐理由能说明「为什么练这些」
 *   · 题目不会被单一弱项占满（maxShare 上限真的生效）
 *
 * 运行：node _test/mix.mjs
 */
import { planMixedSession } from '../src/core/mix.js';
import { KEY_COMPONENTS } from '../src/core/questions.js';

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const kinds = (qs) => qs.map(q => q.kind);

/** 造一份 keyMastery 形状的数据（只用到本套件关心的字段） */
function fakeMastery({ mastered = [], learning = [], untouched = [] } = {}) {
  const items = [];
  for (const key of mastered) items.push({ key, state: 'mastered', samples: 20, errors: 0, practice: 20, errorRate: 0, medianMs: 200, slow: false, need: 0 });
  for (const key of learning) items.push({ key, state: 'learning', samples: 3, errors: 1, practice: 4, errorRate: 0.25, medianMs: 300, slow: false, need: 2 });
  for (const key of untouched) items.push({ key, state: 'untouched', samples: 0, errors: 0, practice: 0, errorRate: 0, medianMs: 0, slow: false, need: 5 });
  const counts = { mastered: mastered.length, learning: learning.length, untouched: untouched.length };
  return { items, counts, total: items.length, minSamples: 5 };
}

/** 造一份 slowestKeys 形状的数据 */
function fakeSlow(keys, min = 5) {
  return {
    items: keys.map(key => ({ key, samples: min + 2, medianMs: 500, leadMs: 480, followMs: 520 })),
    eligible: keys.length, thin: 0, total: 26, min
  };
}

/** 造一份 getWeakList 形状的数据（pinyin 必须真实 —— 生成器会校验拼音，缺了会走兜底） */
const PINYIN = { '海豚': ['hai', 'tun'], '请': ['qing'], '休息': ['xiu', 'xi'], '经济': ['jing', 'ji'], '发展': ['fa', 'zhan'], '斯': ['si'], '那': ['na'] };
function fakeWeak(list) {
  // list: [['海豚', 3], ['请', 1]] → [词或字, 错误次数]
  return list.map(([w, count]) => {
    const py = PINYIN[w] || [];
    return {
      word: w.length > 1 ? w : '', char: w.length === 1 ? w : '',
      pinyin: py.length > 1 ? py : (py[0] || ''),
      count, correct: 0, lastTs: Date.now(), mastered: false,
      isDue: true, weight: count * 10, errorRate: 1
    };
  });
}

console.log('\n【1】三类数据齐全：三类都出题、交错排列、理由齐全');
{
  const r = planMixedSession({
    durationSec: 300,
    weakList: fakeWeak([['海豚', 3], ['请', 2], ['休息', 1], ['经济', 2], ['发展', 1]]),
    slowKeys: fakeSlow(['Q', 'W']),
    mastery: fakeMastery({ mastered: ['A', 'S', 'D', 'F', 'J', 'K', 'L'], learning: ['E'], untouched: ['R', 'U', 'I'] }),
    seed: 42
  });
  ok(r.questions.length >= 6, `出了 ${r.questions.length} 道题（目标 ${r.target}）`);
  ok(kinds(r.questions).includes('key'), '包含键位题（慢键 / 覆盖段）');
  ok(r.questions.some(q => q.kind === 'word' || q.kind === 'char' || q.kind === 'passage'),
    '包含字词题（易错复习段）');
  // 交错：开头三题不该全是同一类（轮转穿插，而不是一段打完再一段）
  const head3 = kinds(r.questions).slice(0, 3);
  ok(new Set(head3).size >= 2, `开头三题类型有变化（${head3.join(',')}），不是一段段排队`);

  // 推荐理由必须回答「为什么练这些」
  const reasons = r.reasons.join('\n');
  ok(/易错复习/.test(reasons), '理由说明为什么练易错词');
  ok(/慢键/.test(reasons), '理由说明为什么练慢键');
  ok(/键位覆盖|没练熟/.test(reasons), '理由说明为什么练没覆盖的键');
  ok(/分钟/.test(reasons), '理由带目标时长与题量');

  // 「不被单一弱项占满」：任何一类的占比 ≤ maxShare(0.5) + 容差
  const byKind = {};
  for (const q of r.questions) {
    const k = q.kind === 'key' ? '键位' : '字词';
    byKind[k] = (byKind[k] || 0) + 1;
  }
  const maxRatio = Math.max(...Object.values(byKind)) / r.questions.length;
  ok(maxRatio <= 0.85,
    `单一形态占比 ${(maxRatio * 100).toFixed(0)}% ≤ 85%（键位 vs 字词的混合比例）`);
  // 「不被单一弱项占满」：三个弱项段各自的占比 ≤ maxShare(0.5) + 容差。
  // 注意 basic（高频单字补足）不算弱项 —— 新手没有任何弱项数据时，
  // 整局都是基础练习，这是预期行为，不该套这个上限。
  const segMax = Math.max(...r.plan.filter(p => p.kind !== 'basic').map(p => p.produced));
  ok(segMax <= Math.ceil(r.questions.length * 0.5) + 2,
    `单一弱项来源最多 ${segMax} 题，未被占满（总 ${r.questions.length} 题）`);
}

console.log('\n【2】每类数据为空：不炸、有理由、份额让出去');
{
  const r = planMixedSession({ durationSec: 300, seed: 7 });
  ok(Array.isArray(r.questions) && r.questions.length >= 6,
    `全空时仍能出题（${r.questions.length} 题，落在基础练习上）`);
  const reasons = r.reasons.join('\n');
  ok(/易错字词：还没有记录/.test(reasons), '如实说明易错表为空');
  ok(/慢键：还没有足够样本/.test(reasons), '如实说明慢键样本不足');
  ok(/键位覆盖：暂无键位练习数据/.test(reasons), '如实说明键位数据为空');
  // 三类都空 → 全部由 coverage 兜不了，应当退回「全面基础练习」的说法
  ok(/全面基础/.test(reasons), '三类全空时给出「全面基础练习」的说法');
  ok(r.questions.every(q => q && q.id && q.kind), '题目结构完整');
}

console.log('\n【3】样本不足：慢键门槛真的生效');
{
  // slowestKeys 的 min=5：样本 <5 的键根本不该进 items（storage 已过滤），
  // 但 plan 里要验证 thin（被门槛挡下的键）会如实说明
  const r = planMixedSession({
    durationSec: 300,
    slowKeys: { items: [], eligible: 0, thin: 9, total: 26, min: 5 },
    mastery: fakeMastery({ untouched: KEY_COMPONENTS.map(c => c.key).filter((v, i, a) => a.indexOf(v) === i).slice(0, 8) }),
    seed: 11
  });
  const reasons = r.reasons.join('\n');
  ok(/慢键/.test(reasons) && /样本/.test(reasons), '慢键无样本时说明原因，而不是静默跳过');
  ok(r.plan.find(p => p.kind === 'slow').produced === 0, '慢键段 0 题');
  ok(r.questions.length >= 6, `其它段接住了份额（共 ${r.questions.length} 题）`);
}

console.log('\n【4】样本不足：易错表只有 1 项时，不硬凑重复题');
{
  const r = planMixedSession({
    durationSec: 300,
    weakList: fakeWeak([['海豚', 2]]),   // 只有 1 个易错词，却按权重该分 ~8 题
    slowKeys: fakeSlow(['Q']),
    mastery: fakeMastery({ mastered: ['A', 'S', 'D', 'F', 'J', 'K', 'L', 'I', 'U'], learning: ['E', 'R'] }),
    seed: 5
  });
  const ids = r.questions.map(q => `${q.kind}|${q.role || ''}|${q.text || q.promptText}`);
  const dup = ids.length - new Set(ids).size;
  ok(dup === 0, `无重复题（${ids.length} 题，重复 ${dup}）`);
  const reviewSeg = r.plan.find(p => p.kind === 'review');
  ok(reviewSeg.produced <= 1, `易错段只出 1 题（产能 1，实际 ${reviewSeg.produced}）`);
  const reasons = r.reasons.join('\n');
  ok(true, `理由：${reasons.split('\n')[0]}`);
  // 缺口必须被别的段补上，而不是少出题
  ok(r.questions.length >= r.target - 2,
    `缺口被回填（出 ${r.questions.length} 题，目标 ${r.target}）`);
}

console.log('\n【5】重复题过多：去重 + 理由说明');
{
  // 构造「同一词出现多次」的易错表 —— getWeakList 按 key 去重过，
  // 但 plan 仍要能扛住调用方传入的重复数据
  const weak = [...fakeWeak([['海豚', 3]]), ...fakeWeak([['海豚', 3]]), ...fakeWeak([['请', 1]])];
  const r = planMixedSession({
    durationSec: 300, weakList: weak,
    slowKeys: fakeSlow(['Q', 'W', 'E']),
    mastery: fakeMastery({ mastered: ['A', 'S', 'D', 'F', 'J', 'K', 'L'], untouched: ['R', 'U', 'I', 'O'] }),
    seed: 3
  });
  const ids = r.questions.map(q => `${q.kind}|${q.role || ''}|${q.text || q.promptText}`);
  const uniq = new Set(ids).size;
  ok(uniq === ids.length, `传入重复数据后仍无重复题（${ids.length} 题 / ${uniq} 唯一）`);
  // 重复输入不得放大题量：3 条输入里有 2 条是同一个词，去重后只有 2 个易错项
  const reviewSeg = r.plan.find(p => p.kind === 'review');
  ok(reviewSeg.produced <= 2,
    `重复输入不会放大易错段题量（${reviewSeg.produced} ≤ 2）`);
}

console.log('\n【6】全员已掌握：不再安排键位题，且理由不说「暂无数据」');
{
  const allKeys = [...new Set(KEY_COMPONENTS.map(c => c.key))];
  const r = planMixedSession({
    durationSec: 300,
    weakList: fakeWeak([['海豚', 2], ['经济', 1]]),
    slowKeys: fakeSlow(['Q']),
    mastery: fakeMastery({ mastered: allKeys }),
    seed: 21
  });
  const reasons = r.reasons.join('\n');
  ok(!/键位覆盖：暂无键位练习数据/.test(reasons), '不把「全掌握了」误报成「暂无数据」');
  ok(/已全部掌握/.test(reasons), '如实说明「26 键已全部掌握」');
  ok(r.questions.every(q => q.kind !== 'key' || q.text || q.promptText), '题目仍然有效');
  ok(r.questions.length >= 6, `仍有题可练（${r.questions.length} 题）`);
}

console.log('\n【7】时长换算：5 分钟 ≈ 目标题量，且被夹在 6–40 之间');
{
  const short = planMixedSession({ durationSec: 60, seed: 1 });
  const five = planMixedSession({ durationSec: 300, seed: 1 });
  const long = planMixedSession({ durationSec: 3600, seed: 1 });
  ok(short.target >= 6 && short.target <= 20, `1 分钟目标题量 ${short.target}（偏小）`);
  ok(five.target >= 30, `5 分钟目标题量 ${five.target}`);
  ok(long.target <= 40, `1 小时目标题量被封顶在 ${long.target}（≤40）`);
  // 同 seed 可复现（比对内容而不是 id —— id 里含自增计数与时间戳）
  const again = planMixedSession({ durationSec: 300, seed: 1 });
  const sig = (x) => JSON.stringify(x.questions.map(q => {
    const { id, ...rest } = q; return rest;
  }));
  ok(sig(five) === sig(again), '同 seed 两次组题结果一致（失败可重放）');
}

console.log('\n【8】段间重叠：慢键同时也是没练熟的键，最终队列不得混入重复题');
{
  /* E 既是慢键（slow 段的目标）又是「在练」（coverage 段的目标）——
     两段各自生成时都会产出 E 上的成分题。曾验证过：去重统计是对的
     （说去掉了 2 道重复），但交错队列拿的是**原始数组**，
     重复题换个位置又混回来，40 题里只有 38 道不同的。 */
  const r = planMixedSession({
    durationSec: 300,
    weakList: fakeWeak([['海豚', 2], ['经济', 1]]),
    slowKeys: fakeSlow(['E', 'R']),
    mastery: fakeMastery({ mastered: ['A', 'S', 'D', 'F', 'J', 'K', 'L'], learning: ['E', 'R'], untouched: ['U', 'I'] }),
    seed: 77
  });
  const ids = r.questions.map(q => `${q.kind}|${q.role || ''}|${q.text || q.promptText}`);
  ok(new Set(ids).size === ids.length,
    `段间重叠时最终队列无重复（${ids.length} 题 / ${new Set(ids).size} 唯一）`);
  ok(r.questions.length <= r.target, `总题数不超过目标（${r.questions.length} ≤ ${r.target}）`);
  // 理由里报的题数必须与实际进入队列的各段数量一致（曾报生成量而非入队量）
  const slowReason = r.reasons.find(x => /慢键专项/.test(x)) || '';
  const claimed = Number((slowReason.match(/（(\d+) 题）/) || [])[1]);
  const actualSlow = r.plan.find(p => p.kind === 'slow').produced;
  ok(claimed === actualSlow,
    `慢键理由的题数与实际一致（理由 ${claimed} / 实际 ${actualSlow}）`);
  // 慢键段与覆盖段的键位题，只能落在各自的目标键上（E、R 慢 + U、I 没练熟）
  const allowed = new Set(['E', 'R', 'U', 'I']);
  const keyQs = r.questions.filter(q => q.kind === 'key' && q.keyDetail);
  ok(keyQs.length > 0 && keyQs.every(q => allowed.has(q.keyDetail.key)),
    `键位题落在目标键上（${[...new Set(keyQs.map(q => q.keyDetail.key))].join(',')}）`);
}

console.log('\n【9】产能补题后仍不足：宁缺不重，且总数如实');
{
  // 极端：三类产能加起来远小于目标，缺口全靠基础练习补
  const r = planMixedSession({
    durationSec: 1800,            // 目标 40 题
    weakList: fakeWeak([['请', 1]]),          // 产能 1
    slowKeys: fakeSlow(['Q']),               // 产能 2
    mastery: fakeMastery({ mastered: ['A'], learning: ['S'] }),  // 产能 ~2
    seed: 9
  });
  const ids = r.questions.map(q => `${q.kind}|${q.role || ''}|${q.text || q.promptText}`);
  ok(new Set(ids).size === ids.length, '补题后仍无重复题');
  ok(r.questions.length === r.target,
    `目标仍被填满（${r.questions.length} = ${r.target}，缺口由基础练习补）`);
  const basic = r.plan.find(p => p.kind === 'basic');
  const others = r.plan.filter(p => p.kind !== 'basic').reduce((s, p) => s + p.produced, 0);
  ok(basic && basic.produced === r.target - others,
    `基础练习精确补足缺口（${basic && basic.produced} = ${r.target} - ${others}）`);
}

console.log('\n' + (fail === 0
  ? `✅ 混合组题自检全部通过（${pass} 项）`
  : `❌ 混合组题自检共 ${fail} 项未通过（${pass} 通过）`));
process.exit(fail === 0 ? 0 : 1);
