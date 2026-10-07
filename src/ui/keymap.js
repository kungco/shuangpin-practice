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
 * @returns {{ setHighlight(list): void, clear(): void, setHeat(list): void, clearHeat(): void, destroy(): void }}
 */
export function renderKeymap(container, opts = {}) {
  if (!container) return makeNoop();

  const interactive = !!opts.onKeyClick;
  let svg;

  try {
    svg = buildSvg(interactive, opts.onKeyClick);
  } catch (err) {
    console.error('[keymap] 渲染失败', err);
    container.innerHTML = '<p style="color:#93a0b4;font-size:13px;padding:16px">键位图渲染失败。</p>';
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

  return {
    /**
     * 高亮一组键
     * @param {Array<{key:string, role?:string, state?:string}>} list
     *   role: 'sheng' | 'yun' | 'zero'
     *   state: 'next' | 'hit' | 'miss'
     */
    setHighlight(list) {
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
      if (!Array.isArray(list) || !list.length) return;
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

    clear() { clearHighlight(); },
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
    t.setAttribute('fill', '#8a4a1e');
    t.textContent = String(Number(item.count) || 0);
    // 用 <g> 包一层带上 translate，避免和已有 text 冲突
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-heat-for', K);
    g.appendChild(t);
    return g;
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
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '小鹤双拼键位图');

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
  body.setAttribute('fill', '#ffffff');
  body.setAttribute('stroke', '#cfd8e3');
  body.setAttribute('stroke-width', 1.4);
  g.appendChild(body);

  // 主字母（左上）
  const main = document.createElementNS(SVG_NS, 'text');
  main.setAttribute('class', 'kb-main');
  main.setAttribute('x', 9);
  main.setAttribute('y', 18);
  main.setAttribute('font-size', 15);
  main.setAttribute('fill', '#1d2433');
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
    t.setAttribute('fill', '#2f6df6');
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
    t.setAttribute('fill', '#e0863a');
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
    t.setAttribute('fill', '#93a0b4');
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
    destroy() {}
  };
}

export { ALL_KEYS };
