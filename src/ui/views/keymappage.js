/**
 * 键位图页面
 * ------------------------------------------------------------
 * 从 main.js 拆出来的视图。main.js 只负责在「视图构造区」里实例化它。
 *
 * 【为什么是工厂函数 + ctx，而不是顶层导出】
 * 这段代码用到 `$` / `$$` / `ALL_CHARS` / `app` 等 main.js 的共享设施。
 * 顶层导出会形成循环依赖（main.js 又要 import 本模块），所以由 main.js
 * 把依赖作为 ctx 传进来。
 *
 * 【为什么函数体没有缩进】
 * 段内有跨行模板字符串（拼 HTML）。搬进工厂后按理该缩进两格，但
 * **模板字符串内部的行一旦缩进，字符串内容就变了**（生成的 HTML 会多出空格）。
 * 为保「逐字节等价搬运」，这里刻意保持原缩进。改动本文件时请沿用这个约定。
 */

export function createKeymapPageView(ctx) {
  const {
    $,
    $$,
    ALL_CHARS,
    app,
    escapeHtml,
    getKeymapData,
    primarySplit,
    questionFromCharChar,
    renderKeymap,
    startSession,
    switchView
  } = ctx;

  function initKeymapView() {
    const wrap = $('#fullKeymap');
    if (wrap) {
      try {
        app.fullKeymap = renderKeymap(wrap, {
          onKeyClick: (key) => showKeyDetail(key)
        });
      } catch (err) {
        console.error('[keymap] 完整键位图渲染失败', err);
      }
    }

    const search = $('#sylSearch');
    if (search) {
      search.addEventListener('input', () => renderSyllableList());
    }

    const chips = $('#sylFilterChips');
    if (chips) {
      chips.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        $$('#sylFilterChips .chip').forEach(c => c.classList.toggle('is-active', c === chip));
        renderSyllableList();
      });
    }

    renderSyllableList();
  }

  function showKeyDetail(key) {
    const box = $('#keyDetail');
    if (!box) return;
    const data = getKeymapData().find(d => d.key === key);
    if (!data) { box.hidden = true; return; }

    const sheng = data.shengmu.length
      ? data.shengmu.map(s => `<b>${escapeHtml(s)}</b>`).join('、')
      : '（无）';
    const yun = data.yunmu.length
      ? data.yunmu.map(y => `<b>${escapeHtml(y)}</b>`).join('、')
      : '（无）';
    const second = data.secondOf && data.secondOf.length
      ? data.secondOf.map(s => `<b>${escapeHtml(s)}</b>`).join('、')
      : '';

    // 举例（小鹤：zh/ch/sh 各占一键，整音节恒为 2 键）
    const examples = [];
    if (data.shengmu.includes('zh')) examples.push('zhang → VH');
    if (data.shengmu.includes('ch')) examples.push('chun → IY');
    if (data.shengmu.includes('sh')) examples.push('shen → UF');
    if (data.yunmu.includes('ang')) examples.push('zhang → VH');
    if (data.yunmu.includes('eng')) examples.push('zheng → VG');
    if (data.yunmu.includes('ui')) examples.push('zhui → VV');
    if (data.yunmu.includes('u')) examples.push('shu → UU');
    if (data.yunmu.includes('i')) examples.push('qi → QI');
    if (data.yunmu.includes('v')) examples.push('lv → LV');

    box.hidden = false;
    box.innerHTML = `
    <h4>${escapeHtml(key)} 键</h4>
    <div class="kd-rows">
      <div class="kd-row">作为声母键：${sheng}</div>
      <div class="kd-row">作为韵母键：${yun}</div>
      ${second ? `<div class="kd-row">作为双字母声母第二键：${second}</div>` : ''}
      ${examples.length ? `<div class="kd-row">示例：${examples.map(escapeHtml).join('　')}</div>` : ''}
      ${data.shengmu.includes('zh') || data.shengmu.includes('ch') || data.shengmu.includes('sh')
        ? '<div class="kd-row" style="color:#5a6577">提示：zh / ch / sh 各占一键（zh→V、ch→I、sh→U），整个音节仍是 2 键</div>' : ''}
    </div>
  `;
    if (app.fullKeymap) {
      app.fullKeymap.setHighlight(
        data.yunmu.map(y => ({ key, role: 'yun' }))
          .concat(data.shengmu.map(s => ({ key, role: 'sheng' })))
      );
    }
  }

  function renderSyllableList() {
    const list = $('#sylList');
    if (!list) return;

    const search = ($('#sylSearch') ? $('#sylSearch').value : '').trim().toLowerCase();
    const activeChip = $('#sylFilterChips .chip.is-active');
    const filter = activeChip ? activeChip.getAttribute('data-filter') : 'all';

    // 从字表推导全部出现过的拼音，去重
    const set = new Map();
    for (const [ch, py] of Object.entries(ALL_CHARS)) {
      if (!py) continue;
      if (!set.has(py)) set.set(py, []);
      set.get(py).push(ch);
    }

    let items = Array.from(set.entries()).map(([py, chars]) => {
      const split = primarySplit(py);
      return { py, chars, split };
    }).filter(x => x.split);

    if (filter === 'zero') items = items.filter(x => x.split.zero);
    if (filter === 'sheng') items = items.filter(x => !x.split.zero);
    if (search) {
      items = items.filter(x =>
        x.py.includes(search) ||
        x.split.code.toLowerCase().includes(search) ||
        x.chars.some(c => c.includes(search)));
    }

    items.sort((a, b) => a.py.localeCompare(b.py));

    if (!items.length) {
      list.innerHTML = '<div class="syl-empty">没有匹配的拼音</div>';
      return;
    }

    list.innerHTML = items.slice(0, 400).map(x => `
    <div class="syl-item${x.split.zero ? ' is-zero' : ''}" data-py="${escapeHtml(x.py)}" title="点击练习这个音节">
      <div class="syl-item-top">
        <span class="syl-item-py">${escapeHtml(x.py)}</span>
        <span class="syl-item-keys">${escapeHtml(x.split.code)}</span>
      </div>
      <div class="syl-item-split">
        ${x.split.zero ? '零声母' : escapeHtml(x.split.sheng) + ' + ' + escapeHtml(x.split.yun)}
        · ${escapeHtml(x.chars.slice(0, 4).join(''))}
      </div>
    </div>
  `).join('');

    // 点击直接练这个音节
    list.querySelectorAll('.syl-item').forEach(el => {
      el.addEventListener('click', () => {
        const py = el.getAttribute('data-py');
        const split = primarySplit(py);
        if (!split) return;
        const chars = set.get(py) || [];
        const ch = chars[0] || '';
        const q = ch ? questionFromCharChar(ch, py) : null;
        const questions = q ? [q, q] : null;
        if (questions) {
          switchView('practice');
          startSession(questions, 'char');
        }
      });
    });
  }


  return { initKeymapView, renderSyllableList };
}
