// main.js 视图段依赖分析（拆分前的调研工具）。
//
// 【用途】main.js 一度到 5617 行，是唯一的结构性膨胀点。但**不能凭行号乱切**：
// 它是一个高度互连的闭包 —— 131 个顶层函数里只有 4 个是「纯叶子」
// （不碰 app / $() / S，也不调其它顶层函数），合计才 100 行。
// 所以切之前必须知道：每段**对外暴露几个函数**、**依赖 main.js 的哪些设施**。
// 只有对外接口小、外部依赖少的段才切得动。
//
// 【用法】node _test/tools/analyze_main.mjs
// 段的位置由**标题文字**定位，不写死行号 —— 拆走一段之后其余段的行号会整体
// 上移，写死行号的话这个工具第二次跑就是错的（第一版就是这么过期的）。
//
// 【实测结论（2026-10-14，拆分前）】
//   段              行数   对外接口   外部函数依赖   可切
//   个人文本书架     427     3 个       5 个          ✅ 已拆到 ui/views/shelf.js
//   统计页面         294     1 个       3 个          ✅
//   错误热力图       319     1 个       3 个          ✅
//   复习页面         403     3 个      11 个          ❌ 太缠
//   新手引导课程     293    13 个       —             ❌ 几乎全暴露
//   练习：渲染       706    14 个       —             ❌ 几乎全暴露

import { readFileSync } from 'node:fs';

const src = readFileSync('src/main.js', 'utf8').split('\n');

/* ---------- 切出所有「段落」：/* ==== 开头、下一行是标题 ---------- */
const sections = [];
for (let i = 0; i < src.length; i++) {
  if (!/^\/\* ={10,}/.test(src[i])) continue;
  const title = (src[i + 1] || '').trim();
  if (!title || /^={10,}/.test(title)) continue;
  sections.push({ title, start: i + 1 });          // 行号从 1 开始
}
sections.forEach((s, k) => {
  s.end = (k + 1 < sections.length ? sections[k + 1].start - 1 : src.length);
});

/* ---------- 顶层函数及其行范围 ---------- */
const fns = [];
src.forEach((l, i) => {
  const m = l.match(/^function\s+([A-Za-z_$][\w$]*)/);
  if (m) fns.push({ name: m[1], line: i + 1 });
});

/* ---------- main.js 的模块级声明（含 const 箭头函数 —— 最初漏的就是这类） ---------- */
const decls = new Set();
for (const l of src) {
  const m = l.match(/^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/);
  if (m) decls.add(m[1]);
  const im = l.match(/^import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)/);
  if (im) decls.add(im[1]);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CALLS = (name) => new RegExp('\\b' + esc(name) + '\\s*\\(');

/* ---------- 逐段统计 ---------- */
const rows = [];
for (const sec of sections) {
  const inside = fns.filter((f) => f.line >= sec.start && f.line <= sec.end);
  if (inside.length === 0) continue;

  const body = src.slice(sec.start - 1, sec.end).join('\n');
  const outsideText = [...src.slice(0, sec.start - 1), ...src.slice(sec.end)].join('\n');

  const insideNames = new Set(inside.map((f) => f.name));

  // 对外接口：段内函数被段外调用的个数
  const exposed = [...insideNames].filter((n) => CALLS(n).test(outsideText));
  // 外部依赖：段内调用的、段外的 main.js 模块级函数
  const deps = [...decls].filter((n) => !insideNames.has(n) && CALLS(n).test(body));

  rows.push({
    title: sec.title,
    lines: sec.end - sec.start + 1,
    fnCount: inside.length,
    exposed,
    deps
  });
}

rows.sort((a, b) => b.lines - a.lines);

console.log('main.js 各段落依赖分析（总 ' + src.length + ' 行）\n');
for (const r of rows) {
  // 可切性：对外接口 ≤3 且外部依赖 ≤6
  const cuttable = r.exposed.length <= 3 && r.deps.length <= 6;
  console.log(
    `${cuttable ? '✅' : '  '} ${r.title}`
    + `\n    行 ${r.lines}｜函数 ${r.fnCount}｜对外接口 ${r.exposed.length}`
    + `｜外部依赖 ${r.deps.length}`
  );
  if (r.exposed.length) console.log('    对外：' + r.exposed.join(', '));
  if (r.deps.length) console.log('    依赖：' + r.deps.join(', '));
  console.log('');
}
