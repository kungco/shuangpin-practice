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
  ALL_CHARS, PHRASES, PASSAGES
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
  hint: null           // 当前提示状态（由引擎 hint / reveal 事件驱动）
};

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/* ============================================================
   启动
   ============================================================ */

function boot() {
  try {
    app.settings = S.loadSettings();
    // 先确保 [hidden] 兜底规则生效，再渲染任何东西
    ensureHiddenRule();
    if (!S.isStorageAvailable()) {
      toast('浏览器存储不可用，本次记录不会被保存', 'err', 5000);
    }
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

  if (selDuration) {
    selDuration.value = String(app.settings.duration);
    selDuration.addEventListener('change', () => {
      app.settings.duration = Number(selDuration.value) || 0;
      saveSettingsDebounced();
    });
  }
  if (selCount) {
    selCount.value = String(app.settings.count);
    selCount.addEventListener('change', () => {
      app.settings.count = Number(selCount.value) || 0;
      saveSettingsDebounced();
      updateModeCounts();
    });
  }
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

  // 短文模式的默认题量与其它不同
  const selCount = $('#selCount');
  if (selCount && !silent) {
    // 若当前题量对短文不合适，给一个建议值（仅当用户没手动改过）
    const cur = Number(selCount.value);
    if (m === 'passage' && cur > 10) selCount.value = '3';
    if (m !== 'passage' && cur > 0 && cur < 10 && cur === 3) selCount.value = '20';
    // 测验需要足够的样本量分数才可信（见 score.js 的可信度因子），
    // 题量过小时给一个下限建议，但不强制——用户仍可自行调小。
    if (m === 'exam' && (cur === 0 || cur < 30)) selCount.value = '50';
    app.settings.count = Number(selCount.value) || 0;
  }
  const tip = LEVEL_MAP[m] ? LEVEL_MAP[m].tip : '';
  const stageTip = $('#stageTip');
  if (stageTip) stageTip.textContent = tip;
  toggleExamNote(m);
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

function updateModeCounts() {
  const count = Number($('#selCount') ? $('#selCount').value : 20) || 0;
  $$('#modeGrid .mode-count').forEach(el => {
    const mode = el.getAttribute('data-count');
    if (mode === 'passage') {
      el.textContent = count > 0 ? `${Math.min(count, 5)} 段` : '3 段';
    } else if (mode === 'keymap') {
      el.textContent = count > 0 ? `${count} 题` : '40 题';
    } else if (mode === 'sheng' || mode === 'yun') {
      // 单键题，一轮可以用更少的题量就覆盖全部键位
      el.textContent = count > 0 ? `${count} 题` : '30 题';
    } else if (mode === 'exam') {
      el.textContent = count > 0 ? `${count} 题` : '50 题';
    } else {
      el.textContent = count > 0 ? `${count} 题` : '20 题';
    }
  });
}

function saveSettingsDebounced() {
  if (app.saveTimer) clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => {
    try { S.saveSettings(app.settings); } catch (e) { console.warn(e); }
  }, 400);
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

    let questions = preset;

    if (!questions) {
      if (app.settings.weakBoost) {
        // 侧重易错：一半易错题 + 一半常规题
        const weak = weakRanking(60);
        const half = Math.max(1, Math.floor((count || 20) / 2));
        const fromWeak = generateReviewQuestions(weak, half);
        const rest = generateQuestions({ mode, count: Math.max(1, (count || 20) - fromWeak.length) });
        questions = fromWeak.concat(rest);
        if (!questions.length) questions = generateQuestions({ mode, count: count || 20 });
      } else {
        const effectiveCount = count > 0
          ? (mode === 'passage' ? Math.min(count, 8) : count)
          : (mode === 'passage' ? 3 : (mode === 'keymap' ? 40 : 20));
        questions = generateQuestions({ mode, count: effectiveCount });
      }    }

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

    app.engine.start();

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
    const eng = PracticeEngine.restore(saved);
    if (!eng) { toast('进度已损坏，无法恢复', 'err'); S.clearResume(); return; }
    if (app.engine) app.engine.destroy();
    app.engine = eng;
    app.sessionMode = eng.mode;
    bindEngineEvents();
    showSessionUI(true);
    ensureMiniKeymap();
    renderSession();
    eng.start();
    const hint = $('#resumeHint');
    if (hint) hint.hidden = true;
    toast('已恢复上次进度');
  } catch (err) {
    console.error('[resumeSession] 失败', err);
    toast('恢复进度失败', 'err');
  }
}

