/**
 * 开发期静态服务器（零依赖）
 * ------------------------------------------------------------
 * 用途：给 headless Chrome / 人工预览提供 HTTP 服务。
 * 为什么不用 `python -m http.server`：那个进程会随父 shell 一起被回收，
 * 后台跑很容易在截图时已经死掉（ERR_CONNECTION_REFUSED）。
 *
 * 运行：node _test/serve.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 注意：必须用 resolve() 归一化，且补上路径分隔符 ——
// 否则 forward-slash 的 ROOT 与 path.join 产出的反斜杠路径永远 startsWith 失败，
// 表现为「所有静态资源 403」。
const ROOT = resolve(__dirname, '..') + sep;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const port = Number(process.argv[2]) || 8791;

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (p === '/' || p.endsWith('/')) p += 'index.html';
    const file = resolve(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500); res.end('error: ' + e.message);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${ROOT} at http://127.0.0.1:${port}/`);
});
