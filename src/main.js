/**
 * 应用主控
 * ------------------------------------------------------------
 * 职责：
 *   - 视图路由（练习 / 键位图 / 统计 / 复习 / 设置）
 *   - 练习会话的 UI 绑定（渲染题目、键位图高亮、HUD、反馈）
 *   - 键盘输入接管（含中文输入法屏蔽、移动端隐藏输入）
 *   - 结果弹窗、续练、导入导出
 *
 * 全局错误兜底：window.onerror / unhandledrejection 都会转成 toast，
 * 保证任何意外都不会让界面「白屏卡死」。
 */

import {
  generateQuestions, generateReviewQuestions, LEVELS, LEVEL_MAP,
  questionFromCharChar, questionFromPhrase, isPunct,
  makeCustomPassageQuestion, splitPassageText,
  ALL_CHARS, PHRASES, PASSAGES, CHAR_TIERS, phrasePool
} from './core/questions.js';
import { planMixedSession } from './core/mix.js';
import { COURSE, currentLesson, buildLessonQuestions, recordLessonAttempt } from './core/course.js';
import { PracticeEngine, STATE, normalizeKey } from './core/engine.js';
import { TRAINING_LABELS } from './core/training.js';
import * as S from './core/storage.js';
import { summarize, historySeries, dailySeries, scoreSeries, weakRanking, groupWeakItems,
         reviewAdvice, formatDuration, formatClock, keyHeatmap, keySlowness,
         KEY_SLOW_MIN_SAMPLES, recentBaseline, dailyGoalProgress, keyMastery,
         MASTERY_MIN_SAMPLES, buildWeakPassage } from './core/stats.js';
import { scoreExam, gradeTier, SCORE_CONFIG } from './core/score.js';
import {
  getKeymapData, splitSyllable, primarySplit, highlightForSplit,
  acceptableKeys, SCHEME_META
} from './core/scheme.js';
import { renderKeymap } from './ui/keymap.js';
import { drawLine, drawBars, setTheme as setChartTheme } from './ui/chart.js';
import { play as playSound, prime as primeSound, resetErrorFatigue,
         isSupported as soundSupported } from './ui/sound.js';
import { speak as speakText, stop as stopSpeech,
         hasChineseVoice, isSupported as speechSupported } from './ui/speech.js';
import {
  prefersReducedMotion, watchReducedMotion, motionClass,
  prefersDark, watchColorScheme, applyTheme,
  mergeShortcuts, validateShortcuts, normalizeShortcutKey, prettyKey,
  matchesShortcut, letterFromEvent, announce, SHORTCUT_ACTIONS,
  DEFAULT_SHORTCUTS
} from './ui/a11y.js';

/* ============================================================
   全局状态
   ============================================================ */

const app = {
  view: 'practice',
  settings: S.DEFAULT_SETTINGS,
  engine: null,
  keymap: null,        // 迷你键位图控制器
  fullKeymap: null,    // 完整键位图控制器
  heatKeymap: null,    // 统计页热力图控制器（与上面两个互不干扰）
  sessionMode: 'char',
  lastErrorTarget: null,
  // 用户在练习中临时收起迷你键位图。null = 未表态（听设置的）。
  // 必须独立于 settings.showMiniKeymap：后者是持久偏好，
  // 这里是一轮练习里的临时动作，两者语义不同。
  keymapHidden: null,   // true = 本轮收起；false = 本轮强制显示；null = 听设置
  stats: { mode: 'all', chartMetric: 'speed', chartRange: '20', dailyDays: 14, heatRange: 'all' },
  saveTimer: null,
  lastResumeSave: 0,
  hint: null,          // 当前提示状态（由引擎 hint / reveal 事件驱动）
  _capturingShortcut: false,  // 设置页「按下新键」捕获中：此时全局快捷键必须让路
  _captureCleanup: null,      // 当前捕获的收尾函数（保证旧监听器必然被摘掉）
  _armAudio: null             // 首次用户手势时解锁音频（用完置空）
};

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/* ------------------------------------------------------------
   常驻节点缓存
   ------------------------------------------------------------
   为什么需要：打字是 8–15 键/秒的场景，每次按键都会走
   change → renderSession → updateHud(6×setText) + updateTimebar + 若干
   clearHint/clearFeedback/flashXxx，累计十几次 querySelector 查的是
   **同一批从页面加载起就不再变**的节点（#hudSpeed、#feedback、#stage…）。

   querySelector 是实时查找（要解析选择器 + 走树），不是索引取用，
   在高频路径上纯属浪费。这里把这批稳定节点在首次访问时记下来。

   安全性：只缓存**不会在运行中被替换**的元素。像 #prompt / #decode 的
   内容会被重写，但元素本身始终是同一个，缓存引用是安全的。
   若某个节点因故不在文档里了（被重新挂载/测试环境重建），
   cacheEl 会自动退回实时查询，绝不返回陈旧引用。 */
const _elCache = new Map();
function cacheEl(sel) {
  const hit = _elCache.get(sel);
  // 命中且仍在文档中 → 直接用；否则重新查询（覆盖节点被替换/移除的情况）
  if (hit && document.contains(hit)) return hit;
  const el = document.querySelector(sel);
  if (el) _elCache.set(sel, el);
  else _elCache.delete(sel);
  return el;
}

/* renderSession 的重绘粒度白名单（见该函数注释）。
   用 Set 而非数组，是为了让「未知值一律降级成全量重绘」这件事
   在代码上一眼可见 —— 漏画比多画危险得多。 */
const ARG_LEVELS = new Set(['key', 'char', 'question']);


/* ============================================================
   辅助功能（无障碍 / 快捷键 / 音效）
   ============================================================ */

/**
 * 把拼音拆成「逐键」的展示文本，用于播报与提示。
 *
 * 例：'ni' → 'N I'；'zhuang' 这种多键的也会被逐个点开，
 * 但调用方通常只传**当前这一题**的键，所以长度可控。
 *
 * @param {{keys?:string[]|string}} fb 引擎反馈对象，或直接给键串
 */
function spellKeys(fb) {
  let s = '';
  if (fb && Array.isArray(fb.keys)) s = fb.keys.join('');
  else if (fb && typeof fb.keys === 'string') s = fb.keys;
  else if (typeof fb === 'string') s = fb;
  if (!s) return '';
  return Array.from(s).join(' ').toUpperCase();
}

/**
 * 确保屏幕阅读器用的 aria-live 区域存在。
 *
 * 为什么在运行时插入而不是写在 index.html 里：
 * 这两个节点**没有任何视觉呈现**，放在静态 HTML 里会让人以为
 * 「这东西是页面的一部分」，删改时容易误伤。运行时创建则明确
 * 表达「它只是辅助功能的基础设施」。
 */
function ensureLiveRegions() {
  try {
    if (typeof document === 'undefined' || !document.body) return;
    if (!document.getElementById('srLive')) {
      const el = document.createElement('div');
      el.id = 'srLive';
      el.className = 'sr-only';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'true');
      document.body.appendChild(el);
    }
    if (!document.getElementById('srLiveAssertive')) {
      const el = document.createElement('div');
      el.id = 'srLiveAssertive';
      el.className = 'sr-only';
      el.setAttribute('role', 'alert');
      el.setAttribute('aria-live', 'assertive');
      el.setAttribute('aria-atomic', 'true');
      document.body.appendChild(el);
    }
  } catch (_) { /* 辅助设施失败不应影响主流程 */ }
}

/**
 * 初始化辅助功能：减少动态效果 + 音频解锁 + 播报区域。
 *
 * 「音频解锁」是浏览器的硬性要求：AudioContext 必须由**用户手势**
 * 触发才能出声。所以这里在第一次 pointerdown / keydown 时就预热一次，
 * 之后按键反馈音才不会「第一次没声音」。
 */
function initA11y() {
  try {
    motionClass(currentReduceMotion());
  } catch (_) {}

  // 系统设置中途变化时跟随（仅在 'auto' 模式下 —— 用户显式选了
  // 'on'/'off' 就应尊重用户的显式选择，不能被系统覆盖）
  try {
    watchReducedMotion(() => {
      if ((app.settings.reduceMotion || 'auto') === 'auto') motionClass(true);
    });
  } catch (_) {}

  ensureLiveRegions();

  // 音频解锁：一次性，之后自动摘掉监听
  const armAudio = () => {
    try { primeSound(); } catch (_) {}
    try { document.removeEventListener('pointerdown', armAudio, true); } catch (_) {}
    try { document.removeEventListener('keydown', armAudio, true); } catch (_) {}
    app._armAudio = null;
  };
  app._armAudio = armAudio;
  try {
    document.addEventListener('pointerdown', armAudio, true);
    document.addEventListener('keydown', armAudio, true);
  } catch (_) {}
}

/* ============================================================
   启动
   ============================================================ */

function boot() {
  try {
    app.settings = S.loadSettings();
    // 快捷键：把「脏数据」在进入应用前就修正掉（合并默认值 + 冲突校验），
    // 免得后面每个用到的地方都要自己防一手
    app.settings.shortcuts = mergeShortcuts(app.settings.shortcuts);
    // 先确保 [hidden] 兜底规则生效，再渲染任何东西
    ensureHiddenRule();
    // 主题要在**第一次绘制之前**定下来，否则深色用户会看到一帧浅色闪烁。
    // initTheme() 放在最前面，后面 initA11y 的回调也要能重绘图表。
    initTheme();
    renderStorageBadge();
    if (!S.isStorageAvailable()) {
      toast('浏览器存储不可用，本次记录不会被保存', 'err', 5000);
    }
    initA11y();
    initNav();
    initSetupPanel();
    initSessionPanel();
    initKeymapView();
    renderStatsView();
    renderReviewView();
    initSettingsView();
    initResume();
    initGlobalGuards();
    initHiddenInput();
  } catch (err) {
    console.error('[boot] 初始化失败', err);
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="padding:20px;background:#fdeaea;color:#a02a2a;font-family:sans-serif">' +
      '应用初始化失败：' + escapeHtml(err && err.message ? err.message : '未知错误') +
      '<br>请刷新页面重试。</div>');
  }
}

/* ============================================================
   存储状态
   ============================================================ */

/**
 * 把「数据现在到底存哪」如实说给用户听。
 *
 * 这个应用对数据丢失最敏感：localStorage 配额满时会**静默**降级到内存，
 * 那时用户练完一整场、关掉页面，记录全部蒸发 —— 而顶栏原本一直挂着
 * 「离线 · 本地存储」，等于在数据已经不在的时候继续声称数据在。
 *
 * storageModeName() 早就写好了、注释里也明说「给设置页用」，但一直没有
 * 调用点。这里把它接到顶栏徽标和设置页说明上；降级状态还会补一个提示。
 */
const STORAGE_BADGE = {
  persistent: { text: '离线 · 本地存储', tip: '所有数据保存在本机浏览器的 localStorage 中，不会上传到任何服务器。' },
  memory: { text: '离线 · 内存（不保存）', tip: '当前浏览器不允许写入本地存储（可能是隐私模式）。本次练习结束后记录会丢失。' },
  'quota-memory': { text: '离线 · 内存（配额已满）', tip: 'localStorage 配额已满，本次记录只存在内存里，关闭页面即丢失。请导出备份或清理浏览器数据。' },
  unprobed: { text: '离线 · 本地存储', tip: '所有数据保存在本机浏览器中，不会上传到任何服务器。' }
};

/** 刷新顶栏徽标与设置页说明。存储状态可能在运行中变化（配额写满）。 */
function renderStorageBadge() {
  // 必须先探一次：storageModeName() 只读模块级状态，初始为 null 时会
  // 返回 'unprobed' —— 也就是「还没探测过」。而探测在 isStorageAvailable()
  // 里。不主动探，徽标会一直显示未探测态，用户看到的是承诺而不是事实。
  // 顺带的好处：处于配额降级时会顺手尝试恢复（清理了空间就能落盘）。
  try { S.isStorageAvailable(); } catch (_) {}
  const mode = S.storageModeName();
  const info = STORAGE_BADGE[mode] || STORAGE_BADGE.unprobed;
  const badge = $('#storageBadge');
  if (badge) {
    badge.textContent = info.text;
    badge.title = info.tip;
    badge.classList.toggle('is-warn', mode === 'memory' || mode === 'quota-memory');
  }
  const note = $('#storageNote');
  if (note) {
    let bytes = 0;
    try { bytes = S.storageUsage(); } catch (_) {}
    const kb = (bytes / 1024).toFixed(1);
    note.textContent = mode === 'persistent' || mode === 'unprobed'
      ? `所有数据保存在浏览器 localStorage 中（当前约 ${kb} KB），不会上传到任何服务器。清除浏览器数据会导致记录丢失，建议定期导出备份。`
      : `${info.tip}（当前约 ${kb} KB）` + (mode === 'quota-memory'
        ? '历史记录可能仍完整（那是之前写入的），但新的练习记录不再落盘。'
        : '');
    note.classList.toggle('is-warn', mode === 'memory' || mode === 'quota-memory');
  }
  return mode;
}

/** 存储状态一旦转差就提醒一次，避免用户白练。 */
let lastStorageWarn = '';
function watchStorageMode() {
  const mode = S.storageModeName();
  if (mode === 'memory' || mode === 'quota-memory') {
    const tip = STORAGE_BADGE[mode].tip;
    if (mode !== lastStorageWarn) {
      lastStorageWarn = mode;
      toast(tip, 'err', 6000);
    }
  } else {
    lastStorageWarn = '';
  }
  renderStorageBadge();
}

/* ============================================================
   视图路由
   ============================================================ */

function initNav() {
  $$('#nav .nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.getAttribute('data-view')));
  });
}

function switchView(view) {
  const v = LEVEL_MAP[view] ? view : view;
  if (!v) return;

  // 练习中离开 → 暂停计时
  if (app.view === 'practice' && v !== 'practice' && app.engine &&
      app.engine.state === STATE.RUNNING) {
    app.engine.pause();
    updatePauseButton();
  }

  /* 离开练习页就掐掉正在朗读的语音。
     不加这句的话，L2「听声母/听韵母」模式下切到设置页/统计页时，
     上一题的音节会继续念完 —— 声音和屏幕内容对不上，用户会以为串台了。
     放在「离开 practice」判断之外、无条件执行，是因为朗读可能残留于
     暂停态或多题连播的间隙，只判 RUNNING 会漏。 */
  if (v !== 'practice') stopSpeech();

  app.view = v;
  $$('.view').forEach(el => el.classList.toggle('is-active', el.id === `view-${v}`));
  $$('#nav .nav-btn').forEach(b => b.classList.toggle('is-active', b.getAttribute('data-view') === v));

  if (v === 'stats') renderStatsView();
  if (v === 'review') renderReviewView();
  if (v === 'keymap') renderSyllableList();
  // 进设置页时刷新存储状态：配额可能在练习途中写满，
  // 而设置页那段文案是「数据安全」承诺的唯一出处。
  if (v === 'settings') watchStorageMode();
}

/* ============================================================
   主题（明暗）
   ============================================================ */

/**
 * 应用主题，并在需要时重绘那些**不走 CSS 变量**的画布。
 *
 * 图表是 Canvas 手绘的，颜色写死在 chart.js 的 THEME 常量里 ——
 * 切主题不会让它们自动变色，必须显式重画。所以这里两件事都要做：
 *   ① 写 <html data-theme>（CSS 变量换掉，其余部分自动生效）
 *   ② 通知 chart.js 重新读取配色并重绘
 * 设置页的 select 在这里一并绑定，改完立刻生效并落盘。
 */
function applyThemeNow(pref) {
  const resolved = applyTheme(pref);
  app.theme = resolved;
  // 图表的取色来自 CSS 变量，主题一变就该重新读一遍
  setChartTheme(resolved);
  // 键位图是 SVG（走 CSS 变量，自动变色），但热力层的文字色由
  // setHeat 写死在 fill 属性上，所以要重画
  redrawKeymapTheme();
  if (app.view === 'stats') renderStatsView();
  return resolved;
}

function initTheme() {
  applyThemeNow(app.settings.theme || 'auto');
  // 跟随系统时，用户在系统里改配色要立刻生效（不要求刷新）
  watchColorScheme(() => {
    if ((app.settings.theme || 'auto') === 'auto') applyThemeNow('auto');
  });
}

/** 主题切换后重画三个键位图控制器（它们各自缓存了 fill 属性） */
function redrawKeymapTheme() {
  try {
    for (const km of [app.keymap, app.fullKeymap, app.heatKeymap]) {
      if (km && typeof km.repaint === 'function') km.repaint();
    }
  } catch (err) {
    console.error('[theme] 键位图重绘失败', err);
  }
}

/**
 * 取一个模式的显示名。
 *
 * L2 的两个模式是特例：名字里的「听」只有在真的能出声时才成立。
 * 本机没中文语音包（或用户没开朗读）时，它们实际是「看字母认键」，
 * 就该叫「认声母键」。这样界面上的承诺永远和实际发生的事一致。
 *
 * @param {string} id 模式 id
 * @returns {string}
 */
function modeDisplayName(id) {
  const lv = LEVEL_MAP[id];
  if (!lv) return String(id || '');
  if (lv.nameSpoken && app.settings.speech && app._hasZhVoice) return lv.nameSpoken;
  return lv.name;
}

/* ============================================================
   练习：模式选择面板
   ============================================================ */

function initSetupPanel() {
  const grid = $('#modeGrid');
  if (grid) {
    /* 用函数渲染而非一次性 innerHTML：语音能力探测是异步的，
       探测结果回来后需要重画模式名（「认声母键」↔「只听声母」）。 */
    const paint = () => {
      /* hidden 的模式（智能混合）不进卡片 —— 它由「练 5 分钟」按钮进入 */
      grid.innerHTML = LEVELS.filter(l => !l.hidden).map(l => `
        <button class="mode-card" data-mode="${l.id}">
          <span class="mode-count" data-count="${l.id}"></span>
          <span class="mode-card-head">
            <span class="mode-lv">${l.badge}</span>
            <span class="mode-card-name">${escapeHtml(modeDisplayName(l.id))}</span>
          </span>
          <span class="mode-card-desc">${escapeHtml(l.desc)}</span>
        </button>
      `).join('');
      updateModeCounts();
    };
    app._paintModeGrid = paint;
    paint();

    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.mode-card');
      if (!card) return;
      const mode = card.getAttribute('data-mode');
      selectMode(mode);
    });
  }

  selectMode(app.settings.mode || 'char', true);

  // 时长 / 题量
  const selDuration = $('#selDuration');
  const selCount = $('#selCount');
  const chkWeak = $('#chkWeakBoost');
  const selTier = $('#selCharTier');
  if (selTier) {
    selTier.innerHTML = CHAR_TIERS.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')
      + '<option value="progressive">自适应挑战（按掌握程度升降档）</option>';
    selTier.value = app.settings.charTier;
    selTier.addEventListener('change', () => {
      app.settings.charTier = selTier.value;
      if (selTier.value === 'progressive' && app.settings.trainingPolicy === 'full') {
        app.settings.trainingPolicy = 'progressive';
        if ($('#selTrainingPolicy')) $('#selTrainingPolicy').value = 'progressive';
      }
      saveSettingsDebounced();
    });
  }

  if (selDuration) {
    selDuration.value = String(app.settings.duration);
    selDuration.addEventListener('change', () => {
      app.settings.duration = Number(selDuration.value) || 0;
      saveSettingsDebounced();
    });
  }
  bindCountControl('selCount', 'customCount');
  if (chkWeak) {
    chkWeak.checked = !!app.settings.weakBoost;
    chkWeak.addEventListener('change', () => {
      app.settings.weakBoost = chkWeak.checked;
      saveSettingsDebounced();
    });
  }

  for (const [id, key] of [['selTrainingPolicy', 'trainingPolicy'], ['selPhraseCategory', 'phraseCategory'], ['selPhraseLength', 'phraseLength']]) {
    const el = $(`#${id}`);
    if (!el) continue;
    el.value = app.settings[key];
    el.addEventListener('change', () => {
      app.settings[key] = el.value;
      updatePhrasePoolInfo();
      saveSettingsDebounced();
    });
  }
  updatePhrasePoolInfo();
  // 旧数据迁移：单个 customText → 书架。只跑一次（见 migrateCustomTextToShelf），
  // 迁了要告诉用户东西去哪了，不能悄悄搬。
  try {
    const mig = S.migrateCustomTextToShelf();
    if (mig.migrated) toast('已把你之前粘贴的自定义文本放进书架（练习页选「自定义文本」可见）');
  } catch (err) { console.warn('[shelf] 迁移失败', err); }
  initCustomText();
  initSmartMix();
  initShelf();
  initCourse();

  const btnStart = $('#btnStart');
  // 注意：必须用箭头函数包装。若直接传 startSession，
  // 浏览器会把 click 事件对象当作第一个参数 questionsOverride 传入，
  // 导致「有题目但格式不对」而静默失败。
  if (btnStart) btnStart.addEventListener('click', () => startSession());

  const btnResume = $('#btnResume');
  if (btnResume) btnResume.addEventListener('click', resumeSession);

  const btnDrop = $('#btnDropResume');
  if (btnDrop) btnDrop.addEventListener('click', () => {
    S.clearResume();
    $('#resumeHint').hidden = true;
    toast('已放弃上次进度');
  });

  updateModeCounts();
}

/**
 * 「自定义文本」输入区。
 *
 * 【持久化时机】用 input 事件 + 防抖写盘，而不是 change / blur。
 * 用户粘一篇长文后不太可能立刻点开始，而是先滚动检查一下 ——
 * 若等 change（失焦）才存，中途关掉标签页就丢了。
 *
 * 【实时统计】每次输入都算一遍「可打字数 / 跳过字数」并显示。
 * 这是刻意做的：用户粘完一段材料，最想知道的是「这段能不能练、
 * 有多少字是练不了的」。直接告诉他，而不是等他点了开始才发现
 * 一半的字被跳过。
 */
function initCustomText() {
  const ta = $('#customTextInput');
  const stat = $('#customTextStat');
  if (!ta) return;

  // 恢复上次粘贴的内容（跟着设置一起落盘）
  ta.value = app.settings.customText || '';

  const refresh = () => {
    const text = String(ta.value || '');
    if (!stat) return;
    if (!text.trim()) { stat.textContent = ''; return; }

    /* 用 makeCustomPassageQuestion 算统计 —— 而不是自己数汉字。
       因为它就是真正开练时用的那个函数，两边口径完全一致：
       「统计说 500 字可练」但开练后实际只有 480 字这种事不会发生。 */
    const q = makeCustomPassageQuestion(text);
    if (!q) {
      stat.textContent = '这段文字里没有可练的汉字（全是标点/英文/数字）。';
      stat.className = 'is-warn';
      return;
    }
    const m = q.meta;
    const skip = m.unknownCount;
    stat.className = skip ? 'is-thin' : '';
    stat.textContent = `可练 ${m.hanCount - skip} 字` +
      (skip ? ` · 跳过 ${skip} 字（未收录）` : '') +
      ` · 约 ${splitPassageText(text, CUSTOM_SEG_CHARS).length} 段`;
  };

  ta.addEventListener('input', () => {
    app.settings.customText = ta.value;
    refresh();
    saveSettingsDebounced();
  });
  // 初次进入时也刷新一次（可能是从存储恢复的旧内容）
  refresh();

  const btnClear = $('#btnClearCustomText');
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      ta.value = '';
      app.settings.customText = '';
      refresh();
      saveSettingsDebounced();
      ta.focus();
    });
  }
}

