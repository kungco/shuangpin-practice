/**
 * 智能混合练习：一键把「易错字词 + 慢键 + 没练过的键位成分」组成一套题。
 * ------------------------------------------------------------
 * 为什么单独一个文件：组题逻辑要被两处消费（主界面的「练 5 分钟」按钮、
 * 以及测试），而且它必须**可测** —— 三个数据源各有「为空 / 样本不足 /
 * 重复」的边界，验收标准明确要求这些情况都有断言。纯函数、不碰 DOM。
 *
 * 【三类来源，各有明确的数据出处】
 *   review    易错字词 —— storage.getWeakList()（间隔重复队列，到期优先）
 *   slow      慢键     —— storage.slowestKeys(loadKeyTimings())（中位数最慢的一批）
 *   coverage  键位覆盖 —— stats.keyMastery() 里还没「已掌握」的键（untouched+learning）
 *
 * 【分配原则】
 *   · 按权重 4:3:3 分配题量，但任何一类不得超过 maxShare（默认 50%）——
 *     验收要求「题目不会被单一弱项占满」：错 20 次的字不该把整局变成它的复读机。
 *   · 某类数据为空 / 样本不足时，它的份额按比例还给其它类，而不是凭空凑数。
 *   · 每类的实际产能有上限（易错项就那么几个、慢键就那几把），分配不得超过产能；
 *     产能富余的类接住多出来的份额。
 *   · 生成后再按题目身份去重；因去重 / 产能不足产生的缺口，由还有产能的类补齐。
 *
 * 【推荐理由】返回的 reasons 是给人看的一句话列表，必须能回答「为什么练这些」，
 *   也要说明「为什么没练那些」（数据为空 / 样本不足时如实说明，不装作没有）。
 */
import { generateQuestions, generateReviewQuestions, KEY_COMPONENTS } from './questions.js';

/** 默认各来源的份额。加起来是 1；错词最多，因为它是最直接的「不会」。 */
const DEFAULT_WEIGHTS = { review: 0.4, slow: 0.3, coverage: 0.3 };

/** 一道题的去重身份。key 类题同一成分不该重复出现，字词题同字同理。 */
function questionId(q) {
  if (!q) return '';
  return `${q.kind || ''}|${q.role || ''}|${q.text || q.promptText || ''}|${q.part || ''}`;
}

/** 一个键上挂着几个键位成分（如 H 键 = 韵母 ang；V 键 = 声母 zh） */
function componentsOfKey(key) {
  const K = String(key || '').toUpperCase();
  return KEY_COMPONENTS.filter(c => String(c.key).toUpperCase() === K);
}

/** 把「除这些键以外的全部成分」标成已用 —— pickUnused 就只会从剩下的键里抽 */
function usedSetExcluding(excludeKeys) {
  const hide = new Set((excludeKeys || []).map(k => String(k).toUpperCase()));
  const used = new Set();
  for (const c of KEY_COMPONENTS) {
    if (!hide.has(String(c.key).toUpperCase())) used.add(`${c.role}:${c.part}`);
  }
  return used;
}

/** 把「这些键以外的全部成分」标成已用（用于只练这些键） */
function usedSetOnly(onlyKeys) {
  const keep = new Set((onlyKeys || []).map(k => String(k).toUpperCase()));
  const used = new Set();
  for (const c of KEY_COMPONENTS) {
    if (!keep.has(String(c.key).toUpperCase())) used.add(`${c.role}:${c.part}`);
  }
  return used;
}

/**
 * 把 target 道题按权重分给各段，受 maxShare 与各段产能约束。
 *
 * @returns {Promise<{alloc:Object, skipped:Object}>} alloc: 每段分到的题量
 *   skipped: 每段被跳过的原因（给 reasons 用）；没有跳过就没有键。
 */
