/** Correct only known erroneous built-in readings, including old backups and resumes. */
export function correctedReading(text, value) {
  const wrong = text === '豫' ? 'lv' : text === '犹豫' ? 'you lv' : null;
  if (!wrong || (Array.isArray(value) ? value.join(' ') : value) !== wrong) return value;
  const fixed = text === '豫' ? 'yu' : 'you yu';
  return Array.isArray(value) ? fixed.split(' ') : fixed;
}