/* 自定义文本切成多段时的每段上限（可打字数）。
   为什么是分段而不是一次性跑完：一段 5000 字的文章，
   进度条和「已完成 N 字」会变得毫无意义，而且中途被打断
   （刷新、暂停退出）时续练的粒度太粗。按 80 字一段，
   大约是一屏能看完、一口气能打完的长度。 */
const CUSTOM_SEG_CHARS = 80;

/* 自定义文本切成多段时的每段上限（可打字数）。
   为什么是分段而不是一次性跑完：一段 5000 字的文章，
   进度条和「已完成 N 字」会变得毫无意义，而且中途被打断
   （刷新、暂停退出）时续练的粒度太粗。按 80 字一段，
   大约是一屏能看完、一口气能打完的长度。 */

/* ============================================================
   智能混合练习（练 5 分钟）
   ============================================================ */

/**
 * 「练 5 分钟」入口：按当前易错字词、慢键、没练熟的键位组一套题。
 *
 * 三类数据各有出处：weakRanking（易错，到期优先）、slowestKeys（慢键）、
 * keyMastery（键位掌握度）。推荐理由必须展示出来 —— 说不清「为什么练这些」，
 * 它就只是又一个随机按钮。
 */
function initSmartMix() {
  const btn = $('#btnSmartMix');
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener('click', () => {
    try {
      const plan = planMixedSession({
        durationSec: 300,
        weakList: weakRanking(30),
        slowKeys: S.slowestKeys(S.loadKeyTimings(), { min: KEY_SLOW_MIN_SAMPLES, top: 5 }),
        mastery: keyMastery({ range: 'all', mode: 'all' })
      });
      if (!plan.questions.length) {
        toast('暂时组不出练习，请稍后再试', 'err');
        return;
      }
      renderMixReasons(plan.reasons);
      startSession(plan.questions, 'mix', { durationSec: 300 });
    } catch (err) {
      console.error('[smartmix] 组题失败', err);
      toast('智能混合组题失败：' + (err && err.message ? err.message : '未知错误'), 'err');
    }
  });
}

