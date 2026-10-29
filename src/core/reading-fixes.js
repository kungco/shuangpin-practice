import { CONTEXT_READINGS } from '../data/context-readings.js';

/** Apply reviewed contexts without changing noun readings such as 地图、地方. */
export function correctContextReadings(text, values) {
  const chars = Array.from(String(text || '')), out = values.slice();
  for (const [phrase, readings] of Object.entries(CONTEXT_READINGS)) {
    const needle = Array.from(phrase);
    for (let i=0;i<=chars.length-needle.length;i++) {
      if (needle.every((ch,j)=>chars[i+j]===ch)) readings.forEach((py,j)=>{out[i+j]=py;});
    }
  }
  return out;
}

/** Correct only known erroneous built-in readings, including old backups and resumes. */
export function correctedReading(text, value) {
  const wrong = text === '豫' ? 'lv' : text === '犹豫' ? 'you lv' : null;
  if (wrong && (Array.isArray(value) ? value.join(' ') : value) === wrong) {
    const fixed = text === '豫' ? 'yu' : 'you yu';
    return Array.isArray(value) ? fixed.split(' ') : fixed;
  }
  const readings = Array.isArray(value) ? value : typeof value==='string' ? value.split(' ') : [];
  if (readings.length !== Array.from(String(text||'')).length) return value;
  const fixed = correctContextReadings(text, readings);
  return Array.isArray(value) ? fixed : fixed.join(' ');
}
