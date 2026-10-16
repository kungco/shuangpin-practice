/** Review context survives save/resume; failure in a round cannot become a pass on repetition. */
const RESULTS = new Set(['advanced','practice','wrong','helped','skipped']);
export const isReviewFailure = value => ['wrong','helped','skipped'].includes(value?.status);
export function normalizeReviewSession(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const outcomes = Object.create(null);
  for (const [key, value] of Object.entries(raw.outcomes || {}).slice(0, 100)) {
    if (!key || key.length > 300 || !RESULTS.has(value?.status)) continue;
    outcomes[key] = { status: value.status, lapsed: value.lapsed === true,
      due: Math.max(0, Number(value.due) || 0), mastered: value.mastered === true };
  }
  const keys = Array.isArray(raw.keys) ? [...new Set(raw.keys.filter(k => typeof k === 'string' && k && k.length <= 300))].slice(0,100) : [];
  return { outcomes, keys };
}
export function reviewTotals(session) {
  const items = Object.entries(session?.outcomes || {}).filter(([key]) => !session.keys?.length || session.keys.includes(key)).map(([,value])=>value);
  return { advanced: items.filter(v => v.status === 'advanced').length,
    practice: items.filter(v => v.status === 'practice').length,
    repair: items.filter(isReviewFailure).length };
}