/** 把推荐理由写进界面。列表形式，读屏逐条念得清。 */
function renderMixReasons(list) {
  const box = $('#mixReasons');
  if (!box) return;
  if (!Array.isArray(list) || !list.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div class="mix-reasons-title">为什么练这些</div>` +
    `<ul class="mix-reason-list">${list.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`;
}

/* ============================================================
   个人文本书架
   ============================================================ */

function initShelf() {
  const btnSave = $('#btnShelfSave');
  if (btnSave && !btnSave._bound) {
    btnSave._bound = true;
    btnSave.addEventListener('click', () => {
      const ta = $('#customTextInput');
      const text = ta ? ta.value : '';
      if (!String(text).trim()) { toast('先粘贴文字，再存入书架', 'err'); return; }
      const existed = S.loadShelf().find(e => e.text === text);
      if (existed) {
        app.shelfActiveId = existed.id;
        toast(`书架里已有这份材料：「${existed.title}」`);
        renderShelf();
        return;
      }
      const n = S.loadShelf().length + 1;
      const entry = S.addShelfEntry({ title: `材料 ${n}`, tags: [], text });
      if (entry) {
        app.shelfActiveId = entry.id;
        toast('已存入书架，下次可直接从列表继续');
        renderShelf();
      }
    });
  }

  const list = $('#shelfList');
  if (list && !list._bound) {
    list._bound = true;
    // 列表内容每次重画，事件绑在容器上做委托（和弹窗的 data-act 同一思路）
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const act = btn.getAttribute('data-act');
      if (act === 'open') openShelfEntry(id);
      else if (act === 'del') confirmRemoveShelfEntry(id);
    });
  }

  renderShelf();
}

/** 重画书架列表（含每份材料自己的速度 / 正确率与上次进度） */
function renderShelf() {
  const box = $('#shelfBox');
  const list = $('#shelfList');
  const count = $('#shelfCount');
  if (!box || !list) return;
  const entries = S.loadShelf();
  box.hidden = entries.length === 0;
  if (count) count.textContent = entries.length ? `${entries.length} 份` : '';
  list.innerHTML = entries.map(e => {
    const avg = S.shelfEntryAverages(e);
    const last = e.lastAt ? new Date(e.lastAt).toLocaleDateString() : '没练过';
    const prog = e.progress.segCount > 0
      ? (e.progress.segIndex >= e.progress.segCount
        ? '上一轮已打完'
        : `练到第 ${e.progress.segIndex + 1}/${e.progress.segCount} 段`)
      : '';
    const meta = [avg.sessions ? `${avg.sessions} 次` : '还没练过',
      avg.sessions ? `均 ${avg.avgSpeed} 字/分 · 正确率 ${avg.avgAccuracy}%` : '',
      last, prog].filter(Boolean).join(' · ');
    const canResume = e.progress.segIndex > 0 && e.progress.segIndex < e.progress.segCount;
    return `<li class="shelf-item" data-id="${e.id}">
      <div class="shelf-item-main">
        <span class="shelf-item-title">${escapeHtml(e.title)}</span>
        <span class="shelf-item-meta">${escapeHtml(meta)}</span>
      </div>
      <div class="shelf-item-actions">
        <button class="btn btn-ghost btn-sm" data-act="open" data-id="${e.id}">${canResume ? '继续' : '练习'}</button>
        <button class="btn btn-ghost btn-sm" data-act="del" data-id="${e.id}"
          aria-label="删除 ${escapeHtml(e.title)}">删除</button>
      </div>
    </li>`;
  }).join('');
}

/** 打开一份材料：文本进 textarea，并从上次的段继续 */
function openShelfEntry(id) {
  const entry = S.loadShelf().find(e => e.id === id);
  if (!entry) return;
  const ta = $('#customTextInput');
  if (ta) {
    ta.value = entry.text;
    app.settings.customText = entry.text;
    saveSettingsDebounced();
    ta.dispatchEvent(new Event('input'));
  }
  app.shelfActiveId = entry.id;

  // 切到自定义文本模式，让用户看得见自己要练什么
  const card = $$('#modeGrid .mode-card').find(c => c.getAttribute('data-mode') === 'custom');
  if (card) card.click();

  if (entry.progress.segIndex >= entry.progress.segCount) {
    // 上一轮已打完 → 从头再来（进度会随本次练习覆盖）
    toast(`「${entry.title}」上一轮已打完，从头开始`);
    app.shelfSegOffset = 0;
  } else if (entry.progress.segIndex > 0) {
    app.shelfSegOffset = entry.progress.segIndex;
    toast(`「${entry.title}」从第 ${entry.progress.segIndex + 1} 段继续`);
  } else {
    app.shelfSegOffset = 0;
  }
}

/** 删除确认：书架条目一删，进度与统计一起没了，必须让用户明确知情 */
function confirmRemoveShelfEntry(id) {
  const entry = S.loadShelf().find(e => e.id === id);
  if (!entry) return;
  const avg = S.shelfEntryAverages(entry);
  openModal(`
    <h2>删除「${escapeHtml(entry.title)}」？</h2>
    <p>${escapeHtml(entry.stats.sessions
      ? `这份材料练过 ${avg.sessions} 次（均 ${avg.avgSpeed} 字/分），删除后这些进度与统计一起消失。`
      : '这份材料还没有练习记录。')}正文无法恢复。</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-danger" data-act="remove">删除</button>
    </div>
  `, (act, close) => {
    if (act !== 'remove') { close(); return; }
    if (app.shelfActiveId === id) app.shelfActiveId = null;
    S.removeShelfEntry(id);
    close();
    toast('已删除');
    renderShelf();
  });
}

/** 练完一次自定义文本后回写书架（进度 + 该材料自己的统计） */
function touchShelfAfterSession(s) {
  const id = app.shelfActiveId;
  app.shelfActiveId = null;
  app.shelfSegOffset = 0;
  if (!id || s.mode !== 'custom') return;
  const entry = S.loadShelf().find(e => e.id === id);
  if (!entry) return;
  /* 正文必须和条目一致才记账：用户从书架打开 A 之后又把文本改成了 B，
     这一局练的是 B，不能把成绩算到 A 头上。 */
  const ta = $('#customTextInput');
  const cur = ta ? ta.value : (app.settings.customText || '');
  if (cur !== entry.text) return;
  S.touchShelfEntry(id, {
    segIndex: s.doneQuestions || 0,
    segCount: s.questionCount || 0
  }, s);
  renderShelf();
}

/* ============================================================
   新手引导课程
   ============================================================ */

function initCourse() {
  const btn = $('#btnCourseStart');
  if (btn && !btn._bound) {
    btn._bound = true;
    btn.addEventListener('click', () => {
      const lesson = currentLesson(S.loadCourseProgress());
      if (!lesson) { renderCourseBox(); return; }
      const qs = buildLessonQuestions(lesson);
      if (!qs.length) { toast('本课暂时组不出题目，请稍后再试', 'err'); return; }
      startSession(qs, lesson.mode, { courseLessonId: lesson.id });
    });
  }
  renderCourseBox();
}

/** 课程卡片：当前课、练过几次、过关条件。每次进练习页 / 练完一局都刷新。 */
function renderCourseBox() {
  const box = $('#courseBox');
  if (!box) return;
  const progress = S.loadCourseProgress();
  const lesson = currentLesson(progress);
  const title = $('#courseTitle');
  const stat = $('#courseStat');
  const goal = $('#courseGoal');
  const check = $('#courseCheck');
  const note = $('#courseNote');
  const btn = $('#btnCourseStart');
  if (!lesson) {
    box.hidden = false;
    if (title) title.textContent = '课程已全部完成 🎓';
    if (goal) goal.textContent = '六门课都过了。接下来可以自由练习、做能力测验，或用「智能混合」保持手感。';
    if (check) check.textContent = '';
    if (note) note.textContent = '';
    if (btn) btn.hidden = true;
    return;
  }
  const rec = progress.lessons[lesson.id] ||
    { attempts: 0, bestAcc: 0, bestSpeed: 0, bestChars: 0 };
  box.hidden = false;
  if (title) title.textContent = lesson.title;
  if (stat) {
    stat.textContent = rec.attempts
      ? `已练 ${rec.attempts} 次 · 最好正确率 ${Math.round(rec.bestAcc)}%`
      : '还没练过';
  }
  if (goal) goal.textContent = lesson.goal;
  const parts = [];
  if (lesson.check.minAccuracy != null) parts.push(`正确率 ≥${lesson.check.minAccuracy}%`);
  if (lesson.check.minSpeed != null) parts.push(`速度 ≥${lesson.check.minSpeed} 字/分`);
  if (lesson.check.minChars != null) parts.push(`完成 ≥${lesson.check.minChars} 字`);
  if (check) check.textContent = `过关条件：${parts.join(' 且 ')}`;
  if (btn) { btn.hidden = false; btn.textContent = rec.attempts ? '继续本课' : '开始本课'; }
  if (note) note.textContent = lesson.reason || '';
}

/** 练完一局后做课程晋级判定，并把结果告诉用户 */
function applyCourseAfterSession(s) {
  const lessonId = app.courseActiveId;
  app.courseActiveId = null;
  if (!lessonId) return;
  const res = recordLessonAttempt(lessonId, s);
  renderCourseBox();
  if (!res.attempted) return;
  const p = res.promotion;
  const title = (COURSE.find(l => l.id === lessonId) || {}).title || lessonId;
  if (p && p.passed) {
    toast(res.next
      ? `通过「${title}」！下一课：${res.next.title}`
      : `通过「${title}」！全部课程完成 🎓`, undefined, 4500);
  } else if (p) {
    const why = p.failed.map(f => `${f.label} ${f.got}（需 ${f.need}）`).join('、');
    toast(`「${title}」未过关：${why}。再练一轮就能通过`, 'err', 5000);
  }
}

/**
 * 从自定义文本生成题目序列。
 * 切段后每段一道 passage 题。空文本返回空数组（调用方提示用户）。
 */
function buildCustomQuestions(text) {
  const segs = splitPassageText(text, CUSTOM_SEG_CHARS);
  const out = [];
  segs.forEach((seg, i) => {
    const q = makeCustomPassageQuestion(seg, { title: `第 ${i + 1} 段` });
    if (q) out.push(q);              // 纯标点的段会被 makeCustom... 判为 null，跳过
  });
  return out;
}

function selectMode(mode, silent) {
  const m = LEVEL_MAP[mode] ? mode : 'char';
  app.sessionMode = m;
  app.settings.mode = m;
  $$('#modeGrid .mode-card').forEach(c =>
    c.classList.toggle('is-active', c.getAttribute('data-mode') === m));

  // 测验保持有限题量，短文也允许用户选择较长轮次。
  if (!silent && m === 'exam' && app.settings.count < 30) {
    app.settings.count = 50;
    syncCountControls();
  }
  updateModeCounts();
  const tip = LEVEL_MAP[m] ? LEVEL_MAP[m].tip : '';
  const stageTip = $('#stageTip');
  if (stageTip) stageTip.textContent = tip;
  toggleExamNote(m);
  const tierField = $('#charTierField');
  if (tierField) tierField.hidden = m !== 'char';
  for (const id of ['phraseCategoryField', 'phraseLengthField']) { const el = $(`#${id}`); if (el) el.hidden = m !== 'phrase'; }
  if ($('#trainingField')) $('#trainingField').hidden = m === 'exam';
  // 自定义文本输入区只在「自定义文本」模式下出现。
  // 其余模式（含测验）都隐藏 —— 一个和当前模式无关的输入框
  // 只会让人以为「填了会生效」。
  const customField = $('#customTextField');
  if (customField) customField.hidden = m !== 'custom';
  if (!silent) saveSettingsDebounced();
}

/**
 * 测验模式的提示条：选中「能力测验」时在设置面板上给出醒目提醒
 * （全程无提示、会给分数），避免用户以为是普通练习。
 */
function toggleExamNote(mode) {
  const note = $('#examNote');
  if (!note) return;
  note.hidden = mode !== 'exam';
}

function syncCountControls() {
  for (const [selectId, inputId] of [['selCount', 'customCount'], ['setCount', 'setCustomCount']]) {
    const select = $('#' + selectId), input = $('#' + inputId);
    if (!select || !input) continue;
    const value = String(app.settings.count);
    const preset = Array.from(select.options).some(o => o.value === value);
    select.value = preset ? value : 'custom';
    input.hidden = preset;
    if (!preset) input.value = value;
  }
}

function bindCountControl(selectId, inputId) {
  const select = $('#' + selectId), input = $('#' + inputId);
  if (!select || !input) return;
  syncCountControls();
  select.addEventListener('change', () => {
    if (select.value === 'custom') {
      input.hidden = false;
      app.settings.count = Math.max(1, S.normalizeCount(input.value));
      // 保持当前控件的自定义输入可见，即使数值恰好等于预设。
      syncCountControls();
      select.value = 'custom'; input.hidden = false; input.focus();
    } else {
      app.settings.count = S.normalizeCount(select.value);
      syncCountControls();
    }
    saveSettingsDebounced(); updateModeCounts();
  });
  input.addEventListener('input', () => {
    // 数字输入尚未失焦时也应生效，避免立即开始仍使用旧题量。
    if (!input.value || !Number.isFinite(Number(input.value))) return;
    app.settings.count = Math.max(1, S.normalizeCount(input.value));
    saveSettingsDebounced(); updateModeCounts();
  });
  input.addEventListener('change', () => {
    app.settings.count = Math.max(1, S.normalizeCount(input.value));
    syncCountControls();
    select.value = 'custom'; input.hidden = false; input.value = String(app.settings.count);
    saveSettingsDebounced(); updateModeCounts();
  });
}

function updateModeCounts() {
  const count = app.settings.count;
  $$('#modeGrid .mode-count').forEach(el => {
    const mode = el.getAttribute('data-count');
    // 自定义文本的题量由材料长度决定（按 80 字切段），
    // 显示用户在「题量」里选了什么没有意义 —— 直接说明这件事。
    if (mode === 'custom') {
      const segs = splitPassageText(app.settings.customText || '', CUSTOM_SEG_CHARS).length;
      el.textContent = app.settings.customText ? `${segs} 段` : '粘贴文本';
      return;
    }
    el.textContent = count > 0 ? `${count} ${mode === 'passage' ? '段' : '题'}`
      : (mode === 'exam' ? '50 题' : '不限量');
  });
}

// 生成器保留去重集合，不限量时按小批次补充，避免续练数据无限膨胀。
function updatePhrasePoolInfo() {
  const info = $('#phrasePoolInfo');
  if (info) {
    const count = phrasePool(app.settings).length;
    info.textContent = count ? `可练 ${count} 个词组；练完后循环` : '此组合暂无词组，请更换分类或长度';
  }
}

function createQuestionSource(config, initial = [], savedState = {}) {
  const recent = S.loadRecent(config.mode);
  const context = {};
  for (const name of ['used', 'usedPinyin', 'usedPhrase', 'usedKeys']) {
    const state = savedState?.[name];
    context[name] = new Set(Array.isArray(state?.items) ? state.items : recent);
    context[name].last = state?.last;
    context[name].cycles = Number(state?.cycles) || 0;
    context[name].draws = Number(state?.draws) || 0;
    // 距上次易错键强化的抽数：续练后要接着算，否则会立刻补一题强化
    context[name].weakAt = Number(state?.weakAt) || 0;
  }
  for (const q of initial) {
    context.used.add(q.text || q.promptText);
    context.usedPhrase.add(q.text || q.promptText);
    if (q.kind === 'key') context.usedKeys.add(`${q.role}:${q.promptText}`);
    const py = q.pinyin || q.chars?.[0]?.pinyin;
    if (py) context.usedPinyin.add(q.kind === 'part' ? `${q.part}:${py}` : py);
  }
  const source = (overrides = {}) => {
    const options = { ...config, ...overrides };
    // Fixed-tier practice and phrase filters also apply to weak review candidates.
    const allowedWords = options.mode === 'phrase' ? new Set(phrasePool(options).map(p => p.w)) : null;
    const allowedChars = options.mode === 'char' && options.charTier !== 'progressive'
      ? CHAR_TIERS.find(t => String(t.id) === String(options.charTier))?.data : null;
    const weak = options.weakBoost && ['char', 'phrase'].includes(options.mode) && !(options.mode === 'char' && options.charTier === 'progressive')
      ? weakRanking(60).filter(it => allowedWords ? allowedWords.has(it.word)
        : !it.word && (!allowedChars || Object.hasOwn(allowedChars, it.char))) : [];
    const review = weak.length ? generateReviewQuestions(weak, Math.floor(options.count / 5)) : [];
    const historyKeys = S.getKeyErrorTotals().counts;
    const keyWeights = { ...historyKeys };
    for (const [key, count] of Object.entries(overrides.keyWeights || {})) keyWeights[key] = (keyWeights[key] || 0) + count;
    const fresh = generateQuestions({ ...options, keyWeights, count: options.count - review.length, context });
    const out = fresh.slice();
    review.forEach((q, i) => out.splice(Math.min(out.length, i * 5 + 4), 0, q));
    return out;
  };
  source.exportState = () => Object.fromEntries(Object.entries(context).map(([name, used]) =>
    [name, {
      items: [...used], last: used.last,
      cycles: used.cycles || 0, draws: used.draws || 0, weakAt: used.weakAt || 0
    }]));

  /* 把一道从未真正作答的题还回候选池（自适应换档顶掉旧档题目时调用）。
     去重集合是「一轮全覆盖」的依据，所以还回时必须用与生成时完全一致的
     标记键，否则还回去的键和当初打的键不是同一个，等于没还。 */
  source.releaseQuestion = (q) => {
    if (!q) return;
    if (q.kind === 'key') context.usedKeys.delete(`${q.role}:${q.promptText}`);
    else {
      context.used.delete(q.text || q.promptText);
      context.usedPhrase.delete(q.text || q.promptText);
      const py = q.pinyin || q.chars?.[0]?.pinyin;
      if (py) context.usedPinyin.delete(q.kind === 'part' ? `${q.part}:${py}` : py);
    }
    // last 若指向被还回的题，下一题的「不重复上一题」检查会误判
    if (q.kind === 'key' && context.usedKeys.last === `${q.role}:${q.promptText}`)
      context.usedKeys.last = undefined;
  };
  return source;
}

function saveSettingsDebounced() {
  if (app.saveTimer) clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => {
    flushSettings();
  }, 400);
}

function flushSettings() {
  if (app.saveTimer) clearTimeout(app.saveTimer);
  app.saveTimer = null;
  try { S.saveSettings(app.settings); } catch (e) { console.warn(e); }
}

function saveProgress(force = false) {
  const eng = app.engine;
  if (!eng || ![STATE.RUNNING, STATE.PAUSED].includes(eng.state) || !eng.stats.keystrokes) return;
  const now = Date.now();
  if (!force && now - app.lastResumeSave < 2000) return;
  S.saveResume(eng.exportResume());
  app.lastResumeSave = now;
}

/* ============================================================
   练习：开始 / 续练 / 结束
   ============================================================ */

/**
 * 开始一次练习。
 * @param {Array}  [questionsOverride] 预置题目（智能混合 / 课程 / 自定义文本用）
 * @param {string} [modeOverride]      模式 id（须在 LEVEL_MAP 里）
 * @param {object} [opts]
 *   durationSec     覆盖「练习时长」设置（智能混合固定 5 分钟用它）
 *   shelfId         本次练的是书架里的哪份材料（练完回写进度与统计）
 *   courseLessonId  本次练的是哪门课（练完做晋级判定）
 */
function startSession(questionsOverride, modeOverride, opts = {}) {
  try {
    // 防御：若被当作事件回调直接调用，第一个参数会是 Event 对象。
    // 只接受「看起来像题目数组」的值，其余一律忽略并走正常生成流程。
    let preset = null;
    if (Array.isArray(questionsOverride) && questionsOverride.length &&
        questionsOverride[0] && typeof questionsOverride[0] === 'object' &&
        questionsOverride[0].id && questionsOverride[0].kind) {
      preset = questionsOverride;
    } else if (questionsOverride != null && typeof questionsOverride === 'object' &&
               typeof questionsOverride.type === 'string') {
      console.warn('[startSession] 收到事件对象作为题目参数，已忽略');
    }

    // 若第二个参数其实是事件对象，同样忽略
    const safeModeOverride = (typeof modeOverride === 'string' && LEVEL_MAP[modeOverride])
      ? modeOverride : null;

    const mode = safeModeOverride || app.sessionMode;
    const durationSec = Number(opts.durationSec != null ? opts.durationSec : app.settings.duration) || 0;
    const count = Number(app.settings.count) || 0;
    // 本次会话的归属：书架材料 / 课程。练完（persistRecord）按它回写。
    app.shelfActiveId = (typeof opts.shelfId === 'string' && opts.shelfId) || null;
    app.courseActiveId = (typeof opts.courseLessonId === 'string' && opts.courseLessonId) || null;

    const unlimited = !preset && count === 0 && mode !== 'exam';
    const generation = {
      mode, count: unlimited ? (mode === 'passage' ? 3 : 20) : (count || 50),
      charTier: app.settings.charTier, weakBoost: app.settings.weakBoost,
      phraseCategory: app.settings.phraseCategory, phraseLength: app.settings.phraseLength
    };

    /* 自定义文本不走通用出题器：题目来自用户粘的那段文字。
       在 createQuestionSource 之前拦下来，是因为出题器只认内置语料
       （passage 从 PASSAGES 里挑），给它 mode='custom' 会走进
       「未知模式 → 落到默认分支」的坑。 */
    let customPreset = null;
    if (!preset && mode === 'custom') {
      // 以 textarea 的当前值为准（用户可能刚粘完就点了开始，防抖还没落盘）
      const ta = $('#customTextInput');
      const text = (ta ? ta.value : app.settings.customText) || '';
      if (!text.trim()) {
        toast('请先粘贴要练的文字', 'err');
        // 把焦点送回去，用户不用再找输入框
        if (ta) ta.focus();
        return;
      }
      customPreset = buildCustomQuestions(text);
      if (!customPreset.length) {
        toast('这段文字里没有可练的汉字，试试其他内容', 'err');
        if (ta) ta.focus();
        return;
      }
      /* 从书架条目「继续」：跳过上次已经打完的段。
         越界（上次已打完）时从头再来 —— 进度会随本次练习覆盖。 */
      if (app.shelfSegOffset > 0) {
        const off = Math.min(app.shelfSegOffset, customPreset.length);
        const rest = customPreset.slice(off);
        customPreset = rest.length ? rest : buildCustomQuestions(text);
      }
    }

    const questionSource = (preset || customPreset) ? null : createQuestionSource(generation);
    const questions = preset || customPreset || questionSource();

    if (!Array.isArray(questions) || !questions.length) {
      toast(mode === 'phrase' ? '此分类与长度组合暂无词组，请更换筛选条件' : '题目生成失败，请重试', 'err');
      return;
    }

    // 清理旧引擎
    if (app.engine) { app.engine.destroy(); app.engine = null; }

    /* 测验模式：强制无提示。
       注意这里**不是**沿用 app.settings.hint —— 测验语义是「脱离辅助」，
       用户即使把设置里的提示开着，测验也必须关掉（引擎侧还有 examMode 硬闸门）。 */
    const isExam = mode === 'exam';

    app.engine = new PracticeEngine({
      questions,
      unlimited, questionSource, generation,
      mode,
      modeName: modeDisplayName(mode),
      durationSec,
      strict: app.settings.strict,
      skipPunct: app.settings.skipPunct,
      examMode: isExam,
      trainingPolicy: app.settings.trainingPolicy,
      hintEnabled: isExam ? false : app.settings.hint,
      hintDelayMs: isExam ? 0 : app.settings.hintDelay,
      revealDelayMs: isExam ? 0 : app.settings.revealDelay
    });

    bindEngineEvents();
    showSessionUI(true);
    ensureMiniKeymap();
    renderSession();

    app.lastResumeSave = 0;
    // 连错降音的计数跨会话不清零的话，第二轮的第一声错音就会接着上一轮
    // 继续变轻 —— 用户会觉得「什么都没做，音量就变小了」。
    try { resetErrorFatigue(); } catch (_) {}
    app.engine.start();
    rememberCurrentQuestion(app.engine);

    // 隐藏续练提示
    const hint = $('#resumeHint');
    if (hint) hint.hidden = true;
    S.clearResume();

  } catch (err) {
    console.error('[startSession] 失败', err);
    toast('无法开始练习：' + (err && err.message ? err.message : '未知错误'), 'err', 4000);
  }
}

function resumeSession() {
  const saved = S.loadResume();
  if (!saved) { toast('没有可继续的进度', 'err'); return; }
  try {
    const generation = saved.generation || { mode: saved.mode, count: saved.mode === 'passage' ? 3 : 20, charTier: app.settings.charTier };
    /* 自定义文本不能重建出题源 —— 它的题目来自用户当时粘的那段文字，
       而出题器只认内置语料。不过续练其实不需要重建：saved.questions
       里已经存着剩余的题目，PracticeEngine.restore 靠它恢复。
       所以这里对 custom 传 null source（与有限题量练习一致）。 */
    const canResumeBySource = saved.unlimited || generation.charTier === 'progressive';
    const source = (canResumeBySource && generation.mode !== 'custom')
      ? createQuestionSource(generation, saved.questions, saved.generationState) : null;
    const eng = PracticeEngine.restore(saved, source);
    if (!eng) { toast('进度已损坏，无法恢复', 'err'); S.clearResume(); return; }
    if (app.engine) app.engine.destroy();
    app.engine = eng;
    app.sessionMode = eng.mode;
    bindEngineEvents();
    showSessionUI(true);
    ensureMiniKeymap();
    renderSession();
    eng.start();
    rememberCurrentQuestion(eng);
    const hint = $('#resumeHint');
    if (hint) hint.hidden = true;
    toast('已恢复上次进度');
  } catch (err) {
    console.error('[resumeSession] 失败', err);
    toast('恢复进度失败', 'err');
  }
}

function rememberCurrentQuestion(eng) {
  const q = eng.currentQuestion();
  if (q && q.meta?.from !== 'review') {
    S.recordRecent(eng.mode, q.kind === 'key' ? `${q.role}:${q.promptText}` : q.kind === 'part' ? `${q.part}:${q.pinyin}` : (q.text || q.promptText));
  }
}

function bindEngineEvents() {
  const eng = app.engine;
  if (!eng) return;

  eng.on('question', ({ done }) => {
    if (!done) {
      rememberCurrentQuestion(eng);
      /* 换到新题时朗读（只对 L2「听」模式有效，见 speakCurrentQuestion）。
         挂在 question 而非 change 上：change 在本轮每次按键都会触发，
         会把朗读打成结巴。 */
      speakCurrentQuestion();
    }
  });

  /* 分级重绘：change 的第三个参数由引擎给出粒度，见 engine.js 各 emit 点。
       'key'   —— 同一个音节里推进到下一键：字符集、题干都没变，只是高亮位移。
                  这是打字场景里最频繁的一次 change（8–15 次/秒），走增量路径，
                  只更新「已达/当前」两个 class 与下一步提示。
       'char'  —— 换字（音节打完）：解码块要重建，但整段题干的字符状态虽变，
                  仍不必走「重建 + 事件重挂」的全量路径。
       'question' —— 换题：允许全量重绘。
     不传（旧调用/第三方）时按 'question' 处理，宁可多画也不漏画。 */
  eng.on('change', (_snap, level) => {
    renderSession(level || 'question');
  });

  eng.on('tick', () => {
    updateHud();
    updateTimebar();
  });

  eng.on('error', (fb) => {
    showErrorFeedback(fb);
    app.lastErrorTarget = fb;
    // 错误反馈：音效 + 屏幕阅读器播报（assertive：走打断队列，因为用户需要立刻知道按错了）
    playSound('error', app.settings.sound);
    if (!eng.examMode && eng.assistanceLevel() === 0 && fb && fb.expectedAll && fb.expectedAll.length) {
      announce(`按错。应键入 ${fb.expectedAll.map(k => String(k).toUpperCase()).join(' 或 ')}` +
        (fb.skipped ? '，非严格模式，已跳到下一个。' : ''), 'assertive');
    } else announce('按错，请重试。', 'assertive');
  });

  eng.on('unit', ({ target, independent }) => {
    // 每个音节/题目完成：记录易错的「正确一次」
    try {
      if (independent && target && target.char) {
        S.recordWeakCorrect({ char: target.char });
      }
    } catch (e) { /* 忽略 */ }
  });

  eng.on('finish', (summary) => {
    // 落盘时配额可能刚好写满 → 状态转差，趁结算页还在就告诉用户。
    watchStorageMode();
    onSessionFinish(summary);
  });

  /* ---- 卡住提示 ---- */
  eng.on('hint', (payload) => {
    app.hint = payload;
    applyMiniKeymapVisibility();
    renderHint(payload);
    highlightMiniKeymap();
  });

  eng.on('pause', () => { updatePauseButton(); clearFeedback(); clearHint(); saveProgress(true); });
  eng.on('resume', () => { updatePauseButton(); clearHint(); });
}

function showSessionUI(show) {
  const setup = $('#setupPanel');
  const session = $('#sessionPanel');
  if (setup) setup.hidden = !!show;
  if (session) session.hidden = !show;

  /* 离开练习面板时立刻停掉朗读 —— 否则切回设置页后
     上一题的音节还在念，听起来像界面失控。 */
  if (!show) stopSpeech();

  /* 测验模式：隐藏一切「辅助」元素，避免暗示答案。
     - 迷你键位图会高亮当前该按的键 → 必须隐藏
     - 「看提示」按钮 → 隐藏
     用 class 统一控制，样式见 .session-panel.is-exam */
  const isExam = !!(app.engine && app.engine.examMode);
  if (session) session.classList.toggle('is-exam', !!show && isExam);
  // 迷你键位图同样按模式收敛（属性式隐藏，便于断言）
  applyMiniKeymapVisibility();
}

function quitSession() {
  const eng = app.engine;
  if (!eng) { showSessionUI(false); return; }
  if (eng.state === STATE.FINISHED) { showSessionUI(false); return; }
  if (eng.state === STATE.RUNNING) eng.pause();

  const isExam = !!eng.examMode;
  openModal(`
    <h2>${isExam ? '结束本次测验？' : '结束本次练习？'}</h2>
    <p class="modal-sub">${isExam
      ? `至少完成 ${SCORE_CONFIG.minReliableChars} 个字符才评定分数与等级；中途交卷会按已完成部分计算，未答部分会拉低完成度。`
      : '已完成的成绩会被记录，当前进度也可以留到下次继续。'}</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-act="cancel">${isExam ? '继续测验' : '继续练习'}</button>
      ${isExam ? '' : '<button class="btn btn-ghost" data-act="save">保存进度并结束</button>'}
      <button class="btn btn-primary" data-act="end">${isExam ? '交卷并查看分数' : '结束并查看成绩'}</button>
    </div>
  `, (act, close) => {
    if (act === 'cancel') {
      close();
      if (app.engine && app.engine.state === STATE.PAUSED) app.engine.resume();
      updatePauseButton();
    } else if (act === 'save') {
      close();
      saveProgressAndExit();
    } else if (act === 'end') {
      close();
      const s = app.engine ? app.engine.finish('user') : null;
      persistRecord(s);
    }
  });
}

function saveProgressAndExit() {
  try {
    const eng = app.engine;
    if (!eng) { showSessionUI(false); return; }
    const snap = eng.exportResume();
    S.saveResume(snap);
    eng.destroy();
    app.engine = null;
    showSessionUI(false);
    showResumeHint();
    toast('进度已保存，下次可继续');
  } catch (err) {
    console.error('[saveProgressAndExit] 失败', err);
    toast('保存进度失败', 'err');
    showSessionUI(false);
  }
}

function onSessionFinish(summary) {
  persistRecord(summary);
  updatePauseButton();
}

/** 落库 + 弹出结果 */
function persistRecord(summary) {
  try {
    const s = summary || (app.engine ? app.engine.summary() : null);
    if (!s) { showSessionUI(false); showResumeHint(); return; }

    /* 测验成绩：先算分，再决定是否落库。
       分数只对 exam 模式有意义，其它模式不做评分（避免「练习也被打分」
       造成的压力 —— 练习与考核要分开）。 */
    const examIsMode = s.mode === 'exam' || s.examMode === true;
    const examResult = examIsMode ? scoreExam(s) : null;
    if (examResult) s.score = examResult;
    // 供结果弹窗与测试读取（summary() 本身是纯函数，不携带分数）
    app.lastResult = { summary: s, score: examResult };

    // 太短的练习不记录（避免无意义数据污染曲线）
    // 提示：无需等待满 3 秒才能落库。真实用户练习时计时器每 250ms 推进一次，
    // 而引擎结束时把「最后一次 tick 之后的零头」补回来，因此提前结束也能拿到
    // 正确的用时；这里只拦「几乎没输入」的空练习。
    const meaningful = s.keystrokes >= 5 && s.durationSec >= 1;

    /* 本轮记录的 id。要在 if 外声明 —— 结算页的「本轮对照」需要它
       （拿近几轮做基线时得把自己排除掉），而赋值发生在 if 内。 */
    let recordId = '';

    if (meaningful) {
      const rec = S.makeRecord({
        mode: s.mode,
        modeName: s.modeName,
        durationSec: s.durationSec,
        totalChars: s.totalChars,
        correctChars: s.correctChars,
        wrongChars: s.wrongChars,
        hintedChars: s.hintedChars,
        keystrokes: s.keystrokes,
        wrongKeystrokes: s.wrongKeystrokes,
        speed: s.speed,
        accuracy: s.accuracy,
        independentAccuracy: s.independentAccuracy,
        maxCombo: s.maxCombo,
        completed: s.completed,
        questionCount: s.questionCount
      });
      // 分数写进记录里（仅测验模式有值），这样统计页才能画「历史分数曲线」
      if (examResult) {
        if (examResult.valid) {
          rec.score = examResult.score;
          rec.grade = examResult.grade;
        }
        rec.scoreValid = examResult.valid;
      }
      S.appendRecord(rec);
      recordId = rec.id;

      // 记录易错字词
      const perErr = s.perCharErrors || {};
      Object.entries(perErr).forEach(([k, cnt]) => {
        if (!cnt) return;
        S.recordWeak({ char: k, word: '', pinyin: ALL_CHARS[k] || '' });
      });

      /* 词组 / 短文按「整条」记一次。上面那条永远传 word: ''，所以复习页的
       * 「易错词语」分组（groupWeakItems 靠 word 且多字判断）本来永远是空的，
       * 词组出错的词全被当成单字混进「易错单字」—— 那一组里的多字键查不到
       * 拼音，界面显示「—」，也没有对应编码。
       * 整条内容才是词组练习真正该复习的粒度。 */
      const perWord = s.perWordErrors || {};
      Object.entries(perWord).forEach(([text, cnt]) => {
        if (!cnt) return;
        const entry = PHRASES.find(p => p.w === text);
        const chars = Array.from(text);
        const pys = entry ? entry.p : chars.map(c => ALL_CHARS[c]).filter(Boolean);
        if (!entry && pys.length !== chars.length) return;   // 拼音不齐就不收，避免生成不出题
        S.recordWeak({ char: chars[0], word: text, pinyin: (pys || []).join(' ') });
      });

      // 记录键维度错误（错误热力图的数据来源）。
      // 与字词表分开存：字词表是「哪些字不会」，热力图是「哪些键不熟」。
      if (s.keyErrors && Object.keys(s.keyErrors).length) {
        // 带上模式：统计页的模式筛选要覆盖热力图，就必须能按模式取数
        S.recordKeyErrors(s.keyErrors, s.mode);
      }

      /* 键维度按键耗时（慢键诊断）。与键错误分开存：一个是「按错」，
         一个是「按对但犹豫」，混在一张表里就分不清「不会」和「不熟」。
         同样带上模式，好让统计页的模式筛选同时覆盖两层诊断。 */
      if (s.keyTimings && Object.keys(s.keyTimings).length) {
        S.recordKeyTimings(s.keyTimings, s.mode);
      }
    }

    /* 收尾音。playFinish / playSoften 早就写好、index.html 也写着「完成提示音」，
       但一直没有调用点 —— 声音开关管的是 per-keystroke 的两声，完成这一声
       永远缺席。分数不理想时用两音下行的 soften：测验只是诊断，
       不该让用户觉得被责备（见 sound.js 的注释）。
       无效分数（样本不足）不出声：没资格评价就不评价。 */
    if (meaningful) {
      const lowScore = examResult && examResult.valid && examResult.score < SCORE_CONFIG.grades[3].min;
      playSound(lowScore ? 'soften' : 'finish', app.settings.sound);
    }

    S.clearResume();

    /* 书架 / 课程的回写。放在弹窗之前：弹窗里要能读到最新进度
       （「本次练的是书架里的哪份材料」「课程是否晋级」）。 */
    if (meaningful) {
      try { touchShelfAfterSession(s); } catch (err) { console.warn('[shelf] 回写失败', err); }
      try { applyCourseAfterSession(s); } catch (err) { console.warn('[course] 判定失败', err); }
    }

    /* 把本轮记录 id 带上：结算页的「本轮对照」要拿近几轮做基线，
       而自己刚刚已经落库了（就在上面 appendRecord）。不排除自己的话
       基线里混进了「本轮」，N=1 时还会变成「本轮 vs 本轮」= 永远持平。 */
    showResultModal(s, meaningful, recordId);
  } catch (err) {
    console.error('[persistRecord] 失败', err);
    toast('成绩保存失败', 'err');
    showSessionUI(false);
    showResumeHint();
  }
}

function showResultModal(s, recorded, recordId) {
  const sc = s.score || null;

  // 测验模式用「分数 + 等级」做标题，练习模式沿用「正确率」评语
  const acc = s.accuracy;
  const practiceGrade = acc >= 98 && s.speed >= 60 ? '优秀'
    : acc >= 95 ? '很好'
    : acc >= 85 ? '不错'
    : acc >= 70 ? '继续加油' : '仍需熟悉键位';

  const title = s.reason === 'timeup' ? '时间到' : '练习完成';
  const headRight = sc ? `${sc.grade}` : practiceGrade;

  const noteParts = [];
  if (sc && sc.warnings && sc.warnings.length) {
    noteParts.push(...sc.warnings);
  }
  if (!recorded) {
    noteParts.push('本次练习时间过短，未计入历史记录。');
  }
  if (s.wrongChars > 0) {
    noteParts.push(`有 ${s.wrongChars} 个字出过错，已加入易错练习，可在「错题复习」中专项突破。`);
  } else if (recorded && !sc) {
    noteParts.push('全程没有出错的字，键位掌握得很扎实。');
  }

  /* ---------- 本轮对照：和最近几轮比怎么样 ----------
     光看「速度 42 字/分」是没有意义的 —— 快还是慢要看跟自己的历史比。
     这也是练习者最想立刻知道的：这一轮比平时进步了没有。

     口径（与 keySlowness 保持一致）：
       - 取**中位数**而非平均值（单次走神就能把均值拽走一大截）
       - 不足 3 轮**如实说明**，不硬凑一个不可靠的对照
       - 按**模式**分开比：单字和短文的速度天然不是一个量级 */
  const base = recentBaseline({
    mode: s.mode,
    exclude: recordId,
    curSpeed: s.speed,
    curAccuracy: s.accuracy
  });
  const deltaTag = (d, unit, digits = 1) => {
    if (!base.enough) return '';
    const cls = d > 0 ? 'is-up' : d < 0 ? 'is-down' : 'is-flat';
    const arrow = d > 0 ? '↑' : d < 0 ? '↓' : '＝';
    return `<span class="base-delta ${cls}">${arrow}${Math.abs(d).toFixed(digits)}${unit}</span>`;
  };
  const baselineBlock = base.samples > 0 ? `
    <div class="base-block${base.enough ? '' : ' is-thin'}">
      ${base.enough
        ? `<span class="base-line">与最近 ${base.samples} 轮同模式练习比：`
          + `速度 <b>${base.speed}</b> 字/分 ${deltaTag(base.speedDelta, '')}`
          + `　正确率 <b>${base.accuracy}%</b> ${deltaTag(base.accuracyDelta, '%')}</span>`
        : `<span class="base-line">已有 <b>${base.samples}</b> 轮同模式记录，`
          + `攒够 <b>${base.min}</b> 轮后就能给出「比平时快/慢」的对照。</span>`}
    </div>` : '';

  /* ---------- 本轮错字：点了就能当场重练 ----------
     上面那句 notePart 只给了一个**数字**，用户看到「有 3 个字出过错」
     却不知道是哪 3 个，也没法立刻重练 —— 得先切到复习页、再从几十个
     历史易错项里找。刚练完这一刻的记忆最鲜活，正是重练的最佳时机。

     数据来源就是落库时用的那两个字段（perWordErrors 是词组/短文按整条记的，
     perCharErrors 是单字）。口径必须与落库一致，否则会出现
     「结算页列了它、但复习页里没有」的割裂。

     排序：先按错误次数降序，同次数时词组在前（词组错说明连打有问题，
     信息量比单个字更大）。上限 12 个，再多会把弹窗撑得很长。 */
  const wrongChips = (() => {
    const entries = [];
    const seen = new Set();

    // 词组优先入列，并把它包含的单字标记为「已覆盖」
    Object.entries(s.perWordErrors || {}).forEach(([text, cnt]) => {
      if (!cnt || !text) return;
      const chars = Array.from(text);
      const entry = PHRASES.find(p => p.w === text);
      if (!entry && chars.some(c => !ALL_CHARS[c])) return;   // 拼音凑不齐，练不了
      if (seen.has(text)) return;
      seen.add(text);
      chars.forEach(c => seen.add(c));                        // 单字不重复列
      entries.push({ key: text, count: cnt, phrase: true });
    });

    Object.entries(s.perCharErrors || {}).forEach(([ch, cnt]) => {
      if (!cnt || !ch || seen.has(ch)) return;
      if (!ALL_CHARS[ch]) return;                             // 没有拼音就出不了题
      seen.add(ch);
      entries.push({ key: ch, count: cnt, phrase: false });
    });

    if (!entries.length) return '';
    entries.sort((a, b) => (b.count - a.count) || (Number(b.phrase) - Number(a.phrase)));
    const shown = entries.slice(0, 12);
    const more = entries.length - shown.length;

    return `<div class="wrong-block">
      <h3 class="sub-title">本轮出错的字词</h3>
      <div class="wrong-chips">
        ${shown.map(e => `
          <button class="wrong-chip" type="button" data-weak="${escapeHtml(e.key)}"
                  title="点击立刻重练「${escapeHtml(e.key)}」（连做 3 遍）">
            <span class="wc-char">${escapeHtml(e.key)}</span>
            <span class="wc-err">×${e.count}</span>
            <span class="wc-cta">重练</span>
          </button>`).join('')}
      </div>
      <p class="wrong-note">点任意一个立刻开练（连做 3 遍，用来区分「真会了」和「蒙对的」）。
        ${more > 0 ? `另有 ${more} 个未列出，都在「错题复习」里。` : ''}</p>
    </div>`;
  })();
  if (s.maxCombo >= 30) {
    noteParts.push(`最长连击 ${s.maxCombo} 键，手感相当稳定。`);
  }
  if (recorded && !s.completed && s.reason !== 'timeup') {
    noteParts.push('本次为主动结束，已完成部分已计入统计。');
  }

  /* ---------- 提示依赖度 ----------
     README 承诺结算页给出提示次数，并说「两个指标的差值正好反映真实掌握程度」。
     那个差值以前根本没显示，所以这里把它算出来摆到台面上：
     差值大 = 有相当一部分字是等提示才打对的，独立正确率已经扣掉了它们，
     但用户需要看见「扣了多少」才知道该练哪。 */
  const hinted = Math.max(0, Number(s.hintedChars) || 0);
  const gap = Math.max(0, Math.round((s.accuracy - s.independentAccuracy) * 10) / 10);
  const hintedNote = hinted > 0
    ? `<p class="result-hint-note">其中 <strong>${hinted}</strong> 个字是等提示才打对的，已从独立正确率中剔除。` +
      `表面正确率 ${s.accuracy}%、独立正确率 ${s.independentAccuracy}%，相差 ${gap} 个百分点。</p>`
    : '';

  /* ---------- 按键耗时：反应最慢的键 ----------
     这是「诊断闭环」的第三维：热力图说哪些键**按错**，这里说哪些键
     **按对但犹豫**。后者往往更早出现 —— 一个键还没被按错，只是变慢了，
     那正是该干预的时候。

     口径要点（否则数字会骗人）：
       - 用**中位数**而非均值：偶尔走神一次就能把均值拽高一倍。
       - 样本数 < KEY_SLOW_MIN_SAMPLES 的键不进排名：两个样本的中位数
         毫无意义，报出来的是噪音。
       - 测的**不是**「读完字到按下」，而是**纯运动时间**：音节首键
         含读字时间，若一并统计，所有声母键会系统性显得比韵母键慢，
         排出来的「最慢的键」基本等于「所有声母键」（见 engine.js KEY_TIMING）。
     达不到门槛时**如实说明**，而不是安静地不显示 —— 沉默会被读成「都不慢」。 */
  const slow = S.slowestKeys(s.keyTimings, { min: KEY_SLOW_MIN_SAMPLES, top: 5 });
  const msText = (n) => `${(Math.round(n) / 1000).toFixed(2)}s`;
  const slowBlock = (() => {
    if (!slow.total) {
      return `<div class="slow-block">
        <h3 class="sub-title">反应最慢的键</h3>
        <p class="slow-block-note">本轮没有采集到按键耗时样本。</p>
      </div>`;
    }
    if (!slow.items.length) {
      return `<div class="slow-block">
        <h3 class="sub-title">反应最慢的键</h3>
        <p class="slow-block-note">共测到 <strong>${slow.total}</strong> 个键，但每个都不足
          <strong>${slow.min}</strong> 次样本，暂不排名。样本太少时中位数不可靠，
          再练几轮就能给出结论。</p>
      </div>`;
    }
    const rows = slow.items.map(it => `
      <li class="slow-row">
        <kbd class="slow-key">${it.key}</kbd>
        <span class="slow-ms">${msText(it.medianMs)}</span>
        <span class="slow-meta">${it.samples} 次样本的中位数</span>
      </li>`).join('');
    const thinNote = slow.thin
      ? ` 另有 ${slow.thin} 个键样本不足 ${slow.min} 次，未参与排名。` : '';
    return `<div class="slow-block">
      <h3 class="sub-title">反应最慢的键</h3>
      <ul class="slow-list">${rows}</ul>
      <p class="slow-block-note">口径：该键成为下一个目标后到按下之间的<b>纯运动时间</b>
        （不含读字时间），取<b>中位数</b>。按错、提示介入与超过 5 秒的等待都不计入。${thinNote}</p>
    </div>`;
  })();

  /* ---------- 测验：分数区块 ---------- */
  const scoreBlock = sc ? `
    <div class="score-card ${sc.valid ? '' : 'is-invalid'}">
      <div class="score-main">
        <div class="score-num">${sc.valid ? `${sc.score}<i>分</i>` : '—'}</div>
        <div class="score-grade">
          ${sc.valid ? `<span class="score-badge score-tier-${gradeTier(sc.score)}">${escapeHtml(sc.badge)}</span>` : ''}
          <span class="score-grade-name">${escapeHtml(sc.grade)}</span>
        </div>
      </div>
      <p class="score-desc">${escapeHtml(sc.gradeDesc)}</p>
      ${sc.valid ? `<div class="score-parts">
        <div class="score-part">
          <span class="score-part-label">正确率得分</span>
          <span class="score-part-value">${sc.parts.accuracy}<i>/${SCORE_CONFIG.accuracyWeight}</i></span>
          <span class="score-part-bar"><i style="width:${Math.round(sc.parts.accuracy / SCORE_CONFIG.accuracyWeight * 100)}%"></i></span>
        </div>
        <div class="score-part">
          <span class="score-part-label">速度得分</span>
          <span class="score-part-value">${sc.parts.speed}<i>/${SCORE_CONFIG.speedWeight}</i></span>
          <span class="score-part-bar"><i style="width:${Math.round(sc.parts.speed / SCORE_CONFIG.speedWeight * 100)}%"></i></span>
        </div>
        <div class="score-part is-plain">
          <span class="score-part-label">完成度</span>
          <span class="score-part-value">${sc.parts.completion}<i>%</i></span>
        </div>
      </div>` : ''}
      <p class="score-foot">
        计分口径：正确率 ${SCORE_CONFIG.accuracyWeight} 分（用<strong>独立正确率</strong>，提示无效）
        + 速度 ${SCORE_CONFIG.speedWeight} 分（${SCORE_CONFIG.speedBaseline}–${SCORE_CONFIG.speedFull} 字/分线性计分）
        → 按完成度加权。${sc.valid ? '本次测验<strong>全程无提示</strong>，分数有效。' : '本次未达到有效测验条件，不评定分数与等级。'}
      </p>
    </div>
  ` : '';

  openModal(`
    <h2>${title} · ${escapeHtml(headRight)}</h2>
    <p class="modal-sub">${escapeHtml(s.modeName || '')} · 用时 ${formatClock(s.durationSec)}</p>

    ${scoreBlock}

    <div class="result-grid">
      <div class="result-cell is-hl">
        <div class="result-cell-label">速度</div>
        <div class="result-cell-value">${s.speed}<i>字/分</i></div>
      </div>
      <div class="result-cell is-hl">
        <div class="result-cell-label">${sc ? '独立正确率' : '正确率'}</div>
        <div class="result-cell-value">${sc ? s.independentAccuracy : s.accuracy}<i>%</i></div>
      </div>
      <div class="result-cell">
        <div class="result-cell-label">完成字数</div>
        <div class="result-cell-value">${s.totalChars}<i>字</i></div>
      </div>
      <div class="result-cell">
        <div class="result-cell-label">正确 / 错误</div>
        <div class="result-cell-value">${s.correctChars}<i>/</i>${s.wrongChars}</div>
      </div>
      <div class="result-cell">
        <div class="result-cell-label">按键 / 错键</div>
        <div class="result-cell-value">${s.keystrokes}<i>/</i>${s.wrongKeystrokes}</div>
      </div>
      <div class="result-cell">
        <div class="result-cell-label">最长连击</div>
        <div class="result-cell-value">${s.maxCombo}<i>键</i></div>
      </div>
      <div class="result-cell${hinted ? ' is-warn' : ''}">
        <div class="result-cell-label">依赖提示</div>
        <div class="result-cell-value">${hinted}<i>字</i></div>
      </div>
      <div class="result-cell">
        <div class="result-cell-label">自动跳过</div>
        <div class="result-cell-value">${s.skipped || 0}<i>字</i></div>
      </div>
    </div>
    ${hintedNote}

    ${baselineBlock}

    ${wrongChips}

    ${slowBlock}

    ${noteParts.length ? `<div class="result-note">${noteParts.map(escapeHtml).join('<br>')}</div>` : ''}

    <div class="modal-actions">
      <button class="btn btn-ghost" data-act="stats">查看统计</button>
      <button class="btn btn-ghost" data-act="review">错题复习</button>
      <button class="btn btn-primary" data-act="again">${sc ? '再测一次' : '再来一次'}</button>
    </div>
  `, (act, close) => {
    close();
    if (act === 'stats') switchView('stats');
    else if (act === 'review') switchView('review');
    else if (act === 'again') {
      showSessionUI(false);
      startSession();
    }
  }, () => {
    // 关闭弹窗后回到设置面板
    const eng = app.engine;
    if (eng) { eng.destroy(); app.engine = null; }
    showSessionUI(false);
    showResumeHint();
  });
}

/* ============================================================
   练习：渲染
   ============================================================ */

function initSessionPanel() {
  const btnPause = $('#btnPause');
  const btnQuit = $('#btnQuit');
  const btnToggle = $('#btnToggleKeymap');

  if (btnPause) btnPause.addEventListener('click', () => {
    if (!app.engine) return;
    app.engine.togglePause();
    updatePauseButton();
  });
  if (btnQuit) btnQuit.addEventListener('click', quitSession);
  const btnHintNow = $('#btnHintNow');
  if (btnHintNow) btnHintNow.addEventListener('click', requestHintNow);
  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      const wrap = $('#miniKeymap');
      if (!wrap) return;
      // 记住用户的意图，交给 applyMiniKeymapVisibility() 统一执行 ——
      // 直接改 style.display 会被下一帧的 renderSession 覆盖掉。
      app.keymapHidden = !wrap.hidden;
      applyMiniKeymapVisibility();
    });
  }
}

