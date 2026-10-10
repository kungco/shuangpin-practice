/**
 * 可分享的练习包自检
 * ------------------------------------------------------------
 * 覆盖「导出练习包 → 导入到另一台设备 → 判重跳过」这条链路：
 *   1. 导出内容  只装材料 + 练习设置，**绝不含任何成绩**
 *   2. 设置白名单  主题/音效/快捷键等个人偏好不进包
 *   3. 导入合并  只增不减、按正文判重、不覆盖本机已有设置
 *   4. 格式校验  认错文件类型时给得出「该用哪个入口」的提示
 *
 * 运行：node _test/pack.mjs
 *
 * 为什么单独一个文件：这一层唯一但**极其严重**的风险是数据泄露 ——
 * 练习包是要发给别人的，一旦混进了历史成绩或隐私设置，
 * 发出去就收不回来了。所以这里必须逐条断言「不该有的字段确实没有」，
 * 而不是只测「该有的字段有」。
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗ ' + m); } else { console.log('  ✓ ' + m); } };

const require = createRequire(import.meta.url);
let modSeq = 0;

function makeLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] ?? null,
    clear: () => map.clear()
  };
}

const base = new URL('../src/core/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fresh = (f) => import(`${pathToFileURL(base + f).href}?t=${++modSeq}`);

const ls = makeLocalStorage();
globalThis.window = {
  localStorage: ls, setTimeout, clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
};

const S = await fresh('storage.js');

/* ============================================================
   【1】导出：只装材料 + 练习设置
   ============================================================ */
console.log('【1】exportPack 的内容范围');

{
  S.clearAll();
  S.addShelfEntry({ title: '形近字练习', tags: ['基础', '形近'], text: '己已巳 戊戌戍 未末' });
  S.addShelfEntry({ title: '唐诗一首', tags: ['诗词'], text: '床前明月光疑是地上霜' });

  /* 造一批「个人成绩」，用来验证它们**不会**进练习包 */
  S.appendRecord({
    id: 'r1', ts: Date.now(), date: S.dateStr(new Date()), mode: 'char',
    durationSec: 120, totalChars: 50, correctChars: 48, wrongChars: 2,
    keystrokes: 100, speed: 25, accuracy: 96
  });
  S.recordWeak({ char: '己', word: '', pinyin: 'ji' });

  const pack = S.exportPack();

  ok(pack.app === S.PACK_APP, 'app 标识为练习包专用值（与完整备份区分）');
  ok(pack.app !== 'shuangpin-practice', 'app 标识不是完整备份用的那个值');
  ok(pack.version === S.PACK_VERSION, '带上格式版本号');
  ok(Array.isArray(pack.entries), 'entries 是数组');
  ok(pack.entries.length === 2, `装进了 2 份材料（实际 ${pack.entries.length}）`);
  ok(pack.entries.every(e => e.title && e.text), '每份材料都有标题与正文');
  ok(pack.entries.some(e => e.tags.includes('形近')), '标签跟着材料一起导出');

  /* ---- 关键：不含任何成绩 ---- */
  ok(pack.history === undefined, '不含历史成绩（history 未出现）');
  ok(pack.daily === undefined, '不含每日统计（daily 未出现）');
  ok(pack.weak === undefined, '不含易错字词表（weak 未出现）');
  ok(pack.keyErrors === undefined, '不含键位错误数据（keyErrors 未出现）');
  ok(pack.keyConfusions === undefined, '不含键位混淆数据');
  ok(pack.keyTimings === undefined, '不含按键耗时数据');
  ok(pack.course === undefined, '不含课程进度');
  ok(pack.exportedAt !== undefined, '带导出时间（便于接收方了解包的新旧）');

  /* 材料里的进度/统计字段也要剥掉 —— 那是发送者自己的练习痕迹，
     对方导入一份「你已经练过 3 次、正确率 95%」的材料毫无意义。 */
  const first = pack.entries[0];
  ok(first.progress === undefined, '材料不含练习进度（progress 被剥掉）');
  ok(first.stats === undefined, '材料不含练习统计（stats 被剥掉）');
  ok(first.slow === undefined, '材料不含逐字用时快照（slow 被剥掉）');
  ok(first.id === undefined, '材料不含本地 id（避免与对方已有材料撞 id）');
  ok(first.createdAt === undefined, '材料不含创建时间（属于发送者的痕迹）');
}

/* ============================================================
   【2】设置白名单：个人偏好不进包
   ============================================================ */
console.log('【2】练习包的设置白名单');

