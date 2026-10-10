// 双拼练习 — Electron 桌面壳
//
// 设计说明：
//   应用本体是纯静态站点（仓库根的 index.html + assets/ + src/），
//   原来靠 启动双拼练习.bat 起本地 HTTP 服务再让浏览器打开。
//   这个壳把同一份静态资源装进 Electron 窗口里，双击 .exe 即可运行，
//   不需要 Python / Node / 浏览器。
//
// 为什么用自定义协议而不是 file://：
//   浏览器与 Electron 都禁止在 file:// 下加载 ES 模块（CORS），
//   而 src/main.js 正是 ES 模块。因此注册一个 app:// 自定义协议，
//   以「本地 HTTP 服务」的语义提供文件，模块才能正常 import。
//   数据存储（localStorage）因此也有了稳定的 origin，升级后记录不丢。

const { app, BrowserWindow, protocol, net, shell } = require('electron');
const path = require('node:path');
const url = require('node:url');
const { spawn } = require('node:child_process');

// ---------- 兼容性处理：Chromium 沙箱 ----------
// 正常情况下 Chromium 的进程沙箱能正常工作，不应关闭（关掉会降低安全性）。
//
// 但在部分受限环境（虚拟机、远程桌面、企业安全策略、某些杀软/沙箱宿主）中，
// 沙箱初始化会失败，导致 GPU 进程与渲染进程双双崩溃
// （exit_code -1073741819 / 0xC0000005），表现为白屏、闪退或花屏。
//
// 处理策略：不默认关闭沙箱，而是在检测到「窗口起不来 / 渲染进程崩溃」时，
// 自动带 --no-sandbox 重启一次（见下方 relaunchWithoutSandbox）。
// 这样在正常机器上仍使用安全的默认沙箱，只在确有需要的环境降级。
//
// 手动强制关闭沙箱（调试用）：SHUANGPIN_NO_SANDBOX=1
const FORCE_NO_SANDBOX = process.env.SHUANGPIN_NO_SANDBOX === '1';
const ALREADY_RELAUNCHED = process.argv.includes('--shuangpin-no-sandbox');

if (FORCE_NO_SANDBOX || ALREADY_RELAUNCHED) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// 本应用是纯文本练习器，不使用 WebGL / 3D / 视频硬件解码。
// 在沙箱异常的环境里，GPU 进程往往最先崩溃，这里顺带降低其权重。
if (process.env.SHUANGPIN_ENABLE_GPU !== '1') {
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

// 静态资源根目录：打包后置于 resources/app-root，开发时是仓库根
const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app-root')
  : path.join(__dirname, '..');

const SCHEME = 'app';
const START_PAGE = `${SCHEME}://local/index.html`;

// 自定义协议必须在 app ready 之前注册为「标准 + 安全」，
// 这样 ES 模块、fetch、localStorage 才会被当作正常网页环境对待。
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function registerRootProtocol() {
  protocol.handle(SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    let rel = decodeURIComponent(pathname);

    // 目录请求回落到 index.html
    if (rel === '/' || rel === '') rel = '/index.html';

    const target = path.join(ROOT, rel);

    // 防目录穿越：解析后必须仍在 ROOT 之内
    const resolved = path.resolve(target);
    const rootResolved = path.resolve(ROOT);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    return net.fetch(url.pathToFileURL(resolved).toString());
  });
}

// 以 --no-sandbox 重新启动一次。用环境变量做标记，确保只会降级一次，
// 避免陷入「崩溃 → 重启 → 再崩溃」的死循环。
let relaunchScheduled = false;
function relaunchWithoutSandbox(reason) {
  if (ALREADY_RELAUNCHED || relaunchScheduled) return;
  relaunchScheduled = true;
  process.stderr.write(`[双拼练习] 检测到渲染异常（${reason}），改用无沙箱模式重启。\n`);
  const child = spawn(process.execPath, [...process.argv.slice(1), '--shuangpin-no-sandbox'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SHUANGPIN_NO_SANDBOX: '1' },
  });
  child.unref();
  app.quit();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    title: '双拼练习 · 小鹤方案',
    webPreferences: {
      // 页面是零依赖的纯前端，不需要 Node 能力，保持默认隔离更安全
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 站内链接走应用内，外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(`${SCHEME}://`)) return { action: 'allow' };
    shell.openExternal(target);
    return { action: 'deny' };
  });

  // 渲染进程崩溃（典型症状：沙箱不可用导致的白屏/闪退）。
  // 若尚未降级过，则自动以 --no-sandbox 重启整个应用再试一次。
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') return;
    relaunchWithoutSandbox(`render-process-gone: ${details.reason}`);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // -2 (ERR_FAILED) 常见于沙箱/GPU 初始化失败
    if (errorCode === -2) {
      relaunchWithoutSandbox(`did-fail-load: ${errorDescription} (${validatedURL})`);
    }
  });

  win.loadURL(START_PAGE);
}

app.whenReady().then(() => {
  registerRootProtocol();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Windows 上关窗即退出，符合桌面应用直觉
  if (process.platform !== 'darwin') app.quit();
});