function updatePauseButton() {
  const btn = $('#btnPause');
  if (!btn || !app.engine) return;
  btn.textContent = app.engine.state === STATE.PAUSED ? '继续' : '暂停';
}

/**
 * 渲染练习舞台。
 * @param {'key'|'char'|'question'} [arg] 由引擎 change 事件给出的重绘粒度：
 *   'key'      音节内推进 —— 题干不变，只重画解码区/HUD/键位高亮
 *   'char'     换字 —— 题干字符状态更新
 *   'question' 换题/开局 —— 全量重绘
 *   省略或传入未知值时按 'question' 处理（旧调用点与第三方调用都不会漏画）。
 */
function renderSession(arg) {
  const eng = app.engine;
  if (!eng) return;

  /* 分级重绘。
     引擎给回来的粒度决定「哪些区域重画」：
       key      —— 同一音节内推进到下一键：字符集与题干都没变，只重画解码区
                   与迷你键位高亮；连 #prompt / #stageMode / #stageTip 都不碰。
       char     —— 换字：解码区重画，题干按下面的字符状态更新。
       question —— 换题/开局：整段重画。

     为什么值得分级：一次 change 会连带 updateHud（6 次 textContent）
     + updateTimebar + clearHint/clearFeedback，而 'key' 占打字时 change 的
     绝大多数（一个音节 2 键，第 1 键就是 'key'）。把「重写 #prompt 的 HTML」
     从这条路径上摘掉，既少一次 DOM 解析，也避免读屏把整句重念一遍。 */
  const level = ARG_LEVELS.has(arg) ? arg : 'question';
  const isKeyStep = level === 'key';

  const q = eng.currentQuestion();
  const prompt = cacheEl('#prompt');
  const decode = cacheEl('#decode');
  const feedback = cacheEl('#feedback');
  const stageMode = cacheEl('#stageMode');
  const stageTip = cacheEl('#stageTip');

  if (!q || !prompt || !decode) return;

  /* 舞台标题与副标题只在**换题**时才可能变。
     它们每键都重写一次纯属浪费，而且对读屏是实打实的噪音
     （重复播报同一句说明）。 */
  if (level !== 'key') {
    if (stageMode) stageMode.textContent = (q.label || '练习') + (!eng.examMode ? ` · ${TRAINING_LABELS[eng.assistanceLevel()]}` : '') + (eng.adaptive ? ` · 第 ${eng.training.tier} 档` : '');
    if (stageTip) stageTip.textContent = eng.training.policy === 'progressive' && eng.assistanceLevel() < 2
      ? '每 10 个作答单元评估一次：正确率达 90% 且反应稳定后减少提示；卡住可按 Tab 求助。'
      : (LEVEL_MAP[eng.mode] ? LEVEL_MAP[eng.mode].tip : '');
  }

  /* 测验模式：在舞台顶部挂一个「无提示」标记。
     用户随时能看见自己处在测验中（而不是以为应用坏了），
     这也是诚实计分的一部分。 */
  let examFlag = cacheEl('#examFlag');
  if (eng.examMode) {
    if (!examFlag) {
      examFlag = document.createElement('span');
      examFlag.id = 'examFlag';
      examFlag.className = 'exam-flag';
      examFlag.textContent = '测验中 · 无提示';
      const head = $('#stage .stage-head');
      if (head) head.appendChild(examFlag);
    }
    examFlag.hidden = false;
  } else if (examFlag) {
    examFlag.hidden = true;
  }

  // 暂停遮罩
  if (eng.state === STATE.PAUSED) {
    prompt.innerHTML = '<span style="font-size:20px;color:#93a0b4;letter-spacing:0">已暂停 —— 点击「继续」恢复</span>';
    decode.innerHTML = '<div class="decode-empty">暂停中</div>';
    if (feedback) feedback.hidden = true;
    clearHint();
    updateHud();
    updateTimebar();
    highlightMiniKeymap();
    return;
  }

  // 每一帧重绘前先清掉上一帧的提示态；引擎若仍处于提示中，
  // renderHint 会在下面重新画出来，因此不会闪。
  clearHint();

  /* ---- 字形行 ----
     音节内推进（'key'）时整行文字与高亮都不变，直接跳过重建。
     注意此时**仍要**清提示态：clearHint() 擦掉的是 #hintBar 与
     decode 里的 is-hinted* class，与 #prompt 无关，跳过题干不影响它。 */
  if (!isKeyStep) {
    if (q.kind === 'key' || q.kind === 'part' || q.kind === 'syllable') {
      prompt.className = 'prompt';
      prompt.innerHTML =
        `<span style="font-family:var(--mono);color:var(--primary)">${escapeHtml(q.promptText)}</span>` +
        `<div style="font-size:14px;letter-spacing:0;color:#93a0b4;font-family:var(--sans);margin-top:6px">` +
        `${escapeHtml(q.promptSub || '')}</div>`;
    } else {
      const states = eng.charStates();
      const isPassage = q.kind === 'passage';
      prompt.className = 'prompt' + (isPassage ? ' is-passage' : '');
      prompt.innerHTML = states.map(st => {
        const cls = ['ch'];
        if (st.punct) cls.push('ch-punct');
        else if (st.done) cls.push('is-done');
        else if (st.current) cls.push('is-current');
        if (st.unknown) cls.push('is-bad');
        // 等提示才打对的字：标成 is-hinted，视觉上比 is-done 弱一档。
        // 标点与未收录的字不算「靠提示」，不该带这个记号。
        if (st.hinted && !st.punct && !st.unknown) cls.push('is-hinted');
        let extra = '';
        if (st.punct) extra = '';
        else if (st.unknown) extra = ' title="该字未收录拼音，自动跳过"';
        else if (st.hinted) extra = ` title="${escapeHtml(st.ch)} ${escapeHtml(st.pinyin)} —— 等提示才打对，不计入独立正确率"`;
        else if (!eng.examMode && eng.assistanceLevel() < 2) extra = ` title="${escapeHtml(st.ch)} ${escapeHtml(st.pinyin)}"`;
        return `<span class="${cls.join(' ')}"${extra}>${escapeHtml(st.ch)}</span>`;
      }).join('');
    }
  }

  /* ---- 拆分与键位 ----
     分级重绘修掉了 #prompt 这一路，但这里每个键都还在重建 #decode。
     难点是两条调用方提供的逃生口都在 renderDecode 内部按需触发：
       · 拖选复制（bootstrapDecodeCopy）：依赖节点身份，
         而每次重绘都会 withSelectionGuard 存/取选区；
       · 框选连击（enableDecodeDragChain）：直接检查 document.contains(pa)，
         节点被换掉后 startEl 立刻失效。
     patch 掉这两条属于「用『不改动 renderDecode』换取的收益」，
     风险高于本次优化的对象，且基准里 B 那条「完成音节仍会重绘解码区」
     在语义上正是要求它重建 —— 于是这一轮到此为止，只把题干摘出去。 */
  renderDecode(eng, q, decode);

  /* ---- HUD ---- */
  updateHud();
  updateTimebar();

  /* ---- 键位图高亮 ---- */
  applyMiniKeymapVisibility();
  highlightMiniKeymap();

  /* ---- 提示态还原 ----
     提示可能是在「上一次渲染」时就已亮起的。上面 clearHint() 把它擦掉了，
     但引擎里的 _hintLevel 仍是 hint/reveal，这里据实补回来，
     避免引擎已经提示了、界面却什么都没显示。 */
  const lv = eng.hintLevel ? eng.hintLevel() : '';
  if (lv) {
    const t = eng.currentTarget();
    if (t) renderHint({
      level: lv,
      idleMs: eng.idleMs ? eng.idleMs() : 0,
      key: String((t.keys || [])[t.pos] || '').toLowerCase(),
      pos: t.pos,
      role: t.role,
      part: t.part2 || t.part,
      code: t.split ? t.split.code : ''
    });
  }
}

function renderDecode(eng, q, container) {
  if (!container) return;

  // 测验题干保留，答案不进入 DOM，避免视觉与读屏提前泄露键位。
  if (eng.examMode) {
    container.innerHTML = '<div class="decode-empty">凭记忆输入双拼编码</div>';
    return;
  }

  if (eng.assistanceLevel() > 0) {
    const py = eng.assistanceLevel() === 1 ? (q.chars || []).filter(c => !c.punct).map(c => c.pinyin).join(' ') : '';
    container.innerHTML = `<div class="decode-empty">${py ? escapeHtml(py) : '凭记忆输入'} · 卡住可按 Tab 求助</div>`;
    return;
  }

  // 拆分成分题（只听声母 / 只听韵母）：只展示要考的那一步
  if (q.kind === 'part') {
    const target = eng.currentTarget();
    if (!target || !target.split) { container.innerHTML = '<div class="decode-empty">—</div>'; return; }
    const stepIdx = Number.isInteger(target.stepIndex) ? target.stepIndex : 0;
    const step = target.split.steps[stepIdx] || {};
    const roleCls = target.part === 'sheng' ? 'kc-sheng' : 'kc-yun';
    container.innerHTML = `
      <div class="syl-block is-current" data-part-block="1">
        <div class="syl-top">${escapeHtml(target.pinyin)} ${escapeHtml(target.part === 'sheng' ? '声母' : '韵母')}</div>
        <div class="syl-keys">
          <span class="kc ${roleCls} is-next">
            <span class="kc-role">${target.part === 'sheng' ? '声' : '韵'}</span>
            <span class="kc-letter">${escapeHtml(String(step.key || ''))}</span>
            <span class="kc-part">${escapeHtml(step.part || '')}</span>
          </span>
        </div>
      </div>
      <div class="syl-block" style="min-width:auto">
        <div class="syl-top">完整编码</div>
        <div class="syl-keys">
          ${target.split.steps.map(st => `
            <span class="kc ${st.role === 'sheng' ? 'kc-sheng' : (st.role === 'zero' ? 'kc-zero' : 'kc-yun')}"
                  style="opacity:${st === step ? 1 : .45}">
              <span class="kc-role">${st.role === 'sheng' ? '声' : (st.role === 'zero' ? '首' : '韵')}</span>
              <span class="kc-letter">${escapeHtml(String(st.key))}</span>
              <span class="kc-part">${escapeHtml(st.part || '')}</span>
            </span>`).join('')}
        </div>
      </div>`;
    return;
  }

  // 键位模式：直接展示单键目标
  if (q.kind === 'key') {
    const target = eng.currentTarget();
    if (!target) { container.innerHTML = '<div class="decode-empty">—</div>'; return; }
    const keys = target.keys || [];
    const pos = target.pos || 0;
    const splitLike = {
      steps: keys.map((k, i) => ({
        key: k,
        role: i === 0 ? (target.role === 'sheng' ? 'sheng' : 'zero') : (target.role === 'sheng' ? 'sheng' : 'yun'),
        part: target.char,
        label: i === 0 ? '目标键' : '第 2 键'
      })),
      code: keys.join(''),
      text: `${target.char} → ${keys.join('+')}`,
      zero: target.role !== 'sheng',
      sheng: target.role === 'sheng' ? target.char : '',
      yun: target.role === 'sheng' ? '' : target.char
    };
    container.innerHTML = buildSylBlock(splitLike, eng, true);
    return;
  }

  const ch = eng.currentChar();
  if (!ch || ch.punct || ch.unknown || !ch.syl) {
    container.innerHTML = `<div class="decode-empty">${ch && ch.punct ? '标点，自动跳过' : '按下第一个键开始'}</div>`;
    return;
  }

  // 展示：当前音节的拆分 + 可见的上下文（前后各一个字）
  const q2 = eng.currentQuestion();
  const chars = q2.chars || [];
  const blocks = [];
  const from = Math.max(0, eng.charIndex - 1);
  const to = Math.min(chars.length, eng.charIndex + 2);

  for (let i = from; i < to; i++) {
    const c = chars[i];
    if (!c) continue;
    if (c.punct || c.unknown || !c.syl) {
      blocks.push(`<div class="syl-block" style="opacity:.5;min-width:auto"><div class="syl-top">${escapeHtml(c.ch)}</div><div class="decode-empty" style="min-height:auto;font-size:11.5px">跳过</div></div>`);
      continue;
    }
    const isCurrent = i === eng.charIndex;
    blocks.push(buildSylBlock(c.syl.split || c.syl.candidates[0], eng, isCurrent, c.ch));
  }
  container.innerHTML = blocks.join('');
}

function buildSylBlock(split, eng, isCurrent, chOverride) {
  if (!split || !split.steps) return '';
  const typedCount = isCurrent ? (eng.typed || '').length : 0;
  const curPos = isCurrent && eng.currentTarget() ? eng.currentTarget().pos : -1;

  const keysHtml = split.steps.map((step, i) => {
    const roleCls = step.role === 'sheng' ? 'kc-sheng'
      : step.role === 'zero' ? 'kc-zero' : 'kc-yun';
    const cls = ['kc', roleCls];
    if (isCurrent) {
      if (i < typedCount) cls.push('is-hit');
      else if (i === curPos) cls.push('is-next');
    }
    const roleLabel = step.role === 'sheng' ? '声'
      : step.role === 'zero' ? '首' : '韵';
    return `<span class="${cls.join(' ')}">
      <span class="kc-role">${roleLabel}</span>
      <span class="kc-letter">${escapeHtml(step.key)}</span>
      <span class="kc-part">${escapeHtml(step.part)}</span>
    </span>`;
  }).join('');

  const ch = chOverride || '';
  const top = split.zero
    ? `${escapeHtml(ch)} ${escapeHtml(split.yun)}<span class="sep">·</span>零声母`
    : `${escapeHtml(ch)} ${escapeHtml(split.sheng)}<span class="sep">+</span>${escapeHtml(split.yun)}`;

  return `<div class="syl-block${isCurrent ? ' is-current' : ''}">
    <div class="syl-top">${top}</div>
    <div class="syl-keys">${keysHtml}</div>
  </div>`;
}

function updateHud() {
  const eng = app.engine;
  if (!eng) return;
  const st = eng.visibleStats();

  setText('#hudSpeed', st.speed);
  setText('#hudAcc', st.accuracy);
  setText('#hudTime', formatClock(st.elapsedSec));
  setText('#hudProgress', st.progress);
  setText('#hudCombo', st.combo);
  setText('#hudMaxCombo', st.maxCombo);
  /* 今日目标格子也在这里刷新。
     注意：这是**每 tick** 调用的（updateHud ← eng.on('tick')），
     而 dailyGoalProgress 内部会 summarize() 读一遍全部历史 ——
     一轮练习动辄几百条记录，每秒读一次并不划算。
     所以这里做了节流：同一秒内不重复计算。 */
  const now = Date.now();
  if (now - (app._goalHudAt || 0) >= 1000) {
    app._goalHudAt = now;
    renderGoalHud();
  }
}

/**
 * 渲染练习 HUD 里的「今日目标」格子。
 *
 * 【口径来源】必须与统计页的「今日 N 字」同源 —— 都走 stats.summarize()，
 * 它内部用 dateStr(new Date()) 划今天。自己再写一套日期判断迟早会错开
 * （比如把「凌晨 4 点前算昨天」这类规则只加在一处）。
 *
 * 【为什么要容忍「没设目标」】goalChars / goalSessions 都是 0 时不能画一条
 * 永远 0% 的进度条 —— 那看起来像「你还没开始」，而实际是「你没设目标」。
 * 这一格直接隐藏。
 *
 * 【为什么练习中也要更新】练习开始时调用一次（显示今天的起点），
 * 每答完一题再调用一次（今日字数在增长）。这里只在**练习内更新**，
 * 不引入新的定时器 —— updateHud 本来就被答题事件驱动。
 *
 * 【达标的处理】达标只提示一次：用 app._goalToastDay 记住「哪一天已经
 * 提示过」，避免每答一个字就弹一次 toast。跨天（日期字符串变化）自动重置。
 */
