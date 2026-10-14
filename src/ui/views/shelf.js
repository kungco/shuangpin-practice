/**
 * 个人文本书架视图
 * ------------------------------------------------------------
 * 从 main.js 搬出来的第一块视图（main.js 曾 5617 行，是唯一的膨胀点）。
 *
 * 【为什么是工厂函数而不是顶层导出】
 * 这段代码用到 `$` / `$$` / `app` / `S` / `toast` 等 main.js 里的共享设施。
 * 直接 import 会形成循环依赖（main.js 又要 import 本模块），
 * 所以改成由 main.js 把依赖作为 ctx 传进来。
 *
 * 【为什么函数体没有缩进】
 * 段内有 8 处跨行模板字符串（拼 HTML）。把函数搬进工厂后按理该缩进两格，
 * 但**模板字符串内部的行一旦缩进，字符串内容就变了**（生成的 HTML 会多出空格）。
 * 为保「逐字节等价搬运」，这里刻意保持原缩进。改动本文件时请沿用这个约定。
 */

export function createShelfView(ctx) {
  const {
    $,
    $$,
    app,
    S,
    toast,
    escapeHtml,
    openModal,
    saveSettingsDebounced,
    watchStorageMode
  } = ctx;

  function initShelf() {
    const btnSave = $('#btnShelfSave');
    if (btnSave && !btnSave._bound) {
      btnSave._bound = true;
      btnSave.addEventListener('click', () => {
        const ta = $('#customTextInput');
        const text = ta ? ta.value : '';
        if (!String(text).trim()) { toast('先粘贴文字，再存入书架', 'err'); return; }
        const existed = S.loadShelf().find(e => e.text === text);
        if (existed) {
          app.shelfActiveId = existed.id;
          toast(`书架里已有这份材料：「${existed.title}」`);
          renderShelf();
          return;
        }
        const n = S.loadShelf().length + 1;
        const entry = S.addShelfEntry({ title: `材料 ${n}`, tags: [], text });
        if (entry) {
          app.shelfActiveId = entry.id;
          toast('已存入书架，下次可直接从列表继续');
          renderShelf();
          /* 存材料是占地最大的一类写入（单篇上限 2 万字）。
             顺手检查一次占用，接近上限就当场提醒 —— 别等下次练习写不进去。 */
          watchStorageMode();
        }
      });
    }

    const list = $('#shelfList');
    if (list && !list._bound) {
      list._bound = true;
      // 列表内容每次重画，事件绑在容器上做委托（和弹窗的 data-act 同一思路）
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.getAttribute('data-id');
        const act = btn.getAttribute('data-act');
        if (act === 'open') openShelfEntry(id);
        else if (act === 'edit') editShelfEntry(id);
        else if (act === 'del') confirmRemoveShelfEntry(id);
        else if (act === 'slow') showShelfSlow(id);
      });
    }

    /* 搜索输入：只重画列表，不动输入框本身 ——
       输入框若被一起重建，焦点会丢、光标会跳到开头，打字立刻断掉。 */
    const search = $('#shelfSearch');
    if (search && !search._bound) {
      search._bound = true;
      search.addEventListener('input', renderShelf);
      // Esc 清空（type=search 自带清除按钮，但键盘用户不一定有那个按钮）
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && search.value) {
          e.stopPropagation();      // 别让 Esc 冒泡去关弹窗
          search.value = '';
          renderShelf();
        }
      });
    }

    renderShelf();
  }

  /** 书架搜索框出现的最少材料数。低于这个数，滚动比搜索快，搜索框只是占地方。 */
  const SHELF_SEARCH_MIN = 4;

  /**
   * 一份材料是否命中搜索词。
   *
   * 【搜什么】标题、标签、正文三处。正文也搜是必要的 ——
   * 用户记得「那篇讲黄鹤楼的文章」，但未必记得自己给它起了什么标题。
   *
   * 【大小写】两边都转小写比较。中文不受影响，但材料里混英文
   * （人名、术语）时不该因为大小写搜不到。
   *
   * @param {object} entry 书架条目
   * @param {string} q 已转小写的查询词
   */
  function shelfMatches(entry, q) {
    if (!q) return true;
    if (String(entry.title || '').toLowerCase().includes(q)) return true;
    if (Array.isArray(entry.tags) && entry.tags.some(t => String(t).toLowerCase().includes(q))) return true;
    return String(entry.text || '').toLowerCase().includes(q);
  }

  /** 重画书架列表（含每份材料自己的速度 / 正确率与上次进度） */
  function renderShelf() {
    const box = $('#shelfBox');
    const list = $('#shelfList');
    const count = $('#shelfCount');
    if (!box || !list) return;
    const all = S.loadShelf();
    box.hidden = all.length === 0;

    /* 搜索。条数少时整块隐藏 —— 两三条材料摆个搜索框纯属占地方。 */
    const searchBox = $('#shelfSearchBox');
    const searchInput = $('#shelfSearch');
    const showSearch = all.length >= SHELF_SEARCH_MIN;
    if (searchBox) searchBox.hidden = !showSearch;
    /* 材料被删到不足阈值时把输入框一起清空 —— 否则等材料又多起来、
       搜索框重新出现时，会带着一个上次残留的查询词，列表莫名其妙是空的。 */
    if (!showSearch && searchInput && searchInput.value) searchInput.value = '';

    const rawQuery = (showSearch && searchInput) ? searchInput.value.trim() : '';
    const query = rawQuery.toLowerCase();
    const entries = query ? all.filter(e => shelfMatches(e, query)) : all;

    if (count) {
      /* 搜索时显示「命中 / 总数」两个数：只显示命中数的话，
         用户会以为材料被删掉了。 */
      count.textContent = !all.length ? ''
        : (query ? `${entries.length} / ${all.length} 份` : `${all.length} 份`);
    }

    /* 用 DOM API 逐个节点搭，不用 innerHTML 拼字符串。
       理由是安全而非风格：条目数据（id / 标题 / 标签）最终来自**导入的备份**，
       是别人的输入。拼 HTML 的写法只要漏转义一个字段就是脚本注入
       （曾经验证过：构造一份 id 带 `"><img onerror=...>` 的备份能注入成功）。
       textContent / setAttribute 从机制上杜绝这一整类问题，
       就算将来有人在 normalize 阶段漏了校验也炸不了。 */
    list.innerHTML = '';

    if (query && !entries.length) {
      const empty = document.createElement('li');
      empty.className = 'shelf-empty';
      empty.textContent = `没有匹配「${rawQuery}」的材料`;
      list.append(empty);
      return;
    }

    const frag = document.createDocumentFragment();

    for (const e of entries) {
      const avg = S.shelfEntryAverages(e);
      const last = e.lastAt ? new Date(e.lastAt).toLocaleDateString() : '没练过';
      const prog = e.progress.segCount > 0
        ? (e.progress.segIndex >= e.progress.segCount
          ? '上一轮已打完'
          : `练到第 ${e.progress.segIndex + 1}/${e.progress.segCount} 段`)
        : '';
      const meta = [e.tags.length ? e.tags.join('、') : '',
        avg.sessions ? `${avg.sessions} 次` : '还没练过',
        avg.sessions ? `均 ${avg.avgSpeed} 字/分 · 正确率 ${avg.avgAccuracy}%` : '',
        last, prog].filter(Boolean).join(' · ');
      const canResume = e.progress.segIndex > 0 && e.progress.segIndex < e.progress.segCount;

      const li = document.createElement('li');
      li.className = 'shelf-item';
      li.dataset.id = e.id;

      const main = document.createElement('div');
      main.className = 'shelf-item-main';
      const title = document.createElement('span');
      title.className = 'shelf-item-title';
      title.textContent = e.title;                    // textContent：防注入
      const metaEl = document.createElement('span');
      metaEl.className = 'shelf-item-meta';
      metaEl.textContent = meta;
      main.append(title, metaEl);

      const actions = document.createElement('div');
      actions.className = 'shelf-item-actions';
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-ghost btn-sm';
      openBtn.type = 'button';
      openBtn.dataset.act = 'open';
      openBtn.dataset.id = e.id;                      // setAttribute 语义：值就是值
      openBtn.textContent = canResume ? '继续' : '练习';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-ghost btn-sm';
      editBtn.type = 'button';
      editBtn.dataset.act = 'edit';
      editBtn.dataset.id = e.id;
      editBtn.setAttribute('aria-label', `编辑 ${e.title} 的标题和标签`);
      editBtn.textContent = '编辑';
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-ghost btn-sm';
      delBtn.type = 'button';
      delBtn.dataset.act = 'del';
      delBtn.dataset.id = e.id;
      delBtn.setAttribute('aria-label', `删除 ${e.title}`);
      delBtn.textContent = '删除';
      actions.append(openBtn);
      /* 卡顿分析：只有练过、且留下逐字用时的材料才有这个入口。
         没有数据的材料不给按钮 —— 点开只有一句「暂无数据」比不给更糟。 */
      if (Array.isArray(e.slow) && e.slow.length) {
        const slowBtn = document.createElement('button');
        slowBtn.className = 'btn btn-ghost btn-sm';
        slowBtn.type = 'button';
        slowBtn.dataset.act = 'slow';
        slowBtn.dataset.id = e.id;
        slowBtn.setAttribute('aria-label', `查看 ${e.title} 的卡顿分析`);
        slowBtn.textContent = '卡顿分析';
        actions.append(slowBtn);
      }
      actions.append(editBtn, delBtn);

      li.append(main, actions);
      frag.append(li);
    }
    list.append(frag);
  }

  /** 编辑书架材料的显示名与标签，保留正文、练习进度和统计。 */
  function editShelfEntry(id) {
    const entry = S.loadShelf().find(e => e.id === id);
    if (!entry) return;
    openModal(`
    <h2>编辑书架材料</h2>
    <label class="field">
      <span>标题</span>
      <input id="shelfEditTitle" type="text" maxlength="60" value="${escapeHtml(entry.title)}" required />
    </label>
    <label class="field">
      <span>标签</span>
      <input id="shelfEditTags" type="text" maxlength="120" value="${escapeHtml(entry.tags.join(', '))}"
        placeholder="例如：小说、工作、复习" />
    </label>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-primary" data-act="save">保存</button>
    </div>
  `, (act, close) => {
      if (act !== 'save') { close(); return; }
      const title = String($('#shelfEditTitle')?.value || '').trim();
      if (!title) {
        toast('标题不能为空', 'err');
        $('#shelfEditTitle')?.focus();
        return;
      }
      const tags = String($('#shelfEditTags')?.value || '')
        .split(/[,，、;；]/).map(tag => tag.trim()).filter(Boolean).slice(0, 6);
      if (!S.updateShelfEntry(id, { title, tags })) {
        toast('保存失败，材料可能已被删除', 'err');
        close();
        return;
      }
      close();
      toast('书架信息已更新');
      renderShelf();
    });
  }

  /**
   * 卡顿分析弹窗：这份材料里「停顿最长的 5 个位置」，以及和上次的对比。
   *
   * 【对着谁说话】用这份材料自己的数据，不掺全局统计 ——
   * 用户点的是「这篇练得怎么样」，给他全站平均速度是答非所问。
   *
   * 【为什么要把「不可比」说得那么清楚】重练时段的起点可能不同、
   * 上次可能中途退出。数据对不齐的时候给一个「快了 0.3 秒」，
   * 用户会以为自己在进步，实际上根本没测到。宁可说「还没法对比」。
   */
  function showShelfSlow(id) {
    const entry = S.loadShelf().find(e => e.id === id);
    if (!entry) { toast('材料已被删除', 'err'); return; }
    const a = S.shelfSlowAnalysis(entry, { top: 5, minMs: 900 });

    if (!a.hasData) {
      openModal(`
      <h2>卡顿分析</h2>
      <p class="panel-sub">「${escapeHtml(entry.title)}」还没有逐字用时数据。完整练完一次后，这里会标出停顿最长的位置。</p>
      <div class="modal-actions"><button class="btn btn-primary" data-act="cancel">知道了</button></div>
    `, () => {});
      return;
    }

    const fmt = (ms) => (ms / 1000).toFixed(2) + 's';
    const rows = a.slowest.map(s => `
    <li class="slow-row">
      <span class="slow-rank">${s.rank}</span>
      <span class="slow-char">${escapeHtml(s.ch)}</span>
      <span class="slow-ms">${fmt(s.ms)}</span>
      <span class="slow-ratio">${s.ratio > 1 ? `比本篇中位数慢 ${s.ratio}×` : '本篇较慢'}</span>
    </li>`).join('');

    let cmp = '';
    const c = a.compare;
    if (!c) {
      cmp = `<div class="slow-legend-note">这是第一次练习这份材料，下次再练就能对比卡顿位置了。</div>`;
    } else if (c.segMismatch) {
      cmp = `<div class="slow-legend-note">上次练的是别的段落，位置对不上，暂不做对比。
      同一段再练一次就能看出进步。</div>`;
    } else if (!c.comparable) {
      cmp = `<div class="slow-legend-note">上次的数据不足以对比（可能中途退出）。再完整练一次即可。</div>`;
    } else {
      const d = c.deltaMs;
      const better = d < 0;
      const tone = Math.abs(d) < 120 ? '基本持平' : (better ? '比上次快' : '比上次慢');
      cmp = `
      <div class="slow-compare ${better ? 'is-better' : (Math.abs(d) < 120 ? '' : 'is-worse')}">
        <span class="slow-compare-main">整篇平均 ${fmt(c.recentMs)}，${tone}
          ${Math.abs(d) >= 120 ? ` ${fmt(Math.abs(d))}` : ''}</span>
        <span class="slow-compare-sub">上次 ${fmt(c.prevMs)}（${new Date(c.prevAt).toLocaleString()}）</span>
      </div>
      ${c.sameSpots.length ? `
          <div class="slow-legend-note" style="margin-top:8px">
            同一位置比上次更慢的字：
            ${c.sameSpots.map(s => `<b>${escapeHtml(s.ch)}</b>（${fmt(s.prevMs)} → ${fmt(s.ms)}）`).join('、')}
          </div>` : `
          <div class="slow-legend-note" style="margin-top:8px">没有哪个位置比上次明显更慢 —— 稳定性保持得不错。</div>`}
    `;
    }

    openModal(`
    <h2>卡顿分析 · ${escapeHtml(entry.title)}</h2>
    <p class="panel-sub">
      逐字用时取「从上一个字打完到这一个字打完」的秒数；
      参考线是本篇的<b>中位数</b>（对偶尔走神免疫）。已排除每篇第一个字 —— 它含「进入状态」的启动成本。
    </p>
    <h3 class="sub-title">最慢的 ${a.slowest.length || 0} 个位置</h3>
    ${a.slowest.length
      ? `<ul class="slow-list">${rows}</ul>`
      : `<div class="slow-legend-note">这一篇没有超过 ${fmt(900)} 的停顿 —— 每个字都很顺。</div>`}
    <h3 class="sub-title" style="margin-top:18px">与上次对比</h3>
    ${cmp}
    <div class="slow-legend-note" style="margin-top:12px">
      本篇中位数 ${fmt(a.medianMs)} · 平均 ${fmt(a.avgMs)} ·
      共 ${a.totalChars} 字 · 保存了最近 ${a.sessions} 次（上限 ${S.SHELF_SLOW_SNAPSHOTS} 次）
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-act="cancel">关闭</button>
      <button class="btn btn-primary" data-act="replay">再练这一篇</button>
    </div>
  `, (act, close) => {
      close();
      if (act === 'replay') openShelfEntry(entry.id);
    });
  }

  /** 打开一份材料：文本进 textarea，并从上次的段继续 */
  function openShelfEntry(id) {  const entry = S.loadShelf().find(e => e.id === id);
    if (!entry) return;
    const ta = $('#customTextInput');
    if (ta) {
      ta.value = entry.text;
      app.settings.customText = entry.text;
      saveSettingsDebounced();
      ta.dispatchEvent(new Event('input'));
    }
    app.shelfActiveId = entry.id;

    // 切到自定义文本模式，让用户看得见自己要练什么
    const card = $$('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'custom');
    if (card) card.click();

    if (entry.progress.segIndex >= entry.progress.segCount) {
      // 上一轮已打完 → 从头再来（进度会随本次练习覆盖）
      toast(`「${entry.title}」上一轮已打完，从头开始`);
      app.shelfSegOffset = 0;
    } else if (entry.progress.segIndex > 0) {
      app.shelfSegOffset = entry.progress.segIndex;
      toast(`「${entry.title}」从第 ${entry.progress.segIndex + 1} 段继续`);
    } else {
      app.shelfSegOffset = 0;
    }
  }

  /** 删除确认：书架条目一删，进度与统计一起没了，必须让用户明确知情 */
  function confirmRemoveShelfEntry(id) {
    const entry = S.loadShelf().find(e => e.id === id);
    if (!entry) return;
    const avg = S.shelfEntryAverages(entry);
    openModal(`
    <h2>删除「${escapeHtml(entry.title)}」？</h2>
    <p>${escapeHtml(entry.stats.sessions
      ? `这份材料练过 ${avg.sessions} 次（均 ${avg.avgSpeed} 字/分），删除后这些进度与统计一起消失。`
      : '这份材料还没有练习记录。')}正文无法恢复。</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-danger" data-act="remove">删除</button>
    </div>
  `, (act, close) => {
      if (act !== 'remove') { close(); return; }
      if (app.shelfActiveId === id) app.shelfActiveId = null;
      S.removeShelfEntry(id);
      close();
      toast('已删除');
      renderShelf();
    });
  }

  /** 练完一次自定义文本后回写书架（进度 + 该材料自己的统计） */
  function touchShelfAfterSession(s) {
    const id = app.shelfActiveId;
    const segBase = app.shelfSegBase || 0;
    const slowChars = app.slowChars;
    app.shelfActiveId = null;
    app.shelfSegBase = 0;
    app.shelfSegOffset = 0;
    app.slowChars = null;
    if (!id || s.mode !== 'custom') return;
    const entry = S.loadShelf().find(e => e.id === id);
    if (!entry) return;
    /* 正文必须和条目一致才记账：用户从书架打开 A 之后又把文本改成了 B，
       这一局练的是 B，不能把成绩算到 A 头上。 */
    const ta = $('#customTextInput');
    const cur = ta ? ta.value : (app.settings.customText || '');
    if (cur !== entry.text) return;
    /* 段号要加上**本次开局的基数**：从第 3 段续打又完成了 5 段，
       进度是 8 而不是 5 —— doneQuestions 只数得了本次会话内的。 */
    const segIndex = segBase + (s.doneQuestions || 0);
    S.touchShelfEntry(id, {
      segIndex,
      segCount: segBase + (s.questionCount || 0)
    }, s);

    /* 逐字用时快照（卡顿分析）。与上面的聚合值分开写：
       聚合值永久累加，明细只留最近 5 次（见 storage 的 SHELF_SLOW_SNAPSHOTS）。
       段号一起记 —— 对比卡顿位置时必须同一段之间比，否则位置对不上。 */
    if (Array.isArray(slowChars) && slowChars.length) {
      try {
        S.recordShelfSlow(id, slowChars, {
          segIndex,
          durationSec: s.durationSec,
          totalChars: s.totalChars
        });
      } catch (err) { console.warn('[shelf] 逐字用时回写失败', err); }
    }

    renderShelf();
  }

  return { initShelf, renderShelf, touchShelfAfterSession };
}
