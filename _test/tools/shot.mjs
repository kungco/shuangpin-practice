/**
 * 用 headless Chrome + CDP 驱动页面截图（开发期视觉验证）
 * ------------------------------------------------------------
 * 用法：node _test/tools/shot.mjs <url> <out.png> [width] [height] [script-file]
 *   - 若给了 script-file（一段 JS 表达式/语句），会在截图前注入执行，
 *     便于切到指定视图、模拟按键等。
 *
 * 浏览器探测与 CDP 连接的公共部分抽到了 tools/cdp.mjs，
 * 与 browser.mjs（端到端冒烟）共用同一份。
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChrome, evaluate } from './cdp.mjs';

const [url, out, w = '1240', h = '900', scriptFile] = process.argv.slice(2);

if (!url || !out) {
  console.error('用法：node _test/tools/shot.mjs <url> <out.png> [width] [height] [script-file]');
  process.exit(2);
}

const chrome = await launchChrome({ port: 9333, width: Number(w), height: Number(h) });
if (!chrome) {
  console.error('未找到 Chrome/Edge（可用 CHROME_PATH 环境变量指定），无法截图。');
  process.exit(3);
}

try {
  await chrome.send('Page.navigate', { url });
  await sleep(1200);

  if (scriptFile && existsSync(scriptFile)) {
    const src = readFileSync(scriptFile, 'utf8');
    const { value, exception } = await evaluate(chrome.send, src);
    if (exception) console.error('注入脚本异常:', exception);
    else if (value !== undefined) console.log('注入结果:', JSON.stringify(value));
    await sleep(700);
  }

  const shot = await chrome.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true
  });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('已保存', out);
} finally {
  chrome.close();
}
