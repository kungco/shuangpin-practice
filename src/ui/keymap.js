/**
 * 键盘键位图组件
 * ------------------------------------------------------------
 * 用纯 SVG 绘制 QWERTY 键盘，支持：
 *   - 键面上分区显示声母 / 韵母
 *   - 按角色高亮（声母蓝 / 韵母橙 / 零声母绿 / 命中绿 / 错误红 / 下一键虚线）
 *   - 点击回调（用于键位图页面的详情面板）
 *
 * 之所以手绘 SVG 而不用 HTML 网格，是为了精确控制每行错位、
 * 以及在键内排版「拼音 + 独立字母」的复杂内容。
 */

import { getKeymapData, ALL_KEYS } from '../core/scheme.js';

/* QWERTY 三行布局（含左右手标准错位） */
const ROWS = [
  { keys: 'QWERTYUIOP'.split(''), offset: 0 },
  { keys: 'ASDFGHJKL'.split(''),  offset: 0.42 },
  { keys: 'ZXCVBNM'.split(''),    offset: 1.06 }
];

const KEY_W = 62;
const KEY_H = 62;
const GAP = 6;
const PAD = 10;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 某个键在 SVG 坐标系里的 translate()。
 *
 * 覆盖层（热力数字、慢键环）挂在一个独立的 `<g>` 里，那个 `<g>` 不在
 * .kb-key 内部，拿不到键自带的 transform，所以必须自己算一遍坐标。
 * 算式必须与 buildSvg / buildKey 保持一致 —— 两处各写一份必然漂移。
 */
function keyTransform(key) {
  const K = String(key || '').toUpperCase();
  for (let r = 0; r < ROWS.length; r++) {
    const row = ROWS[r];
    const c = row.keys.indexOf(K);
    if (c < 0) continue;
    const x = c * (KEY_W + GAP) + row.offset * (KEY_W + GAP);
    const y = PAD + r * (KEY_H + GAP);
    return `translate(${x},${y})`;
  }
  return 'translate(0,0)';
}

/* 缓存键位数据，避免重复计算 */
let KEY_DATA = null;
function keyData() {
  if (!KEY_DATA) {
    const list = getKeymapData();
    KEY_DATA = {};
    list.forEach(d => { KEY_DATA[d.key] = d; });
  }
  return KEY_DATA;
}

/* ============================================================
   公开 API
   ============================================================ */

/**
 * 渲染一个键位图
 * @param {HTMLElement} container 容器
 * @param {object} opts
 *   - interactive: 是否可点击（默认 false）
 *   - onKeyClick(key): 点击回调
 *   - showDetail: 是否在键内显示韵母明细（默认 true）
 *   - heat: 热力图数据 [{key, level, percent, count}]。给了就切到「热力模式」：
 *           键底按 level 上色，并叠一个百分比数字。热力模式下不淡出其它键。
 * @returns {{ setHighlight(list): void, clear(): void, setHeat(list): void,
 *             clearHeat(): void, setSlow(list): void, clearSlow(): void,
 *             setMastery(list): void, clearMastery(): void, repaint(): void,
 *             destroy(): void }}
 */
