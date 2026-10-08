/**
 * 启动脚本静态自检
 * ------------------------------------------------------------
 * 为什么不做「真的跑一遍 bat」：沙箱环境不允许从这里派生 cmd.exe 进程。
 * 但启动脚本出错的代价很高（用户双击没反应），所以改为**静态检查**：
 * 把「跑起来才知道」的那几类问题提前钉死。
 *
 * 覆盖：
 *   A. 编码前提（bat 不能带 BOM、必须 CRLF、必须是 UTF-8）
 *   B. 脚本里引用的文件是否真实存在
 *   C. 标签 / goto 是否配对（错一个就是死循环或跳到文件尾）
 *   D. 回退链是否三级齐全
 *   E. 服务端脚本（serve.mjs / serve.ps1）的接口是否与调用方式一致
 *
 * 运行：node _test/launcher.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let fail = 0, pass = 0;
const ok = (c, m) => {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m); }
};

const BAT = resolve(ROOT, '启动双拼练习.bat');
const batBuf = readFileSync(BAT);
const bat = batBuf.toString('utf8');

/* ============================================================
   A. 编码前提
   ============================================================ */
console.log('【A】启动脚本的编码前提');

ok(existsSync(BAT), '启动脚本存在');
ok(!(batBuf[0] === 0xEF && batBuf[1] === 0xBB && batBuf[2] === 0xBF),
  '★ .bat 不带 UTF-8 BOM（带 BOM 时部分 Windows 会把首行当成非法命令，直接不执行）');
ok(bat.startsWith('@echo off\r\n'), '首行是 @echo off 且立刻跟上 CRLF');
ok(!/(?<!\r)\n/.test(bat), '★ 全部使用 CRLF 换行（.bat 用 LF 会在部分环境执行异常）');

// 必须是合法 UTF-8（无替换字符）
ok(!bat.includes('\uFFFD'), '文件是合法 UTF-8（无解码替换字符）');
ok(bat.includes('双拼练习'), '中文文案完好（没有被转成乱码）');

// chcp 必须在任何中文输出之前
const chcpIdx = bat.indexOf('chcp 65001');
const firstCJK = bat.search(/[\u4e00-\u9fff]/);
ok(chcpIdx > 0, '脚本里设置了 chcp 65001');
ok(firstCJK > chcpIdx,
  `★ chcp 65001 出现在第一处中文之前（位置 ${chcpIdx} < ${firstCJK}）`);

/* ============================================================
   B. 引用的文件都真实存在
   ============================================================ */
console.log('\n【B】脚本引用的文件');

ok(bat.includes('_test\\serve.mjs'), '脚本引用了 _test\\serve.mjs（Node 分支）');
ok(bat.includes('_test\\serve.ps1'), '脚本引用了 _test\\serve.ps1（PowerShell 分支）');
ok(existsSync(resolve(ROOT, '_test/serve.mjs')), '★ _test/serve.mjs 真实存在');
ok(existsSync(resolve(ROOT, '_test/serve.ps1')), '★ _test/serve.ps1 真实存在');
ok(existsSync(resolve(ROOT, 'index.html')), 'index.html 存在（脚本开头的检查依赖它）');

/* ============================================================
   C. 标签 / goto 配对
   ============================================================ */
console.log('\n【C】标签与 goto 配对');

const labels = new Set(
  Array.from(bat.matchAll(/^:(\w+)/gm)).map(m => m[1].toLowerCase())
);
const gotos = Array.from(bat.matchAll(/\bgoto\s+(\w+)/gi)).map(m => m[1].toLowerCase());
const calls = Array.from(bat.matchAll(/\bcall\s+:(\w+)/gi)).map(m => m[1].toLowerCase());

ok(labels.size > 0, `定义了标签：${Array.from(labels).join(', ')}`);
for (const g of new Set(gotos)) {
  ok(labels.has(g), `goto ${g} 有对应标签`);
}
for (const c of new Set(calls)) {
  ok(labels.has(c), `call :${c} 有对应标签`);
}
// 反向：定义了但没人跳的标签（可能是多余的，也可能是漏了 goto）
for (const l of labels) {
  const used = gotos.includes(l) || calls.includes(l);
  if (!used) console.log(`  · 提示：标签 :${l} 没有被 goto/call 引用`);
}

/* ============================================================
   D. 三级回退链
   ============================================================ */
console.log('\n【D】解析器回退链');

ok(bat.includes('set "MODE=py"'), '① Python 分支存在');
ok(bat.includes('set "MODE=node"'), '② Node.js 分支存在');
ok(bat.includes('set "MODE=ps"'), '③ PowerShell 分支存在');

