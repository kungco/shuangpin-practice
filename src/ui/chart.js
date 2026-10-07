/**
 * 轻量 Canvas 图表
 * ------------------------------------------------------------
 * 手绘实现，零依赖，避免引入图表库（保持「双击即可运行」）。
 * 支持：折线图（历史成绩曲线）、柱状图（每日练习量）。
 * 自动处理：空数据、单点、全等值、高低 DPI、主题色。
 */

const THEME = {
  axis: '#cfd8e3',
  grid: '#eef1f6',
  text: '#93a0b4',
  textStrong: '#5a6577',
  line: '#2f6df6',
  lineFill: 'rgba(47,109,246,.10)',
  bar: '#2f6df6',
  barSoft: '#c3d5fb',
  barToday: '#e0863a',
  avg: '#e0863a'
};

/**
 * 准备画布（处理 DPI 缩放）
 */
function prepare(canvas, cssWidth, cssHeight) {
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  canvas.style.width = '100%';
  canvas.style.height = cssHeight + 'px';

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return ctx;
}

/** 文字绘制辅助 */
function drawText(ctx, text, x, y, opts = {}) {
  ctx.save();
  ctx.font = opts.font || '11px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  ctx.fillStyle = opts.color || THEME.text;
  ctx.textAlign = opts.align || 'left';
  ctx.textBaseline = opts.baseline || 'middle';
  ctx.fillText(String(text), x, y);
  ctx.restore();
}

/* ============================================================
   折线图
   ============================================================ */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{value:number, accuracy:number, speed:number, date:string, modeName:string}>} points
 * @param {object} opts { metric, avg, unit, color }
 */
export function drawLine(canvas, points, opts = {}) {
  if (!canvas) return;
  const cssW = canvas.clientWidth || canvas.parentElement && canvas.parentElement.clientWidth || 900;
  const cssH = Number(opts.height) || 260;
  const ctx = prepare(canvas, cssW, cssH);
  if (!ctx) return;

  const pad = { l: 46, r: 16, t: 16, b: 30 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;

  // 空数据
  if (!Array.isArray(points) || !points.length) {
    drawText(ctx, '暂无数据，完成一次练习后这里会显示曲线', cssW / 2, cssH / 2, {
      align: 'center', color: THEME.text
    });
    return;
  }

  const values = points.map(p => Number(p.value) || 0);
  const rawMax = Math.max(...values);
  const rawMin = Math.min(...values);

  // Y 轴范围：留出上下各 10% 余量；全等值时人为撑开
  let max = rawMax;
  let min = rawMin;
  if (max === min) {
    const padV = Math.max(1, Math.abs(max) * 0.2 || 5);
    max += padV;
    min = Math.max(0, min - padV);
  } else {
    const span = max - min;
    max += span * 0.12;
    min -= span * 0.12;
    if (opts.metric !== 'acc' && min < 0) min = 0;
  }
  if (max <= min) max = min + 1;

  const X = (i) => points.length === 1
    ? pad.l + w / 2
    : pad.l + (i / (points.length - 1)) * w;
  const Y = (v) => pad.t + h - ((v - min) / (max - min)) * h;

  /* ---- 网格与 Y 轴刻度 ---- */
  const ticks = 4;
  ctx.save();
  ctx.strokeStyle = THEME.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= ticks; i++) {
    const v = min + (max - min) * (i / ticks);
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + w, y);
    ctx.stroke();
    drawText(ctx, fmtTick(v, opts.metric), pad.l - 8, y, { align: 'right' });
  }
  ctx.restore();

  /* ---- 平均值虚线 ---- */
  if (Number.isFinite(opts.avg)) {
    const y = Math.round(Y(opts.avg)) + 0.5;
    ctx.save();
    ctx.strokeStyle = THEME.avg;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + w, y);
    ctx.stroke();
    ctx.restore();
    drawText(ctx, `平均 ${opts.avg}`, pad.l + w - 2, y - 9, {
      align: 'right', color: THEME.avg, font: '10.5px "PingFang SC", system-ui, sans-serif'
    });
  }

  /* ---- 面积填充 ---- */
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(X(0), pad.t + h);
  points.forEach((p, i) => ctx.lineTo(X(i), Y(Number(p.value) || 0)));
  ctx.lineTo(X(points.length - 1), pad.t + h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + h);
  grad.addColorStop(0, THEME.lineFill);
  grad.addColorStop(1, 'rgba(47,109,246,0)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  /* ---- 折线 ---- */
  ctx.save();
  ctx.strokeStyle = opts.color || THEME.line;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = X(i);
    const y = Y(Number(p.value) || 0);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();

  /* ---- 数据点 ---- */
  const showDots = points.length <= 40;
  if (showDots) {
    points.forEach((p, i) => {
      const x = X(i);
      const y = Y(Number(p.value) || 0);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = opts.color || THEME.line;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    });
  }

  /* ---- 最高点标注 ---- */
  const maxIdx = values.indexOf(rawMax);
  if (maxIdx >= 0 && points.length > 1) {
    drawText(ctx, fmtTick(rawMax, opts.metric), X(maxIdx), Y(rawMax) - 12, {
      align: 'center', color: THEME.textStrong,
      font: '600 10.5px "PingFang SC", system-ui, sans-serif'
    });
  }

  /* ---- X 轴标签（最多 6 个，避免拥挤） ---- */
  const labelCount = Math.min(6, points.length);
  const step = points.length <= 1 ? 1 : Math.max(1, Math.floor((points.length - 1) / (labelCount - 1)));
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    drawText(ctx, shortDate(p.date, p.ts), X(i), pad.t + h + 14, { align: 'center' });
  }
  // 保证最后一个点有标签
  if ((points.length - 1) % step !== 0 && points.length > 1) {
    const p = points[points.length - 1];
    drawText(ctx, shortDate(p.date, p.ts), X(points.length - 1), pad.t + h + 14, { align: 'center' });
  }
}

