/**
 * 错误热力图
 * ------------------------------------------------------------
 * 从 main.js 拆出来的视图。main.js 只负责在「视图构造区」里实例化它。
 *
 * 【为什么是工厂函数 + ctx，而不是顶层导出】
 * 这段代码用到 `app` / `escapeHtml` / `startSession` / `toast` 等 main.js 的共享设施。
 * 顶层导出会形成循环依赖（main.js 又要 import 本模块），所以由 main.js
 * 把依赖作为 ctx 传进来。
 *
 * 【为什么函数体没有缩进】
 * 段内有跨行模板字符串（拼 HTML）。搬进工厂后按理该缩进两格，但
 * **模板字符串内部的行一旦缩进，字符串内容就变了**（生成的 HTML 会多出空格）。
 * 为保「逐字节等价搬运」，这里刻意保持原缩进。改动本文件时请沿用这个约定。
 */

export function createHeatmapView(ctx) {
  const {
    $,
    $$,
    app,
    escapeHtml,
    startSession,
    toast,
    keyMastery,
    keyHeatmap,
    keySlowness,
    KEY_SLOW_MIN_SAMPLES,
    keyConfusionRanking,
    confusionPairs,
    discriminationDrills,
    CONFUSION_MIN_COUNT,
    getKeymapData,
    renderKeymap
  } = ctx;

  /**
   * 在统计页渲染键位热力图。
   *
   * 与「易错字词表」是互补的两种视角：
   *   字词表 —— 哪些字我不会（语义层，颗粒度=字）
   *   热力图 —— 哪些键我不熟（肌肉层，颗粒度=键）
   * 后者能暴露字词表看不到的问题：某个键你其实一直在绕开，
   * 所以「错误率」低，但恰恰是它拖慢了整体速度。
   */
  function renderHeatmap() {
    const wrap = $('#heatWrap');
    if (!wrap) return;

    try {
      const heat = keyHeatmap({ range: app.stats.heatRange, mode: app.stats.mode });

      /* 范围 chip 高亮 */
      $$('#heatRangeChips .chip').forEach(c =>
        c.classList.toggle('is-active', c.getAttribute('data-range') === app.stats.heatRange));

      /* 首次渲染时创建独立键位图（与练习页 / 键位图页互不影响） */
      if (!app.heatKeymap) {
        app.heatKeymap = renderKeymap(wrap, {});
      }

      if (!heat.items.length) {
        app.heatKeymap.clearHeat();
        const summary = $('#heatSummary');
        if (summary) summary.innerHTML = '';
        const top = $('#heatTop');
        if (top) {
          top.innerHTML = `<div class="empty-state" style="padding:22px">
          <strong>还没有键位错误数据</strong>
          完成练习后，按错的键会以热力色的深浅显示在这里 —— 颜色最深的键就是最该补的地方。
        </div>`;
        }
        /* 慢键层与热力层**独立**：没有错误数据不代表没有耗时数据，
           一并 return 会把「按得慢但一直按对」的用户也显示成「什么都没有」。
           掌握度层同理 —— 它靠 timings 也能算出「已掌握」。
           辨析层同样独立 —— 它自己那张表，与前两层互不影响。 */
        app.heatKeymap.clearSlow();
        renderSlowLayer();
        renderMasteryLayer();
        renderConfusionLayer();
        return;
      }

      app.heatKeymap.setHeat(heat.items);
      renderSlowLayer();
      renderMasteryLayer();
      renderConfusionLayer();

      /* 概览文字 */
      const summary = $('#heatSummary');
      if (summary) {
        const hot = heat.hottest;
        // 选中了某个模式、但该模式还没有专属数据（老记录没存模式）时，
        // 实际显示的是全量。必须说出来，否则「筛选看起来生效了其实没有」。
        const fallback = app.stats.mode !== 'all' && !heat.byMode
          ? '<span class="heat-fallback-note">该模式暂无专属数据，此处仍为全部模式累计</span>'
          : '';
        summary.innerHTML =
          `共 <b>${heat.total}</b> 次按键错误，涉及 <b>${heat.items.length}</b> 个键` +
          (hot ? `　最集中：<b>${escapeHtml(hot.key)}</b> 键（${hot.count} 次）` : '') + fallback;
      }

      /* TOP 排行 */
      const top = $('#heatTop');
      if (top) {
        top.innerHTML = heat.items.slice(0, 8).map(it => {
          const info = keyMeaning(it.key);
          return `<span class="heat-chip">
          <span class="heat-chip-k">${escapeHtml(it.key)}</span>
          <span class="heat-chip-c">${it.count} 次</span>
          <span class="heat-chip-m">${escapeHtml(info)}</span>
        </span>`;
        }).join('');
      }
    } catch (err) {
      console.error('[heatmap] 渲染失败', err);
      wrap.innerHTML = '<div class="empty-state">热力图渲染失败</div>';
      app.heatKeymap = null;
    }
  }

  /**
   * 慢键层：把「按得慢」的键以虚线环叠在同一张键盘图上。
   *
   * 与热力层共用一张图但用不同通道（热力=填充、慢键=虚线环），所以两个诊断
   * 能同时看：「又错又慢」的键既有橙色填充又有蓝色环，那是最该练的键。
   */
  function renderSlowLayer() {
    const box = $('#slowKeysBox');
    if (!box || !app.heatKeymap) return;
    try {
      const slow = keySlowness({ range: app.stats.heatRange, mode: app.stats.mode });
      app.heatKeymap.setSlow(slow.items);

      if (!slow.items.length) {
        box.innerHTML = slow.thin
          ? `<div class="slow-legend-note">慢键：另有 ${slow.thin} 个键的样本不足
             ${KEY_SLOW_MIN_SAMPLES} 次，暂不显示。再练几轮就能标出。</div>`
          : '<div class="slow-legend-note">慢键：还没有足够的按键耗时数据。完成几轮练习后，'
            + '「按对但犹豫」的键会用蓝色虚线环标在这里。</div>';
        return;
      }
      const top = slow.items.slice(0, 8);
      box.innerHTML = `
      <div class="slow-legend">
        <span class="slow-legend-title">慢键（按对但犹豫）</span>
        ${top.map(it => `<span class="slow-chip">
            <span class="slow-chip-k">${escapeHtml(it.key)}</span>
            <span class="slow-chip-c">${(Math.round(it.medianMs) / 1000).toFixed(2)}s</span>
          </span>`).join('')}
      </div>
      <div class="slow-legend-note">
        取<b>中位数</b>，只统计不含读字时间的纯运动按键时间；
        整体中位数 <b>${(Math.round(slow.overall) / 1000).toFixed(2)}s</b>，
        环越粗表示越慢。${slow.thin ? `另有 ${slow.thin} 个键样本不足 ${KEY_SLOW_MIN_SAMPLES} 次未显示。` : ''}
      </div>`;
    } catch (err) {
      console.error('[slowkeys] 渲染失败', err);
      box.innerHTML = '';
      try { app.heatKeymap.clearSlow(); } catch (_) {}
    }
  }

  /**
   * 掌握度层：在统计页的键盘图上标出「哪些键已经练熟、哪些还没碰过」。
   *
   * 第三个诊断层，与热力（红填充 = 按错）、慢键（蓝环 = 按得慢）共用一张图。
   * 回答的是最朴素的那个问题：**「这 26 个键，我到底掌握了几个？」**
   * 前两层只能告诉你「哪里还有问题」，这一层第一次给出**进度感**——
   * 绿点一个个亮起来，是这类练习应用里唯一真正给人成就的东西。
   */
  function renderMasteryLayer() {
    const box = $('#masteryBox');
    if (!box || !app.heatKeymap) return;
    try {
      const m = keyMastery({ range: app.stats.heatRange, mode: app.stats.mode });
      app.heatKeymap.setMastery(m.items);

      const { mastered, learning, untouched } = m.counts;
      if (untouched === m.total) {
        box.innerHTML = `<div class="mastery-legend">掌握度：还没有练习数据。
        练过的键会显示为「在练」，连续答对且不慢的键会亮起<b>绿色圆点</b>表示已掌握。</div>`;
        return;
      }

      // 还差一点的键（在练、且样本少于门槛的）—— 给出「再练 N 次」的量化指引
      const close = m.items.filter(it => it.state === 'learning' && it.need > 0 && it.practice > 0)
        .slice(0, 8);

      box.innerHTML = `
      <div class="mastery-legend">
        <span class="mastery-stat"><b class="mastery-num">${mastered}</b> / ${m.total} 个键已掌握</span>
        <span class="mastery-stat">在练 <b>${learning}</b></span>
        <span class="mastery-stat">没碰过 <b>${untouched}</b></span>
        ${m.byMode || app.stats.mode === 'all' ? '' :
          '<span class="heat-fallback-note">该模式暂无专属数据，此处为全部模式累计</span>'}
      </div>
      ${close.length ? `<div class="mastery-legend" style="margin-top:4px">
          <span class="mastery-stat">离掌握最近：</span>
          ${close.map(it => `<span class="slow-chip">
          <span class="slow-chip-k">${escapeHtml(it.key)}</span>
          <span class="slow-chip-c">再练 ${it.need} 次</span>
        </span>`).join('')}
        </div>` : ''}
      <div class="mastery-legend" style="margin-top:4px">
        判定「已掌握」需同时满足：按对 <b>${m.minSamples}</b> 次以上、
        错误率 ≤ 8%、且不慢于整体中位数的 1.3 倍 ——
        「每次都要想一秒才按对」算不得掌握，那是还没形成肌肉记忆。
      </div>`;
    } catch (err) {
      console.error('[mastery] 渲染失败', err);
      box.innerHTML = '';
      try { app.heatKeymap.clearMastery(); } catch (_) {}
    }
  }

  /**
   * 错键辨析层：把「想按 G 却按成 K」这种**有向混淆**聚成键对，并给出一键开练。
   *
   * 与前三层的关系：
   *   keyHeatmap  → 「K 错了 12 次」（处方：多练 K）
   *   keySlowness → 「K 按得慢」（处方：放慢、练手感）
   *   keyMastery  → 「K 掌握了没有」（进度感）
   *   **本层**    → 「G 按成了 K 8 次」（处方：把 G/K 拎出来二选一辨析）
   * 只有这一层能直接变成一组题 —— 前三层都只能告诉你「哪里弱」，
   * 说不出「怎么练」。这正是用户提这条需求的原话：「能进一步告诉用户具体该怎么练」。
   */
  function renderConfusionLayer() {
    const box = $('#confusionBox');
    if (!box) return;
    try {
      const rank = keyConfusionRanking({ range: app.stats.heatRange, mode: app.stats.mode, limit: 0 });
      const pairs = confusionPairs({ range: app.stats.heatRange, mode: app.stats.mode });

      if (!rank.total) {
        box.innerHTML = `
        <div class="slow-legend">
          <span class="slow-legend-title">错键辨析</span>
        </div>
        <div class="slow-legend-note">
          还没有可分析的错键数据。练习中按错时，应用会记下<b>你本想按哪个键、实际按成了哪个键</b>，
          攒够几组后这里会指出「这两个键容易混」，并生成只考这两个键的辨析小练习。
        </div>`;
        return;
      }

      // 够格的键对才给「开练」按钮 —— 偶发一次手滑不值得专门练
      const eligiblePairs = pairs.filter(p => p.eligible);
      const topPairs = pairs.slice(0, 6);

      box.innerHTML = `
      <div class="slow-legend">
        <span class="slow-legend-title">错键辨析（本想按 A，按成了 B）</span>
        <span class="heat-fallback-note">共 ${rank.total} 次混淆 · 涉及 ${rank.sessions} 次练习</span>
        ${rank.byMode || app.stats.mode === 'all' ? '' :
          '<span class="heat-fallback-note">该模式暂无专属数据，此处为全部模式累计</span>'}
      </div>
      <div class="confuse-grid">
        ${topPairs.map(p => {
          // 方向：哪个键被「按错成」另一个。用箭头表达有向性，
          // 但标注这个键对整体出现了几次 —— 两个方向合起来才是这一对的问题量。
          const arrow = p.forward && p.backward
            ? `${p.a} ⇄ ${p.b}`
            : (p.forward ? `${p.a} → ${p.b}` : `${p.b} → ${p.a}`);
          return `
              <button class="confuse-card${p.eligible ? '' : ' is-thin'}"
                      data-pair="${escapeHtml(p.pairKey)}"
                      ${p.eligible ? '' : 'disabled aria-disabled="true"'}
                      title="${p.eligible ? '只练这两个键的辨析' : `仅 ${p.count} 次，攒到 ${CONFUSION_MIN_COUNT} 次即可开练`}">
                <span class="confuse-card-pair">${escapeHtml(arrow)}</span>
                <span class="confuse-card-num">${p.count} 次</span>
                <span class="confuse-card-go">${p.eligible ? '开练 →' : `攒到 ${CONFUSION_MIN_COUNT} 次`}</span>
              </button>`;
        }).join('')}
      </div>
      ${eligiblePairs.length ? `
          <div class="confuse-actions">
            <button class="btn btn-primary btn-sm" id="btnConfuseDrill">
              练这 ${eligiblePairs.length} 组混淆（${Math.min(eligiblePairs.length, 3) * 6} 题）
            </button>
          </div>` : `
          <div class="confuse-actions">
            <span class="heat-fallback-note">
              还没有攒够 ${CONFUSION_MIN_COUNT} 次的键对。偶发的手滑不用专门练，再多打几轮就能识别出真正的习惯性混淆。
            </span>
          </div>`}
      <div class="slow-legend-note">
        口径：只记录「<b>本该按的键 → 实际按错的键</b>」这一有向组合；同一对键的两个方向会合并成一组来练
        （「G 按成 K」和「K 按成 G」练的都是 G/K 的区别）。够 ${CONFUSION_MIN_COUNT} 次才建议专项开练 ——
        一次手滑是偶然，反复出现才是习惯。
      </div>`;

      // 单组开练
      box.querySelectorAll('.confuse-card:not(.is-thin)').forEach(card => {
        card.addEventListener('click', () => {
          startConfusionDrill([card.getAttribute('data-pair')]);
        });
      });
      const allBtn = $('#btnConfuseDrill');
      if (allBtn) {
        allBtn.addEventListener('click', () => {
          startConfusionDrill(eligiblePairs.map(p => p.pairKey));
        });
      }
    } catch (err) {
      console.error('[confusion] 渲染失败', err);
      box.innerHTML = '';
    }
  }

  /**
   * 用指定的键对开一局「错键辨析」。
   *
   * 复用现有引擎与 startSession —— 不另造一套出题/判分系统。
   * 题目由 stats.discriminationDrills() 生成，是标准的 key 类题，
   * 引擎照常跑，只是每道题的答案被限制在这一对键里。
   *
   * @param {string[]} pairKeys 形如 ['G|K','D|T'] 的键对标识（空数组 = 用全部够格的）
   */
  function startConfusionDrill(pairKeys) {
    try {
      const all = confusionPairs({ range: app.stats.heatRange, mode: app.stats.mode });
      const wanted = Array.isArray(pairKeys) && pairKeys.length
        ? new Set(pairKeys) : new Set(all.filter(p => p.eligible).map(p => p.pairKey));
      const chosen = all.filter(p => wanted.has(p.pairKey));
      if (!chosen.length) {
        toast(`还没有攒够 ${CONFUSION_MIN_COUNT} 次的混淆键对，再多打几轮`, 'err');
        return;
      }
      // 最多取 3 对（3 × 6 = 18 题）—— 一次练太多对反而每对都练不透
      const { questions } = discriminationDrills(chosen, { perPair: 6, maxPairs: 3, onlyEligible: false });
      if (!questions.length) { toast('暂时生成不出辨析题', 'err'); return; }
      startSession(questions, 'confuse', { durationSec: 0 });
    } catch (err) {
      console.error('[confusion] 开练失败', err);
      toast('无法开始辨析练习：' + (err && err.message ? err.message : '未知错误'), 'err');
    }
  }

  /** 把一个键翻译成「它在方案里代表什么」，让热力图排行能读得懂 */
  function keyMeaning(key) {
    try {
      const d = getKeymapData().find(x => x.key === key);
      if (!d) return '';
      const parts = [];
      if (d.shengmu.length) parts.push(`声母 ${d.shengmu.join('/')}`);
      if (d.yunmu.length) parts.push(`韵母 ${d.yunmu.join('/')}`);
      return parts.join(' · ') || '未使用';
    } catch (_) { return ''; }
  }


  return { renderHeatmap };
}