function renderGoalHud() {
  const item = cacheEl('#hudGoalItem');
  if (!item) return;

  const prog = dailyGoalProgress(app.settings);

  if (!prog.hasGoal) {
    item.hidden = true;
    return;
  }
  item.hidden = false;

  /* 显示哪个维度：两个都设时以「更不容易达标」的那个为准（与 ratio 同源，
     取比率较小者），这样格子里的数字和进度条的方向一致 —— 否则会出现
     「字数 500/300 已超额，但次数 0/1 还没开始」却显示「500/300」的错位。
     只有次数目标时显示 N/M 次。 */
  const useChars = prog.goalChars > 0 &&
    (prog.goalSessions <= 0 || (prog.chars / prog.goalChars) <= (prog.sessions / prog.goalSessions));

  const now = useChars ? prog.chars : prog.sessions;
  const total = useChars ? prog.goalChars : prog.goalSessions;
  setText('#hudGoal', now);
  setText('#hudGoalUnit', `/${total} ${useChars ? '字' : '次'}`);

  item.classList.toggle('is-done', prog.achieved);

  // 达标只提示一次（按天去重）
  const today = S.dateStr(new Date());
  if (prog.achieved && app._goalToastDay !== today) {
    app._goalToastDay = today;
    toast('今日目标已达成 🎉', 'ok');
    playSound('finish', app.settings.sound);
    if (app.view === 'stats') renderStatsView();
  }
}

function updateTimebar() {
  const eng = app.engine;
  const fill = cacheEl('#timebarFill');
  if (!fill) return;
  if (!eng || !eng.durationSec) {
    fill.style.width = '0%';
    fill.className = 'timebar-fill';
    return;
  }
  const pct = Math.max(0, Math.min(100, (eng.elapsedSec / eng.durationSec) * 100));
  fill.style.width = pct + '%';
  fill.className = 'timebar-fill' + (pct > 90 ? ' is-critical' : pct > 70 ? ' is-low' : '');
}

function setText(sel, val) {
  // 走缓存：这 6 个 HUD 格子每键/每 tick 都要刷，是最典型的热点
  const el = cacheEl(sel);
  if (el) el.textContent = String(val);
}

/* ---- 错误反馈 ---- */

function showErrorFeedback(fb) {
  const box = $('#feedback');
  if (!box || !fb) return;

  if (app.engine?.examMode || app.engine?.assistanceLevel() > 0) {
    box.className = 'feedback is-err'; box.hidden = false;
    box.textContent = '按错了，请重试。' + (app.engine.examMode ? '' : ' 需要帮助可按 Tab。');
    if (app._fbTimer) clearTimeout(app._fbTimer);
    app._fbTimer = setTimeout(() => clearFeedback(), 3200);
    return;
  }
  const keySeq = (fb.expectedAll || []).map((k, i) =>
    i === fb.pos ? `<b style="text-decoration:underline">${escapeHtml(k)}</b>` : escapeHtml(k)
  ).join(' ');

  box.className = 'feedback is-err';
  box.hidden = false;
  box.innerHTML =
    `<span class="fb-icon">✕</span>` +
    `<span>你按了 <code>${escapeHtml(fb.pressed)}</code>，这里应该是 <code>${escapeHtml(fb.expected)}</code>` +
    `${fb.expectedAll && fb.expectedAll.length > 1 ? `（完整编码 <code>${escapeHtml(fb.codeText)}</code>）` : ''}` +
    /* 非严格模式下会顺带跳到下一个字，不说清楚用户会以为按键失灵了 */
    `${fb.skipped ? '<b>（非严格模式，已跳到下一个）</b>' : ''}</span>` +
    `<span class="fb-explain">${escapeHtml(fb.explain || '')}</span>`;

  // 自动淡出
  if (app._fbTimer) clearTimeout(app._fbTimer);
  app._fbTimer = setTimeout(() => clearFeedback(), 3200);
}

function clearFeedback() {
  const box = cacheEl('#feedback');
  if (!box) return;
  box.hidden = true;
  box.innerHTML = '';
}

/* ---- 卡住提示 ---- */

/**
 * 渲染提示条。
 * 分两级：
 *   hint   —— 只说「该看哪个键了」，不给答案。目的是把人从发呆里拽出来，
 *             但保留「自己想起来」的机会。
 *   reveal —— 直接给答案。用于长时间仍然卡住的兜底，以及用户按 Tab 主动求助。
 */
function renderHint(p) {
  const bar = $('#hintBar');
  const flag = $('#hintFlag');
  const flagText = $('#hintFlagText');
  const note = $('#miniKeymapNote');
  const panes = $$('#decode .syl-block');
  if (!bar || !p) return;
  // 重新渲染会换掉按钮节点，旧的委托目标随之失效 → 重新挂一次。
  // 静态 HTML 里那个同名按钮已经不存在（这里每次都被 innerHTML 覆盖），
  // 所以「只绑一次」的写法反而会漏掉后续点击。
  if (!bar.dataset.hintBound) {
    bar.dataset.hintBound = '1';
    bar.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('#btnHintNow') : null;
      if (btn) requestHintNow();
    });
  }

  const isReveal = p.level === 'reveal';
  const roleName = p.role === 'sheng' ? '声母' : (p.role === 'zero' ? '首字母' : '韵母');
  const partText = p.part ? `「${escapeHtml(p.part)}」` : '';

  bar.hidden = false;
  bar.className = 'hintbar' + (isReveal ? ' is-reveal' : '');

  if (isReveal) {
    bar.innerHTML =
      `<span class="hintbar-icon">💡</span>` +
      `<span class="hintbar-text">` +
      `${p.manual ? '你按下了 Tab —— ' : `停留 ${Math.round((p.idleMs || 0) / 1000)} 秒，`}` +
      `${roleName}${partText} 应落在 <code>${escapeHtml((p.key || '').toUpperCase())}</code> 键` +
      `${p.code ? `（完整编码 <code>${escapeHtml(p.code)}</code>）` : ''}</span>`;
  } else {
    bar.innerHTML =
      `<span class="hintbar-icon">💡</span>` +
      `<span class="hintbar-text">` +
      `这个键想不起来？看下面的键盘 —— 闪烁的键就是${roleName}${partText}所在的位置。` +
      `还不会就按 <b>Tab</b> 看答案。</span>` +
      `<button class="btn btn-ghost btn-sm" id="btnHintNow">看提示（Tab）</button>`;
  }

  // 顶部状态标记
  if (flag) {
    flag.hidden = false;
    flag.className = 'hint-flag' + (isReveal ? ' is-reveal' : '');
    if (flagText) flagText.textContent = isReveal ? '已给答案' : '提示中';
  }
  if (note) note.textContent = isReveal ? '答案已给出，不计入独立正确率' : '闪烁的键 = 当前答案';

  // 把「下一步」那块标成提示态，视觉上和键位图呼应
  if (panes.length) {
    const last = panes[panes.length - 1];
    if (last) last.classList.add(isReveal ? 'is-hinted-reveal' : 'is-hinted');
  }
}

function clearHint() {
  app.hint = null;
  const bar = cacheEl('#hintBar');
  const flag = cacheEl('#hintFlag');
  const note = cacheEl('#miniKeymapNote');
  /* 只在「确实有东西要清」时才写。
     clearHint 挂在每键路径上（renderSession 开头无条件调用），
     而绝大多数按键时提示条本来就是空的 —— 不加这个判断，
     每键都会对空元素执行一次 innerHTML=''（一次 HTML 解析 +
     一次子节点回收），而结果与不写完全一致。
     判据用 innerHTML 是否为空，而不是 hidden：hidden 为 true 也可能
     残留着上一次的内容（clearHint 之外没人会清它）。 */
  if (bar) {
    if (bar.innerHTML !== '') bar.innerHTML = '';
    bar.hidden = true;
    bar.className = 'hintbar';
  }
  if (flag) { flag.hidden = true; flag.className = 'hint-flag'; }
  if (note) note.textContent = '';
  $$('#decode .syl-block').forEach(el => el.classList.remove('is-hinted', 'is-hinted-reveal'));
}

/** 用户主动求助（Tab / 点按钮） */
function requestHintNow() {
  if (!app.engine) return;
  if (app.engine.examMode) {
    // 测验中不提供任何求助。给出明确说明，避免用户以为是功能坏了。
    toast('测验模式不提供提示', 'err');
    return;
  }
  if (!app.engine.requestHint || !app.engine.requestHint('reveal')) {
    toast('当前没有可提示的内容', 'err');
  }
}

/* ---- 迷你键位图 ---- */

function ensureMiniKeymap() {
  const wrap = $('#miniKeymap');
  if (!wrap || app.keymap) return;
  try {
    app.keymap = renderKeymap(wrap, {});
    applyMiniKeymapVisibility();
  } catch (err) {
    console.error('[keymap] 迷你键位图渲染失败', err);
    wrap.innerHTML = '';
  }
}

/**
 * 迷你键位图的显示/隐藏。
 * 平时由用户设置（showMiniKeymap）控制；测验模式下**一律隐藏**，
 * 因为它会把当前该按的键直接画出来，等于变相给答案。
 *
 * 这里对**外层容器**（.mini-keymap-wrap，含「键位提示」标题与显示/隐藏按钮）
 * 统一使用 `hidden` 属性，而不是只改内层 style.display ——
 * 属性式隐藏语义更清晰，也便于测试直接断言（CSS 的 display:none
 * 在 jsdom/linkedom 里读不出来）。CSS 里的 .is-exam 规则作为兜底保留。
 */
function applyMiniKeymapVisibility() {
  const isExam = !!(app.engine && app.engine.examMode);
  /* 三层可见性，从外到内：
     ① 训练阶段 / 测验模式决定「该不该有」；
     ② 用户的显示/隐藏开关决定「想不想看」（app.keymapHidden，可为 null）；
     ③ 暂停/结束态强制收起。
     之前按钮改的是 style.display，而本函数每次 renderSession 都跑、
     只看设置项，于是每帧都把用户的选择覆盖回去 —— 按钮写着「显示」
     键位图却可见，反之亦然。 */
  const stageAllows = !isExam &&
    (!app.engine || app.engine.assistanceLevel() === 0 || !!app.engine.hintLevel());
  const stateAllows = !app.engine ||
    (app.engine.state !== STATE.PAUSED && app.engine.state !== STATE.FINISHED);
  // keymapHidden 为 null = 用户没表态，听持久设置；true/false = 本轮练习里的临时选择
  const wants = app.keymapHidden === null ? app.settings.showMiniKeymap : !app.keymapHidden;
  const visible = stageAllows && stateAllows && wants;
  const wrap = $('#miniKeymap');
  const outer = wrap && wrap.closest ? wrap.closest('.mini-keymap-wrap') : null;
  if (outer) outer.hidden = !visible;
  if (wrap) wrap.hidden = !visible;
  const btn = $('#btnToggleKeymap');
  if (btn) {
    btn.textContent = visible ? '隐藏' : '显示';
    // 被阶段/状态强制收起时按钮不可点，否则用户点了会以为坏了
    btn.disabled = !stageAllows || !stateAllows;
  }
}

function highlightMiniKeymap() {
  if (!app.keymap || !app.engine) return;
  try {
    // 测验模式下绝不把答案画到键位图上
    if (app.engine.examMode || (app.engine.assistanceLevel() > 0 && !app.engine.hintLevel())) { app.keymap.clear(); return; }
    if (app.engine.state === STATE.PAUSED || app.engine.state === STATE.FINISHED) {
      app.keymap.clear();
      return;
    }
    app.keymap.setHighlight(app.engine.keymapHighlight());
  } catch (err) {
    console.warn('[keymap] 高亮失败', err);
  }
}

/* ============================================================
   键盘输入接管
   ============================================================ */

function initHiddenInput() {
  const input = $('#hiddenInput');
  if (!input) return;

  // 移动端：点击舞台时聚焦隐藏输入以唤起键盘
  const stage = $('#stage');
  if (stage) {
    stage.addEventListener('click', () => {
      if (isTouchDevice()) input.focus();
    });
  }

  // 隐藏输入兜底（移动端 / 输入法异常时）
  input.addEventListener('input', () => {
    const v = input.value;
    input.value = '';
    if (!v) return;
    const ch = v[v.length - 1];
    handleKeyInput(ch);
  });
  input.addEventListener('compositionend', () => {
    input.value = '';
  });

  // 主键盘监听
  window.addEventListener('keydown', onKeyDown, { capture: true });
}

function isTouchDevice() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
}

/**
 * 当前是否应「减少动态效果」。
 *
 * 用户显式设置（'on'/'off'）优先；'auto' 时跟随系统。
 * 这个值在启动与系统设置变化时都会刷新（见 initA11y）。
 */
function currentReduceMotion() {
  const pref = app.settings && app.settings.reduceMotion;
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return prefersReducedMotion();
}

/** 当前生效的快捷键映射（用户配置已合并默认值、已校验） */
function shortcuts() {
  return mergeShortcuts(app.settings && app.settings.shortcuts);
}

let lastKeyAt = 0;

function onKeyDown(e) {
  // 任何输入控件聚焦时不拦截（设置页、搜索框等）
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
            t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    // 但如果是隐藏输入，仍交给 input 事件处理
    if (!t.classList || !t.classList.contains('hidden-input')) return;
  }

  // 中文输入法组合中：忽略，避免把候选词当按键
  if (e.isComposing || e.keyCode === 229) return;

  // 快捷键在「设置页改键」时需要先被吞掉，避免触发器动作
  if (app._capturingShortcut) return;

  const sc = shortcuts();

  /* ---- 全局快捷键 ---- */
  // 暂停/继续（默认 Esc）
  if (matchesShortcut(e, sc.pause)) {
    if (isModalOpen()) { closeModal(); return; }
    if (app.engine && app.engine.state === STATE.RUNNING) {
      e.preventDefault();
      app.engine.pause();
      updatePauseButton();
      return;
    }
  }

  if (!isSessionActive()) return;

  // 看答案 / 求助（默认 Tab）
  if (matchesShortcut(e, sc.hint)) {
    /* 焦点在某个键/按钮上时，Tab 必须让给浏览器的原生焦点导航。
       否则「Tab 求助」会把 Tab 从焦点键上偷走 —— 而键位图页那 26 个键
       正是靠 Tab 才能到达的，等于把「继续往下 Tab」变成「看答案」，
       焦点再也走不动。这是 2026-10 给键位图加上 role/tabindex 之后
       才出现的冲突（在那之前 SVG 里根本没有可聚焦元素）。 */
    const ae = document.activeElement;
    const tabWanted = e.key === 'Tab' &&
      ae && ae !== document.body && ae !== document.documentElement;
    if (!tabWanted) {
      // 只有真的绑定了快捷键才 preventDefault —— 用户选择「不占用 Tab」时，
      // Tab 应当恢复成浏览器原生的焦点导航，不能被我们吞掉。
      e.preventDefault();
      if (app.engine && app.engine.state === STATE.RUNNING) requestHintNow();
      return;
    }
  }

  // 跳过当前（默认 Backspace）
  if (matchesShortcut(e, sc.skip)) {
    e.preventDefault();
    if (app.engine && app.engine.state === STATE.RUNNING) {
      app.engine.skipCurrent();
      clearFeedback();
      playSound('correct', app.settings.sound);
    }
    return;
  }

  // 提交（测验模式下 Enter 结束）
  if (matchesShortcut(e, sc.submit)) {
    if (app.engine && app.engine.state === STATE.RUNNING && app.engine.examMode) {
      e.preventDefault();
      finishSession();
      return;
    }
  }

  /* ---- 作答键：按**物理键位**取字母 ----
     用 e.code 而非 e.key，才能让 Dvorak / 其它布局的用户练到
     「手指实际落在哪个键」，详见 ui/a11y.js::letterFromEvent 的注释。 */
  const key = letterFromEvent(e);
  if (!key) {
    // 其它键不阻止默认，但也不进入练习
    return;
  }

  e.preventDefault();
  // 极短的重复触发保护（某些输入法会连发）
  const now = performance.now();
  if (now - lastKeyAt < 8) return;
  lastKeyAt = now;

  handleKeyInput(key);
}

function handleKeyInput(rawKey) {
  if (!app.engine) return;
  if (!isSessionActive()) return;

  // 按了键就说明人已经动起来了，提示该收了。
  // 引擎内部也会重置计时器，这里同步清 UI，避免提示条留到下一键。
  if (app.hint) clearHint();

  const result = app.engine.pressKey(rawKey);
  saveProgress();

  if (!result || !result.handled) return;

  if (result.correct === false) {
    // 错误反馈已由 error 事件渲染（含音效与播报）
    flashStageError();
  } else if (result.feedback && result.feedback.type === 'ok') {
    // 正确：轻脆一声 + 播报当前进度（polite，不打断）
    playSound('correct', app.settings.sound);
    flashStageOk();
    clearFeedback();
    announceProgress();
  } else {
    clearFeedback();
  }
}

/** 播报练习进度（屏幕阅读器，polite 队列） */
function announceProgress() {
  try {
    const eng = app.engine;
    if (!eng) return;
    const s = eng.visibleStats ? eng.visibleStats() : null;
    if (!s) return;
    // 只在「整题完成」时播报，避免每按一键都念 —— 那会吵到没法用
    const t = eng.currentTarget();
    if (t && t.kind === 'syllable' && t.pos === 0) {
      announce(`${t.char || t.pinyin || ''} 完成。已完成 ${s.totalChars} 字，正确率 ${s.accuracy}%`);
    }
  } catch (e) {
    // 播报失败不该打断练习，但也不能彻底无声 —— 这条走了太久静默，
    // 出问题时连线索都没有。降级为警告，不进 toast（那是给用户看的）。
    console.warn('[a11y] 进度播报失败', e);
  }
}

/**
 * 错误时让「舞台」抖一下 —— 但必须尊重「减少动态效果」。
 *
 * 抖动/闪烁对前庭敏感的用户会引起真实不适，所以系统开了这个设置时
 * 我们换成**不移动**的提示：把边框闪一下，信息量等价，但不动。
 */
function flashStageError() {
  const stage = cacheEl('#stage');
  if (!stage) return;
  if (currentReduceMotion()) {
    // 静态替代：描边高亮一下，不做位移
    stage.classList.add('is-error-static');
    setTimeout(() => stage.classList.remove('is-error-static'), 260);
    return;
  }
  try {
    stage.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' },
       { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }],
      { duration: 180, easing: 'ease-in-out' }
    );
  } catch (_) { /* 不支持 Web Animations 时静默降级 */ }
}

function flashStageOk() {
  const decode = cacheEl('#decode');
  if (!decode) return;
  if (currentReduceMotion()) return;   // 正确本来就不需要视觉强调
  try {
    decode.animate(
      [{ opacity: 1 }, { opacity: .55 }, { opacity: 1 }],
      { duration: 160 }
    );
  } catch (_) { /* 同上 */ }
}

function isSessionActive() {
  const panel = $('#sessionPanel');
  if (!panel || panel.hidden) return false;
  if (!app.engine) return false;
  return app.engine.state === STATE.RUNNING || app.engine.state === STATE.IDLE;
}

/* ============================================================
   续练提示
   ============================================================ */

function initResume() {
  showResumeHint();
}

function showResumeHint() {
  try {
    const saved = S.loadResume();
    const hint = $('#resumeHint');
    const text = $('#resumeText');
    if (!hint || !text) return;
    if (!saved) { hint.hidden = true; return; }

    const lv = LEVEL_MAP[saved.mode];
    const done = (saved.questionOffset || 0) + (saved.index || 0);
    const total = (saved.questions || []).length;
    text.textContent = `上次「${lv ? lv.name : saved.mode}」进行到 ${saved.unlimited ? `${done + 1}/∞` : `${done + 1}/${total}`} 题`;
    hint.hidden = false;
  } catch (err) {
    console.warn('[resume] 读取失败', err);
  }
}

/* ============================================================
   键位图页面
   ============================================================ */

function initKeymapView() {
  const wrap = $('#fullKeymap');
  if (wrap) {
    try {
      app.fullKeymap = renderKeymap(wrap, {
        onKeyClick: (key) => showKeyDetail(key)
      });
    } catch (err) {
      console.error('[keymap] 完整键位图渲染失败', err);
    }
  }

  const search = $('#sylSearch');
  if (search) {
    search.addEventListener('input', () => renderSyllableList());
  }

  const chips = $('#sylFilterChips');
  if (chips) {
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      $$('#sylFilterChips .chip').forEach(c => c.classList.toggle('is-active', c === chip));
      renderSyllableList();
    });
  }

  renderSyllableList();
}

function showKeyDetail(key) {
  const box = $('#keyDetail');
  if (!box) return;
  const data = getKeymapData().find(d => d.key === key);
  if (!data) { box.hidden = true; return; }

  const sheng = data.shengmu.length
    ? data.shengmu.map(s => `<b>${escapeHtml(s)}</b>`).join('、')
    : '（无）';
  const yun = data.yunmu.length
    ? data.yunmu.map(y => `<b>${escapeHtml(y)}</b>`).join('、')
    : '（无）';
  const second = data.secondOf && data.secondOf.length
    ? data.secondOf.map(s => `<b>${escapeHtml(s)}</b>`).join('、')
    : '';

  // 举例（小鹤：zh/ch/sh 各占一键，整音节恒为 2 键）
  const examples = [];
  if (data.shengmu.includes('zh')) examples.push('zhang → VH');
  if (data.shengmu.includes('ch')) examples.push('chun → IY');
  if (data.shengmu.includes('sh')) examples.push('shen → UF');
  if (data.yunmu.includes('ang')) examples.push('zhang → VH');
  if (data.yunmu.includes('eng')) examples.push('zheng → VG');
  if (data.yunmu.includes('ui')) examples.push('zhui → VV');
  if (data.yunmu.includes('u')) examples.push('shu → UU');
  if (data.yunmu.includes('i')) examples.push('qi → QI');
  if (data.yunmu.includes('v')) examples.push('lv → LV');

  box.hidden = false;
  box.innerHTML = `
    <h4>${escapeHtml(key)} 键</h4>
    <div class="kd-rows">
      <div class="kd-row">作为声母键：${sheng}</div>
      <div class="kd-row">作为韵母键：${yun}</div>
      ${second ? `<div class="kd-row">作为双字母声母第二键：${second}</div>` : ''}
      ${examples.length ? `<div class="kd-row">示例：${examples.map(escapeHtml).join('　')}</div>` : ''}
      ${data.shengmu.includes('zh') || data.shengmu.includes('ch') || data.shengmu.includes('sh')
        ? '<div class="kd-row" style="color:#5a6577">提示：zh / ch / sh 各占一键（zh→V、ch→I、sh→U），整个音节仍是 2 键</div>' : ''}
    </div>
  `;
  if (app.fullKeymap) {
    app.fullKeymap.setHighlight(
      data.yunmu.map(y => ({ key, role: 'yun' }))
        .concat(data.shengmu.map(s => ({ key, role: 'sheng' })))
    );
  }
}