/* ============================================================
   柱状图
   ============================================================ */

/**
 * @param {Array<{label:string, chars:number, bestSpeed:number, sessions:number, date:string}>} data
 */
export function drawBars(canvas, data, opts = {}) {
  if (!canvas) return;
  const cssW = canvas.clientWidth || canvas.parentElement && canvas.parentElement.clientWidth || 900;
  const cssH = Number(opts.height) || 200;
  const ctx = prepare(canvas, cssW, cssH);
  if (!ctx) return;

  const pad = { l: 46, r: 16, t: 18, b: 30 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;

  if (!Array.isArray(data) || !data.length) {
    drawText(ctx, '暂无每日数据', cssW / 2, cssH / 2, { align: 'center' });
    return;
  }

  const values = data.map(d => Number(d.chars) || 0);
  const rawMax = Math.max(...values, 1);
  const max = niceCeil(rawMax);

  const slot = w / data.length;
  const barW = Math.max(4, Math.min(38, slot * 0.62));

  /* ---- 网格 ---- */
  const ticks = 3;
  ctx.save();
  ctx.strokeStyle = THEME.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= ticks; i++) {
    const v = max * (i / ticks);
    const y = Math.round(pad.t + h - (v / max) * h) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + w, y);
    ctx.stroke();
    drawText(ctx, String(Math.round(v)), pad.l - 8, y, { align: 'right' });
  }
  ctx.restore();

  /* ---- 柱子 ---- */
  const todayKey = new Date();
  const todayStr = `${todayKey.getFullYear()}-${String(todayKey.getMonth() + 1).padStart(2, '0')}-${String(todayKey.getDate()).padStart(2, '0')}`;

  data.forEach((d, i) => {
    const v = Number(d.chars) || 0;
    const cx = pad.l + slot * i + slot / 2;
    const bh = v > 0 ? Math.max(2, (v / max) * h) : 0;
    const x = cx - barW / 2;
    const y = pad.t + h - bh;

    ctx.save();
    ctx.fillStyle = d.date === todayStr
      ? THEME.barToday
      : (v > 0 ? THEME.bar : THEME.barSoft);
    if (bh > 0) {
      roundRect(ctx, x, y, barW, bh, Math.min(4, barW / 2));
      ctx.fill();
    } else {
      // 零值也画一个浅色底桩，视觉上保持连续
      ctx.fillStyle = '#eef1f6';
      roundRect(ctx, x, pad.t + h - 3, barW, 3, 1.5);
      ctx.fill();
    }
    ctx.restore();

    // 数值标注（超过一定高度才显示，避免拥挤）
    if (bh > 18 && data.length <= 20) {
      drawText(ctx, String(v), cx, y - 8, {
        align: 'center', color: THEME.textStrong,
        font: '600 10px "PingFang SC", system-ui, sans-serif'
      });
    }

    // X 轴标签
    const showLabel = data.length <= 16 || i % Math.ceil(data.length / 12) === 0;
    if (showLabel) {
      drawText(ctx, d.label || '', cx, pad.t + h + 14, { align: 'center' });
    }
  });
}

/* ============================================================
   工具
   ============================================================ */

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function fmtTick(v, metric) {
  if (metric === 'acc') return `${Math.round(v)}%`;
  const n = Math.round(v);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function shortDate(dateStr, ts) {
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [, m, d] = dateStr.split('-');
    return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
  }
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return '';
}

/** 把最大值向上取整到「好看」的刻度 */
function niceCeil(v) {
  const n = Math.max(1, Number(v) || 1);
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const norm = n / mag;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 5) step = 5;
  else step = 10;
  return step * mag;
}
