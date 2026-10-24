// Deterministic schedule + dose-status logic (no AI involved).
const pad = n => String(n).padStart(2, '0');
export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const BASE = { 1: ['08:00'], 2: ['08:00', '20:00'], 3: ['08:00', '14:00', '20:00'], 4: ['08:00', '12:00', '16:00', '20:00'] };
const SLOT = { morning: '08:00', afternoon: '14:00', evening: '18:00', night: '21:00' };
const COUNTS = [[/\b(four|4|qid|qds)\b/i, 4], [/\b(thrice|three|3|tds|tid)\b/i, 3], [/\b(twice|two|2|bd|bid)\b/i, 2], [/\b(once|one|1|od|qd|daily)\b/i, 1]];

// "twice daily" / "TDS" / "1-0-1" + timing words -> ['08:00','20:00']; null if not understood
export function timesFor(frequency = '', timing = '') {
  const p = String(frequency).match(/(\d)\s*-\s*(\d)\s*-\s*(\d)/);
  if (p) { const t = [p[1] !== '0' && '08:00', p[2] !== '0' && '14:00', p[3] !== '0' && '20:00'].filter(Boolean); return t.length ? t : null; }
  const hit = COUNTS.find(([re]) => re.test(frequency));
  if (!hit) return null;
  if (hit[1] === 1) { const s = Object.keys(SLOT).find(k => new RegExp(k, 'i').test(`${frequency} ${timing}`)); if (s) return [SLOT[s]]; }
  return BASE[hit[1]];
}

export function makeDoses(med, start = new Date()) {
  const out = [];
  const times = timesFor(med.frequency, med.timing) || [];
  for (let d = 0; d < med.durationDays; d++) for (const t of times) {
    const [h, m] = t.split(':').map(Number);
    out.push({ medicationId: med.id, userId: med.userId, scheduledAt: new Date(start.getFullYear(), start.getMonth(), start.getDate() + d, h, m).toISOString(), takenAt: null });
  }
  return out;
}

const MIN = 60000;
export function statusOf(dose, now = new Date()) {
  const s = new Date(dose.scheduledAt);
  if (dose.takenAt) return new Date(dose.takenAt) - s > 30 * MIN ? 'delayed' : 'taken';
  if (now - s > 120 * MIN) return 'missed';
  return now >= s ? 'due' : 'upcoming';
}

// adherence = (taken + delayed) / (taken + delayed + missed) x 100, counting only resolved doses
export function adherence(doses, now = new Date()) {
  let ok = 0, bad = 0;
  for (const d of doses) { const s = statusOf(d, now); if (s === 'taken' || s === 'delayed') ok++; else if (s === 'missed') bad++; }
  return ok + bad ? Math.round((ok / (ok + bad)) * 100) : null;
}
