// 把 main.js 里的一个「段落」整体搬到 src/ui/views/ 下的独立模块。
//
// 【为什么需要工具】main.js 是高度互连的闭包（131 个顶层函数里只有 4 个是纯叶子），
// 手工搬运 300–400 行必然出错。这个工具做四件事：
//   1. 按**标题**定位段落（不写死行号 —— 拆走一段后其余段的行号会整体上移）
//   2. 逐字节等价搬运：跟踪模板字符串状态，内部行原样保留、其余行缩进
//      （模板字符串里是 HTML，一缩进字符串内容就变了）
//   3. 自动算出 ctx（段内用到的 main.js 模块级名字）与对外导出（段外引用的段内函数）
//   4. 自检：漏一个 ctx 就会在运行时 ReferenceError，这里提前拦住
//
// 【背景坑，改这个工具前先读】
//   · TDZ：段内函数原本是 function 声明（提升），搬成 const 后不再提升。
//     所以构造点必须放在「const 依赖初始化之后、任何调用之前」——
//     也就是 main.js 里那个「视图构造区」标记处，别放回原位置。
//   · 依赖扫描必须覆盖 const 箭头函数（如 $$），只扫 function 会漏。
//
// 用法：
//   node _test/tools/extract_view.mjs --title "错误热力图" \
//        --out src/ui/views/heatmap.js --factory createHeatmapView
//   加 --write 才真正改文件；不加只做 dry-run。
//   加 --force-write 允许在自检失败时仍然写盘（一般不要用）。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN = resolve(ROOT, 'src/main.js');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const TITLE = arg('title');
const OUT_REL = arg('out');
const FACTORY = arg('factory');
const WRITE = argv.includes('--write');
const FORCE = argv.includes('--force-write');

if (!TITLE || !OUT_REL || !FACTORY) {
  console.error('用法：node _test/tools/extract_view.mjs --title "段落标题" --out src/ui/views/x.js --factory createXView [--write]');
  process.exit(1);
}

const lines = readFileSync(MAIN, 'utf8').split('\n');

/* ---------------- 1. 定位段落 ---------------- */
const SECTION_RE = /^\/\* ={10,}/;
const titleIdx = lines.findIndex((l) => l.trim() === TITLE);
if (titleIdx < 0) throw new Error(`找不到标题为「${TITLE}」的段落`);
let start = titleIdx;
while (start > 0 && !SECTION_RE.test(lines[start])) start--;
const nextRel = lines.slice(titleIdx + 1).findIndex((l) => SECTION_RE.test(l));
if (nextRel < 0) throw new Error('找不到下一段的分隔注释');
let end = titleIdx + 1 + nextRel - 1;
while (end > start && lines[end].trim() === '') end--;

const body = lines.slice(start, end + 1);
console.log(`段落「${TITLE}」：第 ${start + 1}–${end + 1} 行（${body.length} 行）`);

/* ---------------- 2. 逐字节等价搬运（模板字符串内部不缩进） ---------------- */
const INDENT = '  ';
const moved = [];
let inTpl = false;
for (const raw of body) {
  const line = raw.replace(/\r$/, '');
  if (inTpl) moved.push(line);                                  // 字符串内容，原样
  else moved.push(line.trim() === '' ? '' : INDENT + line);
  let ticks = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '`' && line[i - 1] !== '\\') ticks++;
  }
  if (ticks % 2 === 1) inTpl = !inTpl;
}
if (inTpl) throw new Error('模板字符串未闭合，扫描逻辑有问题 —— 停下来人工检查');

// 去掉原段落标题注释
while (moved.length && (moved[0].trim() === '' || moved[0].includes('====') || moved[0].includes(TITLE))) moved.shift();
while (moved.length && moved[moved.length - 1].trim() === '') moved.pop();

