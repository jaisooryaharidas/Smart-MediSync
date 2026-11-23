// Deterministic schedule + dose-status logic. All calendar dates and wall-clock times use Asia/Kolkata.
const pad = n => String(n).padStart(2, '0');
const IST = 'Asia/Kolkata';
const IST_OFFSET_MINUTES = 330;
const dateParts = d => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const v = Object.fromEntries(p.map(x => [x.type, x.value]));
  return { year: Number(v.year), month: Number(v.month), day: Number(v.day) };
};
export const dayKey = d => { const p = dateParts(d); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
const BASE = { 1: ['08:00'], 2: ['08:00', '20:00'], 3: ['08:00', '14:00', '20:00'], 4: ['08:00', '12:00', '16:00', '20:00'] };
const SLOT = { morning: '08:00', afternoon: '14:00', evening: '18:00', night: '21:00' };
const COUNTS = [[/\b(four|4|qid|qds)\b/i, 4], [/\b(thrice|three|3|tds|tid)\b/i, 3], [/\b(twice|two|2|bd|bid)\b/i, 2], [/\b(once|one|1|od|qd|daily)\b/i, 1]];
export function timesFor(frequency = '', timing = '') {
  const p = String(frequency).match(/(\d)\s*-\s*(\d)\s*-\s*(\d)/);
  if (p) { const t = [p[1] !== '0' && '08:00', p[2] !== '0' && '14:00', p[3] !== '0' && '20:00'].filter(Boolean); return t.length ? t : null; }
  const hit = COUNTS.find(([re]) => re.test(frequency));
  if (!hit) return null;
  if (hit[1] === 1) { const s = Object.keys(SLOT).find(k => new RegExp(k, 'i').test(`${frequency} ${timing}`)); if (s) return [SLOT[s]]; }
  return BASE[hit[1]];
}
export function makeDoses(med, start = new Date()) {
  const out = [], times = timesFor(med.frequency, med.timing) || [];
  // start is a date-only carrier; UTC fields preserve YYYY-MM-DD regardless of host timezone.
  const y = start.getUTCFullYear(), mo = start.getUTCMonth(), da = start.getUTCDate();
  for (let d = 0; d < med.durationDays; d++) {
    const calendar = new Date(Date.UTC(y, mo, da + d));
    for (const t of times) {
      const [h, m] = t.split(':').map(Number);
      // Convert India wall-clock time to a real UTC instant without relying on process.env.TZ.
      const utc = Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate(), h, m) - IST_OFFSET_MINUTES * 60000;
      out.push({ medicationId: med.id, userId: med.userId, scheduledAt: new Date(utc).toISOString(), takenAt: null });
    }
  }
  return out;
}
const MIN = 60000;
export function statusOf(dose, now = new Date()) {
  const scheduled = new Date(dose.scheduledAt);
  if (dose.takenAt) return new Date(dose.takenAt) - scheduled > 30 * MIN ? 'delayed' : 'taken';
  if (now - scheduled > 120 * MIN) return 'missed';
  return now >= scheduled ? 'due' : 'upcoming';
}
export function adherence(doses, now = new Date()) {
  let ok = 0, bad = 0;
  for (const d of doses) { const s = statusOf(d, now); if (s === 'taken' || s === 'delayed') ok++; else if (s === 'missed') bad++; }
  return ok + bad ? Math.round((ok / (ok + bad)) * 100) : null;
}
