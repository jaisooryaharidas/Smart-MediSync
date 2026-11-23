// Smart MediSync backend: zero dependencies (Node 18+). Auth, JSON-file DB, Gemini proxy, doses.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { timesFor, makeDoses, statusOf, adherence, dayKey } from './schedule.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { for (const l of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; } } catch {}
const { PORT = 4000, GEMINI_API_KEY, GEMINI_MODEL = 'gemini-flash-latest', AUTH_SECRET = 'dev-secret-change-me' } = process.env;

if (AUTH_SECRET === 'dev-secret-change-me') console.warn('WARNING: set AUTH_SECRET in .env (login tokens are signed with it).');

// ---- tiny JSON-file database (collections: users, prescriptions, medications, doses) ----
const dbFile = path.join(process.env.DATA_DIR || path.join(root, 'server', 'data'), 'db.json');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
let db = { users: [], prescriptions: [], medications: [], doses: [], caregiverRelationships: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(dbFile, 'utf8')) }; } catch {}
const save = () => { fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db)); fs.renameSync(dbFile + '.tmp', dbFile); };

// One-time migration: previous Render schedules were created using the server's UTC wall clock.
// Subtract 5h30 so 08:00Z becomes the intended 08:00 IST instant (02:30Z).
// Keep takenAt untouched. A pre-migration copy is retained beside db.json.
const IST_MIGRATION = 'scheduledAt-utc-to-ist-v1';
if (!(db.timezoneMigrations || []).includes(IST_MIGRATION)) {
  if (fs.existsSync(dbFile) && !fs.existsSync(dbFile + '.pre-ist-migration')) {
    fs.copyFileSync(dbFile, dbFile + '.pre-ist-migration');
  }
  db.doses = (db.doses || []).map(d => {
    const stamp = Date.parse(d.scheduledAt);
    return Number.isFinite(stamp) ? { ...d, scheduledAt: new Date(stamp - 330 * 60000).toISOString() } : d;
  });
  db.timezoneMigrations = [...(db.timezoneMigrations || []), IST_MIGRATION];
  save();
  console.log('Applied one-time Asia/Kolkata schedule migration; takenAt history preserved.');
}

// ---- auth: scrypt password hashes + HMAC-signed tokens ----
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
const checkPw = (pw, stored) => { const [s, h] = stored.split(':'); return crypto.timingSafeEqual(Buffer.from(hash(pw, s).split(':')[1], 'hex'), Buffer.from(h, 'hex')); };
const mac = b => crypto.createHmac('sha256', AUTH_SECRET).update(b).digest('base64url');
const sign = uid => { const b = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 7 * 864e5 })).toString('base64url'); return `${b}.${mac(b)}`; };
const verify = t => { const [b, s] = (t || '').split('.'); if (!b || !s || s.length !== mac(b).length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(mac(b)))) return null; try { const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p.uid : null; } catch { return null; } };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---- Gemini prescription extraction (key stays on the server) ----
const PROMPT = `You read medical prescriptions. Extract ONLY what is written on the document. Never diagnose, recommend, or change doses. If a field is not clearly readable or not present, return "Unknown". Do not guess medicine names. durationDays is an integer only if the duration is written, otherwise omit it. Return every medicine listed.`;
const schema = { type: 'OBJECT', properties: { medicines: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, strength: { type: 'STRING' }, dose: { type: 'STRING' }, frequency: { type: 'STRING' }, timing: { type: 'STRING' }, durationDays: { type: 'INTEGER' }, instructions: { type: 'STRING' } }, required: ['name'] } } }, required: ['medicines'] };
const FIELDS = ['name', 'strength', 'dose', 'frequency', 'timing', 'instructions'];

async function extract(mime, b64) {
  if (!GEMINI_API_KEY) throw new HttpError(503, 'AI is not configured. Add GEMINI_API_KEY to .env, or add medicines manually.');
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: b64 } }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0 } }),
    });
  } catch { throw new HttpError(502, 'Could not reach the AI service. Check your internet connection.'); }
  if (r.status === 429) throw new HttpError(429, 'AI free-tier limit reached. Wait a minute and try again.');
  if (!r.ok) { console.error('Gemini error', r.status, (await r.text()).slice(0, 300)); throw new HttpError(502, 'AI extraction failed. Check GEMINI_API_KEY / GEMINI_MODEL, or add medicines manually.'); }
  let list = [];
  try { list = JSON.parse((await r.json()).candidates[0].content.parts[0].text).medicines || []; } catch { throw new HttpError(502, 'The AI returned an unreadable answer. Try a clearer photo or add medicines manually.'); }
  return list.map(m => {
    const med = { durationDays: Number.isInteger(m.durationDays) && m.durationDays > 0 ? m.durationDays : null };
    for (const f of FIELDS) med[f] = String(m[f] ?? '').trim() || 'Unknown';
    med.uncertain = [...FIELDS.filter(f => /^unknown$/i.test(med[f])), ...(med.durationDays ? [] : ['durationDays'])];
    return med;
  });
}