/* ---------------- 3. 算 ctx 与导出 ---------------- */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 匹配一个标识符的「独立出现」。
// **不能用 \b**：\b 是「单词字符与非单词字符之间」的边界，而 $ 与 $$ 不是单词字符
// （\w = [A-Za-z0-9_]），所以 `\b\$\b` 永远匹配不上 `$('#x')`。
// 第一版就是这么漏掉 $ 的 —— ctx 里没有 $，heatmap.js 一渲染就
// ReferenceError: $ is not defined，而且自检同样用 \b，所以**没能拦住**。
// 改用「前后都不是标识符字符」的环视断言，$ 与普通名字都能正确匹配。
const IDENT = (n) => new RegExp('(?<![\\w$])' + esc(n) + '(?![\\w$])');
const CALLS = (n) => new RegExp('(?<![\\w$])' + esc(n) + '\\s*\\(');

const bodyText = body.join('\n');
const outsideText = [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');

// 段内声明的名字
const declaredInside = new Set();
for (const l of body) {
  const m = l.match(/^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/);
  if (m) declaredInside.add(m[1]);
}

// main.js 的模块级声明。**三种形态都要收**，漏一种就会漏依赖：
//   · function / const / let / var / class 的顶层声明
//   · import 的默认导入与命名空间导入：import X from ... / import * as S from ...
//   · **命名导入**：import { a, b, c } from ...
//     第三类最容易漏 —— keyMastery 就是从 storage.js 命名导入的，漏了它
//     heatmap.js 里 `keyMastery(...)` 直接 ReferenceError，而掌握度图层
//     恰好是所有失败断言里最安静的一个（错误被上层 try 吞掉，只表现为
//     「绿点没画出来」）。
const mainDecls = new Set();
for (const l of lines) {
  const m = l.match(/^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/);
  if (m) mainDecls.add(m[1]);
  const im = l.match(/^import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)/);
  if (im) mainDecls.add(im[1]);
}
// 命名导入可能跨多行，把整个文件拼成一段后按 `import { ... } from` 切块解
for (const blk of lines.join('\n').matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
  for (const item of blk[1].split(',')) {
    const n = item.trim().split(/\s+as\s+/).pop().trim();
    if (n) mainDecls.add(n);
  }
}

const CTX = [...mainDecls]
  .filter((n) => !declaredInside.has(n) && IDENT(n).test(bodyText))
  .sort();

// 导出：段内函数被段外调用
const EXPORTS = [...declaredInside].filter((n) => CALLS(n).test(outsideText)).sort();

console.log('ctx（' + CTX.length + '）：' + (CTX.join(', ') || '（无）'));
console.log('导出（' + EXPORTS.length + '）：' + (EXPORTS.join(', ') || '（无）'));

/* ---------------- 4. 自检 ---------------- */
const HEADER = `/**
 * ${TITLE}
 * ------------------------------------------------------------
 * 从 main.js 拆出来的视图。main.js 只负责在「视图构造区」里实例化它。
 *
 * 【为什么是工厂函数 + ctx，而不是顶层导出】
 * 这段代码用到 ${CTX.slice(0, 4).map((n) => '`' + n + '`').join(' / ')} 等 main.js 的共享设施。
 * 顶层导出会形成循环依赖（main.js 又要 import 本模块），所以由 main.js
 * 把依赖作为 ctx 传进来。
 *
 * 【为什么函数体没有缩进】
 * 段内有跨行模板字符串（拼 HTML）。搬进工厂后按理该缩进两格，但
 * **模板字符串内部的行一旦缩进，字符串内容就变了**（生成的 HTML 会多出空格）。
 * 为保「逐字节等价搬运」，这里刻意保持原缩进。改动本文件时请沿用这个约定。
 */

export function ${FACTORY}(ctx) {
  const {
${CTX.map((n, i) => `    ${n}${i === CTX.length - 1 ? '' : ','}`).join('\n')}
  } = ctx;

`;

const FOOTER = `

  return { ${EXPORTS.join(', ')} };
}
`;

const moduleText = HEADER + moved.join('\n') + '\n' + FOOTER;

