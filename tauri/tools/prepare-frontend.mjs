// 把仓库根的静态站点复制到 tauri/dist/，供 Tauri 打包。
//
// 为什么要复制而不是直接把 frontendDist 指向仓库根：
//   仓库根还躺着 _test/、desktop/、tauri/、docs/、.git/ —— 指向它等于把这些
//   全部塞进应用包（desktop/node_modules 就有几百 MB）。这里只挑**运行时
//   真正需要**的三样，与 _test/tools/make_web_package.py 的口径一致：
//     index.html   页面
//     assets/      样式
//     src/         引擎、题库、界面模块
//   （网页版那份清单里还有「启动双拼练习.bat + 三个辅助脚本」，那是给浏览器
//     起本地服务用的；Tauri 自带 WebView 与内建协议，不需要它们。）
//
// 用法：node tools/prepare-frontend.mjs

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 按脚本自身的位置定位，不受调用时的工作目录影响
const here = dirname(fileURLToPath(import.meta.url));   // tauri/tools
const tauriDir = resolve(here, '..');                   // tauri
const repoRoot = resolve(tauriDir, '..');               // 仓库根
const outDir = join(tauriDir, 'dist');

const ITEMS = ['index.html', 'assets', 'src'];

function fail(msg) {
  console.error(`[prepare] ${msg}`);
  process.exit(1);
}

// 先校验源文件齐全，再动手 —— 免得删了旧产物才发现缺文件，
// 留下一个「半新半旧」的 dist。
for (const item of ITEMS) {
  const src = join(repoRoot, item);
  if (!existsSync(src)) fail(`缺少必需文件：${item}（期望在 ${src}）`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let files = 0;
let bytes = 0;

for (const item of ITEMS) {
  const src = join(repoRoot, item);
  const dst = join(outDir, item);
  cpSync(src, dst, { recursive: true });
  if (statSync(src).isFile()) {
    files += 1;
    bytes += statSync(src).size;
  }
}

// 统计一下复制了多少（目录要递归数）
function walk(dir) {
  let n = 0, b = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const r = walk(p); n += r.n; b += r.b; }
    else { n += 1; b += statSync(p).size; }
  }
  return { n, b };
}
const total = walk(outDir);

console.log(`[prepare] 已生成 ${outDir}`);
console.log(`[prepare] 文件数：${total.n}，大小：${(total.b / 1024).toFixed(1)} KB`);
console.log('[prepare] 清单：' + ITEMS.join('、'));