// ---- routes ----
const routes = [];
const route = (method, p, auth, fn) => routes.push({ method, auth, fn, re: new RegExp('^' + p.replace(/:\w+/g, '([^/]+)') + '$') });
const str = v => String(v ?? '').trim();
const pub = u => ({ id: u.id, name: u.name, email: u.email });

route('POST', '/api/register', false, ({ body }) => {
  const email = str(body.email).toLowerCase(), name = str(body.name);
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || str(body.password).length < 6) throw new HttpError(400, 'Enter a name, a valid email and a password of at least 6 characters.');
  if (db.users.some(u => u.email === email)) throw new HttpError(409, 'This email is already registered.');
  const u = { id: crypto.randomUUID(), name, email, password: hash(body.password), role: 'patient', createdAt: new Date().toISOString() };
  db.users.push(u); save();
  return { token: sign(u.id), user: pub(u) };
});
route('POST', '/api/login', false, ({ body }) => {
  const u = db.users.find(x => x.email === str(body.email).toLowerCase());
  if (!u || !checkPw(str(body.password), u.password)) throw new HttpError(401, 'Incorrect email or password.');
  return { token: sign(u.id), user: pub(u) };
});
route('GET', '/api/me', true, ({ uid }) => {
  const user = db.users.find(u => u.id === uid);
  if (!user) throw new HttpError(401, 'Please log in again.');
  return { user: pub(user) };
});