const inModule = new Set();
for (const m of moduleText.matchAll(/(?:^|\s)(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
  inModule.add(m[1]);
}
const ctxSet = new Set(CTX);
const missing = [...mainDecls].filter((n) =>
  !inModule.has(n) && !ctxSet.has(n) && IDENT(n).test(moduleText));

if (missing.length) {
  console.error('❌ 自检失败：新模块引用了这些 main.js 模块级名字，但没进 ctx：');
  missing.forEach((n) => console.error('   ' + n));
  if (!FORCE) process.exit(1);
}

if (!WRITE) {
  console.log('\n— dry-run，未写盘（加 --write 才写入）—');
  console.log('新模块行数：' + moduleText.split('\n').length);
  console.log('main.js 行数：' + lines.length + ' → 约 ' + (lines.length - body.length + EXPORTS.length + 6));
  process.exit(0);
}

/* ---------------- 5. 摘掉原段落 + 在构造区插入 ---------------- */
const MARKER = '>>> 新视图插在这一行之前 <<<';
// 标记是一行独立的注释（不在块注释内部），构造代码插在它**之前**。
// 第一版把标记写在块注释的最后一行（`>>> ... <<< */`），然后往后找独立的 ` */`
// 行 —— 找不到就近的，于是一路找到几百行外另一个 JSDoc 的结尾，
// 把构造代码插进了「辅助功能」段中间。标记独立成行就没有这个歧义。
const markerIdx = lines.findIndex((l) => l.includes(MARKER));
if (markerIdx < 0) throw new Error('main.js 里找不到「视图构造区」的插入标记：' + MARKER);
const insertAfter = markerIdx - 1;   // 插在标记行之前 → 即标记行的上一行之后

// 变量名：createHeatmapView → heatmapView（首字母小写，和 shelfView 保持一致）
const varName = FACTORY.replace(/^create/, '').replace(/^./, (c) => c.toLowerCase());

const construction = [
  `const ${varName} = ${FACTORY}({`,
  '  ' + CTX.join(', '),
  '});',
  `const { ${EXPORTS.join(', ')} } = ${varName};`,
  ''
];

// 先删段落，再插入。**插入位置要按「删除后」的下标重算**：
// 视图构造区在文件开头，而被拆的段落在后面（3000+ 行），
// 此时插入点在被删段落之前，下标不变；反过来（段落在前）则要减去被删行数。
// 第一版没做这个换算，直接算成负数，splice 把构造代码插到了文件末尾。
const removed = end - start + 1;
const insertIdx = insertAfter >= start ? insertAfter - removed : insertAfter;

const newMain = [...lines.slice(0, start), ...lines.slice(end + 1)];
newMain.splice(insertIdx + 1, 0, ...construction);

// 还要加 import —— 漏了这一步的话 main.js 能过语法检查，
// 但一加载就 ReferenceError: createXxxView is not defined
// （集成测试「main.js 加载无异常」会抓到）。import 统一插在已有的
// ui/views/ import 之后，保持这一组在一起。
const IMPORT_LINE = `import { ${FACTORY} } from './${OUT_REL.replace(/^src\//, '')}';`;
const viewImportIdx = newMain.reduce(
  (acc, l, i) => (l.includes("from './ui/views/") ? i : acc), -1);
if (viewImportIdx >= 0) newMain.splice(viewImportIdx + 1, 0, IMPORT_LINE);
else {
  // 还没有任何视图 import —— 插在 import 区末尾
  let last = -1, inMulti = false;
  for (let i = 0; i < newMain.length; i++) {
    const t = newMain[i].trim();
    if (inMulti) {
      if (/^\}\s*from\s*'.*';\s*$/.test(t)) { last = i; inMulti = false; }
      continue;
    }
    if (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    if (t.startsWith('import')) { if (/;\s*$/.test(t)) last = i; else inMulti = true; continue; }
    break;
  }
  if (last < 0) throw new Error('找不到 import 区');
  newMain.splice(last + 1, 0, IMPORT_LINE);
}

const outPath = resolve(ROOT, OUT_REL);
writeFileSync(outPath, moduleText, 'utf8');
writeFileSync(MAIN, newMain.join('\n'), 'utf8');

console.log('\n已写出 ' + OUT_REL);
console.log('main.js 行数：' + lines.length + ' → ' + newMain.length);
console.log('注意：构造顺序有依赖时，需要手工调整「视图构造区」里的先后。');
