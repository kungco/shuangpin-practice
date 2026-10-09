/**
 * 用 headless Chrome + CDP 驱动页面截图（开发期视觉验证）
 * ------------------------------------------------------------
 * 用法：node _test/tools/shot.mjs <url> <out.png> [width] [height] [script-file]
 *   - 若给了 script-file（一段 JS 表达式/语句），会在截图前注入执行，
 *     便于切到指定视图、模拟按键等。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [url, out, w = '1240', h = '900', scriptFile] = process.argv.slice(2);
const PORT = 9333;

/* 临时 profile 目录放在脚本自己身边（与 .gitignore 的 _test/.chrome-profile/ 对齐）。
   早期这里硬编码了另一个工作区的绝对路径，换台机器 / 换个 clone 位置就失效。 */
const userDir = resolve(dirname(fileURLToPath(import.meta.url)), '.chrome-profile');

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`,
  '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server',                    // 环境里有代理，必须显式绕过
  '--disable-gpu', '--hide-scrollbars',
  `--window-size=${w},${h}`,
  '--force-device-scale-factor=2',        // 2x 便于看清细节
  'about:blank'
], { stdio: 'ignore' });

async function cdpTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const j = await r.json();
      const page = j.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

let id = 0;
function client(ws) {
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

try {
  const target = await cdpTargets();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = client(ws);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(w), height: Number(h), deviceScaleFactor: 2, mobile: false
  });
  await send('Page.navigate', { url });
  await sleep(1200);

  if (scriptFile && existsSync(scriptFile)) {
    const src = readFileSync(scriptFile, 'utf8');
    const r = await send('Runtime.evaluate', {
      expression: src, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) console.error('注入脚本异常:', r.exceptionDetails.text);
    else if (r.result && r.result.value !== undefined) console.log('注入结果:', JSON.stringify(r.result.value));
    await sleep(700);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('已保存', out);
  ws.close();
} finally {
  chrome.kill();
}
