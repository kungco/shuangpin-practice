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
  ALL_CHARS, PHRASES, PASSAGES, CHAR_TIERS
} from './core/questions.js';
import { PracticeEngine, STATE, normalizeKey } from './core/engine.js';
import * as S from './core/storage.js';
import { summarize, historySeries, dailySeries, weakRanking, groupWeakItems,
         reviewAdvice, formatDuration, formatClock, keyHeatmap } from './core/stats.js';
import { scoreExam, gradeTier, SCORE_CONFIG } from './core/score.js';
import {
  getKeymapData, splitSyllable, primarySplit, highlightForSplit,
  acceptableKeys, SCHEME_META
} from './core/scheme.js';
import { renderKeymap } from './ui/keymap.js';
import { drawLine, drawBars } from './ui/chart.js';
import { play as playSound, prime as primeSound, resetErrorFatigue,
         isSupported as soundSupported } from './ui/sound.js';
import {
  prefersReducedMotion, watchReducedMotion, motionClass,
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
  stats: { chartMetric: 'speed', chartRange: '20', dailyDays: 14, heatRange: 'all' },
  saveTimer: null,
  lastResumeSave: 0,
  hint: null,          // 当前提示状态（由引擎 hint / reveal 事件驱动）
  _capturingShortcut: false,  // 设置页「按下新键」捕获中：此时全局快捷键必须让路
  _captureCleanup: null,      // 当前捕获的收尾函数（保证旧监听器必然被摘掉）
  _armAudio: null             // 首次用户手势时解锁音频（用完置空）
};

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

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

  // 练习中离开 → 提示
  if (app.view === 'practice' && v !== 'practice' && app.engine &&
      app.engine.state === STATE.RUNNING) {
    app.engine.pause();
    updatePauseButton();
  }

  app.view = v;
  $$('.view').forEach(el => el.classList.toggle('is-active', el.id === `view-${v}`));
  $$('#nav .nav-btn').forEach(b => b.classList.toggle('is-active', b.getAttribute('data-view') === v));

  if (v === 'stats') renderStatsView();
  if (v === 'review') renderReviewView();
  if (v === 'keymap') renderSyllableList();
}

/* ============================================================
   练习：模式选择面板
   ============================================================ */

function initSetupPanel() {
  const grid = $('#modeGrid');
  if (grid) {
    grid.innerHTML = LEVELS.map(l => `
      <button class="mode-card" data-mode="${l.id}">
        <span class="mode-count" data-count="${l.id}"></span>
        <span class="mode-card-head">
          <span class="mode-lv">${l.badge}</span>
          <span class="mode-card-name">${escapeHtml(l.name)}</span>
        </span>
        <span class="mode-card-desc">${escapeHtml(l.desc)}</span>
      </button>
    `).join('');

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
      + '<option value="progressive">逐档挑战</option>';
    selTier.value = app.settings.charTier;
    selTier.addEventListener('change', () => {
      app.settings.charTier = selTier.value;
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
    el.textContent = count > 0 ? `${count} ${mode === 'passage' ? '段' : '题'}`
      : (mode === 'exam' ? '50 题' : '不限量');
  });
}

// 生成器保留去重集合，不限量时按小批次补充，避免续练数据无限膨胀。
function createQuestionSource(config, initial = []) {
  const recent = S.loadRecent(config.mode);
  const context = { used: new Set(recent), usedPinyin: new Set(recent), usedPhrase: new Set(recent) };
  for (const q of initial) {
    context.used.add(q.text || q.promptText);
    context.usedPhrase.add(q.text || q.promptText);
    const py = q.pinyin || q.chars?.[0]?.pinyin;
    if (py) context.usedPinyin.add(q.kind === 'part' ? `${q.part}:${py}` : py);
  }
  return () => {
    const weak = config.weakBoost && ['char', 'phrase'].includes(config.mode) ? weakRanking(60) : [];
    const review = weak.length ? generateReviewQuestions(weak, Math.floor(config.count / 5)) : [];
    const fresh = generateQuestions({ ...config, count: config.count - review.length, context });
    const out = fresh.slice();
    // 每五题最多一题易错复习，避免新内容被挤走。
    review.forEach((q, i) => out.splice(Math.min(out.length, i * 5 + 4), 0, q));
    return out;
  };
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

function startSession(questionsOverride, modeOverride) {
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
    const durationSec = Number(app.settings.duration) || 0;
    const count = Number(app.settings.count) || 0;

    const unlimited = !preset && count === 0 && mode !== 'exam';
    const generation = {
      mode, count: unlimited ? (mode === 'passage' ? 3 : 20) : (count || 50),
      charTier: app.settings.charTier, weakBoost: app.settings.weakBoost
    };
    const questionSource = preset ? null : createQuestionSource(generation);
    const questions = preset || questionSource();

    if (!Array.isArray(questions) || !questions.length) {
      toast('题目生成失败，请重试', 'err');
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
      modeName: LEVEL_MAP[mode] ? LEVEL_MAP[mode].name : mode,
      durationSec,
      strict: app.settings.strict,
      skipPunct: app.settings.skipPunct,
      examMode: isExam,
      hintEnabled: isExam ? false : app.settings.hint,
      hintDelayMs: isExam ? 0 : app.settings.hintDelay,
      revealDelayMs: isExam ? 0 : app.settings.revealDelay
    });

    bindEngineEvents();
    showSessionUI(true);
    ensureMiniKeymap();
    renderSession();

    app.lastResumeSave = 0;
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
    const source = saved.unlimited ? createQuestionSource(generation, saved.questions) : null;
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
    S.recordRecent(eng.mode, q.kind === 'part' ? `${q.part}:${q.pinyin}` : (q.text || q.promptText));
  }
}