function bindEngineEvents() {
  const eng = app.engine;
  if (!eng) return;

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
  });

  eng.on('unit', () => {
    // 每个音节/题目完成：记录易错的「正确一次」
    try {
      const t = eng.currentTarget();
      if (t && t.split) {
        const ch = eng.currentChar();
        if (ch && ch.ch) S.recordWeakCorrect({ char: ch.ch });
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

  eng.on('pause', () => { updatePauseButton(); clearFeedback(); clearHint(); });
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
      ? '测验可以不限时慢慢打，但中途结束会按「已完成部分」计算分数，未答部分会拉低完成度。'
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
    // 若已经接近完成，就不必保留
    if (snap.index >= snap.questions.length - 1 &&
        eng.currentQuestion() && eng.charIndex >= (eng.currentQuestion().chars || []).length - 1) {
      const s = eng.finish('user');
      persistRecord(s);
      eng.destroy();
      app.engine = null;
      showSessionUI(false);
      toast('练习已完成，成绩已记录');
      return;
    }
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
        rec.score = examResult.score;
        rec.grade = examResult.grade;
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
  if (!s.completed && s.reason !== 'timeup') {
    noteParts.push('本次为主动结束，已完成部分已计入统计。');
  }

  /* ---------- 测验：分数区块 ---------- */
  const scoreBlock = sc ? `
    <div class="score-card ${sc.valid ? '' : 'is-invalid'}">
      <div class="score-main">
        <div class="score-num">${sc.score}<i>分</i></div>
        <div class="score-grade">
          <span class="score-badge score-tier-${gradeTier(sc.score)}">${escapeHtml(sc.badge)}</span>
          <span class="score-grade-name">${escapeHtml(sc.grade)}</span>
        </div>
      </div>
      <p class="score-desc">${escapeHtml(sc.gradeDesc)}</p>
      <div class="score-parts">
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
      </div>
      <p class="score-foot">
        计分口径：正确率 ${SCORE_CONFIG.accuracyWeight} 分（用<strong>独立正确率</strong>，提示无效）
        + 速度 ${SCORE_CONFIG.speedWeight} 分（${SCORE_CONFIG.speedBaseline}–${SCORE_CONFIG.speedFull} 字/分线性计分）
        → 按完成度加权。${sc.valid ? '本次测验<strong>全程无提示</strong>，分数有效。' : '本次测验<strong>有提示介入</strong>，分数仅供参考。'}
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
  if (q.kind === 'key' || q.kind === 'part') {
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
      else extra = ` title="${escapeHtml(st.ch)} ${escapeHtml(st.pinyin)}"`;
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

  // 全局快捷键
  if (e.key === 'Escape') {
    if (isModalOpen()) { closeModal(); return; }
    if (app.engine && app.engine.state === STATE.RUNNING) {
      app.engine.pause();
      updatePauseButton();
      return;
    }
  }

  if (!isSessionActive()) return;

  // 练习面板激活时不响应 Tab 的默认行为（避免焦点跳走），
  // 而是把它「征用」成「看答案」的快捷键。
  if (e.key === 'Tab') {
    e.preventDefault();
    if (app.engine && app.engine.state === STATE.RUNNING) requestHintNow();
    return;
  }

  // 空格 / 退格：跳过当前（辅助功能）
  if (e.key === 'Backspace' || (e.key === ' ' && e.ctrlKey)) {
    e.preventDefault();
    if (app.engine && app.engine.state === STATE.RUNNING) {
      app.engine.skipCurrent();
      clearFeedback();
    }
    return;
  }

  // 只处理单个字母键
  const key = normalizeKey(e.key);
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

  if (!result || !result.handled) return;

  if (result.correct === false) {
    // 错误反馈已由 error 事件渲染
    flashStageError();
  } else if (result.feedback && result.feedback.type === 'ok') {
    flashStageOk();
    clearFeedback();
  } else {
    clearFeedback();
  }
}

function flashStageError() {
  const stage = $('#stage');
  if (!stage) return;
  stage.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' },
     { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }],
    { duration: 180, easing: 'ease-in-out' }
  );
}

function flashStageOk() {
  const decode = $('#decode');
  if (!decode) return;
  decode.animate(
    [{ opacity: 1 }, { opacity: .55 }, { opacity: 1 }],
    { duration: 160 }
  );
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
    const done = saved.index || 0;
    const total = (saved.questions || []).length;
    text.textContent = `上次「${lv ? lv.name : saved.mode}」进行到 ${done + 1}/${total} 题`;
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
    const list = weakRanking(60);
    const groups = groupWeakItems(list);
    const advice = reviewAdvice(sum, list);

    if (sub) sub.textContent = '根据你的历史错误自动生成。';

    if (!list.length) {
      body.innerHTML = `
        <div class="empty-state">
          <strong>暂无需要复习的内容</strong>
          练习中出错的字词会自动收集到这里，并按错误频率排序。
        </div>
        <div class="review-cta">
          <button class="btn btn-primary" id="btnReviewPracticeAll">开始一次普通练习</button>
        </div>`;
      bindReviewActions();
      return;
    }

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
              return `<button class="review-chip" data-key="${escapeHtml(w.key)}" title="点击单独练习">
                <span class="rc-char">${escapeHtml(w.key)}</span>
                <span class="rc-py">${escapeHtml(w.pinyin || '')}</span>
                ${keys ? `<span class="rc-keys">${escapeHtml(keys)}</span>` : ''}
                <span class="rc-err">×${w.count}</span>
              </button>`;
            }).join('')}
          </div>
          ${note ? `<p class="footnote" style="margin-top:8px">${escapeHtml(note)}</p>` : ''}
        </div>`;
    };

    body.innerHTML = `
      <div class="review-summary">
        ${advice.map(escapeHtml).join('<br>')}
      </div>

      ${groupHtml('易错单字', groups.char, '')}
      ${groupHtml('易错词语', groups.phrase, '')}
      ${groups.other.length ? groupHtml('其他', groups.other, '') : ''}

      <div class="review-cta">
        <button class="btn btn-primary" id="btnReviewPractice">强化练习这些内容</button>
        <button class="btn btn-ghost" id="btnReviewPracticeAll">普通练习</button>
        <button class="btn btn-ghost" id="btnClearWeak">清空易错记录</button>
      </div>
    `;

    bindReviewActions();
  } catch (err) {
    console.error('[review] 渲染失败', err);
    body.innerHTML = '<div class="empty-state">复习内容生成失败</div>';
  }
}

function bindReviewActions() {
  const btnAll = $('#btnReviewPracticeAll');
  if (btnAll) btnAll.addEventListener('click', () => {
    switchView('practice');
    startSession();
  });

  const btnWeak = $('#btnReviewPractice');
  if (btnWeak) btnWeak.addEventListener('click', () => {
    const list = weakRanking(60);
    const qs = generateReviewQuestions(list, 20);
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
  if (setCount) {
    setCount.value = String(app.settings.count);
    setCount.addEventListener('change', () => {
      app.settings.count = Number(setCount.value) || 0;
      if ($('#selCount')) $('#selCount').value = String(app.settings.count);
      saveSettingsDebounced();
      updateModeCounts();
    });
  }

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
  bindToggle(setSound, 'sound');
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
        S.saveSettings(app.settings);
        syncSettingsUI();
        toast('已恢复默认设置');
      });
    });
  }

  // 数据占用提示
  try {
    const bytes = S.storageUsage();
    const kb = (bytes / 1024).toFixed(1);
    const note = $('.footnote', $('#view-settings'));
    if (note) {
      note.textContent = `所有数据保存在浏览器 localStorage 中（当前约 ${kb} KB），不会上传到任何服务器。` +
        '清除浏览器数据会导致记录丢失，建议定期导出备份。';
    }
  } catch (_) {}
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
  const pairs = [
    ['#selDuration', 'duration'], ['#setDuration', 'duration'],
    ['#selCount', 'count'], ['#setCount', 'count'],
    ['#setHintDelay', 'hintDelay'], ['#setRevealDelay', 'revealDelay']
  ];
  pairs.forEach(([sel, key]) => {
    const el = $(sel);
    if (el) el.value = String(app.settings[key]);
  });
  const checks = [
    ['#setMiniKeymap', 'showMiniKeymap'],
    ['#setSound', 'sound'],
    ['#setStrict', 'strict'],
    ['#setSkipPunct', 'skipPunct'],
    ['#setHint', 'hint'],
    ['#chkWeakBoost', 'weakBoost']
  ];
  checks.forEach(([sel, key]) => {
    const el = $(sel);
    if (el) el.checked = !!app.settings[key];
  });
  selectMode(app.settings.mode, true);
  applyMiniKeymapVisibility();
  updateModeCounts();
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
  window.addEventListener('beforeunload', (e) => {
    try {
      if (app.engine && app.engine.state === STATE.RUNNING) {
        if (app.engine.stats.keystrokes > 3) {
          S.saveResume(app.engine.exportResume());
        }
      }
    } catch (_) {}
  });

  // 页面隐藏时自动暂停（切标签页不会白跑时间）
  document.addEventListener('visibilitychange', () => {
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