route('POST', '/api/extract', true, async ({ uid, body }) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(str(body.image));
  if (!m) throw new HttpError(400, 'Unsupported file. Please upload a JPG, PNG or WebP image.');
  const medicines = await extract(m[1], m[2]);
  const id = crypto.randomUUID(), ext = m[1].split('/')[1];
  const dir = path.join(root, 'server', 'uploads', uid); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.${ext}`), Buffer.from(m[2], 'base64'));
  db.prescriptions.push({ id, userId: uid, file: `${id}.${ext}`, createdAt: new Date().toISOString() }); save();
  return { prescriptionId: id, medicines };
});

// Date-only values are calendar dates in India; keep them timezone-neutral (UTC midnight).
const parseDay = d => new Date(`${d}T00:00:00.000Z`);
function cleanMed(m, uid, i, extra = {}) {
  const med = { id: crypto.randomUUID(), userId: uid, name: str(m.name), strength: str(m.strength), dose: str(m.dose), frequency: str(m.frequency), timing: str(m.timing), instructions: str(m.instructions), durationDays: Number(m.durationDays), ...extra };
  if (!med.name || /^unknown$/i.test(med.name)) throw new HttpError(400, `Medicine ${i + 1}: enter the medicine name.`);
  if (!timesFor(med.frequency, med.timing)) throw new HttpError(400, `${med.name}: frequency "${med.frequency}" is not understood. Use e.g. "twice daily", "TDS" or "1-0-1".`);
  if (!Number.isInteger(med.durationDays) || med.durationDays < 1 || med.durationDays > 365) throw new HttpError(400, `${med.name}: enter the number of days (1-365).`);
  if ('startDate' in med && (!/^\d{4}-\d{2}-\d{2}$/.test(med.startDate) || isNaN(parseDay(med.startDate)) || med.startDate < dayKey(new Date()))) throw new HttpError(400, `${med.name}: choose a start date of today or later.`);
  return med;
}
route('POST', '/api/medications', true, ({ uid, body }) => {
  const items = Array.isArray(body.medications) ? body.medications : [];
  if (!items.length) throw new HttpError(400, 'No medicines to save.');
  const clean = items.map((m, i) => cleanMed(m, uid, i, { sourcePrescription: str(body.prescriptionId) || null, startDate: str(m.startDate) || dayKey(new Date()), createdAt: new Date().toISOString() }));
  for (const med of clean) { db.medications.push(med); db.doses.push(...makeDoses(med, parseDay(med.startDate)).map(d => ({ id: crypto.randomUUID(), ...d }))); }
  save();
  return { saved: clean.length };
});
// Edit: past doses/history are kept; future untaken doses are regenerated from the new settings.
route('PUT', '/api/medications/:id', true, ({ uid, params, body }) => {
  const med = db.medications.find(x => x.id === params[0] && x.userId === uid);
  if (!med) throw new HttpError(404, 'Medicine not found.');
  const { id, userId, ...fields } = cleanMed(body, uid, 0);
  Object.assign(med, fields, { updatedAt: new Date().toISOString() });
  const now = new Date();
  db.doses = db.doses.filter(d => d.medicationId !== med.id || d.takenAt || new Date(d.scheduledAt) <= now);
  const have = new Set(db.doses.filter(d => d.medicationId === med.id).map(d => d.scheduledAt));
  db.doses.push(...makeDoses(med, parseDay(med.startDate)).filter(d => new Date(d.scheduledAt) > now && !have.has(d.scheduledAt)).map(d => ({ id: crypto.randomUUID(), ...d })));
  save(); return { ok: true };
});
route('GET', '/api/medications', true, ({ uid }) => ({ medications: db.medications.filter(m => m.userId === uid) }));
route('DELETE', '/api/medications/:id', true, ({ uid, params }) => {
  const m = db.medications.find(x => x.id === params[0] && x.userId === uid);
  if (!m) throw new HttpError(404, 'Medicine not found.');
  db.medications = db.medications.filter(x => x !== m);
  db.doses = db.doses.filter(d => d.medicationId !== m.id || d.takenAt || new Date(d.scheduledAt) <= new Date()); // keep history
  save(); return { ok: true };
});

function report(uid) {
  const now = new Date(), meds = db.medications.filter(m => m.userId === uid), by = Object.fromEntries(meds.map(m => [m.id, m]));
  const mine = db.doses.filter(d => d.userId === uid).map(d => ({ ...d, status: statusOf(d, now), name: by[d.medicationId]?.name || 'Removed medicine', dose: by[d.medicationId]?.dose || '', timing: by[d.medicationId]?.timing || '' })).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const onDay = day => mine.filter(d => dayKey(new Date(d.scheduledAt)) === dayKey(day));
  const week = [6, 5, 4, 3, 2, 1, 0].map(i => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i), ds = onDay(day);
    return { date: dayKey(day), label: day.toLocaleDateString('en', { weekday: 'short' }), adherence: adherence(ds, now), taken: ds.filter(d => d.status === 'taken' || d.status === 'delayed').length, missed: ds.filter(d => d.status === 'missed').length };
  });
  const resolved = mine.filter(d => ['taken', 'delayed', 'missed'].includes(d.status)).reverse();
  return { today: onDay(now), upcoming: mine.filter(d => d.status === 'upcoming').slice(0, 3), missed: resolved.filter(d => d.status === 'missed'), history: resolved, week, medications: meds, adherenceOverall: adherence(mine, now), adherenceToday: adherence(onDay(now), now) };
}
route('GET', '/api/summary', true, ({ uid }) => report(uid));

// Caregiver: a patient grants read-only access to another registered user; only the caregiver (and the patient) can see the link.
const person = (u, id = u.id) => ({ id, name: u.name, email: u.email });
route('GET', '/api/caregivers', true, ({ uid }) => ({ caregivers: db.caregiverRelationships.filter(r => r.patientId === uid).map(r => person(db.users.find(u => u.id === r.caregiverId), r.id)) }));
route('POST', '/api/caregivers', true, ({ uid, body }) => {
  const c = db.users.find(u => u.email === str(body.email).toLowerCase());
  if (!c) throw new HttpError(404, 'No registered user with that email. Ask them to register first.');
  if (c.id === uid) throw new HttpError(400, 'You cannot add yourself as your own caregiver.');
  if (db.caregiverRelationships.some(r => r.patientId === uid && r.caregiverId === c.id)) throw new HttpError(409, 'This caregiver already has access.');
  db.caregiverRelationships.push({ id: crypto.randomUUID(), patientId: uid, caregiverId: c.id, createdAt: new Date().toISOString() }); save();
  return { ok: true };
});
route('DELETE', '/api/caregivers/:id', true, ({ uid, params }) => {
  const r = db.caregiverRelationships.find(x => x.id === params[0] && x.patientId === uid);
  if (!r) throw new HttpError(404, 'Caregiver not found.');
  db.caregiverRelationships = db.caregiverRelationships.filter(x => x !== r); save(); return { ok: true };
});
route('GET', '/api/patients', true, ({ uid }) => ({ patients: db.caregiverRelationships.filter(r => r.caregiverId === uid).map(r => person(db.users.find(u => u.id === r.patientId))) }));
route('GET', '/api/patients/:id/report', true, ({ uid, params }) => {
  if (!db.caregiverRelationships.some(r => r.patientId === params[0] && r.caregiverId === uid)) throw new HttpError(403, 'You do not have access to this patient.');
  return { patient: person(db.users.find(u => u.id === params[0])), ...report(params[0]) };
});
route('POST', '/api/doses/:id/taken', true, ({ uid, params }) => {
  const d = db.doses.find(x => x.id === params[0] && x.userId === uid);
  if (!d) throw new HttpError(404, 'Dose not found.');
  d.takenAt = d.takenAt || new Date().toISOString(); save(); return { status: statusOf(d) };
});

// ---- http server (+ serves the built frontend from /dist) ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const readBody = req => new Promise((ok, no) => { let n = 0; const c = []; req.on('data', x => { n += x.length; if (n > 12e6) { no(new HttpError(413, 'Image is too large.')); req.destroy(); } else c.push(x); }); req.on('end', () => { try { ok(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch { no(new HttpError(400, 'Invalid request.')); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (!url.pathname.startsWith('/api/')) {
      let f = path.join(root, 'dist', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'dist', 'index.html');
      if (!fs.existsSync(f)) return send(404, { error: 'Run "npm run build" first, or use "npm run dev".' });
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res);
    }
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re); if (!m) continue;
      const uid = verify((req.headers.authorization || '').slice(7));
      if (r.auth && !uid) throw new HttpError(401, 'Please log in again.');
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      return send(200, await r.fn({ uid, body, params: m.slice(1) }));
    }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong. Please try again.' });
  }
}).listen(PORT, () => console.log(`MediSync server on http://localhost:${PORT}`));