function renderSyllableList() {
  const list = $('#sylList');
  if (!list) return;

  const search = ($('#sylSearch') ? $('#sylSearch').value : '').trim().toLowerCase();
  const activeChip = $('#sylFilterChips .chip.is-active');
  const filter = activeChip ? activeChip.getAttribute('data-filter') : 'all';

  // 从字表推导全部出现过的拼音，去重
  const set = new Map();
  for (const [ch, py] of Object.entries(ALL_CHARS)) {
    if (!py) continue;
    if (!set.has(py)) set.set(py, []);
    set.get(py).push(ch);
  }

  let items = Array.from(set.entries()).map(([py, chars]) => {
    const split = primarySplit(py);
    return { py, chars, split };
  }).filter(x => x.split);

  if (filter === 'zero') items = items.filter(x => x.split.zero);
  if (filter === 'sheng') items = items.filter(x => !x.split.zero);
  if (search) {
    items = items.filter(x =>
      x.py.includes(search) ||
      x.split.code.toLowerCase().includes(search) ||
      x.chars.some(c => c.includes(search)));
  }

  items.sort((a, b) => a.py.localeCompare(b.py));

  if (!items.length) {
    list.innerHTML = '<div class="syl-empty">没有匹配的拼音</div>';
    return;
  }

  list.innerHTML = items.slice(0, 400).map(x => `
    <div class="syl-item${x.split.zero ? ' is-zero' : ''}" data-py="${escapeHtml(x.py)}" title="点击练习这个音节">
      <div class="syl-item-top">
        <span class="syl-item-py">${escapeHtml(x.py)}</span>
        <span class="syl-item-keys">${escapeHtml(x.split.code)}</span>
      </div>
      <div class="syl-item-split">
        ${x.split.zero ? '零声母' : escapeHtml(x.split.sheng) + ' + ' + escapeHtml(x.split.yun)}
        · ${escapeHtml(x.chars.slice(0, 4).join(''))}
      </div>
    </div>
  `).join('');

  // 点击直接练这个音节
  list.querySelectorAll('.syl-item').forEach(el => {
    el.addEventListener('click', () => {
      const py = el.getAttribute('data-py');
      const split = primarySplit(py);
      if (!split) return;
      const chars = set.get(py) || [];
      const ch = chars[0] || '';
      const q = ch ? questionFromCharChar(ch, py) : null;
      const questions = q ? [q, q] : null;
      if (questions) {
        switchView('practice');
        startSession(questions, 'char');
      }
    });
  });
}

/* ============================================================
   统计页面
   ============================================================ */

function renderStatsView() {
  try {
    const modeSelect = $('#statsMode');
    if (modeSelect && !modeSelect._bound) {
      modeSelect.innerHTML = '<option value="all">全部模式</option>' + LEVELS.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
      modeSelect._bound = true;
      modeSelect.addEventListener('change', () => { app.stats.mode = modeSelect.value; renderStatsView(); });
    }
    if (modeSelect) modeSelect.value = app.stats.mode;
    const history = S.loadHistory().filter(r => app.stats.mode === 'all' || r.mode === app.stats.mode);
    const sum = summarize(history);

    /* ---- 卡片 ---- */
    const cards = $('#statCards');
    if (cards) {
      /* 「今日」这张卡要同时回答两个问题：今天做了多少、离目标还有多远。
         口径必须与练习页 HUD 完全一致 —— 都用 dailyGoalProgress()，
         它内部复用 summarize()，所以数字不会两边打架。
         不设目标时（hasGoal=false）回落到原来的「N 次练习」副标题。 */
      const goal = dailyGoalProgress(app.settings, sum);
      const todaySub = goal.hasGoal
        ? (goal.achieved
            ? `已完成目标（${goal.percent}%）· ${sum.todaySessions} 次练习`
            : goalSubText(goal))
        : `${sum.todaySessions} 次练习`;

      cards.innerHTML = `
        ${statCard('累计练习', sum.sessions, '次', `${sum.totalDays} 个练习日`)}
        ${statCard('累计字数', sum.totalChars, '字', `总时长 ${formatDuration(sum.totalSeconds)}`)}
        ${statCard('平均速度', sum.avgSpeed, '字/分', `最佳 ${sum.bestSpeed} 字/分`)}
        ${statCard('平均正确率', sum.avgAccuracy, '%', `最佳 ${sum.bestAccuracy}%`)}
        ${statCard('连续练习', sum.streakDays, '天', sum.streakDays >= 3 ? '节奏很好' : '坚持就有效果')}
        ${statCard('今日', sum.todayChars, '字', todaySub, goal.hasGoal ? `目标进度 ${goal.percent}%` : '')}
      `;

      // 目标进度条（独立于卡片网格，放在卡片下方）
      const goalBar = $('#todayGoalBar');
      if (goalBar) {
        if (!goal.hasGoal) {
          goalBar.hidden = true;
        } else {
          goalBar.hidden = false;
          goalBar.className = 'today-goal' + (goal.achieved ? ' is-done' : '');
          goalBar.innerHTML = `
            <div class="tg-head">
              <span class="tg-title">今日目标</span>
              <span class="tg-pct">${goal.percent}%</span>
            </div>
            <div class="tg-track"><div class="tg-fill" style="width:${goal.percent}%"></div></div>
            <div class="tg-detail">${escapeHtml(goalDetail(goal))}</div>
          `;
        }
      }
    }

    /* ---- 曲线 ---- */
    const canvas = $('#historyChart');
    if (canvas) {
      const series = historySeries({ range: app.stats.chartRange, metric: app.stats.chartMetric, mode: app.stats.mode });
      drawLine(canvas, series.points, {
        metric: series.metric,
        avg: series.avg,
        height: 260
      });
      /* 读屏替代：canvas 里的像素读屏拿不到，把这张图**说了什么**写进
         aria-label（随重绘更新，与图上数据一致）。空态也要如实说，
         否则读屏用户听到「图像」却不知道是没数据还是加载失败。 */
      canvas.setAttribute('aria-label', series.points.length
        ? `近 ${series.points.length} 轮${series.metric === 'acc' ? '正确率' : '速度'}曲线，均值 ${series.avg}，最低 ${series.min}，最高 ${series.max}`
        : '还没有练习记录，暂无成绩曲线');
      /* 均值线是加权值（速度按练习时长、正确率按完成字数），
         曲线上的点仍是每轮原始值 —— 所以那条线不会等于各点的算术平均。
         差异大时显式说明，免得被当成画错了。 */
      const note = $('#chartAvgNote');
      if (note) {
        const gap = Math.abs(series.avg - series.plainAvg);
        note.textContent = gap >= Math.max(1, Math.abs(series.plainAvg) * 0.02)
          ? `虚线为加权均值 ${series.avg}（${series.metric === 'acc' ? '按完成字数' : '按练习时长'}加权，各点原始值算术平均为 ${series.plainAvg}）`
          : '';
        note.hidden = !note.textContent;
      }
    }

    /* ---- 测验成绩曲线 ----
       分数在落库时就写好了（rec.score），但一直没有这张图。
       跟随上方的区间切换（20/50/全部），与历史曲线共用同一档位。 */
    const scoreCanvas = $('#scoreChart');
    if (scoreCanvas) {
      const ss = scoreSeries({ range: app.stats.chartRange });
      if (ss.points.length) {
        drawLine(scoreCanvas, ss.points, { metric: 'score', avg: ss.avg, height: 220 });
      } else {
        const ctx = scoreCanvas.getContext ? scoreCanvas.getContext('2d') : null;
        if (ctx) {
          scoreCanvas.width = scoreCanvas.width || 920;
          ctx.clearRect(0, 0, scoreCanvas.width, scoreCanvas.height);
          // 这里的颜色跟着主题走 —— 空态文案不该在深色下用浅色主题的灰。
          // getPropertyValue 对自定义属性会保留首尾空白，必须 trim；
          // 兜底色要和 style.css 的 --text-3 保持一致，否则取不到时会
          // 出现一个「两个主题都对不上」的第三种灰。
          const cssText3 = getComputedStyle(document.documentElement)
            .getPropertyValue('--text-3').trim();
          ctx.fillStyle = cssText3 || '#7d899a';
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(ss.total ? '已完成的测验都不满足计分条件（无提示或字数不足）' : '还没有做过能力测验', 460, 110);
        }
      }
      const sNote = $('#scoreNote');
      if (sNote) {
        sNote.textContent = ss.points.length
          ? `${ss.points.length} 次有效测验，平均 ${ss.avg} 分` +
            (ss.invalid ? `；另有 ${ss.invalid} 次因未达计分条件不计入` : '')
          : '';
        sNote.hidden = !sNote.textContent;
      }
      // 读屏替代：与画布上实际画的内容（曲线或空态文案）保持一致
      scoreCanvas.setAttribute('aria-label', ss.points.length
        ? `${ss.points.length} 次有效测验的成绩曲线，平均 ${ss.avg} 分，最低 ${ss.min}，最高 ${ss.max}`
        : (ss.total ? '已完成的测验都不满足计分条件（无提示或字数不足），无成绩曲线'
                    : '还没有做过能力测验，无成绩曲线'));
    }

    /* ---- 每日柱状 ---- */
    const dailyCanvas = $('#dailyChart');
    if (dailyCanvas) {
      const ds = dailySeries(app.stats.dailyDays, app.stats.mode);
      drawBars(dailyCanvas, ds, { height: 200 });
      /* 读屏替代：柱状图念不出「哪天练了多少」，给出总量与最突出的一天。 */
      const totalChars = ds.reduce((a, d) => a + d.chars, 0);
      const best = ds.reduce((a, d) => (d.chars > (a ? a.chars : 0) ? d : a), null);
      dailyCanvas.setAttribute('aria-label',
        totalChars > 0 && best
          ? `最近 ${ds.length} 天每日练习量：共练 ${totalChars} 字，最多的一天是 ${best.label}（${best.chars} 字）`
          : `最近 ${ds.length} 天还没有练习记录`);
    }

    /* ---- 错误热力图 ---- */
    // 标题跟着模式筛选走：全部模式时不必再加「（全部模式）」后缀
    const heatTitle = $('#heatTitle');
    if (heatTitle) {
      const label = app.stats.mode === 'all'
        ? '错误热力图'
        : `错误热力图（${LEVEL_MAP[app.stats.mode] ? LEVEL_MAP[app.stats.mode].name : app.stats.mode}）`;
      heatTitle.textContent = label;
    }
    renderHeatmap();

    /* ---- 易错表 ---- */
    renderWeakTable();

    /* ---- 图表切换按钮 ---- */
    bindChips('#chartMetricChips', 'metric', (v) => {
      app.stats.chartMetric = v;
      renderStatsView();
    });
    bindChips('#chartRangeChips', 'range', (v) => {
      app.stats.chartRange = v;
      renderStatsView();
    });
    bindChips('#heatRangeChips', 'range', (v) => {
      app.stats.heatRange = v;
      renderHeatmap();
    });

    /* ---- 危险区按钮 ---- */
    const btnExport = $('#btnExport');
    if (btnExport && !btnExport._bound) {
      btnExport._bound = true;
      btnExport.addEventListener('click', exportData);
    }
    const btnExport2 = $('#btnExport2');
    if (btnExport2 && !btnExport2._bound) {
      btnExport2._bound = true;
      btnExport2.addEventListener('click', exportData);
    }
    const btnClear = $('#btnClearStats');
    if (btnClear && !btnClear._bound) {
      btnClear._bound = true;
      btnClear.addEventListener('click', confirmClearStats);
    }
  } catch (err) {
    console.error('[stats] 渲染失败', err);
    const cards = $('#statCards');
    if (cards) cards.innerHTML = '<div class="empty-state">统计数据读取失败</div>';
  }
}

/**
 * 一张统计卡片。
 * @param {string} label 标题
 * @param {any}    value 主数值
 * @param {string} unit  单位（可空）
 * @param {string} sub   副标题（可空）
 * @param {string} badge 右上角小徽标（可空）。只有「今日」卡片用它显示目标进度百分比。
 */
function statCard(label, value, unit, sub, badge) {
  return `<div class="stat-card">
    <div class="stat-card-label">${escapeHtml(label)}${
      badge ? `<span class="stat-card-badge">${escapeHtml(badge)}</span>` : ''
    }</div>
    <div class="stat-card-value">${escapeHtml(String(value))}${unit ? `<i>${escapeHtml(unit)}</i>` : ''}</div>
    <div class="stat-card-sub">${escapeHtml(sub || '')}</div>
  </div>`;
}

/* 今日目标的两段文案。抽出来是为了让「卡片副标题」和「进度条明细」
   用同一套措辞 —— 两处都手写迟早会出现「还差 30 字」vs「剩余 30 字」
   这种不一致，虽然意思一样但读起来像两个功能。 */
function goalSubText(goal) {
  const parts = [];
  if (goal.goalChars > 0) parts.push(`还差 ${goal.charsLeft} 字`);
  if (goal.goalSessions > 0) parts.push(`还差 ${goal.sessionsLeft} 次`);
  return parts.join(' · ') || '还没开始';
}

function goalDetail(goal) {
  const parts = [];
  if (goal.goalChars > 0) parts.push(`字数 ${goal.chars}/${goal.goalChars}`);
  if (goal.goalSessions > 0) parts.push(`次数 ${goal.sessions}/${goal.goalSessions}`);
  return (parts.join(' · ') || '') + (goal.achieved ? ' —— 今天达标了' : '');
}

function bindChips(sel, attr, onPick) {
  const wrap = $(sel);
  if (!wrap) return;
  $$('.chip', wrap).forEach(chip => {
    chip.classList.toggle('is-active', chip.getAttribute(`data-${attr}`) === app.stats[
      attr === 'metric' ? 'chartMetric' : 'chartRange']);
  });
  if (wrap._bound) return;
  wrap._bound = true;
  wrap.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const v = chip.getAttribute(`data-${attr}`);
    if (!v) return;
    onPick(v);
  });
}