{
  // 先把主题、音效、快捷键改成非默认值，验证它们不会跟着走
  const st = S.loadSettings();
  st.theme = 'dark';
  st.sound = true;
  st.speech = true;
  st.speechRate = 1.3;
  st.reduceMotion = 'off';
  st.showMiniKeymap = false;
  st.shortcuts = { start: 'Enter' };
  st.duration = 240;
  st.count = 33;
  S.saveSettings(st);

  const pack = S.exportPack();
  const ps = pack.settings;

  ok(ps && typeof ps === 'object', '包内有 settings 对象');

  /* ---- 与练习有关的，应当带上 ---- */
  ok(ps.duration === 240, '带上练习时长（与怎么练有关）');
  ok(ps.count === 33, '带上题量');
  ok(ps.scheme !== undefined, '带上双拼方案（材料的编码提示依赖它）');
  ok(ps.strict !== undefined, '带上严格模式设置');

  /* ---- 个人偏好，绝不能带上 ---- */
  ok(ps.theme === undefined, '不带主题（个人偏好，与材料无关）');
  ok(ps.sound === undefined, '不带音效开关');
  ok(ps.speech === undefined, '不带语音朗读开关');
  ok(ps.speechRate === undefined, '不带朗读语速');
  ok(ps.reduceMotion === undefined, '不带动效偏好（可及性设置，不该被别人的包改掉）');
  ok(ps.showMiniKeymap === undefined, '不带迷你键位图开关');
  ok(ps.shortcuts === undefined, '不带快捷键（既个人又容易与对方冲突）');
  ok(ps.customText === undefined, '不带自定义文本（那是旧版遗留的大字段）');

  /* 白名单机制的价值：将来新增设置时，默认是不进包。
     这一条断言的是「没有用黑名单」—— 若实现改成「整个 settings 减几个键」，
     上面这些 theme/sound 之类很快就会漏出去。 */
  const keyCount = Object.keys(ps).length;
  ok(keyCount <= 15, `包里设置项数量受白名单限制（${keyCount} 项 ≤ 15）`);
}

/* ============================================================
   【3】导入：合并 + 按正文判重
   ============================================================ */
console.log('【3】importPack 的合并与判重');

{
  S.clearAll();
  S.addShelfEntry({ title: '已有材料', text: '这是本机本来就有的内容' });

  const pack = {
    app: S.PACK_APP,
    version: S.PACK_VERSION,
    title: '别人的练习包',
    settings: { duration: 300 },
    entries: [
      { title: '重复材料（换个标题）', tags: [], text: '这是本机本来就有的内容' },
      { title: '全新材料', tags: ['分享'], text: '这是一份全新的材料内容' }
    ]
  };

  const res = S.importPack(pack);
  ok(res.ok === true, '导入成功');
  ok(res.added === 1, `只新增 1 份（重复的被跳过，实际 ${res.added}）`);
  ok(res.skipped === 1, '跳过 1 份重复材料');
  ok(res.skippedTitles.includes('重复材料（换个标题）'), '跳过清单里列出了重复材料（按正文认出，标题不同也认得出）');

  const shelf = S.loadShelf();
  ok(shelf.length === 2, `书架共 2 份（1 原有 + 1 新增，实际 ${shelf.length}）`);
  ok(shelf.some(e => e.text === '这是一份全新的材料内容'), '新材料确实进库了');
  ok(shelf.filter(e => e.text === '这是本机本来就有的内容').length === 1,
    '重复内容没有产生第二份');

  /* 判重按正文而非标题 —— 这条设计的意义就在这个用例：
     标题被改得面目全非，正文一样仍能认出来。 */
  ok(shelf.some(e => e.title === '已有材料'), '原有材料的标题没被覆盖');
}

/* ============================================================
   【4】判重口径：空白差异不算新材料
   ============================================================ */
console.log('【4】判重口径：忽略空白差异');

{
  S.clearAll();
  S.addShelfEntry({ title: '原文', text: '床前明月光\n疑是地上霜' });

  const pack = {
    app: S.PACK_APP, version: S.PACK_VERSION,
    // 同一首诗，但从别处复制来，空格/换行不一样
    entries: [{ title: '别处复制的同一首', text: '  床前明月光   疑是地上霜  ' }]
  };
  const res = S.importPack(pack);
  ok(res.added === 0, '只有空白差异 → 判为重复，不新增');
  ok(res.skipped === 1, '计入跳过');
  ok(S.loadShelf().length === 1, '书架仍只有 1 份');
}

/* ============================================================
   【5】格式校验：认错文件类型时给得出正确指引
   ============================================================ */
console.log('【5】importPack 的格式校验');

{
  const r1 = S.importPack(null);
  ok(r1.ok === false, 'null 被拒');
  ok(r1.message.includes('JSON'), '提示内容不是有效 JSON');

  const r2 = S.importPack({ app: 'other-app' });
  ok(r2.ok === false, '别的应用的文件被拒');
  ok(r2.message.includes('不是本应用的练习包'), '明确指出这不是练习包');

  /* 拿错文件是最常见的失误：用户想导入练习包，
     结果选了自己上次备份的完整数据文件。这时候必须告诉他
     「这是完整备份，该用导入数据」，而不是干巴巴说「格式不对」——
     后者会让他以为文件坏了。 */
  const r3 = S.importPack({ app: 'shuangpin-practice', version: 3, history: [] });
  ok(r3.ok === false, '完整备份文件被拒（不能当练习包导入）');
  ok(r3.message.includes('完整数据备份'), '识别出这是完整备份');
  ok(r3.message.includes('导入数据'), '并且告诉他该用哪个入口');

  const r4 = S.importPack({ app: S.PACK_APP, version: 1 });
  ok(r4.ok === false, '缺 entries 被拒');
  ok(r4.message.includes('材料列表'), '说明缺的是什么');
}