function allocate({ target, weights, capacity, maxShare }) {
  const names = Object.keys(weights);
  const alloc = {};
  const skipped = {};

  // ① 产能为 0 的段直接跳过，并把它的权重从池子里拿掉
  const live = {};
  let liveWeight = 0;
  for (const n of names) {
    if ((capacity[n] || 0) <= 0) {
      skipped[n] = capacityReason(n);
      alloc[n] = 0;
    } else {
      live[n] = weights[n];
      liveWeight += weights[n];
      alloc[n] = 0;
    }
  }
  if (liveWeight <= 0) return { alloc, skipped };

  // ② 按权重分配（向上取整，避免 0.4*20=8.00000004 被地板成 7）
  let assigned = 0;
  for (const n of Object.keys(live)) {
    const raw = target * (live[n] / liveWeight);
    const capped = Math.min(raw, target * maxShare);
    alloc[n] = Math.min(capacity[n], Math.ceil(capped));
    assigned += alloc[n];
  }

  // ③ 份额还没分完（被 cap / 产能压掉了）→ 按剩余产能补给其它段
  let guard = 0;
  while (assigned < target && guard++ < 8) {
    let moved = false;
    // 优先补给「还没到 maxShare 上限」的段，保持「不单一占满」的承诺
    const order = Object.keys(live).sort((a, b) => (alloc[a] / capacity[a]) - (alloc[b] / capacity[b]));
    for (const n of order) {
      if (assigned >= target) break;
      if (alloc[n] >= capacity[n]) continue;
      if (alloc[n] >= target * maxShare) continue;
      alloc[n]++; assigned++; moved = true;
    }
    if (!moved) {
      // 所有段都到了上限还没分完 → 放开上限，按产能余量补（有总比缺强）
      for (const n of order) {
        if (assigned >= target) break;
        if (alloc[n] >= capacity[n]) continue;
        alloc[n]++; assigned++; moved = true;
      }
    }
    if (!moved) break;   // 全部产能用尽，就到这里
  }
  return { alloc, skipped };
}

function capacityReason(name) {
  switch (name) {
    case 'review': return '易错字词：还没有记录，等练出错了这里会自动出题';
    case 'slow': return '慢键：还没有足够样本（同一键至少 5 次作答才好比较快慢）';
    case 'coverage': return '键位覆盖：暂无键位练习数据';
    default: return '';
  }
}

/**
 * 组一套混合练习。
 *
 * @param {object} opts
 * @param {number} [opts.durationSec=300]   目标时长（秒）。换算成题量：键位题约 2s、
 *                                          字词题约 5s，混合按 6s/题估。
 * @param {Array}  [opts.weakList]          getWeakList() 的结果（可为空）
 * @param {object} [opts.slowKeys]          slowestKeys() 的结果（可为 null）
 * @param {object} [opts.mastery]           keyMastery() 的结果（可为 null）
 * @param {number} [opts.maxShare=0.5]      单一来源的最大占比
 * @param {number} [opts.seed]              固定种子（测试复现用）
 * @param {Function} [opts.rng]             自带随机源
 * @returns {{questions:Array, reasons:string[], plan:Array, target:number}}
 */