function renderWeakTable() {
  const wrap = $('#weakTableWrap');
  if (!wrap) return;

  const list = weakRanking(30);
  if (!list.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <strong>还没有易错记录</strong>
        完成几次练习后，出错的字词会自动出现在这里。
      </div>`;
    return;
  }

  const maxCount = Math.max(...list.map(w => w.count), 1);

  wrap.innerHTML = `
    <table class="weak-table">
      <thead>
        <tr>
          <th>字 / 词</th>
          <th>拼音</th>
          <th>错误次数</th>
          <th class="bar-cell">占比</th>
          <th>最近出错</th>
        </tr>
      </thead>
      <tbody>
        ${list.map(w => `
          <tr>
            <td class="w-char">${escapeHtml(w.key)}</td>
            <td class="w-pinyin">${escapeHtml(w.pinyin || '—')}</td>
            <td>${w.count}</td>
            <td class="bar-cell">
              <div class="mini-bar"><i style="width:${Math.round((w.count / maxCount) * 100)}%"></i></div>
            </td>
            <td>${escapeHtml(relTime(w.lastTs))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

/* ============================================================
   错误热力图
   ============================================================ */

/**
 * 在统计页渲染键位热力图。
 *
 * 与「易错字词表」是互补的两种视角：
 *   字词表 —— 哪些字我不会（语义层，颗粒度=字）
 *   热力图 —— 哪些键我不熟（肌肉层，颗粒度=键）
 * 后者能暴露字词表看不到的问题：某个键你其实一直在绕开，
 * 所以「错误率」低，但恰恰是它拖慢了整体速度。
 */
function renderHeatmap() {
  const wrap = $('#heatWrap');
  if (!wrap) return;

  try {
    const heat = keyHeatmap({ range: app.stats.heatRange, mode: app.stats.mode });

    /* 范围 chip 高亮 */
    $$('#heatRangeChips .chip').forEach(c =>
      c.classList.toggle('is-active', c.getAttribute('data-range') === app.stats.heatRange));

    /* 首次渲染时创建独立键位图（与练习页 / 键位图页互不影响） */
    if (!app.heatKeymap) {
      app.heatKeymap = renderKeymap(wrap, {});
    }

    if (!heat.items.length) {
      app.heatKeymap.clearHeat();
      const summary = $('#heatSummary');
      if (summary) summary.innerHTML = '';
      const top = $('#heatTop');
      if (top) {
        top.innerHTML = `<div class="empty-state" style="padding:22px">
          <strong>还没有键位错误数据</strong>
          完成练习后，按错的键会以热力色的深浅显示在这里 —— 颜色最深的键就是最该补的地方。
        </div>`;
      }
      /* 慢键层与热力层**独立**：没有错误数据不代表没有耗时数据，
         一并 return 会把「按得慢但一直按对」的用户也显示成「什么都没有」。
         掌握度层同理 —— 它靠 timings 也能算出「已掌握」。 */
      app.heatKeymap.clearSlow();
      renderSlowLayer();
      renderMasteryLayer();
      return;
    }

    app.heatKeymap.setHeat(heat.items);
    renderSlowLayer();
    renderMasteryLayer();

    /* 概览文字 */
    const summary = $('#heatSummary');
    if (summary) {
      const hot = heat.hottest;
      // 选中了某个模式、但该模式还没有专属数据（老记录没存模式）时，
      // 实际显示的是全量。必须说出来，否则「筛选看起来生效了其实没有」。
      const fallback = app.stats.mode !== 'all' && !heat.byMode
        ? '<span class="heat-fallback-note">该模式暂无专属数据，此处仍为全部模式累计</span>'
        : '';
      summary.innerHTML =
        `共 <b>${heat.total}</b> 次按键错误，涉及 <b>${heat.items.length}</b> 个键` +
        (hot ? `　最集中：<b>${escapeHtml(hot.key)}</b> 键（${hot.count} 次）` : '') + fallback;
    }

    /* TOP 排行 */
    const top = $('#heatTop');
    if (top) {
      top.innerHTML = heat.items.slice(0, 8).map(it => {
        const info = keyMeaning(it.key);
        return `<span class="heat-chip">
          <span class="heat-chip-k">${escapeHtml(it.key)}</span>
          <span class="heat-chip-c">${it.count} 次</span>
          <span class="heat-chip-m">${escapeHtml(info)}</span>
        </span>`;
      }).join('');
    }
  } catch (err) {
    console.error('[heatmap] 渲染失败', err);
    wrap.innerHTML = '<div class="empty-state">热力图渲染失败</div>';
    app.heatKeymap = null;
  }
}

/**
 * 慢键层：把「按得慢」的键以虚线环叠在同一张键盘图上。
 *
 * 与热力层共用一张图但用不同通道（热力=填充、慢键=虚线环），所以两个诊断
 * 能同时看：「又错又慢」的键既有橙色填充又有蓝色环，那是最该练的键。
 */
function renderSlowLayer() {
  const box = $('#slowKeysBox');
  if (!box || !app.heatKeymap) return;
  try {
    const slow = keySlowness({ range: app.stats.heatRange, mode: app.stats.mode });
    app.heatKeymap.setSlow(slow.items);

    if (!slow.items.length) {
      box.innerHTML = slow.thin
        ? `<div class="slow-legend-note">慢键：另有 ${slow.thin} 个键的样本不足
             ${KEY_SLOW_MIN_SAMPLES} 次，暂不显示。再练几轮就能标出。</div>`
        : '<div class="slow-legend-note">慢键：还没有足够的按键耗时数据。完成几轮练习后，'
          + '「按对但犹豫」的键会用蓝色虚线环标在这里。</div>';
      return;
    }
    const top = slow.items.slice(0, 8);
    box.innerHTML = `
      <div class="slow-legend">
        <span class="slow-legend-title">慢键（按对但犹豫）</span>
        ${top.map(it => `<span class="slow-chip">
          <span class="slow-chip-k">${escapeHtml(it.key)}</span>
          <span class="slow-chip-c">${(Math.round(it.medianMs) / 1000).toFixed(2)}s</span>
        </span>`).join('')}
      </div>
      <div class="slow-legend-note">
        取<b>中位数</b>，只统计不含读字时间的纯运动按键时间；
        整体中位数 <b>${(Math.round(slow.overall) / 1000).toFixed(2)}s</b>，
        环越粗表示越慢。${slow.thin ? `另有 ${slow.thin} 个键样本不足 ${KEY_SLOW_MIN_SAMPLES} 次未显示。` : ''}
      </div>`;
  } catch (err) {
    console.error('[slowkeys] 渲染失败', err);
    box.innerHTML = '';
    try { app.heatKeymap.clearSlow(); } catch (_) {}
  }
}

/**
 * 掌握度层：在统计页的键盘图上标出「哪些键已经练熟、哪些还没碰过」。
 *
 * 第三个诊断层，与热力（红填充 = 按错）、慢键（蓝环 = 按得慢）共用一张图。
 * 回答的是最朴素的那个问题：**「这 26 个键，我到底掌握了几个？」**
 * 前两层只能告诉你「哪里还有问题」，这一层第一次给出**进度感**——
 * 绿点一个个亮起来，是这类练习应用里唯一真正给人成就的东西。
 */
function renderMasteryLayer() {
  const box = $('#masteryBox');
  if (!box || !app.heatKeymap) return;
  try {
    const m = keyMastery({ range: app.stats.heatRange, mode: app.stats.mode });
    app.heatKeymap.setMastery(m.items);

    const { mastered, learning, untouched } = m.counts;
    if (untouched === m.total) {
      box.innerHTML = `<div class="mastery-legend">掌握度：还没有练习数据。
        练过的键会显示为「在练」，连续答对且不慢的键会亮起<b>绿色圆点</b>表示已掌握。</div>`;
      return;
    }

    // 还差一点的键（在练、且样本少于门槛的）—— 给出「再练 N 次」的量化指引
    const close = m.items.filter(it => it.state === 'learning' && it.need > 0 && it.practice > 0)
      .slice(0, 8);

    box.innerHTML = `
      <div class="mastery-legend">
        <span class="mastery-stat"><b class="mastery-num">${mastered}</b> / ${m.total} 个键已掌握</span>
        <span class="mastery-stat">在练 <b>${learning}</b></span>
        <span class="mastery-stat">没碰过 <b>${untouched}</b></span>
        ${m.byMode || app.stats.mode === 'all' ? '' :
          '<span class="heat-fallback-note">该模式暂无专属数据，此处为全部模式累计</span>'}
      </div>
      ${close.length ? `<div class="mastery-legend" style="margin-top:4px">
        <span class="mastery-stat">离掌握最近：</span>
        ${close.map(it => `<span class="slow-chip">
          <span class="slow-chip-k">${escapeHtml(it.key)}</span>
          <span class="slow-chip-c">再练 ${it.need} 次</span>
        </span>`).join('')}
      </div>` : ''}
      <div class="mastery-legend" style="margin-top:4px">
        判定「已掌握」需同时满足：按对 <b>${m.minSamples}</b> 次以上、
        错误率 ≤ 8%、且不慢于整体中位数的 1.3 倍 ——
        「每次都要想一秒才按对」算不得掌握，那是还没形成肌肉记忆。
      </div>`;
  } catch (err) {
    console.error('[mastery] 渲染失败', err);
    box.innerHTML = '';
    try { app.heatKeymap.clearMastery(); } catch (_) {}
  }
}

/** 把一个键翻译成「它在方案里代表什么」，让热力图排行能读得懂 */
function keyMeaning(key) {
  try {
    const d = getKeymapData().find(x => x.key === key);
    if (!d) return '';
    const parts = [];
    if (d.shengmu.length) parts.push(`声母 ${d.shengmu.join('/')}`);
    if (d.yunmu.length) parts.push(`韵母 ${d.yunmu.join('/')}`);
    return parts.join(' · ') || '未使用';
  } catch (_) { return ''; }
}

/* ============================================================
   复习页面
   ============================================================ */

function renderReviewView() {
  const body = $('#reviewBody');
  const sub = $('#reviewSub');
  if (!body) return;

  try {
    const sum = summarize();
    // 复习队列：默认只取「到期」的（间隔重复）。
    // 但列表本身仍展示全部未掌握项 —— 用户需要能看到「接下来几天会考什么」，
    // 只给一个到期队列会让人不知道全貌。
    const all = weakRanking(60);
    const dueList = all.filter(w => w.isDue);
    const list = app.settings.reviewDueOnly ? dueList : all;
    const groups = groupWeakItems(list);
    const advice = reviewAdvice(sum, list);
    const rv = S.reviewSummary();

    if (sub) {
      sub.textContent = rv.due > 0
        ? `间隔重复：今天有 ${rv.due} 项到期，另有 ${Math.max(0, rv.total - rv.due - rv.mastered)} 项在等待。`
        : '间隔重复：今天没有到期项，复习节奏保持得不错。';
    }

    if (!all.length) {
      body.innerHTML = `
        <div class="empty-state">
          <strong>暂无需要复习的内容</strong>
          练习中出错的字词会自动收集到这里，并按错误频率与复习间隔排序。
        </div>
        <div class="review-cta">
          <button class="btn btn-primary" id="btnReviewPracticeAll">开始一次普通练习</button>
        </div>`;
      bindReviewActions();
      return;
    }

    /* ---- 到期概览卡 ---- */
    const dueCard = `
      <div class="review-due-card${rv.due ? ' has-due' : ''}">
        <div class="rdc-main">
          <span class="rdc-num">${rv.due}</span>
          <span class="rdc-label">项今天到期</span>
        </div>
        <div class="rdc-meta">
          <span>队列共 <b>${rv.total}</b> 项</span>
          <span>已掌握 <b>${rv.mastered}</b> 项</span>
          <span>巩固中 <b>${rv.learning}</b> 项</span>
          ${rv.nextDue ? `<span>下次到期 <b>${escapeHtml(relTime(rv.nextDue))}</b></span>` : ''}
        </div>
        <label class="checkbox rdc-toggle">
          <input type="checkbox" id="chkReviewDueOnly"${app.settings.reviewDueOnly ? ' checked' : ''} /><i></i>
          只练到期项
        </label>
      </div>`;

    /**
     * 复习项 chip。
     *
     * 展示「下次复习」而不是只展示错误次数 —— 间隔重复的核心信息是
     * **什么时候该复习它**，错误次数只是历史。
     */
    const groupHtml = (title, items, note) => {
      if (!items.length) return '';
      return `
        <div class="review-group">
          <div class="review-group-head">
            <h3>${escapeHtml(title)}</h3>
            <span class="count">${items.length} 项</span>
          </div>
          <div class="review-items">
            ${items.map(w => {
              /* 词组条目的 pinyin 是逐字拼音拼起来的（如 "shuang pin"），
                 primarySplit 只吃单字拼音，直接调会解析不出来 → 显示不出编码。
                 逐字拆开各自出码，拼成完整序列。 */
              const parts = String(w.pinyin || '').split(/\s+/).filter(Boolean);
              const isPhrase = Array.from(w.key || '').length > 1;
              const keys = isPhrase
                ? parts.map(p => (primarySplit(p) || {}).code || '?').join(' ')
                : (w.char && parts[0] ? (primarySplit(parts[0]) || {}).code || '' : '');
              // 间隔进度：一个条形，越满说明越接近掌握
              const prog = Math.min(100, Math.round((w.streak / 4) * 100));
              const dueText = w.isDue
                ? '今天到期'
                : `还有 ${fmtDays(w.dueInDays)}`;
              return `<button class="review-chip${w.isDue ? ' is-due' : ''}"
                              data-key="${escapeHtml(w.key)}"
                              title="点击单独练习｜连对 ${w.streak} 次｜下次 ${escapeHtml(dueText)}">
                <span class="rc-line">
                  <span class="rc-char">${escapeHtml(w.key)}</span>
                  <span class="rc-py">${escapeHtml(w.pinyin || '')}</span>
                  ${keys ? `<span class="rc-keys">${escapeHtml(keys)}</span>` : ''}
                  <span class="rc-err">×${w.count}</span>
                </span>
                <span class="rc-sched">
                  <span class="rc-bar"><i style="width:${prog}%"></i></span>
                  <span class="rc-due">${escapeHtml(dueText)}</span>
                </span>
              </button>`;
            }).join('')}
          </div>
          ${note ? `<p class="footnote" style="margin-top:8px">${escapeHtml(note)}</p>` : ''}
        </div>`;
    };

    const noDue = app.settings.reviewDueOnly && !dueList.length;

    body.innerHTML = `
      ${dueCard}

      <div class="review-summary">
        ${advice.map(escapeHtml).join('<br>')}
      </div>

      ${noDue ? `
        <div class="empty-state" style="padding:26px">
          <strong>今天没有到期的复习项</strong>
          间隔重复会在你快要忘记的时候把内容送回来。想现在就练，可以关掉上面的「只练到期项」。
        </div>` : ''}

      ${noDue ? '' : groupHtml('易错单字', groups.char, '')}
      ${noDue ? '' : groupHtml('易错词语', groups.phrase, '')}
      ${noDue || !groups.other.length ? '' : groupHtml('其他', groups.other, '')}

      <div class="review-cta">
        <button class="btn btn-primary" id="btnReviewPractice"${noDue ? ' disabled aria-disabled="true"' : ''}>${noDue ? '今天没有到期项' : rv.due ? `复习到期的 ${Math.min(rv.due, 20)} 项` : '强化练习这些内容'}</button>
        <button class="btn btn-ghost" id="btnReviewPracticeAll">普通练习</button>
        <button class="btn btn-ghost" id="btnReviewToCustom"
                title="把易错字词连成一段跟打文本，练字与字之间的连贯">错题连成一段跟打</button>
        <button class="btn btn-ghost" id="btnClearWeak">清空易错记录</button>
      </div>
    `;

    // 「只练到期项」开关
    const chkDue = $('#chkReviewDueOnly');
    if (chkDue) {
      chkDue.addEventListener('change', () => {
        app.settings.reviewDueOnly = !!chkDue.checked;
        saveSettingsDebounced();
        renderReviewView();
      });
    }

    bindReviewActions();
  } catch (err) {
    console.error('[review] 渲染失败', err);
    body.innerHTML = '<div class="empty-state">复习内容生成失败</div>';
  }
}

/** 把「还有 N 天」写成人话（0.5 天 → 半天） */
function fmtDays(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return '—';
  if (n <= 0) return '今天';
  if (n < 1) return '半天';
  if (n < 2) return '1 天';
  return `${Math.round(n)} 天`;
}

function bindReviewActions() {
  const btnAll = $('#btnReviewPracticeAll');
  if (btnAll) btnAll.addEventListener('click', () => {
    switchView('practice');
    startSession();
  });

  const btnWeak = $('#btnReviewPractice');
  if (btnWeak) btnWeak.addEventListener('click', () => {
    const all = weakRanking(60);
    const due = all.filter(w => w.isDue);

    // ★ 先筛选、后传参：练习范围在这里**定型**，出题函数只负责按序构造。
    // 「只练到期项」开着 → 范围只有到期项，绝不掺未到期内容 ——
    //   用户圈定的范围被稀释等于功能失效；
    // 关着 → 到期项全部优先入选，名额没满才用未到期项（按权重序）补齐。
    // 之前把到期与未到期混在一起传给出题函数再按权重重排，
    // 低权重的到期项会被沉底挤出 20 题之外 —— 按钮写着「复习到期的 1 项」，
    // 实际一道到期题都没有。
    const dueOnly = !!app.settings.reviewDueOnly;
    const pick = dueOnly
      ? due.slice(0, 20)
      : due.concat(all.filter(w => !w.isDue)).slice(0, 20);

    // 空范围不能交给 generateReviewQuestions：它会用高频字兜底，
    // 这会把「只练到期项」悄悄变成普通练习。
    if (!pick.length) {
      toast('今天没有到期的复习内容', 'err');
      return;
    }

    const qs = generateReviewQuestions(pick, 20);
    if (!qs.length) { toast('暂时没有可用的复习内容', 'err'); return; }
    switchView('practice');
    startSession(qs, 'char');
  });

  /* 错题连成一段跟打：把易错项写进「自定义文本」并切过去。
     比逐条练更能补上「字与字之间切换不顺」这一环 —— 见 buildWeakPassage 的注释。 */
  const btnToCustom = $('#btnReviewToCustom');
  if (btnToCustom) btnToCustom.addEventListener('click', () => {
    const all = weakRanking(60);
    const built = buildWeakPassage(all, { maxItems: 40 });
    if (!built.count) {
      toast('还没有可用的易错字词', 'err');
      return;
    }

    /* 覆盖前先问：用户可能手头正有一段精心准备的材料，
       直接覆盖是不可撤销的。已有内容且不是上次生成的时，弹窗确认。 */
    const existing = String(app.settings.customText || '').trim();
    const apply = () => {
      app.settings.customText = built.text;
      saveSettingsDebounced();
      const ta = $('#customTextInput');
      if (ta) { ta.value = built.text; ta.dispatchEvent(new Event('input')); }
      // 切到「自定义文本」模式，并把练习区滚动到可见
      selectMode('custom');
      switchView('practice');
      toast(`已生成 ${built.count} 个易错词、共 ${built.chars} 字，可开始跟打`, 'ok');
    };

    if (existing) {
      openModal(`
        <h2>覆盖自定义文本？</h2>
        <p class="modal-sub">当前「自定义文本」里已有 ${Array.from(existing).length} 个字符，
        将被这 ${built.count} 个易错词（共 ${built.chars} 字）替换。此操作不可撤销。</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="cancel">取消</button>
          <button class="btn btn-primary" data-act="ok">替换并开练</button>
        </div>
      `, (act, close) => {
        close();
        if (act === 'ok') apply();
      });
      return;
    }
    apply();
  });

  const btnClear = $('#btnClearWeak');
  if (btnClear) btnClear.addEventListener('click', () => {
    openModal(`
      <h2>清空易错记录？</h2>
      <p class="modal-sub">易错字词表会被清空，已完成的练习成绩不受影响。此操作不可撤销。</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-act="cancel">取消</button>
        <button class="btn btn-danger" data-act="ok">确认清空</button>
      </div>
    `, (act, close) => {
      close();
      if (act === 'ok') {
        S.clearWeak();
        renderReviewView();
        toast('易错记录已清空');
      }
    });
  });

  // 单独练习某个字词
  $$('.review-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      practiceSingleItem(chip.getAttribute('data-key'));
    });
  });
}

/**
 * 由「一个字 / 一个词」直接开一局针对性练习。
 *
 * 复习页的 chip 与结算页的本轮错字 chip 共用这段逻辑 —— 两边要的
 * 完全是同一件事（把某个字词变成 3 道题立刻开练），分开写迟早会长歪。
 *
 * 为什么是 3 道而不是 1 道：单次盲打对了说明不了什么，连做三次
 * 能在几秒内区分「真的记住了」和「蒙对的」。
 *
 * @param {string} key 单字或词组原文（如 "月" / "双拼"）
 */
function practiceSingleItem(key) {
  if (!key) return;
  let q = null;

  // 优先当词组：【词表里查得到】才有经校对的语境拼音，
  // 这比逐字拼默认音准（多音字如「银行」的「行」）。
  const phrase = PHRASES.find(p => p.w === key);
  if (phrase) q = questionFromPhrase(phrase.w, phrase.p);

  if (!q) {
    const chars = Array.from(key);
    if (chars.length === 1 && ALL_CHARS[chars[0]]) {
      q = questionFromCharChar(chars[0], ALL_CHARS[chars[0]]);
    } else {
      // 多字但词表里没有：逐字查。拼音凑不齐就不出题 ——
      // 缺音的字会让引擎走 unknown 分支跳过，题目实际比看起来短，
      // 不如明确告诉用户这条练不了。
      const pys = chars.map(c => ALL_CHARS[c]).filter(Boolean);
      if (pys.length === chars.length) q = questionFromPhrase(key, pys);
    }
  }

  if (!q) { toast('该条目暂无法生成练习', 'err'); return; }
  switchView('practice');
  startSession([q, q, q], 'char');
}

/* ============================================================
   设置页面
   ============================================================ */

function initSettingsView() {
  const selScheme = $('#selScheme');
  const setDuration = $('#setDuration');
  const setCount = $('#setCount');
  const setMini = $('#setMiniKeymap');
  const setSound = $('#setSound');
  const setStrict = $('#setStrict');
  const setSkipPunct = $('#setSkipPunct');
  const setHint = $('#setHint');
  const setHintDelay = $('#setHintDelay');
  const setRevealDelay = $('#setRevealDelay');

  // 时长 / 题量下拉与练习页保持一致
  const durationOpts = $('#selDuration') ? $('#selDuration').innerHTML : '';
  const countOpts = $('#selCount') ? $('#selCount').innerHTML : '';
  if (setDuration) setDuration.innerHTML = durationOpts;
  if (setCount) setCount.innerHTML = countOpts;

  // 方案下拉
  if (selScheme) {
    selScheme.innerHTML = Object.values(SCHEME_META)
      .map(s => `<option value="${s.id}"${s.id === 'xiaohe' ? ' selected' : ''}>${escapeHtml(s.name)}（内置）</option>`)
      .join('');
    selScheme.addEventListener('change', () => {
      app.settings.scheme = selScheme.value;
      saveSettingsDebounced();
      toast('当前仅内置小鹤双拼方案');
    });
  }

  if (setDuration) {
    setDuration.value = String(app.settings.duration);
    setDuration.addEventListener('change', () => {
      app.settings.duration = Number(setDuration.value) || 0;
      if ($('#selDuration')) $('#selDuration').value = String(app.settings.duration);
      saveSettingsDebounced();
    });
  }
  bindCountControl('setCount', 'setCustomCount');

  const bindToggle = (el, key, after) => {
    if (!el) return;
    el.checked = !!app.settings[key];
    el.addEventListener('change', () => {
      app.settings[key] = el.checked;
      saveSettingsDebounced();
      if (after) after(el.checked);
    });
  };

  bindToggle(setMini, 'showMiniKeymap', () => {
    applyMiniKeymapVisibility();
  });

  /* ---- 按键音效 ----
     开的时候立刻放一声：既确认「确实有声音」，又顺便完成
     AudioContext 的用户手势解锁（否则要等第一次按键才出声，
     用户会以为开关没生效）。 */
  if (setSound) {
    setSound.checked = !!app.settings.sound;
    if (!soundSupported()) {
      setSound.disabled = true;
      const lab = setSound.closest('label');
      if (lab) {
        lab.classList.add('is-disabled');
        lab.title = '当前浏览器不支持 WebAudio，音效不可用';
      }
    }
    setSound.addEventListener('change', () => {
      app.settings.sound = !!setSound.checked;
      saveSettingsDebounced();
      if (setSound.checked) {
        // 设置页的这次点击本身就是合法手势，可直接解锁
        primeSound();
        playSound('correct', true);
        app._armAudio = null;
      }
    });
  }

  bindToggle(setStrict, 'strict');
  bindToggle(setSkipPunct, 'skipPunct');

  /* ---- 语音朗读 ----
     与音效是两件事：音效是按键反馈的合成音（WebAudio），
     朗读是「听声母/听韵母」模式下把音节念出来（SpeechSynthesis）。
     分别开关，因为它们对用户的意义不同 —— 有人想要按键反馈但嫌朗读吵。 */
  initSpeechSettings();

  /* ---- 卡住自动提示 ---- */
  bindToggle(setHint, 'hint', (v) => {
    applyHintSettingsToEngine();
    toast(v ? '已开启卡住自动提示' : '已关闭卡住自动提示');
  });

  if (setHintDelay) {
    setHintDelay.value = String(app.settings.hintDelay);
    setHintDelay.addEventListener('change', () => {
      app.settings.hintDelay = Number(setHintDelay.value) || 0;
      saveSettingsDebounced();
      applyHintSettingsToEngine();
    });
  }
  if (setRevealDelay) {
    setRevealDelay.value = String(app.settings.revealDelay);
    setRevealDelay.addEventListener('change', () => {
      app.settings.revealDelay = Number(setRevealDelay.value) || 0;
      saveSettingsDebounced();
      applyHintSettingsToEngine();
    });
  }

  /* ---- 外观：主题（明暗）----
     改完立刻生效（重绘图表与键位图），并落盘。 */
  const setThemeSel = $('#setTheme');
  if (setThemeSel) {
    setThemeSel.value = app.settings.theme || 'auto';
    setThemeSel.addEventListener('change', () => {
      const v = setThemeSel.value;
      app.settings.theme = (v === 'light' || v === 'dark') ? v : 'auto';
      saveSettingsDebounced();
      applyThemeNow(app.settings.theme);
      announce(app.theme === 'dark' ? '已切换到深色主题' : '已切换到浅色主题', 'polite');
    });
  }

  /* ---- 无障碍：减少动态效果 ---- */
  const setReduceMotion = $('#setReduceMotion');
  if (setReduceMotion) {
    setReduceMotion.value = app.settings.reduceMotion || 'auto';
    setReduceMotion.addEventListener('change', () => {
      const v = setReduceMotion.value;
      app.settings.reduceMotion = (v === 'on' || v === 'off') ? v : 'auto';
      saveSettingsDebounced();
      motionClass(currentReduceMotion());
    });
  }

  /* ---- 每日目标 ----
     两个 input 用同一套逻辑：先按 [0, 上限] 夹取再写回控件，
     因为用户可能输入负数或 1e9 —— 负数会让进度条算出负宽度，
     过大值则是笔误。夹取口径与 storage.clampInt 一致，
     这里再夹一次是为了**改完当场看到被纠正的结果**，
     而不是等下一次 loadSettings 时才悄悄变掉。

     改目标后立刻重算：练习中的 HUD 要马上反映新目标，
     统计页的完成度也要跟着变（不然切过去还是旧分母）。 */
  const goalParts = [
    ['#setDailyGoalChars', 'dailyGoalChars', 0, 1000000],
    ['#setDailyGoalSessions', 'dailyGoalSessions', 0, 100]
  ];
  goalParts.forEach(([sel, key, lo, hi]) => {
    const el = $(sel);
    if (!el) return;
    el.value = String(app.settings[key]);
    el.addEventListener('change', () => {
      const n = Math.floor(Number(el.value));
      const v = Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
      app.settings[key] = v;
      el.value = String(v);              // 回写夹取后的值，用户看得见
      saveSettingsDebounced();
      renderGoalHud();
      if (app.view === 'stats') renderStatsView();
    });
  });

  /* ---- 快捷键改键面板 ---- */
  initShortcutSettings();

  // 导入
  const fileImport = $('#fileImport');
  if (fileImport) {
    fileImport.addEventListener('change', () => {
      const f = fileImport.files && fileImport.files[0];
      fileImport.value = '';
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { toast('文件过大（上限 8MB）', 'err'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const payload = JSON.parse(String(reader.result || ''));
          const res = S.importAll(payload);
          toast(res.message, res.ok ? 'ok' : 'err', 4000);
          if (res.ok) {
            app.settings = S.loadSettings();
            renderStatsView();
            renderReviewView();
            syncSettingsUI();
          }
        } catch (err) {
          toast('解析失败：不是有效的 JSON 文件', 'err');
        }
      };
      reader.onerror = () => toast('文件读取失败', 'err');
      reader.readAsText(f, 'utf-8');
    });
  }

  const btnReset = $('#btnResetSettings');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      openModal(`
        <h2>恢复默认设置？</h2>
        <p class="modal-sub">练习时长、题量、显示选项等会恢复为初始值。练习记录与易错表不受影响。</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="cancel">取消</button>
          <button class="btn btn-primary" data-act="ok">恢复默认</button>
        </div>
      `, (act, close) => {
        close();
        if (act !== 'ok') return;
        app.settings = Object.assign({}, S.DEFAULT_SETTINGS);
        // 快捷键是对象，必须单独合并（DEFAULT_SETTINGS 里是 null，
        // 直接用会得到一个没有快捷键的状态）
        app.settings.shortcuts = mergeShortcuts(null);
        S.saveSettings(app.settings);
        motionClass(currentReduceMotion());
        syncSettingsUI();
        initShortcutSettings();
        toast('已恢复默认设置');
      });
    });
  }

  // 数据占用 + 存储状态。
  // renderStorageBadge() 负责 #storageNote 的文案：它必须精确定位到
  // #storageNote —— 设置页里有多个 .footnote，用 $('.footnote') 会命中
  // 第一个（可能是快捷键说明那段），一个 textContent 赋值就把它的
  // <code> 子节点全抹掉了。降级到内存时文案会改口，不能再声称「保存在
  // localStorage 中」。
  renderStorageBadge();
}

/* ============================================================
   快捷键改键面板
   ============================================================ */

/**
 * 渲染设置页的快捷键面板，并为每一行绑定「点击 → 按下新键」的捕获流程。
 *
 * 整个面板是**幂等**的：每次调用都重建 DOM 并重新绑定，
 * 这样「恢复默认设置」之后不需要单独 refresh 逻辑。
 */
function initShortcutSettings() {
  const list = $('#shortcutList');
  if (!list) return;

  const sc = shortcuts();
  list.innerHTML = Object.values(SHORTCUT_ACTIONS).map(a => {
    const k = sc[a.key] || '';
    return `
      <div class="shortcut-row">
        <span class="shortcut-label">${escapeHtml(a.label)}</span>
        <button class="shortcut-key${k ? '' : ' is-unbound'}"
                type="button"
                data-action="${escapeHtml(a.key)}"
                aria-label="修改「${escapeHtml(a.label)}」的快捷键，当前为 ${escapeHtml(k ? prettyKey(k) : '未绑定')}">
          ${escapeHtml(k ? prettyKey(k) : '未设置')}
        </button>
      </div>`;
  }).join('');

  // 说明段落里的键名同步（Tab / Backspace 是用户最容易感知的两个）
  syncShortcutNote();

  $$('.shortcut-key', list).forEach(btn => {
    btn.addEventListener('click', () => {
      startCapture(btn.getAttribute('data-action'), btn);
    });
  });
}

/** 让设置页顶部的说明文本跟随实际快捷键变化 */
function syncShortcutNote() {
  const sc = shortcuts();
  const h = $('#noteHintKey');
  const s = $('#noteSkipKey');
  if (h) h.textContent = sc.hint ? prettyKey(sc.hint) : '未设置';
  if (s) s.textContent = sc.skip ? prettyKey(sc.skip) : '未设置';
}

/**
 * 进入「按下新键」捕获状态。
 *
 * 捕获期间：
 *   - app._capturingShortcut = true，全局快捷键处理函数直接 return，
 *     否则你在改「看答案」键时按 Tab 会被当成「要看答案」
 *   - 只接受单个非修饰键；Esc 取消；Backspace/Delete 解绑
 *   - 点击面板外取消
 *
 * @param {string} action 动作名（hint/skip/pause/submit）
 * @param {HTMLElement} btn 被点击的按钮（用于显示「按下新键…」）
 */
function startCapture(action, btn) {
  if (!action || !SHORTCUT_ACTIONS[action]) return;

  // 同时只允许一个捕获。上一次捕获若因任何路径没有清理干净
  // （尤其是那个 setTimeout 里才挂上的「点外部」监听），这里强制收尾 ——
  // 残留的监听器会在下一次点击时触发旧录制器的重绘，把新点开的按钮
  // 从页面上挪走，表现就是「第一次点没反应，第二次才行」。
  if (typeof app._captureCleanup === 'function') {
    app._captureCleanup();
    app._captureCleanup = null;
  }

  app._capturingShortcut = true;
  const original = btn.textContent;
  btn.classList.add('is-capturing');
  btn.textContent = '按下新键…';

  let done = false;

  const cleanup = () => {
    if (done) return;               // 幂等：重复调用无害
    done = true;
    app._capturingShortcut = false;
    if (app._captureCleanup === cleanup) app._captureCleanup = null;
    btn.classList.remove('is-capturing');
    btn.textContent = original;
    document.removeEventListener('keydown', onCapture, true);
    // 此时 onOutside 可能还没挂上（setTimeout 未到），remove 一个
    // 尚未注册的监听是安全的 no-op —— 关键是**之后**绝不能再挂上去，
    // 所以下面的 setTimeout 里也要看 done 标记。
    document.removeEventListener('pointerdown', onOutside, true);
  };

  const applyAndSave = (key) => {
    const next = shortcuts();
    if (key === '') {
      next[action] = '';                    // 解绑
    } else {
      // 冲突检测：同一个键不能绑两个动作
      const clash = Object.keys(next).find(a => a !== action && next[a] === key);
      if (clash) {
        toast(`${prettyKey(key)} 已被「${SHORTCUT_ACTIONS[clash].label}」占用`, 'err');
        return false;
      }
      // 保留键 / 字母键的拒绝交给 validateShortcuts（字母键是作答键，
      // 绑了它练习里这个字母就打不出来 —— 见 a11y.js 的说明）
      next[action] = key;
    }
    const check = validateShortcuts(next);
    if (!check.ok) { toast(check.reason, 'err'); return false; }
    app.settings.shortcuts = next;
    saveSettingsDebounced();
    return true;
  };

  const rerender = () => {
    initShortcutSettings();
    // 面板重建后当前按钮已被替换，原引用失效 —— 但 cleanup 仍需执行，
    // 所以这里直接改标记，让 cleanup 里的 DOM 操作尽量无害化。
  };

  const onCapture = (e) => {
    if (done) return;
    e.preventDefault();
    e.stopPropagation();

    const k = e.key;
    // 单独按修饰键不算（等真正的键）
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return;
    // Esc 取消
    if (k === 'Escape') { cleanup(); return; }
    // Backspace / Delete = 解绑
    if (k === 'Backspace' || k === 'Delete') {
      if (applyAndSave('')) { cleanup(); rerender(); }
      return;
    }
    // 忽略纯修饰键组合（Ctrl+A 之类不做快捷键）
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const nk = normalizeShortcutKey(k);
    if (!nk || nk.length > 12) return;
    if (applyAndSave(nk)) { cleanup(); rerender(); }
  };

  const onOutside = (e) => {
    if (done) return;
    // 点的是另一个改键按钮：不放行也不在这里取消 —— 让它的 click 处理器
    // 走 startCapture 入口的「先收尾旧的，再开新的」，这样在两个动作之间
    // 换目标只需要各点一次（否则第一次点击只会取消当前捕获，显得没反应）。
    if (e.target && typeof e.target.closest === 'function' &&
        e.target.closest('.shortcut-key')) {
      return;
    }
    // 点面板外：取消
    cleanup();
  };

  app._captureCleanup = cleanup;
  document.addEventListener('keydown', onCapture, true);
  // 延后一拍再挂「点外部取消」，否则当前这次点击会立刻把自己取消掉。
  // done 守卫保证 cleanup 先跑完后，这个监听**不会**再被挂上。
  setTimeout(() => {
    if (!done) document.addEventListener('pointerdown', onOutside, true);
  }, 0);
}

/**
 * 把提示设置「热应用」到正在跑的引擎上。
 * 不必重启练习 —— 改完设置立刻生效，否则用户会以为设置没保存上。
 */
function applyHintSettingsToEngine() {
  const eng = app.engine;
  if (!eng) return;
  try {
    eng.hintEnabled = !!app.settings.hint;
    eng.hintDelayMs = Math.max(0, Number(app.settings.hintDelay) || 0);
    eng.revealDelayMs = Math.max(0, Number(app.settings.revealDelay) || 0);
    if (eng.revealDelayMs > 0 && eng.revealDelayMs < eng.hintDelayMs) {
      eng.revealDelayMs = eng.hintDelayMs;
    }
    if (eng.state === STATE.RUNNING && typeof eng._resetHintTimer === 'function') {
      eng._resetHintTimer();
    }
    if (!eng.hintEnabled) clearHint();
  } catch (err) {
    console.warn('[hint] 应用设置失败', err);
  }
}

/**
 * 语音朗读设置：开关 + 语速 + **能力探测**。
 *
 * 【为什么要探测而不是直接开】「只听声母/听韵母」两个模式的题面是字母
 * （h / ou），打开朗读才有声音。但**没有中文语音包的机器上，
 * 用 en-US 语音念中文会念出英语口音或干脆读不出** —— 比不发声更糟。
 * 所以这里主动探测 zh 语音：
 *   - 有 → 打开开关即朗读，正常宣传「听」
 *   - 无 → 明确告知「本机没有中文语音包，这两个模式是看字母认键」
 *         并给出安装提示，而不是留一个按了没反应的哑巴开关
 *
 * 探测是**异步**的（getVoices() 首次可能为空，要等 voiceschanged），
 * 所以先按「未知」渲染，拿到结果再更新文案。
 */
function initSpeechSettings() {
  const setSpeech = $('#setSpeech');
  const opts = $('#speechOpts');
  const note = $('#speechNote');
  const rate = $('#setSpeechRate');

  const supported = speechSupported();
  if (setSpeech) {
    setSpeech.checked = !!app.settings.speech;
    if (!supported) {
      setSpeech.disabled = true;
      setSpeech.checked = false;
      const lab = setSpeech.closest('label');
      if (lab) {
        lab.classList.add('is-disabled');
        lab.title = '当前浏览器不支持语音合成（speechSynthesis），朗读不可用';
      }
    }
    setSpeech.addEventListener('change', () => {
      app.settings.speech = !!setSpeech.checked;
      saveSettingsDebounced();
      if (!setSpeech.checked) {
        stopSpeech();                    // 关掉时立刻静音，不留残响
        app._speechWarned = false;       // 重新打开时可以再提示一次
      }
      // 重画模式卡片：开关直接决定 L2 两个模式叫「听」还是「认」
      if (typeof app._paintModeGrid === 'function') app._paintModeGrid();
      renderSpeechUI();
    });
  }

  if (rate) {
    rate.value = String(app.settings.speechRate);
    rate.addEventListener('change', () => {
      app.settings.speechRate = Number(rate.value) || 0.85;
      saveSettingsDebounced();
      // 立刻用新语速念一个样本 —— 用户不用开一局练习才知道快慢
      if (app.settings.speech) {
        speakText('双拼练习', { rate: app.settings.speechRate });
      }
    });
  }

  // 先按「探测中」渲染，避免闪烁；拿到结果后更新
  renderSpeechUI({ probing: true });
  hasChineseVoice().then(ok => {
    app._hasZhVoice = ok;
    renderSpeechUI();
  });
}

/**
 * 根据「是否支持 + 有没有中文语音 + 开关是否打开」更新语音相关 UI。
 *
 * 三个状态各有明确文案，绝不出现「开关是开的、但按了没声音、
 * 也没人告诉你为什么」这种最坏情况。
 */
function renderSpeechUI(opts = {}) {
  const setSpeech = $('#setSpeech');
  const box = $('#speechOpts');
  const note = $('#speechNote');
  if (!note) return;

  const supported = speechSupported();
  const hasVoice = app._hasZhVoice;
  const on = !!(setSpeech && setSpeech.checked);

  /* 语音能力会改变 L2 两个模式的**名字**（认键 ↔ 听）。
     重画模式卡片，保证探测结果一回来界面就同步。
     只在状态真的变化时才重画，避免无谓的 DOM 重建。 */
  if (app._speechState !== hasVoice) {
    app._speechState = hasVoice;
    if (typeof app._paintModeGrid === 'function') app._paintModeGrid();
  }

  // 语速选择只在「开着且真的能出声」时才有意义
  if (box) box.hidden = !(supported && on && hasVoice === true);
  note.hidden = false;

  if (!supported) {
    note.textContent = '当前浏览器不支持语音合成，朗读不可用。';
    note.className = 'footnote';
    return;
  }
  if (opts.probing || hasVoice === undefined) {
    note.textContent = '正在检测本机是否安装中文语音包…';
    note.className = 'footnote';
    return;
  }
  if (!hasVoice) {
    /* 关键降级文案：说清「这两个模式现在是干什么的」，
       而不是简单说一句「不支持」。用户据此知道功能没坏，只是语义变了。 */
    note.textContent = '本机未检测到中文语音包，朗读不可用 —— '
      + '「只听声母 / 只听韵母」两个模式此时是**看字母、认按键**，没有声音。'
      + '如需听力练习，可在系统「时间和语言 → 语音」中安装中文语音后重试。';
    note.className = 'footnote';
    return;
  }
  note.textContent = '已检测到中文语音，打开后「只听声母 / 只听韵母」会朗读完整音节。';
  note.className = 'footnote';
}

/**
 * 播放当前题目的语音（若有）。
 *
 * 只对 L2 两个「听」模式生效 —— 它们`speakText` 是完整音节。
 * 其余模式（单字/词组/短文）的题面本身就是汉字，用户是在「看字打字」，
 * 朗读反而干扰。
 *
 * 降级：没装中文语音或开关关闭时静默跳过。**只提示一次** ——
 * 用户开了开关却发现没声音，第一次应该被告知原因；但每题都弹就成噪音了。
 */
function speakCurrentQuestion() {
  if (!app.settings.speech || !speechSupported()) return;

  const eng = app.engine;
  if (!eng) return;
  const q = eng.currentQuestion();
  if (!q || !q.speakText) return;        // 只有 L2 两个模式带 speakText

  if (app._hasZhVoice === false) {
    // 明确告知「为什么没声音」，但只告知一次
    if (!app._speechWarned) {
      app._speechWarned = true;
      toast('本机没有中文语音包，无法朗读音节', 'err', 4000);
    }
    return;
  }
  speakText(q.speakText, { rate: app.settings.speechRate });
}

/** 把 settings 同步到所有相关 UI */
function syncSettingsUI() {
  syncCountControls();
  const selects = [
    ['#selDuration', 'duration'], ['#setDuration', 'duration'],
    ['#selCharTier', 'charTier'],
    ['#selTrainingPolicy', 'trainingPolicy'], ['#selPhraseCategory', 'phraseCategory'], ['#selPhraseLength', 'phraseLength'],
    ['#setHintDelay', 'hintDelay'], ['#setRevealDelay', 'revealDelay'],
    ['#setReduceMotion', 'reduceMotion'],
    ['#setTheme', 'theme']
  ];
  selects.forEach(([sel, key]) => {
    const el = $(sel);
    if (el) el.value = String(app.settings[key]);
  });
  const checks = [
    ['#setMiniKeymap', 'showMiniKeymap'],
    ['#setSound', 'sound'],
    ['#setStrict', 'strict'],
    ['#setSkipPunct', 'skipPunct'],
    ['#setHint', 'hint'],
    ['#chkWeakBoost', 'weakBoost'],
    ['#chkReviewDueOnly', 'reviewDueOnly'],
    ['#setSpeech', 'speech']
  ];
  checks.forEach(([sel, key]) => {
    const el = $(sel);
    if (el) el.checked = !!app.settings[key];
  });
  [['#setSpeechRate', 'speechRate']].forEach(([sel, key]) => {
    const el = $(sel);
    if (el) el.value = String(app.settings[key]);
  });
  renderSpeechUI();
  // 每日目标是数字输入框（不是 select 也不是 checkbox），单独同步。
  // 放在这里而不是散落在各调用点：syncSettingsUI 是「设置变化后统一刷新
  // 所有 UI」的唯一入口，漏掉它会导致「导入数据后目标框还是旧值」。
  [['#setDailyGoalChars', 'dailyGoalChars'], ['#setDailyGoalSessions', 'dailyGoalSessions']]
    .forEach(([sel, key]) => {
      const el = $(sel);
      if (el) el.value = String(app.settings[key]);
    });
  // 自定义文本可能被导入数据 / 恢复默认改掉，输入框要跟着变。
  // 不走 initCustomText()（那会重复绑事件），只同步值 + 刷新统计。
  const ctInput = $('#customTextInput');
  if (ctInput) {
    ctInput.value = app.settings.customText || '';
    ctInput.dispatchEvent(new Event('input'));
  }
  // 书架与课程进度也会被导入 / 清空改变，跟着刷新
  renderShelf();
  renderCourseBox();
  renderGoalHud();
  selectMode(app.settings.mode, true);
  applyMiniKeymapVisibility();
  updateModeCounts();
  syncShortcutNote();
  updatePhrasePoolInfo();
}

/* ============================================================
   导入导出
   ============================================================ */

function exportData() {
  try {
    const data = S.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    a.href = url;
    a.download = `双拼练习数据_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('数据已导出');
  } catch (err) {
    console.error('[export] 失败', err);
    toast('导出失败：' + (err && err.message ? err.message : '未知错误'), 'err');
  }
}

function confirmClearStats() {
  openModal(`
    <h2>清空全部练习记录？</h2>
    <p class="modal-sub">
      将删除：所有历史成绩、每日统计、易错字词表、键位热力图数据。<br>
      设置项会保留。<strong>此操作不可撤销</strong>，建议先导出备份。
    </p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-ghost" data-act="export">先导出</button>
      <button class="btn btn-danger" data-act="ok">确认清空</button>
    </div>
  `, (act, close) => {
    if (act === 'export') { exportData(); return; }
    close();
    if (act !== 'ok') return;
    S.clearHistory();
    S.clearWeak();
    S.clearKeyErrors();
    S.clearResume();
    renderStatsView();
    renderReviewView();
    showResumeHint();
    toast('全部记录已清空');
  });
}

/* ============================================================
   弹窗 & Toast
   ============================================================ */

let modalCleanup = null;
// 打开弹窗前持有焦点的元素，关闭时归还（见 openModal / closeModal）
let lastFocus = null;

/**
 * 兜底：确保 [hidden] 规则真的生效。
 *
 * 浏览器默认的 `[hidden] { display:none }` 属于 UA 样式表，优先级低于
 * 作者样式表里任何 display 声明。若 CSS 里没有 `[hidden] { display:none !important }`，
 * 那么像 .overlay（display:grid）、.feedback（display:flex）这类元素
 * 即使带 hidden 属性也会照常显示 —— 曾导致弹窗一进页面就盖满全屏。
 *
 * 正常情况 CSS 里有这条规则，这里是第二道防线：
 * 检测到规则缺失就动态注入，避免样式表被误删/覆盖时应用直接不可用。
 */
let hiddenRuleChecked = false;
function ensureHiddenRule() {
  if (hiddenRuleChecked) return;
  hiddenRuleChecked = true;
  try {
    // 先看样式表里有没有这条规则。用 CSSOM 而非 getComputedStyle：
    // 前者在所有浏览器都可靠；后者在部分精简 DOM 实现（如测试用的 linkedom）
    // 返回空串，会导致误判。
    const sheets = document.styleSheets || [];
    for (let i = 0; i < sheets.length; i++) {
      let rules;
      try { rules = sheets[i].cssRules; } catch (_) { continue; }  // 跨域表跳过
      if (!rules) continue;
      for (let j = 0; j < rules.length; j++) {
        const r = rules[j];
        if (r && r.selectorText === '[hidden]' && /display\s*:\s*none/i.test(r.style && r.style.cssText || '')) {
          if (String(r.style.cssText).includes('important')) return;
        }
      }
    }

    // 没找到（或没带 !important）→ 动态注入一条
    if (!document.head) return;
    const style = document.createElement('style');
    style.setAttribute('data-fallback', 'hidden-rule');
    style.textContent = '[hidden]{display:none !important;}';
    document.head.appendChild(style);
  } catch (err) {
    // 探测失败也要保证功能可用：直接注入（重复注入无害）
    try {
      if (!document.head) return;
      const style = document.createElement('style');
      style.textContent = '[hidden]{display:none !important;}';
      document.head.appendChild(style);
    } catch (_) {}
  }
}

function openModal(html, onAct, onClose) {
  const overlay = $('#overlay');
  const modal = $('#modal');
  if (!overlay || !modal) return;

  ensureHiddenRule();

  /* 记下打开前的焦点，关闭时还回去。
     不记的话，键盘用户关掉弹窗后焦点会掉到 <body>，
     只能从头 Tab 一遍才能回到刚才那个按钮。 */
  lastFocus = document.activeElement;
  // 重入保护：弹窗里再开弹窗（如「覆盖自定义文本？」）时，
  // lastFocus 已被上一次覆盖成 modal 自己，再还回去等于没还。
  if (lastFocus && modal.contains(lastFocus)) lastFocus = null;

  modal.innerHTML = html;
  overlay.hidden = false;

  /* 给弹窗接上可读名：6 个弹窗的首个元素都是 <h2>，直接把它标成标题。
     没有 h2 的（理论上不该有）就退回 aria-label 兜底，绝不留下无名对话框。 */
  const titleEl = modal.querySelector('h2');
  if (titleEl) {
    if (!titleEl.id) titleEl.id = 'modalTitle';
    modal.setAttribute('aria-labelledby', titleEl.id);
    modal.removeAttribute('aria-label');
  } else {
    modal.removeAttribute('aria-labelledby');
    modal.setAttribute('aria-label', '对话框');
  }

  const handler = (e) => {
    /* [data-weak] 是弹窗里的「点它去练这个字/词」（结算页的本轮错字）。
       放在这里统一处理，而不是让调用方自己 querySelectorAll 绑事件 ——
       弹窗内容是每次 innerHTML 重建的，调用方绑定很容易漏掉重复打开的场景。
       顺序要紧：先判 data-act（关闭/跳转），再判 data-weak，避免嵌套元素
       同时命中两个属性时行为不确定。 */
    const weak = e.target.closest('[data-weak]');
    if (weak) {
      const key = weak.getAttribute('data-weak');
      closeModal();                 // 先关掉，否则练习页被弹窗盖住
      practiceSingleItem(key);
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (typeof onAct === 'function') onAct(act, closeModal);
  };
  modal.addEventListener('click', handler);

  /* 焦点陷阱：Tab 在弹窗内循环。
     不做的话 Tab 会跑到被遮罩盖住的背景控件上 —— 视觉上「什么都没有」，
     但焦点确实在那，读屏会念出用户看不见的东西。 */
  modal.addEventListener('keydown', trapModalTab);

  modalCleanup = () => {
    modal.removeEventListener('click', handler);
    modal.removeEventListener('keydown', trapModalTab);
    if (typeof onClose === 'function') {
      try { onClose(); } catch (err) { console.error(err); }
    }
  };

  // 点击遮罩关闭
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

  /* 把焦点送进弹窗。优先聚焦第一个「安全」控件：
     优先主按钮 [data-act]，否则第一个可聚焦元素，最后才落到容器本身。
     聚焦容器（tabindex="-1"）也能让读屏立刻念出对话框标题。 */
  const prefer = modal.querySelector('[data-act]')
    || modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    || modal;
  try { prefer.focus(); } catch (_) {}
}

function closeModal() {
  const overlay = $('#overlay');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  if (modalCleanup) {
    try { modalCleanup(); } catch (err) { console.error(err); }
    modalCleanup = null;
  }
  const modal = $('#modal');
  if (modal) modal.innerHTML = '';

  /* 把焦点还给打开弹窗的那个元素。
     要放在 innerHTML='' 之后再还，否则某些浏览器里被清空的节点无法接收焦点。
     元素可能已经不在文档里（比如触发它的按钮在重绘中被换掉了），
     这种情况就退回给主内容区，总好过掉到 <body>。 */
  const back = lastFocus;
  lastFocus = null;
  if (back && typeof back.focus === 'function' && document.contains(back)) {
    try { back.focus(); return; } catch (_) {}
  }
  const fallback = $('#hiddenInput') || $('main') || document.body;
  if (fallback && typeof fallback.focus === 'function') {
    try { fallback.focus(); } catch (_) {}
  }
}

/* 弹窗内的 Tab 焦点循环。取「当前可见且可聚焦」的元素作为循环区间 ——
   弹窗内容里有 hidden 的分支（如根据状态显示不同按钮），
   若把隐藏元素也算进去，Tab 会出现「按一下没反应」的空档。 */
function trapModalTab(e) {
  if (e.key !== 'Tab') return;
  const modal = $('#modal');
  if (!modal) return;
  const nodes = Array.from(modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter(el => !el.disabled && el.offsetParent !== null);
  if (!nodes.length) {
    // 没有任何可聚焦控件 → 焦点留在容器上，别让它跑到背景
    e.preventDefault();
    try { modal.focus(); } catch (_) {}
    return;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || active === modal || !modal.contains(active)) {
      e.preventDefault();
      try { last.focus(); } catch (_) {}
    }
  } else if (active === last) {
    e.preventDefault();
    try { first.focus(); } catch (_) {}
  }
}

function isModalOpen() {
  const overlay = $('#overlay');
  return !!overlay && !overlay.hidden;
}

function toast(msg, type, duration) {
  const wrap = $('#toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' is-' + type : '');
  el.textContent = String(msg);
  wrap.appendChild(el);
  const ms = Number(duration) || 2400;
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
  }, ms);
}

/* ============================================================
   全局兜底
   ============================================================ */

function initGlobalGuards() {
  window.addEventListener('error', (e) => {
    console.error('[global error]', e.error || e.message);
    // 避免错误风暴刷屏
    if (Date.now() - (app._lastErrToast || 0) > 3000) {
      app._lastErrToast = Date.now();
      toast('发生了一个错误，已记录到控制台', 'err');
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled rejection]', e.reason);
    if (Date.now() - (app._lastErrToast || 0) > 3000) {
      app._lastErrToast = Date.now();
      toast('发生了一个错误，已记录到控制台', 'err');
    }
  });

  // 窗口尺寸变化：重绘图表（防抖）
  let rTimer = null;
  window.addEventListener('resize', () => {
    if (rTimer) clearTimeout(rTimer);
    rTimer = setTimeout(() => {
      if (app.view === 'stats') renderStatsView();
    }, 200);
  });

  // 离开页面前：保存进度 / 提示
  const saveBeforeLeave = () => {
    flushSettings();
    saveProgress(true);
  };
  window.addEventListener('beforeunload', saveBeforeLeave);
  window.addEventListener('pagehide', saveBeforeLeave);

  // 页面隐藏时自动暂停（切标签页不会白跑时间）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushSettings();
    /* 页面一藏起来就闭嘴。语音合成在部分浏览器里不会因为标签页不可见而自动停，
       用户切回来时会听到上一题念到一半 —— 和切视图同一个道理。 */
    if (document.hidden) stopSpeech();
    if (document.hidden && app.engine && app.engine.state === STATE.RUNNING) {
      app.engine.pause();
      updatePauseButton();
    }
    // 回到前台时先把被节流掉的那段时间结算掉，再恢复计时。
    // pause() 已经同步过，这里覆盖的是「窗口失焦但未 hidden」的场景
    // （visibilitychange 不触发，但定时器被节流到 1 次/秒）。
    if (!document.hidden && app.engine && app.engine.state === STATE.RUNNING) {
      app.engine.syncActiveTime();
    }
  });

  // 窗口失焦/聚焦：非 hidden 的遮挡也会让定时器被节流。
  window.addEventListener('pageshow', () => {
    if (app.engine && app.engine.state === STATE.RUNNING) app.engine.syncActiveTime();
  });
}

/* ============================================================
   工具函数
   ============================================================ */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function relTime(ts) {
  const n = Number(ts);
  if (!n) return '—';
  const diff = Date.now() - n;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const dt = new Date(n);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

/* ============================================================
   启动
   ============================================================ */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// 暴露给控制台，便于排查
window.__app = app;

/* 测试钩子：让自检脚本能在不改动内部实现的前提下触发重渲染。
   之所以显式挂这几个（而不是让测试去翻 app 内部）：
   渲染函数是**闭包私有**的，测试拿不到；硬要暴露全部内部函数会
   让「哪些是公开契约」变得模糊。这里只开一扇小门，且命名带 __ 前缀
   明确标注「非公开 API」。 */
window.__hooks = {
  renderReviewView,
  renderStatsView,
  syncSettingsUI,
  initShortcutSettings,
  currentReduceMotion,
  motionClass
};
