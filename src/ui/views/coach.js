import { COACH_RULES, COACH_MAP, coachRecommendations } from '../../core/coach.js';
import { primarySplit } from '../../core/scheme.js';

export function createCoachView({ $, app, escapeHtml, openModal, toast, startRule }) {
  function ruleHTML(rule, observation = '') {
    return `<strong>${escapeHtml(rule.title)}</strong>${observation ? `<p>${escapeHtml(observation)}</p>` : ''}
      <p>${escapeHtml(rule.explanation)}</p><div class="coach-examples">${rule.samples.map(([ch,py])=>
        `<span><b>${escapeHtml(ch)}</b> ${escapeHtml(py.replaceAll('v','ü'))} <code>${escapeHtml(primarySplit(py)?.code || '')}</code></span>`).join('')}</div>`;
  }
  function refreshTip(diagnosis = null) {
    const box=$('#coachTip');if(!box)return;
    const eng=app.engine;
    // Answer-bearing explanations must never enter an independent check's DOM.
    const allowed=eng && !eng.examMode && eng.assistanceLevel()===0;
    const rule=allowed ? COACH_MAP[app.coachActive?.phase==='guided' ? app.coachActive.ruleId : diagnosis?.ruleId] : null;
    box.hidden=!rule;
    box.innerHTML=rule ? ruleHTML(rule,diagnosis?.text || '') : '';
  }
  function resultHTML(log) {
    const items=coachRecommendations(log);
    if(!items.length)return '';
    return `<section class="coach-results"><h3>规则小教练</h3>${items.map(item=>
      `<div class="coach-rule-card">${ruleHTML(COACH_MAP[item.ruleId],item.text)}
        <button class="btn btn-ghost btn-sm" data-act="coach-${item.ruleId}">对照补练 → 换字验收</button></div>`).join('')}</section>`;
  }
  function openLibrary(returnView='practice') {
    if(['running','paused'].includes(app.engine?.state)) {toast('先保存或结束本轮，再进入规则小课堂');return;}
    openModal(`<h2>易混规则小课堂</h2><p class="modal-sub">先看解释、练对照字，再用本轮没出现的字独立验收。不设速度门槛。</p>
      <div class="coach-library">${COACH_RULES.map(rule=>`<div class="coach-rule-card"><strong>${escapeHtml(rule.title)}</strong>
      <button class="btn btn-ghost btn-sm" data-act="${rule.id}">开始这一课</button></div>`).join('')}</div>
      <div class="modal-actions"><button class="btn btn-ghost" data-act="close">返回</button></div>`,(act,close)=>{
        close();if(Object.hasOwn(COACH_MAP,act))startRule(act,[],returnView);
      });
  }
  function init() {$('#btnCoachLibrary')?.addEventListener('click',()=>openLibrary());}
  return { init, ruleHTML, refreshTip, resultHTML, openLibrary };
}
