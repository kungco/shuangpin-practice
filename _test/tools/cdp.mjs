/**
 * headless Chrome / Edge + CDP 的最小封装（共享）
 * ------------------------------------------------------------
 * 用途：tools/shot.mjs（截图）与 browser.mjs（端到端冒烟）共用。
 * 只用 Node 内置能力（spawn / fetch / WebSocket），保持仓库零依赖。
 *
 * 设计要点：
 *  · Chrome 不在默认路径时可用 CHROME_PATH 环境变量指定；
 *    Windows 上还会兜底尝试 Edge（同为 Chromium，本应用不需要任何
 *    Chrome 专属能力，所以拿 Edge 跑冒烟同样是有效的真浏览器信号）。
 *  · 环境里有代理，必须 --no-proxy-server，否则 CDP 的本机 HTTP 请求
 *    也会被劫持（表现为 /json/list 永远连不上）。
 *  · 临时 profile 放在 _test/.chrome-profile/（已在 .gitignore）。
 *    注意要解析到 _test/ 而不是本文件所在的 tools/ 子目录 ——
 *    .gitignore 与 README 写的都是 _test/.chrome-profile/，两处必须一致，
 *    否则 profile 会以未跟踪文件的形式混进 git status。
 *  · findChrome() 找不到可执行文件时返回 null —— 调用方据此**跳过**而不是
 *    报错：CI（Linux runner）不保证有 Chrome，冒烟是「有真浏览器就加测」，
 *    不该让没有浏览器的环境红掉。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 找一个可用的 Chromium 系浏览器可执行文件；找不到返回 null */
export function findChrome() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:/Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
    const lad = process.env.LOCALAPPDATA || 'C:/Users/Default/AppData/Local';
    candidates.push(
      `${pf}/Google/Chrome/Application/chrome.exe`,
      `${pf86}/Google/Chrome/Application/chrome.exe`,
      `${lad}/Google/Chrome/Application/chrome.exe`,
      `${pf}/Microsoft/Edge/Application/msedge.exe`,
      `${pf86}/Microsoft/Edge/Application/msedge.exe`
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    );
  }
  for (const c of candidates) {
    if (!c) continue;
    try { if (existsSync(c)) return c; } catch (_) { /* 忽略非法路径 */ }
  }
  return null;
}

/**
 * 启动 headless 浏览器并建好 CDP 连接。
 *
 * @param {object} [opts]
 * @param {number} [opts.port=9333]   CDP 调试端口
 * @param {number} [opts.width=1240]  视口宽
 * @param {number} [opts.height=900]  视口高
 * @param {string} [opts.profileDir]  临时 profile 目录（默认 _test/.chrome-profile）
 * @returns {Promise<null|{exe:string, send:Function, setViewport:Function, close:Function}>}
 *          找不到浏览器时返回 null
 */
export async function launchChrome(opts = {}) {
  const port = opts.port ?? 9333;
  const width = opts.width ?? 1240;
  const height = opts.height ?? 900;
  const profileDir = opts.profileDir || resolve(HERE, '..', '.chrome-profile');

  const exe = findChrome();
  if (!exe) return null;

  const chrome = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server',                    // 环境里有代理，必须显式绕过
    '--disable-gpu', '--hide-scrollbars',
    `--window-size=${width},${height}`,
    '--force-device-scale-factor=2',        // 2x 便于看清细节
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    const target = await cdpTargets(port);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const send = makeClient(ws);

    async function setViewport(w, h, mobile = false) {
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Emulation.setDeviceMetricsOverride', {
        width: Number(w), height: Number(h), deviceScaleFactor: 2, mobile
      });
    }
    await setViewport(width, height);

    return {
      exe,
      send,
      setViewport,
      /** 正常收尾：先关 WebSocket 再杀进程 */
      close() {
        try { ws.close(); } catch (_) {}
        try { chrome.kill(); } catch (_) {}
      }
    };
  } catch (err) {
    try { chrome.kill(); } catch (_) {}
    throw err;
  }
}

/** 轮询 /json/list 直到 CDP 就绪（60 次 × 250ms） */
async function cdpTargets(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const j = await r.json();
      const page = j.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

/** CDP 请求/响应配对。拒绝时带上方法名，方便定位是哪一步挂了 */
function makeClient(ws) {
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, (m) => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

/**
 * 在页面里执行一段表达式并取回值。
 * 返回 { value, exception } —— 异常不抛出，交由调用方断言，
 * 这样「页面里炸了」也能以可读的失败出现在测试输出里。
 */
export async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
    return { value: undefined, exception: String(text).split('\n')[0] };
  }
  return { value: r.result ? r.result.value : undefined, exception: null };
}
