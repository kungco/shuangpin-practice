import { LEARNING_CHAPTERS, LEARNING_LESSONS, LEARNING_MAP, LEARNING_PHASES,
  learningItems, learningProgress, learningPhase, recommendedLearning, normalizeLearningSession } from '../../core/learning.js';
import { primarySplit } from '../../core/scheme.js';

export function createLearningView({ $, app, S, escapeHtml, startRound, resumeSession, switchView }) {
  let selectedId = null;
  function choice() {
    const p = learningProgress();
    const recommendation = recommendedLearning(p);
    const saved = S.loadResume();
    const continuation = normalizeLearningSession(saved?.learning);
    const lesson = LEARNING_MAP[selectedId] || (continuation ? LEARNING_MAP[continuation.lessonId] : recommendation?.lesson);
    return { p, lesson, continuation: continuation?.lessonId === lesson?.id ? continuation : null,
      phase: lesson ? learningPhase(lesson, p) : null };
  }
  function init() {
    $('#btnCourseStart')?.addEventListener('click', () => {
      const c = choice();
      if (c.continuation) { resumeSession(); return; }
      if (c.lesson) startRound({ lessonId: c.lesson.id, phase: c.phase });
      else $('#btnDailyPlan')?.click();
    });
    $('#btnLearningTest')?.addEventListener('click', () => {
      const c = choice();
      if (c.lesson) startRound({ lessonId: c.lesson.id, phase: c.phase === 'review' ? 'review' : 'check' });
    });
    $('#learningLessonList')?.addEventListener('click', e => {
      const button = e.target.closest('[data-lesson]');
      if (!button || !LEARNING_MAP[button.dataset.lesson]) return;
      selectedId = button.dataset.lesson;
      render();
      $('#courseTitle')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    });
    $('#btnLearningPath')?.addEventListener('click', () => {
      const path = $('#learningPath');
      path.open = !path.open;
      $('#btnLearningPath').setAttribute('aria-expanded', String(path.open));
    });
    $('#learningPath')?.addEventListener('toggle', () =>
      $('#btnLearningPath')?.setAttribute('aria-expanded', String($('#learningPath').open)));
    $('#btnLearningRecommended')?.addEventListener('click', () => { selectedId = null; render(); });
    $('#btnFreePractice')?.addEventListener('click', openFree);
    $('#btnOpenShelf')?.addEventListener('click', () => {
      openFree();
      $('#modeGrid [data-mode="custom"]')?.click();
      $('#customTextInput')?.focus();
    });
    $('#btnDueReview')?.addEventListener('click', () => switchView('review'));
    render();
  }
  function openFree() {
    const panel = $('#freePracticePanel');
    if (panel) { panel.open = true; panel.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); }
  }
  function status(rec = {}) {
    if (rec.failedAt && !rec.passedAt) return rec.repairedAt > rec.failedAt ? '需要巩固 · 待小测' : '需要巩固 · 待补练';
    if (rec.masteredAt) return '已掌握';
    if (rec.passedAt) return '小测通过 · 待回访';
    if (rec.practicedAt) return rec.legacy ? '旧版已练 · 可直接小测' : '已练过 · 待小测';
    return '未开始';
  }
  function render() {
    const box = $('#courseBox');
    if (!box) return;
    const c = choice();
    box.hidden = false;
    const passed = LEARNING_LESSONS.filter(l => c.p.lessons[l.id]?.passedAt).length;
    const mastered = LEARNING_LESSONS.filter(l => c.p.lessons[l.id]?.masteredAt).length;
    $('#learningOverview').textContent = `${passed} / ${LEARNING_LESSONS.length} 关小测通过 · ${mastered} 关已掌握`;
    $('#learningOverviewFill').style.width = `${passed / LEARNING_LESSONS.length * 100}%`;
    $('#learningOverviewTrack').setAttribute('aria-valuenow', String(passed));
    $('#learningOverviewTrack').setAttribute('aria-valuemax', String(LEARNING_LESSONS.length));
    $('#learningMigrationNote').hidden = !Object.values(c.p.lessons).some(r => r.legacy);
    $('#courseTitle').textContent = c.lesson ? `${c.lesson.chapterTitle} · ${c.lesson.title}` : '所有关卡的小测已完成';
    $('#courseStat').textContent = c.lesson ? status(c.p.lessons[c.lesson.id]) : '按自己的节奏继续练习';
    $('#courseGoal').textContent = c.lesson?.goal || '隔天到期后会推荐回访；现在可以练自己的材料或今日计划。';
    $('#courseCheck').textContent = c.lesson
      ? '小测标准：整轮完成、独立正确率 ≥90%，每项测 4 次且独立答对 ≥75%；不设速度门槛。' : '';
    $('#courseNote').textContent = !c.lesson ? '到期回访会优先显示在这里，也可以随时从学习路径重练。'
      : c.continuation ? '有未完成的本关进度，可从上次按到的位置继续。'
      : c.phase === 'repair' ? '最近小测未通过；先补练薄弱项，再重新小测，隔天回访后确认掌握。'
      : c.phase === 'review' ? '隔天回访已到期，这次独立答对后标记为已掌握。'
      : c.phase === 'check' ? '已练过这一组，接下来撤掉提示，独立试一轮。' : '先看上面的示例，再开始提示练习。约 2–3 分钟。';
    const examples = c.lesson ? learningItems(c.lesson).slice(0, 4) : [];
    $('#courseExamples').innerHTML = examples.map(i => {
      const code = i.key || i.pinyin.split(' ').map(py => primarySplit(py)?.code || '').join(' ');
      return `<span class="learning-example"><b>${escapeHtml(i.label)}</b><span>${escapeHtml(code)}</span></span>`;
    }).join('');
    $('#btnCourseStart').textContent = c.continuation ? '继续本关进度' : !c.lesson ? '开始今日计划'
      : c.phase === 'repair' ? '开始针对性补练'
      : c.phase === 'review' ? '开始隔天回访' : c.phase === 'check' ? '开始独立小测' : '开始提示练习';
    $('#btnLearningTest').hidden = !c.lesson || c.phase !== 'guided' || !!c.continuation;
    $('#btnLearningTest').textContent = '已经会了，直接小测';
    $('#learningLessonList').innerHTML = LEARNING_CHAPTERS.map((chapter, index) => {
      const list = LEARNING_LESSONS.filter(l => l.chapter === index);
      const count = list.filter(l => c.p.lessons[l.id]?.passedAt).length;
      return `<section class="learning-chapter"><div class="learning-chapter-head"><h3>${index + 1}. ${escapeHtml(chapter.title)}</h3><span>${count} / ${list.length} 关</span></div>
        <p>${escapeHtml(chapter.goal)}</p><div class="learning-lessons">${list.map(l => {
          const rec = c.p.lessons[l.id] || {};
          return `<button type="button" class="learning-lesson${rec.masteredAt ? ' is-mastered' : ''}" data-lesson="${l.id}"
            aria-pressed="${l.id === c.lesson?.id}"><span class="learning-number">${index + 1}.${l.number}</span>
            <span><strong>${escapeHtml(l.title)}</strong><small>${status(rec)}</small></span></button>`;
        }).join('')}</div></section>`;
    }).join('');
    const review = S.reviewSummary();
    $('#dueReviewNote').textContent = review.due ? `${review.due} 项到期 · 针对性复习` : '看看最近的易错字词';
  }
  function resetSelection() { selectedId = null; }
  return { init, render, openFree, resetSelection };
}
