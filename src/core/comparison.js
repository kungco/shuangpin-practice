/** A result can be compared only with the same source, material and assistance range. */
export function normalizeComparison(raw) {
  if (!raw || !['full','progressive','pinyin','independent','exam'].includes(raw.policy)) return null;
  const clean=value=>typeof value==='string'?value.slice(0,240):'';
  const source=clean(raw.source),material=clean(raw.material);
  if(!source || !material)return null;
  const stage=value=>Math.max(0,Math.min(2,Math.floor(Number(value)||0)));
  const tier=value=>Math.max(1,Math.min(7,Math.floor(Number(value)||1)));
  return {policy:raw.policy,source,material,startStage:stage(raw.startStage),endStage:stage(raw.endStage),
    startTier:tier(raw.startTier),endTier:tier(raw.endTier),minTier:tier(raw.minTier??raw.startTier),maxTier:tier(raw.maxTier??raw.endTier)};
}
export function comparisonKey(raw) {
  const c=normalizeComparison(raw);return c?JSON.stringify(c):'';
}
export function sessionComparison(app,engine) {
  const s=app.settings, mode=engine.mode;
  const context=app.learningActive||app.coachActive;
  const source=app.learningActive?'lesson':app.coachActive?'coach':app.reviewActive?'review':app.studio?`studio:${app.studio.kind}`:'practice';
  const material=context?`${context.lessonId||context.ruleId}:${context.phase}`
    :app.studio?app.studio.id||app.studio.tracks.join(',')
    :mode==='char'?String(s.charTier):mode==='phrase'?`${s.phraseCategory}:${s.phraseLength}`
    :mode==='passage'?`${s.passageTopic}:${s.passageLength}:${s.passageFocus}`
    :mode==='custom'?`${app.shelfActiveId||textKey(engine.questions.map(q=>q.text).join(''))}:${app.shelfSegBase||0}`:mode;
  return normalizeComparison({policy:engine.examMode?'exam':engine.training.policy,source,material,
    startStage:engine.assistanceLevel(),endStage:engine.assistanceLevel(),startTier:engine.training.tier,endTier:engine.training.tier});
}
function textKey(text){let h=2166136261;for(const ch of text){h=Math.imul(h^ch.codePointAt(0),16777619);}return (h>>>0).toString(16);}