export function planMixedSession(opts = {}) {
  const durationSec = Math.max(30, Number(opts.durationSec) || 300);
  const maxShare = Math.min(1, Math.max(0.1, Number(opts.maxShare) || 0.5));
  const weakList = Array.isArray(opts.weakList) ? opts.weakList : [];
  const slowKeys = opts.slowKeys || null;
  const mastery = opts.mastery || null;
  const seedOpts = {};
  if (typeof opts.rng === 'function') seedOpts.rng = opts.rng;
  else if (opts.seed != null && Number.isFinite(Number(opts.seed))) seedOpts.seed = Number(opts.seed);

  // 题量估算：混合了 1 键的键位题与 2~8 键的字词题，按 6s/题 折中。
  // 上限 40：一次塞太多，进度条与「已完成 N 字」都会变得没有反馈感。
  const target = Math.max(6, Math.min(40, Math.round(durationSec / 6)));

  /* ---- 各段的产能（能出的最大题量） ---- */
  const slowKeyNames = (slowKeys && Array.isArray(slowKeys.items))
    ? slowKeys.items.map(it => it.key) : [];
  const slowCapacity = slowKeyNames.reduce((sum, k) => sum + componentsOfKey(k).length, 0);

  const masteredKeys = (mastery && Array.isArray(mastery.items))
    ? mastery.items.filter(it => it.state === 'mastered').map(it => it.key) : [];
  const todoKeys = (mastery && Array.isArray(mastery.items))
    ? mastery.items.filter(it => it.state !== 'mastered').map(it => it.key) : [];
  const coverageCapacity = todoKeys.reduce((sum, k) => sum + componentsOfKey(k).length, 0);
  // 全部键都已掌握时，覆盖段没有明确目标 → 让它做一轮全覆盖（capacity 视作 0，
  // 由「全员掌握」的 reason 说明），避免无意义地把整局变成键位复读。
  const allMastered = (mastery && mastery.total > 0 && mastery.counts
    && mastery.counts.untouched === 0 && mastery.counts.learning === 0);

  const capacity = {
    review: Math.min(weakList.length, 20),
    slow: slowCapacity,
    coverage: allMastered ? 0 : coverageCapacity
  };

  const { alloc, skipped } = allocate({
    target, weights: DEFAULT_WEIGHTS, capacity, maxShare
  });
  // 「全员已掌握」与「暂无数据」是两回事，理由不能都写成「暂无数据」
  if (allMastered) {
    skipped.coverage = '键位覆盖：26 个键已全部掌握，本轮不再安排键位题';
  }

  /* ---- 逐段生成 ---- */
  const parts = {};    // segment -> questions[]（原始产物，仅供去重）
  // 理由的「描述部分」在生成时记录，题数留到去重后填 ——
  // 理由里必须报**最终真的进了队列**的数量，而不是生成器吐出来多少
  const segDesc = {};

  if (alloc.review > 0) {
    parts.review = generateReviewQuestions(weakList, alloc.review, seedOpts);
    segDesc.review = {
      head: '易错复习',
      detail: weakList.slice(0, 3)
        .map(w => `「${w.word || w.char}」${w.count > 1 ? `错 ${w.count} 次` : '错过 1 次'}`)
        .join('、')
        + (weakList.length > 3 ? ` 等 ${weakList.length} 个易错项` : '')
    };
  }
  if (alloc.slow > 0) {
    const used = usedSetExcluding(slowKeyNames);
    parts.slow = generateQuestions({
      mode: 'keymap', count: alloc.slow,
      /* 键位题走的是 ctx.usedKeys（makeKeymapQuestion 里的去重集合），
         字词题走 ctx.used —— 两个名字必须都指到同一个集合，
         否则这里塞进去的「已见过」标记根本不会被读到，
         键位题就会从全池里抽，跟其它段撞题（第一次实现时踩到）。 */
      context: { used, usedKeys: used }, ...seedOpts
    });
    segDesc.slow = {
      head: '慢键专项',
      detail: `${slowKeyNames.join('、')} 是当前最慢的键（各至少 ${slowKeys.min} 次作答）`
    };
  }
  if (alloc.coverage > 0) {
    const used = usedSetOnly(todoKeys);
    parts.coverage = generateQuestions({
      mode: 'keymap', count: alloc.coverage,
      context: { used, usedKeys: used }, ...seedOpts
    });
    const shown = todoKeys.slice(0, 6).join('、');
    segDesc.coverage = {
      head: '键位覆盖',
      detail: `还有 ${mastery.counts.untouched + mastery.counts.learning} 个键没练熟` +
        (shown ? `（${shown}${todoKeys.length > 6 ? '…' : ''}）` : '')
    };
  }

  /* ---- 去重 ----
     产能是按「成分数 / 易错项数」估的，但生成器可能因为去重集合、
     候选池等原因少给（比如易错表里 1 项却要 5 题）。缺口交给基础练习，
     **绝不放宽去重** —— 同一个词反复出是这套组题最不能犯的错。
     注意：去重后**按段保留**进 kept，最终队列只用 kept ——
     早先的实现去重完又拿原始数组交错，重复题换个位置就混回来了
     （慢键段和覆盖段的键重叠时必现，40 题里混着 2 道重复）。 */
  const seen = new Set();
  let picked = 0;       // 去重后的总题数
  let dupSkipped = 0;   // 因重复被跳过的题数（理由里要说明）
  const kept = { review: [], slow: [], coverage: [], basic: [] };
  const takeUnique = (arr, want, bucket) => {
    let taken = 0;
    for (const q of arr || []) {
      if (taken >= want) break;
      const id = questionId(q);
      if (!id) continue;
      if (seen.has(id)) { dupSkipped++; continue; }
      seen.add(id);
      kept[bucket].push(q);
      taken++; picked++;
    }
    return taken;
  };

  const order = ['review', 'slow', 'coverage'];
  const produced = {};
  for (const name of order) produced[name] = takeUnique(parts[name], alloc[name], name);

  /* ---- 缺口由基础练习补足 ----
     弱项样本不足以填满目标时长时（新手最常见的状态：还没错几个字），
     用高频单字把 5 分钟补满，而不是缩短练习或硬凑重复题。
     基础题不算「弱项」，所以不参与「单一弱项不得占满」的约束。 */
  const deficit = target - picked;
  if (deficit > 0) {
    const basicRaw = generateQuestions({
      mode: 'char', count: deficit, charTier: 1, ...seedOpts
    });
    takeUnique(basicRaw, deficit, 'basic');
  }

  /* ---- 交错排列 ----
     三类题按轮转穿插，而不是一段打完再打下一段：同类题连着来会显得单调，
     且把最难的易错词全排在开头，第一分钟就把人劝退。
     队列只用去重后的 kept，不是原始的 parts。 */
  const queues = ['review', 'slow', 'coverage', 'basic'].map(n => kept[n].slice());
  const questions = [];
  let idx = 0;
  while (questions.length < picked && idx < 1000) {
    const q = queues[idx % queues.length].shift();
    idx++;
    if (q) questions.push(q);
    if (queues.every(a => !a.length)) break;
  }

  /* ---- 推荐理由 ----
     题数用 kept（最终真的进了队列的），不是生成器吐出来的原始数量。 */
  const reasons = [];
  for (const name of order) {
    if (segDesc[name]) reasons.push(`${segDesc[name].head}（${kept[name].length} 题）：${segDesc[name].detail}`);
    if (skipped[name]) reasons.push(skipped[name]);
  }
  if (kept.basic.length) {
    const allEmpty = order.every(n => skipped[n]);
    reasons.push(allEmpty
      ? `基础练习（${kept.basic.length} 题）：暂无易错字词、慢键与键位数据，先做一轮全面基础练习`
      : `基础练习（${kept.basic.length} 题）：弱项样本还不够填满这段时间，用高频单字补足 —— 练满比凑数重要`);
  }
  if (dupSkipped > 0) {
    reasons.push(`已去掉 ${dupSkipped} 道重复题，换成其它类型的练习`);
  }
  if (!reasons.length) {
    reasons.push('暂无易错字词、慢键与键位数据，先做一轮全面基础练习');
  }
  reasons.push(`目标约 ${Math.round(durationSec / 60)} 分钟（${questions.length} 题，打到时间或打完为止）`);

  const plan = order.map(name => ({
    kind: name,
    capacity: capacity[name] || 0,
    allocated: alloc[name] || 0,
    produced: produced[name] || 0,
    skipped: skipped[name] || null
  }));
  if (kept.basic.length) {
    plan.push({
      kind: 'basic', capacity: kept.basic.length,
      allocated: kept.basic.length, produced: kept.basic.length, skipped: null
    });
  }

  return { questions, reasons, plan, target };
}