function bindEngineEvents() {
  const eng = app.engine;
  if (!eng) return;

  eng.on('question', ({ done }) => { if (!done) rememberCurrentQuestion(eng); });

  eng.on('change', () => {
    renderSession();
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
    if (fb && fb.expectedAll && fb.expectedAll.length) {
      announce(`按错。应键入 ${fb.expectedAll.map(k => String(k).toUpperCase()).join(' 或 ')}`, 'assertive');
    }
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
    onSessionFinish(summary);
  });

  /* ---- 卡住提示 ---- */
  eng.on('hint', (payload) => {
    app.hint = payload;
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

      // 记录易错字词
      const perErr = s.perCharErrors || {};
      Object.entries(perErr).forEach(([k, cnt]) => {
        if (!cnt) return;
        S.recordWeak({ char: k, word: '', pinyin: ALL_CHARS[k] || '' });
      });

      // 记录键维度错误（错误热力图的数据来源）。
      // 与字词表分开存：字词表是「哪些字不会」，热力图是「哪些键不熟」。
      if (s.keyErrors && Object.keys(s.keyErrors).length) {
        S.recordKeyErrors(s.keyErrors);
      }
    }

    S.clearResume();
    showResultModal(s, meaningful);
  } catch (err) {
    console.error('[persistRecord] 失败', err);
    toast('成绩保存失败', 'err');
    showSessionUI(false);
    showResumeHint();
  }
}

function showResultModal(s, recorded) {
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
  if (s.maxCombo >= 30) {
    noteParts.push(`最长连击 ${s.maxCombo} 键，手感相当稳定。`);
  }
  if (recorded && !s.completed && s.reason !== 'timeup') {
    noteParts.push('本次为主动结束，已完成部分已计入统计。');
  }

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
        <div class="result-cell-label">总按键</div>
        <div class="result-cell-value">${s.keystrokes}<i>键</i></div>
      </div>
      <div class="result-cell">
        <div class="result-cell-label">最长连击</div>
        <div class="result-cell-value">${s.maxCombo}<i>键</i></div>
      </div>
    </div>

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
      const hidden = wrap.style.display === 'none';
      wrap.style.display = hidden ? '' : 'none';
      btnToggle.textContent = hidden ? '隐藏' : '显示';
    });
  }
}

function updatePauseButton() {
  const btn = $('#btnPause');
  if (!btn || !app.engine) return;
  btn.textContent = app.engine.state === STATE.PAUSED ? '继续' : '暂停';
}

function renderSession() {
  const eng = app.engine;
  if (!eng) return;

  const q = eng.currentQuestion();
  const stage = $('#stage');
  const prompt = $('#prompt');
  const decode = $('#decode');
  const feedback = $('#feedback');
  const stageMode = $('#stageMode');
  const stageTip = $('#stageTip');

  if (!q || !prompt || !decode) return;

  if (stageMode) stageMode.textContent = q.label || (LEVEL_MAP[eng.mode] ? LEVEL_MAP[eng.mode].name : '练习');
  if (stageTip) stageTip.textContent = LEVEL_MAP[eng.mode] ? LEVEL_MAP[eng.mode].tip : '';

  /* 测验模式：在舞台顶部挂一个「无提示」标记。
     用户随时能看见自己处在测验中（而不是以为应用坏了），
     这也是诚实计分的一部分。 */
  let examFlag = $('#examFlag');
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

  /* ---- 字形行 ---- */
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
      let extra = '';
      if (st.punct) extra = '';
      else if (st.unknown) extra = ' title="该字未收录拼音，自动跳过"';
      else if (!eng.examMode) extra = ` title="${escapeHtml(st.ch)} ${escapeHtml(st.pinyin)}"`;
      return `<span class="${cls.join(' ')}"${extra}>${escapeHtml(st.ch)}</span>`;
    }).join('');
  }

  /* ---- 拆分与键位 ---- */
  renderDecode(eng, q, decode);

  /* ---- HUD ---- */
  updateHud();
  updateTimebar();

  /* ---- 键位图高亮 ---- */
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
}