export function renderKeymap(container, opts = {}) {
  if (!container) return makeNoop();

  const interactive = !!opts.onKeyClick;
  let svg;

  try {
    svg = buildSvg(interactive, opts.onKeyClick);
  } catch (err) {
    console.error('[keymap] 渲染失败', err);
    container.innerHTML = '<p class="kb-error">键位图渲染失败。</p>';
    return makeNoop();
  }

  container.innerHTML = '';
  container.appendChild(svg);

  /* 索引键元素，便于高亮 */
  const keyEls = {};
  svg.querySelectorAll('[data-key]').forEach(el => {
    keyEls[el.getAttribute('data-key')] = el;
  });

  /* 热力图数字层：延迟创建（只有统计页会用到） */
  const heatLayer = document.createElementNS(SVG_NS, 'g');
  heatLayer.setAttribute('class', 'kb-heat-layer');
  heatLayer.setAttribute('pointer-events', 'none');

  /* 慢键标记：直接挂在各自键元素的**内部**（而不是另起一层）。
     之所以能共用同一个 .kb-key 容器却不冲突：热力图改的是 `.kb-body` 这一个
     元素的 fill/stroke，慢键环是**另一个** rect，两者互不影响 ——
     「又错又慢」的键上两个信号能同时看见。
     挂在键内部还有个实际好处：--slow-level 设在 .kb-key 上即可层叠到环上，
     不用给每个环单独塞一遍样式变量。 */
  let lastHeat = null;
  let lastSlow = null;
  let lastMastery = null;
  let lastHighlight = null;

  /**
   * 主题切换。
   *
   * 键面/文字的配色现在**完全由 CSS 负责**（.kb-body / .kb-main 等规则用
   * var() 上色），所以切主题本身不需要重写任何属性。这里只做一件事：
   * 重新套用上次的热力与高亮状态 —— 因为它们是靠 class 与内联
   * --heat-level 表达的，重建后要确保 class 还在。
   *
   * 早先这里用 querySelector('.kb-body') 逐个 setAttribute 上色，结果
   * 26 个键里只有第一个变色；而 SVG 的 fill 是**表现属性**，优先级低于
   * 任何 CSS 声明，这条路本身就不该走。
   */
  function repaint() {
    if (lastHeat) this.setHeat(lastHeat);
    if (lastSlow) this.setSlow(lastSlow);
    if (lastMastery) this.setMastery(lastMastery);
    if (lastHighlight) this.setHighlight(lastHighlight);
    else clearHighlight();
  }

  return {
    /**
     * 高亮一组键
     * @param {Array<{key:string, role?:string, state?:string}>} list
     *   role: 'sheng' | 'yun' | 'zero'
     *   state: 'next' | 'hit' | 'miss'
     */
    setHighlight(list) {
      lastHighlight = Array.isArray(list) ? list.slice() : null;
      clearHighlight();
      if (!Array.isArray(list)) return;
      const touched = new Set();
      for (const item of list) {
        if (!item || !item.key) continue;
        const el = keyEls[String(item.key).toUpperCase()];
        if (!el) continue;
        touched.add(String(item.key).toUpperCase());

        if (item.state === 'miss') {
          el.classList.add('is-hl-miss');
        } else if (item.state === 'hit') {
          el.classList.add('is-hl-hit');
        } else if (item.state === 'next') {
          el.classList.add('is-hl-next');
        } else if (item.role === 'sheng') {
          el.classList.add('is-hl-sheng');
        } else if (item.role === 'yun') {
          el.classList.add('is-hl-yun');
        } else if (item.role === 'zero') {
          el.classList.add('is-hl-zero');
        } else {
          el.classList.add('is-hl-sheng');
        }
      }
      // 有高亮时，其余键淡出，聚焦更清晰
      if (touched.size) {
        Object.entries(keyEls).forEach(([k, el]) => {
          if (!touched.has(k)) el.classList.add('is-dim');
        });
      }
    },

    /**
     * 应用热力图。传入空数组 = 清除。
     * @param {Array<{key:string, level?:number, percent?:number, count?:number}>} list
     */
    setHeat(list) {
      this.clearHeat();
      lastHeat = Array.isArray(list) && list.length ? list.slice() : null;
      if (!lastHeat) return;
      const maxLevel = Math.max(...list.map(x => Number(x && x.level) || 1));

      for (const item of list) {
        if (!item || !item.key) continue;
        const K = String(item.key).toUpperCase();
        const el = keyEls[K];
        if (!el) continue;
        const lv = Math.max(1, Math.min(4, Number(item.level) || 1));
        // 用 CSS 变量传层级，样式表里按 var 选色（避免在 JS 里硬编码颜色）
        el.style.setProperty('--heat-level', String(lv));
        el.style.setProperty('--heat-max', String(maxLevel));
        el.classList.add('is-heat');
        const num = heatLayerText(K, item);
        if (num) heatLayer.appendChild(num);
      }
      if (heatLayer.childNodes.length && !heatLayer.parentNode) {
        svg.appendChild(heatLayer);
      }
    },

    clearHeat() {
      Object.values(keyEls).forEach(el => {
        el.classList.remove('is-heat');
        if (el.style && el.style.removeProperty) {
          el.style.removeProperty('--heat-level');
          el.style.removeProperty('--heat-max');
        }
      });
      while (heatLayer.firstChild) heatLayer.removeChild(heatLayer.firstChild);
      if (heatLayer.parentNode) heatLayer.parentNode.removeChild(heatLayer);
    },

    /**
     * 应用「按得慢」标记。传入空数组 = 清除。
     *
     * 用**独立的描边环**而不是改 .kb-body 的 fill/stroke：热力图已经把
     * fill+stroke 用在「按错」上了。两个指标若共用一个元素，「又错又慢」的键
     * 只能显示其中一个 —— 而那恰恰是最该被看见的键。环挂在键内部但是另一个
     * 元素，所以两个信号并存。
     *
     * @param {Array<{key:string, level?:number, medianMs?:number, samples?:number}>} list
     */
    setSlow(list) {
      this.clearSlow();
      lastSlow = Array.isArray(list) && list.length ? list.slice() : null;
      if (!lastSlow) return;
      const maxLevel = Math.max(...list.map(x => Number(x && x.level) || 1));
      for (const item of list) {
        if (!item || !item.key) continue;
        const K = String(item.key).toUpperCase();
        const el = keyEls[K];
        if (!el) continue;
        const lv = Math.max(1, Math.min(4, Number(item.level) || 1));
        // 层级走 CSS 变量 + class，样式表决定颜色（不在 JS 里硬编码）。
        // 设在 .kb-key 上，环作为它的子元素自然继承。
        el.style.setProperty('--slow-level', String(lv));
        el.style.setProperty('--slow-max', String(maxLevel));
        el.classList.add('is-slow');
        el.appendChild(slowRing(item));
      }
    },

    clearSlow() {
      Object.values(keyEls).forEach(el => {
        el.classList.remove('is-slow');
        if (el.style && el.style.removeProperty) {
          el.style.removeProperty('--slow-level');
          el.style.removeProperty('--slow-max');
        }
        // 环是直接挂在键里的，清热力层那套逻辑不会碰到它
        const ring = el.querySelector('.kb-slow-ring');
        if (ring && ring.parentNode) ring.parentNode.removeChild(ring);
      });
    },

    /**
     * 应用「掌握度」标记。传入空数组 = 清除。
     *
     * 与热力（fill）和慢键（虚线环）都不同：掌握度是一个**离散状态**
     * （没碰过 / 在练 / 已掌握），不是连续量，所以用 class + 角标表达：
     *   - 已掌握：键右上角一个小圆点（绿）
     *   - 没碰过：键整体降饱和度（与「方案里没用到的键」区分开 ——
     *     那类键在 buildSvg 里已经加了 is-dim，这里叠的是 is-untouched）
     * 这样三个诊断层能同时出现在一个键上：
     * 「又错又慢、还没掌握」= 红填充 + 蓝环 + 无圆点，一眼就能看出。
     *
     * @param {Array<{key:string, state:'untouched'|'learning'|'mastered'}>} list
     */
    setMastery(list) {
      this.clearMastery();
      lastMastery = Array.isArray(list) && list.length ? list.slice() : null;
      if (!lastMastery) return;
      for (const item of list) {
        if (!item || !item.key) continue;
        const K = String(item.key).toUpperCase();
        const el = keyEls[K];
        if (!el) continue;
        const st = String(item.state || 'learning');
        if (st === 'mastered') {
          el.classList.add('is-mastered');
          el.appendChild(masteryDot());
        } else if (st === 'untouched') {
          el.classList.add('is-untouched');
        }
        // 'learning' 不加额外标记：默认态就是在练，加了反而噪声
      }
    },

    clearMastery() {
      Object.values(keyEls).forEach(el => {
        el.classList.remove('is-mastered', 'is-untouched');
        const dot = el.querySelector('.kb-mastery-dot');
        if (dot && dot.parentNode) dot.parentNode.removeChild(dot);
      });
    },

    clear() { clearHighlight(); lastHighlight = null; },

    repaint,

    destroy() { container.innerHTML = ''; }
  };

  /** 在键底右下角生成「次数」小字 */
  function heatLayerText(K, item) {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('class', 'kb-heat-num');
    t.setAttribute('x', 9);
    t.setAttribute('y', KEY_H - 6);
    t.setAttribute('font-size', 10.5);
    t.setAttribute('font-weight', 700);
    // fill 交给 .kb-heat-num 的 CSS 规则（用 var(--heat-text-2)）
    t.textContent = String(Number(item.count) || 0);
    // 用 <g> 包一层并**带上与键相同的 translate**。
    // 早先这里漏了 transform，所有键的数字都落在同一个坐标上叠成一坨
    // （浏览器实测 8 个数字只有 1 个不同的 bounding box）—— 等于没显示。
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-heat-for', K);
    g.setAttribute('transform', keyTransform(K));
    g.appendChild(t);
    return g;
  }

  /** 慢键标记：键内侧的虚线描边环（不填色，所以热力填充仍可见） */
  function slowRing(item) {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('class', 'kb-slow-ring');
    r.setAttribute('x', 2.5);
    r.setAttribute('y', 2.5);
    r.setAttribute('width', String(KEY_W - 5));
    r.setAttribute('height', String(KEY_H - 5));
    r.setAttribute('rx', '7');
    r.setAttribute('data-slow-ms', String(Math.round(Number(item.medianMs) || 0)));
    return r;
  }

  /**
   * 已掌握小圆点：键右上角一个实心圆。
   *
   * 为什么不用「整键变绿」：绿色填充会和热力图的 fill 抢同一个通道，
   * 「已掌握但又按错过」就画不出来。右上角一个点不占 fill，
   * 与 red 填充 / 蓝环互不干扰。位置避开主字母（左上）与声母（右上偏中点，
   * 见 buildKey），放在最右上、半径 5。
   */
  function masteryDot() {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', 'kb-mastery-dot');
    c.setAttribute('cx', String(KEY_W - 8));
    c.setAttribute('cy', '8');
    c.setAttribute('r', '4.6');
    return c;
  }

  function clearHighlight() {
    Object.values(keyEls).forEach(el => {
      el.classList.remove('is-hl-sheng', 'is-hl-yun', 'is-hl-zero',
                           'is-hl-hit', 'is-hl-miss', 'is-hl-next', 'is-dim');
    });
  }
}

