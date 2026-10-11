// 「精简版」构建入口（跨平台，不依赖 cross-env）。
//
// 为什么要这个文件而不是在 package.json 里写 `SHUANGPIN_SLIM=1 electron-builder`：
// npm script 里那种写法只在类 Unix shell 下成立，Windows 的 cmd 会直接报错，
// 而本项目的主要使用者是 Windows 用户。这里用 Node 显式设好环境变量再起
// electron-builder，两边行为一致，也不用为此引入 cross-env 依赖。
//
// 用法：npm run build:slim

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const isWin = process.platform === 'win32';
const bin = path.join(
  __dirname, '..', 'node_modules', '.bin',
  isWin ? 'electron-builder.cmd' : 'electron-builder'
);

console.log('[build:slim] 以精简模式构建（裁剪 GPU / 媒体运行时组件）');
console.log('[build:slim] 这是实验性裁剪，构建完成后请在目标机器上确认应用能正常启动。');

const res = spawnSync(bin, ['--win', 'portable'], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, SHUANGPIN_SLIM: '1' },
  shell: isWin
});

process.exit(res.status == null ? 1 : res.status);