function updateTimebar() {
  const eng = app.engine;
  const fill = $('#timebarFill');
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
  const el = $(sel);
  if (el) el.textContent = String(val);
}

/* ---- 错误反馈 ---- */

function showErrorFeedback(fb) {
  const box = $('#feedback');
  if (!box || !fb) return;

  const keySeq = (fb.expectedAll || []).map((k, i) =>
    i === fb.pos ? `<b style="text-decoration:underline">${escapeHtml(k)}</b>` : escapeHtml(k)
  ).join(' ');

  box.className = 'feedback is-err';
  box.hidden = false;
  box.innerHTML =
    `<span class="fb-icon">✕</span>` +
    `<span>你按了 <code>${escapeHtml(fb.pressed)}</code>，这里应该是 <code>${escapeHtml(fb.expected)}</code>` +
    `${fb.expectedAll && fb.expectedAll.length > 1 ? `（完整编码 <code>${escapeHtml(fb.codeText)}</code>）` : ''}</span>` +
    `<span class="fb-explain">${escapeHtml(fb.explain || '')}</span>`;

  // 自动淡出
  if (app._fbTimer) clearTimeout(app._fbTimer);
  app._fbTimer = setTimeout(() => clearFeedback(), 3200);
}

function clearFeedback() {
  const box = $('#feedback');
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

  // 重新绑定（innerHTML 会清掉旧监听）
  const btnNow = $('#btnHintNow');
  if (btnNow) btnNow.addEventListener('click', requestHintNow);

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
  const bar = $('#hintBar');
  const flag = $('#hintFlag');
  const note = $('#miniKeymapNote');
  if (bar) { bar.hidden = true; bar.innerHTML = ''; bar.className = 'hintbar'; }
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
  const visible = !isExam && app.settings.showMiniKeymap;
  const wrap = $('#miniKeymap');
  const outer = wrap && wrap.closest ? wrap.closest('.mini-keymap-wrap') : null;
  if (outer) outer.hidden = !visible;
  if (wrap) wrap.hidden = !visible;
  const btn = $('#btnToggleKeymap');
  if (btn) btn.textContent = visible ? '隐藏' : '显示';
}

function highlightMiniKeymap() {
  if (!app.keymap || !app.engine) return;
  try {
    // 测验模式下绝不把答案画到键位图上
    if (app.engine.examMode) { app.keymap.clear(); return; }
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
    // 只有真的绑定了快捷键才 preventDefault —— 用户选择「不占用 Tab」时，
    // Tab 应当恢复成浏览器原生的焦点导航，不能被我们吞掉。
    e.preventDefault();
    if (app.engine && app.engine.state === STATE.RUNNING) requestHintNow();
    return;
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
  } catch (_) {}
}

/**
 * 错误时让「舞台」抖一下 —— 但必须尊重「减少动态效果」。
 *
 * 抖动/闪烁对前庭敏感的用户会引起真实不适，所以系统开了这个设置时
 * 我们换成**不移动**的提示：把边框闪一下，信息量等价，但不动。
 */