/** 渲染完整键位图（键位图页面用，带详情） */
export function renderFullKeymap(container, onKeyClick) {
  return renderKeymap(container, { onKeyClick });
}

/* ============================================================
   SVG 构建
   ============================================================ */

function buildSvg(interactive, onKeyClick) {
  const data = keyData();
  const minX = -0.42 * (KEY_W + GAP);
  const maxCols = 10;
  const width = maxCols * (KEY_W + GAP) + PAD * 2 + Math.abs(minX);
  const height = ROWS.length * (KEY_H + GAP) + PAD * 2;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${minX - PAD} 0 ${width} ${height}`);
  /* role 必须随 interactive 变 —— 这是个容易踩的坑：
     `role="img"` 在 ARIA 里是「原子」角色，会把**所有后代从无障碍树里剪掉**
     （视为纯表现内容）。键位图页的键是 <g role="button" tabindex="0"
     aria-label="X 键">，一旦外层还是 role="img"，那 26 个键名和可聚焦性就全被
     吞掉，读屏用户只会听到「小鹤双拼键位图，图片」，既不知道能点也拿不到键名。
     所以：可交互时用 role="group"（容器角色，不剪后代），
     纯展示（迷你键位图）时才用 role="img"。 */
  svg.setAttribute('role', interactive ? 'group' : 'img');
  svg.setAttribute('aria-label', interactive
    ? '小鹤双拼键位图，可用 Tab 在 26 个键之间移动，按回车查看该键详情'
    : '小鹤双拼键位图');

  ROWS.forEach((row, r) => {
    row.keys.forEach((k, c) => {
      const x = c * (KEY_W + GAP) + row.offset * (KEY_W + GAP);
      const y = PAD + r * (KEY_H + GAP);
      const g = buildKey(k, x, y, data[k], interactive, onKeyClick);
      svg.appendChild(g);
    });
  });

  return svg;
}

function buildKey(key, x, y, info, interactive, onKeyClick) {
  const g = document.createElementNS(SVG_NS, 'svg');
  g.setAttribute('class', 'kb-key' + (interactive ? ' is-clickable' : ''));
  g.setAttribute('data-key', key);
  g.setAttribute('transform', `translate(${x},${y})`);

  if (!info || !info.used) g.classList.add('is-dim');

  // 键底
  const body = document.createElementNS(SVG_NS, 'rect');
  body.setAttribute('class', 'kb-body');
  body.setAttribute('width', KEY_W);
  body.setAttribute('height', KEY_H);
  body.setAttribute('rx', 9);
  // fill / stroke 由 .kb-body 的 CSS 规则负责（见 style.css）。
  // 不在这里写死颜色：SVG 的 fill 属性是「表现属性」，优先级低于任何 CSS
  // 声明，靠 JS 逐个上色迟早会漏（早先就因为 querySelector 而非
  // querySelectorAll，26 个键只有第一个换了色）。
  body.setAttribute('stroke-width', 1.4);
  g.appendChild(body);

  // 主字母（左上）
  const main = document.createElementNS(SVG_NS, 'text');
  main.setAttribute('class', 'kb-main');
  main.setAttribute('x', 9);
  main.setAttribute('y', 18);
  main.setAttribute('font-size', 15);
  main.textContent = key;
  g.appendChild(main);

  // 声母（右上方，蓝色）
  if (info && info.shengmu.length) {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('class', 'kb-sub');
    t.setAttribute('x', KEY_W - 8);
    t.setAttribute('y', 17);
    t.setAttribute('text-anchor', 'end');
    t.setAttribute('font-size', 12.5);
    t.setAttribute('font-weight', 700);
    // fill 由 .kb-sub 的 CSS 规则负责
    t.textContent = info.shengmu.join(' ');
    g.appendChild(t);
  }

  // 小鹤中 zh/ch/sh 各自只占一键（zh→V、ch→I、sh→U），
  // 不存在「第二键」提示，因此 H 键不再有额外行。
  // 只有 V 键需要一条附注（它同时是 zh 的键和 ü 的键），
  // 需要把韵母行稍微上提一点留出空间。
  const hasNote = key === 'V';
  const yunText = info && info.yunmu.length ? info.yunmu.join(' ') : '';

  let yunY = KEY_H - 16;
  if (hasNote) yunY = KEY_H - 23;          // V：给「zh 首键 / ü」附注让位

  // 韵母（橙色）
  if (yunText) {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('class', 'kb-pinyin');
    t.setAttribute('x', KEY_W / 2);
    t.setAttribute('y', yunY);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', yunText.length > 9 ? 10.5 : (yunText.length > 6 ? 11.5 : 13));
    t.setAttribute('font-weight', 600);
    // fill 由 .kb-pinyin 的 CSS 规则负责
    t.textContent = yunText;
    g.appendChild(t);
  }

  // 特殊标记：V 键既是 zh 首键又是 ü
  // V 键内容最挤（字母 + 声母 zh + 韵母「ui v」+ 这条附注），
  // 所以韵母行上移、附注下移，把纵向间距拉开到 13px 以上。
  if (key === 'V' && info && info.shengmu.includes('zh')) {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('class', 'kb-note');
    t.setAttribute('x', KEY_W / 2);
    t.setAttribute('y', KEY_H - 4);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', 9);
    // fill 由 .kb-note 的 CSS 规则负责
    t.textContent = 'zh 首键 / ü';
    g.appendChild(t);
  }

  // 交互
  if (interactive) {
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${key} 键`);
    const fire = (e) => {
      e.preventDefault();
      try { onKeyClick && onKeyClick(key); } catch (err) { console.error(err); }
    };
    g.addEventListener('click', fire);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') fire(e);
    });
  }

  return g;
}

function makeNoop() {
  return {
    setHighlight() {}, clear() {},
    setHeat() {}, clearHeat() {},
    setSlow() {}, clearSlow() {},
    setMastery() {}, clearMastery() {},
    repaint() {},
    destroy() {}
  };
}

export { ALL_KEYS };
