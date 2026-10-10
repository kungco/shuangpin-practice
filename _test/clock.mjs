/**
 * 虚拟时钟自检
 * ------------------------------------------------------------
 * tools/harness.mjs 里的虚拟时钟是整个测试改革的地基：集成测试与引擎测试
 * 都靠它把「等 3.2 秒反馈条消失」「等 250ms 的 ticker」这类等待变成
 * 确定性的一次 advance()。地基不牢，上层所有断言都不可信 ——
 * 所以这里单独把时钟本身的语义钉死，而不是假设它「应该没问题」。
 *
 * 运行：node _test/clock.mjs
 */
import { createVirtualClock } from './tools/harness.mjs';

let bad = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FAIL ') + m); if (!c) bad++; };

// 1) 基本推进
{
  const c = createVirtualClock(1000);
  const log = [];
  c.setTimeout(() => log.push('a'), 100);
  c.setTimeout(() => log.push('b'), 50);
  ok(log.length === 0, '未推进时不触发');
  c.advance(49);
  ok(log.join() === '', `推进 49ms 还没到 b（实际 ${log.join() || '空'}）`);
  c.advance(1);
  ok(log.join() === 'b', `推进到 50ms 触发 b（实际 ${log.join()}）`);
  c.advance(50);
  ok(log.join() === 'b,a', `推进到 100ms 触发 a（实际 ${log.join()}）`);
}

// 2) 同刻按插入序
{
  const c = createVirtualClock(0);
  const log = [];
  c.setTimeout(() => log.push(1), 10);
  c.setTimeout(() => log.push(2), 10);
  c.setTimeout(() => log.push(3), 10);
  c.advance(10);
  ok(log.join() === '1,2,3', `同刻保持插入序（实际 ${log.join()}）`);
}

// 3) clearTimeout
{
  const c = createVirtualClock(0);
  let hit = false;
  const id = c.setTimeout(() => { hit = true; }, 10);
  c.clearTimeout(id);
  c.advance(100);
  ok(!hit, 'clearTimeout 后不触发');
}

// 4) setInterval 重复
{
  const c = createVirtualClock(0);
  let n = 0;
  const id = c.setInterval(() => { n++; }, 100);
  c.advance(350);
  ok(n === 3, `interval 100ms 推进 350ms 触发 3 次（实际 ${n}）`);
  c.clearInterval(id);
  c.advance(1000);
  ok(n === 3, 'clearInterval 后不再触发');
}

// 5) advance 期间新挂的定时器
{
  const c = createVirtualClock(0);
  const log = [];
  c.setTimeout(() => { log.push('x'); c.setTimeout(() => log.push('y'), 10); }, 10);
  c.advance(20);
  ok(log.join() === 'x,y', `推进途中新挂的定时器也执行（实际 ${log.join()}）`);
}

// 6) now 单调
{
  const c = createVirtualClock(500);
  const t0 = c.now();
  c.advance(1234);
  ok(c.now() === t0 + 1234, `now 跟随推进（${t0} → ${c.now()}）`);
  ok(c.performanceNow() === c.now(), 'performanceNow 与 now 同源');
}

// 7) 回调抛错不中断
{
  const c = createVirtualClock(0);
  let after = false;
  c.setTimeout(() => { throw new Error('boom'); }, 10);
  c.setTimeout(() => { after = true; }, 10);
  c.advance(10);
  ok(after, '一个定时器抛错不影响后续定时器');
  ok(c.drainErrors().length === 1, '抛错被记录且可取出');
}

// 8) pending 计数
{
  const c = createVirtualClock(0);
  c.setTimeout(() => {}, 100);
  c.setInterval(() => {}, 100);
  ok(c.pendingCount() === 2, `pending 计数（实际 ${c.pendingCount()}）`);
  c.advance(100);
  ok(c.pendingCount() === 1, `一次性任务执行后减少（实际 ${c.pendingCount()}）`);
}

console.log(bad === 0 ? '\n虚拟时钟全部通过' : `\n${bad} 项失败`);
process.exit(bad ? 1 : 0);