function flashStageError() {
  const stage = $('#stage');
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
  const decode = $('#decode');
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
    const history = S.loadHistory();
    const sum = summarize(history);

    /* ---- 卡片 ---- */
    const cards = $('#statCards');
    if (cards) {
      cards.innerHTML = `
        ${statCard('累计练习', sum.sessions, '次', `${sum.totalDays} 个练习日`)}
        ${statCard('累计字数', sum.totalChars, '字', `总时长 ${formatDuration(sum.totalSeconds)}`)}
        ${statCard('平均速度', sum.avgSpeed, '字/分', `最佳 ${sum.bestSpeed} 字/分`)}
        ${statCard('平均正确率', sum.avgAccuracy, '%', `最佳 ${sum.bestAccuracy}%`)}
        ${statCard('连续练习', sum.streakDays, '天', sum.streakDays >= 3 ? '节奏很好' : '坚持就有效果')}
        ${statCard('今日', sum.todayChars, '字', `${sum.todaySessions} 次练习`)}
      `;
    }

    /* ---- 曲线 ---- */
    const canvas = $('#historyChart');
    if (canvas) {
      const series = historySeries({ range: app.stats.chartRange, metric: app.stats.chartMetric });
      drawLine(canvas, series.points, {
        metric: series.metric,
        avg: series.avg,
        height: 260
      });
    }

    /* ---- 每日柱状 ---- */
    const dailyCanvas = $('#dailyChart');
    if (dailyCanvas) {
      drawBars(dailyCanvas, dailySeries(app.stats.dailyDays), { height: 200 });
    }

    /* ---- 错误热力图 ---- */
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

function statCard(label, value, unit, sub) {
  return `<div class="stat-card">
    <div class="stat-card-label">${escapeHtml(label)}</div>
    <div class="stat-card-value">${escapeHtml(String(value))}${unit ? `<i>${escapeHtml(unit)}</i>` : ''}</div>
    <div class="stat-card-sub">${escapeHtml(sub || '')}</div>
  </div>`;
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
    const heat = keyHeatmap({ range: app.stats.heatRange });

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
      return;
    }

    app.heatKeymap.setHeat(heat.items);

    /* 概览文字 */
    const summary = $('#heatSummary');
    if (summary) {
      const hot = heat.hottest;
      summary.innerHTML =
        `共 <b>${heat.total}</b> 次按键错误，涉及 <b>${heat.items.length}</b> 个键` +
        (hot ? `　最集中：<b>${escapeHtml(hot.key)}</b> 键（${hot.count} 次）` : '');
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
              const split = w.char ? primarySplit(w.pinyin) : null;
              const keys = split ? split.code : '';
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
      const key = chip.getAttribute('data-key');
      if (!key) return;
      let q = null;
      // 优先当词组处理
      const phrase = PHRASES.find(p => p.w === key);
      if (phrase) q = questionFromPhrase(phrase.w, phrase.p);
      if (!q) {
        const chars = Array.from(key);
        if (chars.length === 1 && ALL_CHARS[chars[0]]) {
          q = questionFromCharChar(chars[0], ALL_CHARS[chars[0]]);
        } else {
          // 多字但词表里没有：逐字查
          const pys = chars.map(c => ALL_CHARS[c]).filter(Boolean);
          if (pys.length === chars.length) q = questionFromPhrase(key, pys);
        }
      }
      if (!q) { toast('该条目暂无法生成练习', 'err'); return; }
      switchView('practice');
      startSession([q, q, q], 'char');
    });
  });
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

  // 数据占用提示
  try {
    const bytes = S.storageUsage();
    const kb = (bytes / 1024).toFixed(1);
    // 必须精确定位到 #storageNote —— 设置页里有多个 .footnote，
    // 用 $('.footnote') 会命中第一个（可能是快捷键说明那段），
    // 一个 textContent 赋值就把它的 <code> 子节点全抹掉了。
    const note = $('#storageNote');
    if (note) {
      note.textContent = `所有数据保存在浏览器 localStorage 中（当前约 ${kb} KB），不会上传到任何服务器。` +
        '清除浏览器数据会导致记录丢失，建议定期导出备份。';
    }
  } catch (_) {}
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

/** 把 settings 同步到所有相关 UI */
function syncSettingsUI() {
  syncCountControls();
  const selects = [
    ['#selDuration', 'duration'], ['#setDuration', 'duration'],
    ['#selCharTier', 'charTier'],
    ['#setHintDelay', 'hintDelay'], ['#setRevealDelay', 'revealDelay'],
    ['#setReduceMotion', 'reduceMotion']
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
    ['#chkReviewDueOnly', 'reviewDueOnly']
  ];
  checks.forEach(([sel, key]) => {
    const el = $(sel);
    if (el) el.checked = !!app.settings[key];
  });
  selectMode(app.settings.mode, true);
  applyMiniKeymapVisibility();
  updateModeCounts();
  syncShortcutNote();
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

  modal.innerHTML = html;
  overlay.hidden = false;

  const handler = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (typeof onAct === 'function') onAct(act, closeModal);
  };
  modal.addEventListener('click', handler);

  modalCleanup = () => {
    modal.removeEventListener('click', handler);
    if (typeof onClose === 'function') {
      try { onClose(); } catch (err) { console.error(err); }
    }
  };

  // 点击遮罩关闭
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
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
    if (document.hidden && app.engine && app.engine.state === STATE.RUNNING) {
      app.engine.pause();
      updatePauseButton();
    }
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