/* ============================================================
   【6】导入不覆盖本机已有设置
   ============================================================ */
console.log('【6】导入不覆盖本机设置');

{
  S.clearAll();
  const st = S.loadSettings();
  st.duration = 999;      // 用户明确设过的值
  st.theme = 'dark';
  S.saveSettings(st);

  S.addShelfEntry({ title: '本机材料', text: 'aaa' });
  const before = S.loadSettings();

  S.importPack({
    app: S.PACK_APP, version: S.PACK_VERSION,
    settings: { duration: 60, theme: 'light' },
    entries: [{ title: '外来材料', text: 'bbb' }]
  });

  const after = S.loadSettings();
  /* 设置项总有默认值，无法区分「用户设成了这个」和「只是默认」，
     所以采取保守策略：本机已有设置时，练习包里的设置不覆盖。
     否则每次导入别人的包，自己的时长偏好都会被悄悄改掉。 */
  ok(after.duration === 999, '本机设置过的时长没被包里的值覆盖');
  ok(after.theme === 'dark', '主题更不会被覆盖（本来就不该进包）');
  ok(after.duration === before.duration, '导入前后设置完全一致');
  ok(S.loadShelf().length === 2, '但材料照样导进来了（设置与材料互不影响）');
}

/* ============================================================
   【7】全新设备：包内设置作为起手参数
   ============================================================ */
console.log('【7】全新设备上应用包内设置');

{
  S.clearAll();
  // 全新设备：从未保存过设置
  ls.removeItem(S.KEYS.settings);

  const res = S.importPack({
    app: S.PACK_APP, version: S.PACK_VERSION,
    settings: { duration: 420, count: 25 },
    entries: [{ title: '分享的材料', text: '全新的内容' }]
  });

  ok(res.ok === true, '导入成功');
  ok(res.message.includes('设置'), '导入结果里说明了应用了包内设置');
  const st = S.loadSettings();
  ok(st.duration === 420, `全新设备上采用了包内的时长 420（实际 ${st.duration}）`);
  ok(st.count === 25, '采用了包内的题量');
}

/* ============================================================
   【8】空包与空材料
   ============================================================ */
console.log('【8】边界：空内容');

{
  S.clearAll();

  // 书架为空时导出：entries 应为空数组（由 UI 层负责提示用户）
  const empty = S.exportPack();
  ok(Array.isArray(empty.entries) && empty.entries.length === 0, '书架为空时导出得到空 entries');

  // 导入一个只有空材料的包：不该建出空条目
  const res = S.importPack({
    app: S.PACK_APP, version: S.PACK_VERSION,
    entries: [{ title: '空材料', text: '' }, { title: '空白材料', text: '   ' }]
  });
  ok(res.ok === true, '全是空材料时不报错');
  ok(res.added === 0, '空材料一份都不建');
  ok(S.loadShelf().length === 0, '书架仍是空的（没建出空条目）');

  // 只导出指定的几份
  S.addShelfEntry({ title: '要导出的', text: 'AAA' });
  S.addShelfEntry({ title: '不要导出的', text: 'BBB' });
  const id = S.loadShelf().find(e => e.text === 'AAA').id;
  const partial = S.exportPack({ ids: [id] });
  ok(partial.entries.length === 1, '按 ids 只导出指定的 1 份');
  ok(partial.entries[0].text === 'AAA', '导出的是指定的那份');
}

/* ============================================================
   【9】练习包与完整备份互不干扰
   ============================================================ */
console.log('【9】练习包与完整备份的字段不重叠');

{
  S.clearAll();
  S.addShelfEntry({ title: 'm', text: 'content' });
  S.appendRecord({
    id: 'x1', ts: Date.now(), date: S.dateStr(new Date()), mode: 'char',
    durationSec: 60, totalChars: 20, correctChars: 20, wrongChars: 0,
    keystrokes: 40, speed: 20, accuracy: 100
  });

  const backup = S.exportAll();
  const pack = S.exportPack();

  // 两者都必须能被各自的导入入口认出来，且不互相误认
  ok(S.importPack(backup).ok === false, '完整备份不能当练习包导入');
  ok(S.importAll(pack).ok === false, '练习包也不能当完整备份导入');

  // 完整备份里必须有成绩（那是它的用途），练习包里必须没有（那是它的承诺）
  ok(Array.isArray(backup.history) && backup.history.length > 0, '完整备份里包含成绩');
  ok(pack.history === undefined, '练习包里不含成绩');
}

console.log('');
if (fail) {
  console.log(`❌ 练习包自检有 ${fail} 项失败`);
  process.exit(1);
}
console.log('✅ 练习包自检全部通过');
