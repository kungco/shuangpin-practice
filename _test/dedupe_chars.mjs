/**
 * 单字表去重（构建期一次性工具）
 * 运行：node _test/dedupe_chars.mjs [--write]
 *
 * 背景：原 CHARS_TIER1–5 存在 36 处跨档重复（同一字出现在两个档位）。
 *       ALL_CHARS 用 Object.assign 合并，结果本身正确（拼音一致），
 *       但重复会让「分层抽样」出现权重偏差，属于数据卫生问题，顺手修掉。
 *
 * 策略：保留该字首次出现的档位，从后续档位移除，并重排为每行 8 项。
 *       档 6（扩充字）是我们新加的，天然无重复。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(root, 'src/data/pinyin.js');
const WRITE = process.argv.includes('--write');

const TIER_NAMES = [
  'CHARS_TIER1', 'CHARS_TIER2', 'CHARS_TIER3', 'CHARS_TIER4', 'CHARS_TIER5', 'CHARS_TIER6'
];

let src = readFileSync(DATA, 'utf8');

/* 解析各档位的字→拼音对 */
function parseTier(name) {
  const i = src.indexOf(`export const ${name} = {`);
  if (i < 0) throw new Error(`找不到 ${name}`);
  const j = src.indexOf('\n};', i);
  const body = src.slice(i, j);
  const pairs = [...body.matchAll(/"(.+?)"\s*:\s*"(.+?)"/g)].map(m => [m[1], m[2]]);
  return { i, j, pairs };
}

const tiers = TIER_NAMES.map(n => ({ name: n, ...parseTier(n) }));

/* 跨档去重：保留首次出现 */
const owner = new Map();
let removed = 0;
for (const t of tiers) {
  const kept = [];
  for (const [ch, py] of t.pairs) {
    if (owner.has(ch)) { removed++; continue; }
    owner.set(ch, py);
    kept.push([ch, py]);
  }
  t.kept = kept;
}

console.log('各档位去重后规模：');
for (const t of tiers) {
  console.log(`  ${t.name}: ${t.pairs.length} → ${t.kept.length}`);
}
console.log(`合计移除重复 ${removed} 项`);

/* 校验：全局唯一 */
{
  const seen = new Set();
  for (const t of tiers) for (const [ch] of t.kept) {
    if (seen.has(ch)) throw new Error(`去重失败，仍重复: ${ch}`);
    seen.add(ch);
  }
  console.log(`全局唯一字 ${seen.size} 个`);
}

if (!WRITE) {
  console.log('\n（未加 --write，不写盘）');
  process.exit(0);
}

/* 从后往前替换，避免偏移失效 */
const fmt = (pairs) => pairs.map(([c, p], i) => {
  const sep = i === pairs.length - 1 ? '' : ',';
  return `  "${c}": "${p}"${sep}`;
});

// 每行 8 项
function fmtRows(pairs) {
  const lines = [];
  for (let i = 0; i < pairs.length; i += 8) {
    const row = pairs.slice(i, i + 8).map(([c, p], k) => {
      const isLast = i + k === pairs.length - 1;
      return `"${c}": "${p}"${isLast ? '' : ','}`;
    });
    lines.push('  ' + row.join(' '));
  }
  return lines.join('\n');
}

for (const t of [...tiers].reverse()) {
  const head = src.indexOf(`export const ${t.name} = {`);
  const end = src.indexOf('\n};', head);
  const block = `export const ${t.name} = {\n${fmtRows(t.kept)}\n};`;
  src = src.slice(0, head) + block + src.slice(end + 3);
}

writeFileSync(DATA, src, 'utf8');
console.log('✅ 已写盘');
