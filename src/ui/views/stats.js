/**
 * 统计页面
 * ------------------------------------------------------------
 * 从 main.js 拆出来的视图。main.js 只负责在「视图构造区」里实例化它。
 *
 * 【为什么是工厂函数 + ctx，而不是顶层导出】
 * 这段代码用到 `$` / `$$` / `LEVELS` / `LEVEL_MAP` 等 main.js 的共享设施。
 * 顶层导出会形成循环依赖（main.js 又要 import 本模块），所以由 main.js
 * 把依赖作为 ctx 传进来。
 *
 * 【为什么函数体没有缩进】
 * 段内有跨行模板字符串（拼 HTML）。搬进工厂后按理该缩进两格，但
 * **模板字符串内部的行一旦缩进，字符串内容就变了**（生成的 HTML 会多出空格）。
 * 为保「逐字节等价搬运」，这里刻意保持原缩进。改动本文件时请沿用这个约定。
 */

export function createStatsView(ctx) {
  const {
    $,
    $$,
    LEVELS,
    LEVEL_MAP,
    S,
    app,
    confirmClearStats,
    dailyGoalProgress,
    dailySeries,
    drawBars,
    drawLine,
    escapeHtml,
    exportData,
    formatDuration,
    historySeries,
    relTime,
    renderHeatmap,
    scoreSeries,
    summarize,
    weakRanking
  } = ctx;

  function renderStatsView() {
    try {
      const modeSelect = $('#statsMode');
      if (modeSelect && !modeSelect._bound) {
        modeSelect.innerHTML = '<option value="all">全部模式</option>' + LEVELS.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
        modeSelect._bound = true;
        modeSelect.addEventListener('change', () => { app.stats.mode = modeSelect.value; renderStatsView(); });
      }
      if (modeSelect) modeSelect.value = app.stats.mode;
      const history = S.loadHistory().filter(r => app.stats.mode === 'all' || r.mode === app.stats.mode);
      /* 「全部模式」走不传参的 summarize()：它会用 daily 修正累计值，
         不受「历史只留最近 2000 条」的截断影响（否则练到 2000 局后
         累计字数/时长/次数会停止增长甚至倒退）。
         按模式筛选时只能传数组 —— daily 是**按日期**聚合的，没有按模式拆分，
         拿它去凑某个模式的累计会把别的模式的量也算进来。 */
      const sum = app.stats.mode === 'all' ? summarize() : summarize(history);

      /* ---- 卡片 ---- */
      const cards = $('#statCards');
      if (cards) {
        /* 「今日」这张卡要同时回答两个问题：今天做了多少、离目标还有多远。
           口径必须与练习页 HUD 完全一致 —— 都用 dailyGoalProgress()，
           它内部复用 summarize()，所以数字不会两边打架。
           不设目标时（hasGoal=false）回落到原来的「N 次练习」副标题。 */
        const goal = dailyGoalProgress(app.settings, sum);
        const todaySub = goal.hasGoal
          ? (goal.achieved
              ? `已完成目标（${goal.percent}%）· ${sum.todaySessions} 次练习`
              : goalSubText(goal))
          : `${sum.todaySessions} 次练习`;

        cards.innerHTML = `
        ${statCard('累计练习', sum.sessions, '次', `${sum.totalDays} 个练习日`)}
        ${statCard('累计字数', sum.totalChars, '字', `总时长 ${formatDuration(sum.totalSeconds)}`)}
        ${statCard('平均速度', sum.avgSpeed, '字/分', `最佳 ${sum.bestSpeed} 字/分`)}
        ${statCard('平均正确率', sum.avgAccuracy, '%', `最佳 ${sum.bestAccuracy}%`)}
        ${statCard('连续练习', sum.streakDays, '天', sum.streakDays >= 3 ? '节奏很好' : '坚持就有效果')}
        ${statCard('今日', sum.todayChars, '字', todaySub, goal.hasGoal ? `目标进度 ${goal.percent}%` : '')}
      `;

        // 目标进度条（独立于卡片网格，放在卡片下方）
        const goalBar = $('#todayGoalBar');
        if (goalBar) {
          if (!goal.hasGoal) {
            goalBar.hidden = true;
          } else {
            goalBar.hidden = false;
            goalBar.className = 'today-goal' + (goal.achieved ? ' is-done' : '');
            goalBar.innerHTML = `
            <div class="tg-head">
              <span class="tg-title">今日目标</span>
              <span class="tg-pct">${goal.percent}%</span>
            </div>
            <div class="tg-track"><div class="tg-fill" style="width:${goal.percent}%"></div></div>
            <div class="tg-detail">${escapeHtml(goalDetail(goal))}</div>
          `;
          }
        }
      }

      /* ---- 曲线 ---- */
      const canvas = $('#historyChart');
      if (canvas) {
        const series = historySeries({ range: app.stats.chartRange, metric: app.stats.chartMetric, mode: app.stats.mode });
        drawLine(canvas, series.points, {
          metric: series.metric,
          avg: series.avg,
          height: 260
        });
        /* 读屏替代：canvas 里的像素读屏拿不到，把这张图**说了什么**写进
           aria-label（随重绘更新，与图上数据一致）。空态也要如实说，
           否则读屏用户听到「图像」却不知道是没数据还是加载失败。 */
        canvas.setAttribute('aria-label', series.points.length
          ? `近 ${series.points.length} 轮${series.metric === 'acc' ? '正确率' : '速度'}曲线，均值 ${series.avg}，最低 ${series.min}，最高 ${series.max}`
          : '还没有练习记录，暂无成绩曲线');
        /* 均值线是加权值（速度按练习时长、正确率按完成字数），
           曲线上的点仍是每轮原始值 —— 所以那条线不会等于各点的算术平均。
           差异大时显式说明，免得被当成画错了。 */
        const note = $('#chartAvgNote');
        if (note) {
          const gap = Math.abs(series.avg - series.plainAvg);
          note.textContent = gap >= Math.max(1, Math.abs(series.plainAvg) * 0.02)
            ? `虚线为加权均值 ${series.avg}（${series.metric === 'acc' ? '按完成字数' : '按练习时长'}加权，各点原始值算术平均为 ${series.plainAvg}）`
            : '';
          note.hidden = !note.textContent;
        }
      }

      /* ---- 测验成绩曲线 ----
         分数在落库时就写好了（rec.score），但一直没有这张图。
         跟随上方的区间切换（20/50/全部），与历史曲线共用同一档位。 */
      const scoreCanvas = $('#scoreChart');
      if (scoreCanvas) {
        const ss = scoreSeries({ range: app.stats.chartRange });
        if (ss.points.length) {
          drawLine(scoreCanvas, ss.points, { metric: 'score', avg: ss.avg, height: 220 });
        } else {
          const ctx = scoreCanvas.getContext ? scoreCanvas.getContext('2d') : null;
          if (ctx) {
            scoreCanvas.width = scoreCanvas.width || 920;
            ctx.clearRect(0, 0, scoreCanvas.width, scoreCanvas.height);
            // 这里的颜色跟着主题走 —— 空态文案不该在深色下用浅色主题的灰。
            // getPropertyValue 对自定义属性会保留首尾空白，必须 trim；
            // 兜底色要和 style.css 的 --text-3 保持一致，否则取不到时会
            // 出现一个「两个主题都对不上」的第三种灰。
            const cssText3 = getComputedStyle(document.documentElement)
              .getPropertyValue('--text-3').trim();
            ctx.fillStyle = cssText3 || '#7d899a';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(ss.total ? '已完成的测验都不满足计分条件（无提示或字数不足）' : '还没有做过能力测验', 460, 110);
          }
        }
        const sNote = $('#scoreNote');
        if (sNote) {
          sNote.textContent = ss.points.length
            ? `${ss.points.length} 次有效测验，平均 ${ss.avg} 分` +
              (ss.invalid ? `；另有 ${ss.invalid} 次因未达计分条件不计入` : '')
            : '';
          sNote.hidden = !sNote.textContent;
        }
        // 读屏替代：与画布上实际画的内容（曲线或空态文案）保持一致
        scoreCanvas.setAttribute('aria-label', ss.points.length
          ? `${ss.points.length} 次有效测验的成绩曲线，平均 ${ss.avg} 分，最低 ${ss.min}，最高 ${ss.max}`
          : (ss.total ? '已完成的测验都不满足计分条件（无提示或字数不足），无成绩曲线'
                      : '还没有做过能力测验，无成绩曲线'));
      }

      /* ---- 每日柱状 ---- */
      const dailyCanvas = $('#dailyChart');
      if (dailyCanvas) {
        const ds = dailySeries(app.stats.dailyDays, app.stats.mode);
        drawBars(dailyCanvas, ds, { height: 200 });
        /* 读屏替代：柱状图念不出「哪天练了多少」，给出总量与最突出的一天。 */
        const totalChars = ds.reduce((a, d) => a + d.chars, 0);
        const best = ds.reduce((a, d) => (d.chars > (a ? a.chars : 0) ? d : a), null);
        dailyCanvas.setAttribute('aria-label',
          totalChars > 0 && best
            ? `最近 ${ds.length} 天每日练习量：共练 ${totalChars} 字，最多的一天是 ${best.label}（${best.chars} 字）`
            : `最近 ${ds.length} 天还没有练习记录`);
      }

      /* ---- 错误热力图 ---- */
      // 标题跟着模式筛选走：全部模式时不必再加「（全部模式）」后缀
      const heatTitle = $('#heatTitle');
      if (heatTitle) {
        const label = app.stats.mode === 'all'
          ? '错误热力图'
          : `错误热力图（${LEVEL_MAP[app.stats.mode] ? LEVEL_MAP[app.stats.mode].name : app.stats.mode}）`;
        heatTitle.textContent = label;
      }
      renderHeatmap();

      /* ---- 易错表 ---- */
      renderWeakTable();

      /* ---- 图表切换按钮 ---- */
      bindChips('#chartMetricChips', 'metric', (v) => {
        app.stats.chartMetric = v;
        renderStatsView();
      });
      bindChips('#chartRangeChips', 'range', (v) => {
        app.stats.chartRange = v;
        renderStatsView();
      });
      bindChips('#heatRangeChips', 'range', (v) => {
        app.stats.heatRange = v;
        renderHeatmap();
      });

      /* ---- 危险区按钮 ---- */
      const btnExport = $('#btnExport');
      if (btnExport && !btnExport._bound) {
        btnExport._bound = true;
        btnExport.addEventListener('click', exportData);
      }
      const btnExport2 = $('#btnExport2');
      if (btnExport2 && !btnExport2._bound) {
        btnExport2._bound = true;
        btnExport2.addEventListener('click', exportData);
      }
      const btnClear = $('#btnClearStats');
      if (btnClear && !btnClear._bound) {
        btnClear._bound = true;
        btnClear.addEventListener('click', confirmClearStats);
      }
    } catch (err) {
      console.error('[stats] 渲染失败', err);
      const cards = $('#statCards');
      if (cards) cards.innerHTML = '<div class="empty-state">统计数据读取失败</div>';
    }
  }

  /**
   * 一张统计卡片。
   * @param {string} label 标题
   * @param {any}    value 主数值
   * @param {string} unit  单位（可空）
   * @param {string} sub   副标题（可空）
   * @param {string} badge 右上角小徽标（可空）。只有「今日」卡片用它显示目标进度百分比。
   */
  function statCard(label, value, unit, sub, badge) {
    return `<div class="stat-card">
    <div class="stat-card-label">${escapeHtml(label)}${
      badge ? `<span class="stat-card-badge">${escapeHtml(badge)}</span>` : ''
    }</div>
    <div class="stat-card-value">${escapeHtml(String(value))}${unit ? `<i>${escapeHtml(unit)}</i>` : ''}</div>
    <div class="stat-card-sub">${escapeHtml(sub || '')}</div>
  </div>`;
  }

  /* 今日目标的两段文案。抽出来是为了让「卡片副标题」和「进度条明细」
     用同一套措辞 —— 两处都手写迟早会出现「还差 30 字」vs「剩余 30 字」
     这种不一致，虽然意思一样但读起来像两个功能。 */
  function goalSubText(goal) {
    const parts = [];
    if (goal.goalChars > 0) parts.push(`还差 ${goal.charsLeft} 字`);
    if (goal.goalSessions > 0) parts.push(`还差 ${goal.sessionsLeft} 次`);
    return parts.join(' · ') || '还没开始';
  }

  function goalDetail(goal) {
    const parts = [];
    if (goal.goalChars > 0) parts.push(`字数 ${goal.chars}/${goal.goalChars}`);
    if (goal.goalSessions > 0) parts.push(`次数 ${goal.sessions}/${goal.goalSessions}`);
    return (parts.join(' · ') || '') + (goal.achieved ? ' —— 今天达标了' : '');
  }

  function bindChips(sel, attr, onPick) {
    const wrap = $(sel);
    if (!wrap) return;
    $$('.chip', wrap).forEach(chip => {
      chip.classList.toggle('is-active', chip.getAttribute(`data-${attr}`) === app.stats[
        attr === 'metric' ? 'chartMetric' : 'chartRange']);
    });
    if (wrap._bound) return;
    wrap._bound = true;
    wrap.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const v = chip.getAttribute(`data-${attr}`);
      if (!v) return;
      onPick(v);
    });
  }

  function renderWeakTable() {
    const wrap = $('#weakTableWrap');
    if (!wrap) return;

    const list = weakRanking(30);
    if (!list.length) {
      wrap.innerHTML = `
      <div class="empty-state">
        <strong>还没有易错记录</strong>
        完成几次练习后，出错的字词会自动出现在这里。
      </div>`;
      return;
    }

    const maxCount = Math.max(...list.map(w => w.count), 1);

    wrap.innerHTML = `
    <table class="weak-table">
      <thead>
        <tr>
          <th>字 / 词</th>
          <th>拼音</th>
          <th>错误次数</th>
          <th class="bar-cell">占比</th>
          <th>最近出错</th>
        </tr>
      </thead>
      <tbody>
        ${list.map(w => `
            <tr>
              <td class="w-char">${escapeHtml(w.key)}</td>
              <td class="w-pinyin">${escapeHtml(w.pinyin || '—')}</td>
              <td>${w.count}</td>
              <td class="bar-cell">
                <div class="mini-bar"><i style="width:${Math.round((w.count / maxCount) * 100)}%"></i></div>
              </td>
              <td>${escapeHtml(relTime(w.lastTs))}</td>
            </tr>
          `).join('')}
      </tbody>
    </table>
  `;
  }


  return { renderStatsView };
}
