/**
 * 真实浏览器端到端冒烟（headless Chrome/Edge + CDP）
 * ------------------------------------------------------------
 * linkedom 集成测试覆盖「接线」：选择器写没写错、事件绑没绑上、模块间调用
 * 顺序对不对。但它**模拟不了**真浏览器的布局、焦点、输入管线与 Canvas 光栅化 ——
 * 这四类问题恰好都是「集成测试全绿、真机一打开就是不对」的那类。
 * 本套件补的就是这四个边界，只做少量、只断言最要紧的：
 *
 *   【1】练习输入  —— 用 CDP 的 Input.dispatchKeyEvent 发**真实键盘事件**
 *                     （不是 JS 合成事件），验证「物理按键 → 引擎推进」这条
 *                     真浏览器的输入链路。
 *   【2】弹窗焦点  —— 打开弹窗后焦点必须落在弹窗内的主按钮上，Tab 循环
 *                     不许逃出弹窗，Esc 关闭。焦点是浏览器原生行为，
 *                     linkedom 的 focus() 是空实现，完全观测不到。
 *   【3】Canvas 统计 + 读屏替代 —— 三张统计图必须真的画出了像素
 *                     （linkedom 里是空桩，画没画根本不知道），并且
 *                     带有 role="img" 与随数据更新的 aria-label。
 *   【4】窄屏布局  —— 390×844 下不得出现横向滚动（布局炸了的表现）。
 *
 * 环境策略：找不到 Chrome/Edge 时**跳过**（exit 0），因为 CI 的 Linux runner
 * 不保证有浏览器；冒烟是「有真浏览器就加测」，不该让没有浏览器的环境红掉。
 * 本机开发时它是实实在在跑的。
 *
 * 运行：node _test/browser.mjs   （会自动起一个临时本地服务，跑完即关）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';
import { cdpUnavailableReason, launchChrome, evaluate } from './tools/cdp.mjs';

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

let fail = 0, skipped = 0;
const ok = (c, m) => {
  if (c) { console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m); }
};
const note = (m) => { skipped++; console.log('  · ' + m); };

/* ---------- 找一个空闲端口（避免与开发中的服务撞车） ---------- */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/* ---------- 起临时服务（子进程，随本进程退出而退出） ---------- */
const port = await freePort();
const server = spawn(process.execPath,
  [new URL('serve.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), String(port)],
  { stdio: 'ignore' });
const BASE = `http://127.0.0.1:${port}/index.html`;

async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return true;
    } catch (_) { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

/* ---------- 页面小工具 ---------- */
/** 导航到应用并等 boot 完成（导航 + 轮询 __app 就绪） */
async function goto(chrome) {
  await chrome.send('Page.navigate', { url: BASE });
  const { value } = await evaluate(chrome.send, `
    (async () => {
      for (let i = 0; i < 80; i++) {
        if (window.__app && document.querySelector('#btnStart')) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    })()
  `);
  return value === true;
}

/** 在页面里点一个元素（用原生 click，走完整的事件管线） */
async function click(chrome, sel) {
  const { value, exception } = await evaluate(chrome.send, `
    (() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false; el.click(); return true; })()
  `);
  if (exception) throw new Error(`点击 ${sel} 失败：${exception}`);
  return value === true;
}

/** 发一个真实的物理按键（keyDown + keyUp），走浏览器原生输入管线 */
function realKey(chrome, { key, code, vk, text }) {
  return (async () => {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  })();
}

/** 等某条件在页面里成立（轮询 evaluate） */
async function until(chrome, expr, { timeoutMs = 3000, label = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const { value } = await evaluate(chrome.send, expr);
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(80);
  }
}

/* ============================================================ */
console.log('\n【浏览器冒烟】');

const chrome = await (async () => {
  const why = cdpUnavailableReason();
  if (why) {
    note(`跳过：${why} —— CI 无浏览器 / 低版本 Node 属预期，不是被测代码的问题`);
    return null;
  }
  return launchChrome({ port: 9344, width: 1240, height: 900 });
})();
if (!chrome) {
  server.kill();
  console.log('\n✅ 浏览器冒烟跳过（环境不具备）');
  process.exit(0);
}

if (!(await waitServer())) {
  note('临时服务未能就绪，本套件跳过（这不测量浏览器，是环境问题）');
  chrome.close();
  server.kill();
  console.log('\n✅ 浏览器冒烟跳过（服务未就绪）');
  process.exit(0);
}

try {
  /* ---------- 【0】页面能加载、应用能启动 ---------- */
  console.log('\n【0】加载与启动');
  ok(await goto(chrome), '页面加载完成，应用已启动（window.__app 就绪）');
  {
    const { value } = await evaluate(chrome.send, `
      ({ nav: !!document.querySelector('#nav'),
         modes: document.querySelectorAll('#modeGrid .mode-card').length,
         keymap: !!document.querySelector('#keymapSvg, svg') })
    `);
    ok(value && value.nav, `导航栏已渲染`);
    ok(value && value.modes >= 9, `练习模式卡片渲染完整（实际 ${value && value.modes} 个）`);
  }

  /* ---------- 【1】练习输入：真实键盘事件推进引擎 ---------- */
  console.log('\n【1】练习输入（CDP 真实键盘事件）');
  {
    await click(chrome, '#modeGrid .mode-card[data-mode="char"]');
    await click(chrome, '#btnStart');
    await until(chrome, `window.__app.engine && window.__app.engine.state === 'running'`,
      { label: '引擎进入 running' });
    ok(true, '练习已开始（引擎 running）');

    // 取当前期望键位，用**真实键盘事件**按下去
    const tgt = (await evaluate(chrome.send,
      `(() => { const t = window.__app.engine.currentTarget();
         return t ? { key: String(t.keys[t.pos]).toLowerCase(), pos: t.pos, ki: window.__app.engine.keyIndex } : null; })()`
    )).value;
    ok(!!tgt && !!tgt.key, `拿到当前期望键位「${tgt && tgt.key}」`);

    await realKey(chrome, { key: tgt.key, code: 'Key' + tgt.key.toUpperCase(), vk: tgt.key.toUpperCase().charCodeAt(0), text: tgt.key });
    // 轮询等引擎推进，不用固定 sleep —— CI 的 runner 慢，固定值赌不得
    await until(chrome, `window.__app.engine.keyIndex === ${tgt.ki + 1}`,
      { label: '真实按键推进引擎' });

    const after = (await evaluate(chrome.send,
      `({ ki: window.__app.engine.keyIndex, pos: window.__app.engine.currentTarget().pos,
          prompt: document.querySelector('#prompt').textContent.length })`)).value;
    ok(after && after.ki === tgt.ki + 1,
      `真实按键被引擎受理（keyIndex ${tgt.ki} → ${after && after.ki}）`);
    ok(after && after.prompt > 0, `题干在真实浏览器里有内容（${after && after.prompt} 字符）`);

    // 错误路径：按一个错的键，应当不推进（真浏览器里同样要拦住）
    const before = after.ki;
    const wrong = 'qwertyuiop'.split('').find(c => c !== tgt.key) || 'q';
    await realKey(chrome, { key: wrong, code: 'Key' + wrong.toUpperCase(), vk: wrong.toUpperCase().charCodeAt(0), text: wrong });
    await sleep(150);   // 给「可能的错误反馈」留出触发机会，再验证确实没推进
    const afterWrong = (await evaluate(chrome.send, `window.__app.engine.keyIndex`)).value;
    ok(afterWrong === before, `按错键不推进（keyIndex 稳定在 ${before}）`);

    // 收尾：结束会话，免得影响后面的统计检查
    await evaluate(chrome.send, `window.__app.engine.finish('user'); true`);
    await sleep(200);
    await evaluate(chrome.send, `
      (() => { const b = document.querySelector('#modal [data-act="close"], #modal [data-act]');
               if (b) b.click(); return true; })()
    `);
    await sleep(200);
  }

  /* ---------- 【2】弹窗焦点：原生焦点行为 ---------- */
  console.log('\n【2】弹窗焦点（原生 focus / Tab / Esc）');
  {
    await click(chrome, '#nav .nav-btn[data-view="stats"]');
    await sleep(200);
    await click(chrome, '#btnClearStats');
    await until(chrome, `!document.querySelector('#overlay').hidden`, { label: '弹窗打开' });
    ok(true, '「清空记录」弹窗已打开');

    const f1 = (await evaluate(chrome.send, `
      (() => { const ae = document.activeElement;
        return { inModal: !!(ae && document.querySelector('#modal').contains(ae)),
                 isAction: !!(ae && ae.matches && ae.matches('[data-act]')),
                 tag: ae ? ae.tagName : '' }; })()
    `)).value;
    ok(f1 && f1.inModal, `初始焦点已落进弹窗（${f1 && f1.tag}）`);
    ok(f1 && f1.isAction, `初始焦点在可操作按钮上（读屏能直接念出动作）`);

    // Tab 循环不许逃出弹窗
    for (let i = 0; i < 6; i++) {
      await realKey(chrome, { key: 'Tab', code: 'Tab', vk: 9 });
      await sleep(40);
    }
    const f2 = (await evaluate(chrome.send, `
      (() => { const ae = document.activeElement;
        return { inModal: !!(ae && document.querySelector('#modal').contains(ae)) }; })()
    `)).value;
    ok(f2 && f2.inModal, `Tab 循环 6 次后焦点仍在弹窗内`);

    // Esc 关闭（轮询等弹窗真的关上，不赌固定毫秒）
    await realKey(chrome, { key: 'Escape', code: 'Escape', vk: 27 });
    await until(chrome, `document.querySelector('#overlay').hidden`, { label: 'Esc 关闭弹窗' });
    const f3 = (await evaluate(chrome.send, `
      ({ hidden: document.querySelector('#overlay').hidden,
         inModal: (() => { const ae = document.activeElement;
           return !!(ae && document.querySelector('#modal') && document.querySelector('#modal').contains(ae)); })() })
    `)).value;
    ok(f3 && f3.hidden, 'Esc 关闭弹窗');
    ok(f3 && !f3.inModal, '关闭后焦点已归还（不再停留在弹窗内）');
    // 把视图切回练习，给后面用例一个干净的起点
    await click(chrome, '#nav .nav-btn[data-view="practice"]');
    await sleep(150);
  }

  /* ---------- 【3】Canvas 统计 + 读屏替代 ---------- */
  console.log('\n【3】Canvas 统计（真像素）与读屏替代');
  {
    await click(chrome, '#nav .nav-btn[data-view="stats"]');
    await sleep(400);
    const res = (await evaluate(chrome.send, `
      (() => {
        const ids = ['historyChart', 'scoreChart', 'dailyChart'];
        const out = {};
        for (const id of ids) {
          const c = document.getElementById(id);
          if (!c) { out[id] = { missing: true }; continue; }
          const role = c.getAttribute('role');
          const label = c.getAttribute('aria-label') || '';
          let painted = -1;
          try {
            const ctx = c.getContext('2d');
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            painted = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) painted++;
          } catch (_) {}
          out[id] = { role, labelLen: label.length, painted, w: c.width, h: c.height };
        }
        return out;
      })()
    `)).value;
    for (const id of ['historyChart', 'scoreChart', 'dailyChart']) {
      const v = res && res[id];
      ok(v && !v.missing, `${id} 存在`);
      ok(v && v.painted > 0, `${id} 真的画出了像素（非透明像素 ${v ? v.painted : '?'} 个，${v ? v.w : '?'}×${v ? v.h : '?'}）`);
      ok(v && v.role === 'img', `${id} 带 role="img"（读屏能把它当图像读）`);
      ok(v && v.labelLen > 0, `${id} 带 aria-label（读屏能念出图的内容，长度 ${v ? v.labelLen : 0}）`);
    }
    // 标签必须**随数据**更新，不能是 index.html 里那句静态兜底。
    // 这里逐张图对动态摘要的特征短语做匹配 —— 曾验证过：只查「label 非空」
    // 会被静态兜底（「练习成绩曲线」6 个字）蒙混过去，断言形同虚设。
    const labels = (await evaluate(chrome.send, `
      ({ h: document.getElementById('historyChart').getAttribute('aria-label'),
         s: document.getElementById('scoreChart').getAttribute('aria-label'),
         d: document.getElementById('dailyChart').getAttribute('aria-label') })
    `)).value || {};
    ok(/^近 \d+ 轮|^还没有练习记录/.test(labels.h || ''),
      `historyChart 的 aria-label 是数据摘要（「${(labels.h || '').slice(0, 30)}」）`);
    ok(/^\d+ 次有效测验|^已完成的测验|^还没有做过能力测验/.test(labels.s || ''),
      `scoreChart 的 aria-label 是数据摘要（「${(labels.s || '').slice(0, 30)}」）`);
    ok(/^最近 \d+ 天/.test(labels.d || ''),
      `dailyChart 的 aria-label 是数据摘要（「${(labels.d || '').slice(0, 30)}」）`);
  }

  /* ---------- 【4】窄屏布局 ---------- */
  console.log('\n【4】窄屏布局（390×844）');
  {
    const NARROW_W = 390, NARROW_H = 844;
    await chrome.setViewport(NARROW_W, NARROW_H, true);
    await chrome.send('Page.navigate', { url: BASE });
    await until(chrome, `window.__app && document.querySelector('#btnStart')`, { label: '窄屏下应用重新启动' });
    await sleep(300);
    const r = (await evaluate(chrome.send, `
      (() => {
        const de = document.documentElement;
        const nav = document.querySelector('#nav');
        const grid = document.querySelector('#modeGrid');
        return {
          sw: de.scrollWidth, iw: window.innerWidth,
          navH: nav ? nav.offsetHeight : 0,
          navBtns: document.querySelectorAll('#nav .nav-btn').length,
          gridH: grid ? grid.offsetHeight : 0
        };
      })()
    `)).value;
    /* 注意比较基准：不能跟 window.innerWidth 比 —— 内容真放不下时
       （比如 body 被设了 min-width），Chrome 会把布局视口一起撑大，
       两个数一起涨，比较恒成立，断言就瞎了（反向验证时踩到）。
       要跟**我们模拟进去的**视口宽比，那才是「手机屏幕有多宽」。 */
    ok(r && r.sw <= NARROW_W + 1,
      `窄屏无横向滚动（scrollWidth ${r && r.sw} ≤ 模拟视口 ${NARROW_W}）`);
    ok(r && r.navH > 0 && r.navBtns >= 6, `导航在窄屏下仍可用（高 ${r && r.navH}px，${r && r.navBtns} 个按钮）`);
    ok(r && r.gridH > 0, `模式卡片在窄屏下仍渲染（高 ${r && r.gridH}px）`);

    // 恢复视口，避免影响（本套件是最后一步，但保持习惯）
    await chrome.setViewport(1240, 900, false);
  }
} catch (err) {
  fail++;
  console.log('  ✗ 冒烟过程中断：' + (err && err.message));
} finally {
  chrome.close();
  server.kill();
}

console.log('\n' + (fail === 0
  ? '✅ 浏览器冒烟全部通过'
  : `❌ 浏览器冒烟共 ${fail} 项未通过`));
process.exit(fail === 0 ? 0 : 1);