// 顺序必须是 py → node → ps（不能颠倒，否则明明有 Python 却去用 PowerShell）
const iPy = bat.indexOf('MODE=py');
const iNode = bat.indexOf('MODE=node');
const iPs = bat.indexOf('MODE=ps');
ok(iPy < iNode && iNode < iPs,
  `★ 优先级顺序正确：Python(${iPy}) < Node(${iNode}) < PowerShell(${iPs})`);

// 每个分支都要有对应的启动命令
ok(/MODE!"=="py"/.test(bat) && /http\.server/.test(bat),
  'Python 分支调用了 http.server');
ok(/MODE!"=="node"/.test(bat) && /node.*_test\\serve\.mjs/.test(bat),
  'Node 分支调用了 _test\\serve.mjs');
ok(/MODE!"=="ps"/.test(bat) && /powershell.*serve\.ps1/.test(bat),
  'PowerShell 分支调用了 serve.ps1');

// 必须有「三者都没有」的兜底提示，不能静默失败
ok(bat.includes('没找到可用的本地服务方式'), '三者都不可用时有明确提示（不静默失败）');

// WindowsApps 占位符必须被排除（否则会弹应用商店而不是真的启动）
ok(/findstr \/i \/v "WindowsApps"/.test(bat),
  '★ Python 探测排除了 WindowsApps 占位符');

/* ============================================================
   E. 与服务端脚本的接口一致性
   ============================================================ */
console.log('\n【E】与服务端脚本的接口一致性');

const mjs = readFileSync(resolve(ROOT, '_test/serve.mjs'), 'utf8');
ok(/process\.argv\[2\]/.test(mjs), 'serve.mjs 从 argv[2] 读端口');
ok(/server\.listen\(port, '127\.0\.0\.1'/.test(mjs),
  '★ serve.mjs 只绑 127.0.0.1（不对外暴露）');
ok(/cache-control': 'no-store'/.test(mjs), 'serve.mjs 禁用了缓存');

const ps1Buf = readFileSync(resolve(ROOT, '_test/serve.ps1'));
const ps1 = ps1Buf.toString('utf8');
ok(ps1Buf[0] === 0xEF && ps1Buf[1] === 0xBB && ps1Buf[2] === 0xBF,
  '★ serve.ps1 带 UTF-8 BOM（PowerShell 5.1 无 BOM 会按 GBK 解码，中文注释会变乱码）');
ok(!ps1.includes('\uFFFD'), 'serve.ps1 是合法 UTF-8');
ok(/\$Port/.test(ps1) && /\[int\]\$Port/.test(ps1), 'serve.ps1 接受 -Port 参数');
ok(/\$Root/.test(ps1), 'serve.ps1 接受 -Root 参数');
// 调用方传的 -Port / -Root 名字要对得上
ok(bat.includes('-Port !PORT!'), '启动脚本传了 -Port');
ok(bat.includes('-Root "%APPDIR%"'), '启动脚本传了 -Root');
ok(ps1.includes('127.0.0.1'), 'serve.ps1 只绑 127.0.0.1');
// 穿越防护：拆成了 Test-InsideRoot 函数，既要函数在、也要真的被调用 ——
// 只断言「函数存在」会漏掉「定义了但忘了用」这种最危险的写法。
ok(/function Test-InsideRoot/.test(ps1), '★ serve.ps1 定义了 Test-InsideRoot');
ok(/Test-InsideRoot\s+-FullPath/.test(ps1), '★ Test-InsideRoot 被真正调用（不是定义了没用）');
ok(/StartsWith\(\$RootPath/.test(ps1), '★ 穿越判断基于规范化后的完整路径比对');
ok(/\$SelfTest/.test(ps1) && /-SelfTest/.test(ps1),
  'serve.ps1 支持 -SelfTest（可在不起监听的情况下验证防护逻辑）');
ok(/no-store/.test(ps1), 'serve.ps1 禁用了缓存');

/* ============================================================
   F. 不该出现的危险写法
   ============================================================ */
console.log('\n【F】安全检查');

ok(!/del\s+\/s|rmdir\s+\/s|format\s+/i.test(bat), '脚本里没有递归删除类命令');
ok(!/reg\s+(add|delete)/i.test(bat), '脚本不碰注册表');
ok(!/curl|wget|Invoke-WebRequest/i.test(bat), '脚本不联网下载任何东西');
ok(/exit \/b 1/.test(bat), '出错路径都有非零退出码');

console.log('\n' + (fail === 0
  ? `✅ 启动脚本自检全部通过（${pass} 项）`
  : `❌ 启动脚本自检共 ${fail} 项未通过（${pass} 通过）`));
process.exit(fail === 0 ? 0 : 1);
