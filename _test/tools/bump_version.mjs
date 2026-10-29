#!/usr/bin/env node
// 统一修改版本号。
//
// 【为什么需要】版本号散在 5 个文件里，全是手改就一定会漏：
//     package.json                     仓库根（也是自检脚本读的那份）
//     desktop/package.json             Electron 版
//     tauri/package.json               Tauri 版
//     tauri/src-tauri/Cargo.toml       Rust 包
//     tauri/src-tauri/tauri.conf.json  打包配置（写进 exe 的版本资源）
// 漏掉 tauri.conf.json 的话，exe 属性里显示的还是旧版本，而下载文件名是新版本 ——
// 这类不一致只有用户会碰到，很难在开发时发现。
// 现在 launcher.mjs 里有一条自检专门钉住「五处必须一致」，这个脚本负责改。
//
// 【为什么用正则而不是 JSON.parse】解析后重新序列化会重排/重格式化整个文件
// （package.json 里有带长注释的 "//" 字段，格式变了 review 时看不出真正改了什么）。
// 只替换版本值那一处，diff 里就只有一行变化。
//
// 用法：
//     node _test/tools/bump_version.mjs 1.7.0
//     node _test/tools/bump_version.mjs 1.7.0 --dry-run

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 每个待改文件配一条规则。
 * `pattern` 必须只匹配**版本值**那一处，且只替换第一个匹配
 * （这几个文件里版本都出现在开头，第一次出现就是它）。
 */
const TARGETS = [
  { file: 'index.html', pattern: /(id="appVersion"[^>]*>v)([^<]+)(<)/, label: '界面版本' },
  {
    file: 'desktop/package-lock.json',
    pattern: /("version"\s*:\s*")([^"]+)(")/,
    label: 'Electron 锁文件版本'
  },
  {
    file: 'desktop/package-lock.json',
    pattern: /("packages"\s*:\s*\{\s*""\s*:\s*\{[\s\S]*?"version"\s*:\s*")([^"]+)(")/,
    label: 'Electron 锁文件根包'
  },
  {
    file: 'tauri/src-tauri/Cargo.lock',
    pattern: /(\[\[package\]\]\r?\nname = "shuangpin-practice"\r?\nversion = ")([^"]+)(")/,
    label: 'Rust Cargo.lock'
  },
  {
    file: 'package.json',
    pattern: /("version"\s*:\s*")([^"]+)(")/,
    label: '仓库根 package.json'
  },
  {
    file: 'desktop/package.json',
    pattern: /("version"\s*:\s*")([^"]+)(")/,
    label: 'Electron 版 package.json'
  },
  {
    file: 'tauri/package.json',
    pattern: /("version"\s*:\s*")([^"]+)(")/,
    label: 'Tauri 版 package.json'
  },
  {
    file: 'tauri/src-tauri/Cargo.toml',
    pattern: /^(version\s*=\s*")([^"]+)(")/m,
    label: 'Rust Cargo.toml'
  },
  {
    file: 'tauri/src-tauri/tauri.conf.json',
    pattern: /("version"\s*:\s*")([^"]+)(")/,
    label: 'Tauri 打包配置'
  }
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const version = args.find(a => !a.startsWith('--'));

if (!version) {
  console.error('用法：node _test/tools/bump_version.mjs <新版本号> [--dry-run]');
  console.error('例如：node _test/tools/bump_version.mjs 1.7.0');
  process.exit(1);
}

// 版本号要能当文件名和 tag 用，格式卡严一点
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`❌ 版本号必须是 x.y.z 形式（收到 "${version}"）`);
  process.exit(1);
}

let changed = 0;
let already = 0;
const rows = [];

for (const t of TARGETS) {
  const path = join(REPO_ROOT, t.file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`❌ 读不到 ${t.file}：${err.message}`);
    process.exit(1);
  }

  const m = text.match(t.pattern);
  if (!m) {
    // 匹配不到说明文件结构变了（或规则写错了）—— 必须报错，
    // 静默跳过就等于悄悄漏改一处。
    console.error(`❌ 在 ${t.file} 里找不到版本号字段（规则可能已失效，请检查）`);
    process.exit(1);
  }

  const old = m[2];
  if (old === version) {
    already++;
    rows.push(`  = ${t.label.padEnd(22)} ${old}（已是目标版本）`);
    continue;
  }

  rows.push(`  → ${t.label.padEnd(22)} ${old} → ${version}`);
  if (!dryRun) {
    // 只替换第一次出现，保持文件其余部分逐字节不变
    writeFileSync(path, text.replace(t.pattern, `$1${version}$3`), 'utf8');
  }
  changed++;
}

console.log(dryRun ? '（dry-run，未写入）' : '已更新版本号：');
console.log(rows.join('\n'));
console.log('');
console.log(`  改动 ${changed} 处，${already} 处本就是目标版本，共检查 ${TARGETS.length} 个文件`);

if (changed > 0 && !dryRun) {
  console.log('');
  console.log('下一步：');
  console.log('  1. 重新构建（版本号会写进 exe 的属性与文件名）');
  console.log('  2. node _test/launcher.mjs   # 确认五处一致');
}

process.exit(0);
