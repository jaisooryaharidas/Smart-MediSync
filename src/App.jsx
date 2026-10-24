import { useEffect, useState, useCallback } from 'react';
import { api, setToken, getToken, readImage } from './api.js';

const DISCLAIMER = 'AI-extracted prescription information should be verified by the user/healthcare professional before use.';
const fmt = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDate = iso => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

function Msg({ kind = 'error', children }) { return children ? <p className={'msg ' + kind} role="alert">{children}</p> : null; }

/* ---------- Landing + Auth ---------- */
function Landing({ onAuth }) {
  const [mode, setMode] = useState(null); // null = landing, 'login' | 'register'
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await api('/' + mode, f); setToken(r.token); onAuth(r.user); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  if (!mode) return (
    <main className="landing">
      <h1>Smart MediSync ID System</h1>
      <p>Upload a prescription. AI reads it, you verify it, and we build your medicine schedule, reminders and adherence tracking.</p>
      <ul><li>No manual reminder setup</li><li>You always confirm AI results</li><li>Track taken and missed doses</li></ul>
      <button onClick={() => setMode('register')}>Get Started</button> <button className="ghost" onClick={() => setMode('login')}>Login</button>
    </main>
  );
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <main className="landing">
      <form className="card" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Login' : 'Create account'}</h2>
        {mode === 'register' && <label>Name<input value={f.name} onChange={set('name')} required /></label>}
        <label>Email<input type="email" value={f.email} onChange={set('email')} required /></label>
        <label>Password<input type="password" minLength={6} value={f.password} onChange={set('password')} required /></label>
        <Msg>{err}</Msg>
        <button disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Login' : 'Register'}</button>
        <button type="button" className="link" onClick={() => { setErr(''); setMode(mode === 'login' ? 'register' : 'login'); }}>
          {mode === 'login' ? 'New here? Register' : 'Have an account? Login'}
        </button>
      </form>
    </main>
  );
}

/* ---------- Shared pieces ---------- */
const pct = v => (v == null ? '—' : v + '%');
const tagLabel = d => (d.status === 'delayed' ? 'taken late' : d.status);

function DoseRow({ d, onTaken, showDate }) {
  return (
    <div className="row">
      <div><b>{d.name}</b> <span className="muted">{d.dose} {d.timing && d.timing !== 'Unknown' && '· ' + d.timing}</span><br /><small>{showDate && fmtDate(d.scheduledAt) + ' '}{fmt(d.scheduledAt)}</small></div>
      <div><span className={'tag ' + d.status}>{tagLabel(d)}</span>{' '}
        {onTaken && !d.takenAt && (d.status === 'due' || d.status === 'missed') && <button onClick={() => onTaken(d.id)}>{d.status === 'missed' ? 'Log as taken late' : 'Mark taken'}</button>}
      </div>
    </div>
  );
}

// Simple 7-day bar chart: bar height = adherence % for that day.
function Chart({ week }) {
  return (
    <div className="chart" role="img" aria-label={'Adherence over the last 7 days: ' + week.map(d => `${d.label} ${pct(d.adherence)}`).join(', ')}>
      {week.map(d => (
        <div className="bar" key={d.date} title={`${d.taken} taken, ${d.missed} missed`}>
          <small>{pct(d.adherence)}</small>
          <div className="track"><div className={'fill' + (d.adherence != null && d.adherence < 70 ? ' low' : '')} style={{ height: (d.adherence ?? 0) + '%' }} /></div>
          <small>{d.label}</small>
        </div>
      ))}
    </div>
  );
}

function Stats({ s }) {
  return (
    <section className="grid">
      <div className="card stat"><b>{pct(s.adherenceOverall)}</b><span>Overall adherence</span></div>
      <div className="card stat"><b>{pct(s.adherenceToday)}</b><span>Today</span></div>
      <div className="card stat"><b>{s.missed.length}</b><span>Missed doses</span></div>
    </section>
  );
}

// Browser notifications (free, built in) + in-app banner as the fallback. Works while the page is open.
function useReminders(doses) {
  const [now, setNow] = useState(Date.now());
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  const age = d => now - new Date(d.scheduledAt);
  const due = doses.filter(d => !d.takenAt && age(d) >= 0 && age(d) <= 120 * 60000);
  const missed = doses.filter(d => !d.takenAt && age(d) > 120 * 60000 && age(d) < 6 * 3600000);
  useEffect(() => {
    if (perm !== 'granted') return;
    let seen = []; try { seen = JSON.parse(localStorage.getItem('notified') || '[]'); } catch {}
    const ping = (key, title, body) => { if (seen.includes(key)) return; seen.push(key); try { new Notification(title, { body }); } catch { /* some mobile browsers block this; the in-app banner still shows */ } };
    due.forEach(d => ping('d' + d.id, 'Time for ' + d.name, `${d.dose} ${d.timing !== 'Unknown' ? d.timing : ''}`.trim()));
    missed.forEach(d => ping('m' + d.id, 'Missed dose: ' + d.name, 'Scheduled at ' + fmt(d.scheduledAt)));
    localStorage.setItem('notified', JSON.stringify(seen.slice(-200)));
  }, [now, perm, doses]); // eslint-disable-line react-hooks/exhaustive-deps
  const enable = async () => setPerm(await Notification.requestPermission());
  return { due, perm, enable };
}

/* ---------- Dashboard ---------- */
function EditMed({ m, onDone }) {
  const [f, setF] = useState({ ...m }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => { setErr(''); setBusy(true); try { await api('/medications/' + m.id, f, 'PUT'); onDone(true); } catch (x) { setErr(x.message); } finally { setBusy(false); } };
  return (
    <div className="card inner">
      {FIELDS.map(([k, label]) => <label key={k}>{label}<input value={f[k] || ''} onChange={e => setF({ ...f, [k]: e.target.value })} /></label>)}
      <label>Days<input type="number" min="1" max="365" value={f.durationDays ?? ''} onChange={e => setF({ ...f, durationDays: e.target.value })} /></label>
      <p className="muted small">Saving regenerates future doses only; past history is kept.</p>
      <Msg>{err}</Msg>
      <button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button> <button className="ghost" onClick={() => onDone(false)}>Cancel</button>
    </div>
  );
}

const todayStr = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
function ManualMed({ onDone }) {
  const [f, setF] = useState({ name: '', strength: '', dose: '', frequency: '', timing: '', startDate: todayStr(), durationDays: '', instructions: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const save = async e => {
    e.preventDefault(); setErr('');
    if (!f.name.trim() || !f.dose.trim() || !f.frequency.trim() || !f.startDate || !f.durationDays) return setErr('Please fill in all required fields (marked *).');
    setBusy(true);
    try { await api('/medications', { medications: [f] }); onDone(true); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <form className="card inner" onSubmit={save}>
      <label>Medicine name *<input value={f.name} onChange={set('name')} required /></label>
      <label>Strength<input value={f.strength} onChange={set('strength')} placeholder="e.g. 500 mg" /></label>
      <label>Dose *<input value={f.dose} onChange={set('dose')} placeholder="e.g. 1 tablet" required /></label>
      <label>Frequency *<input value={f.frequency} onChange={set('frequency')} placeholder="e.g. twice daily, TDS, 1-0-1" required /></label>
      <label>Timing<input value={f.timing} onChange={set('timing')} placeholder="e.g. after food, at night" /></label>
      <label>Start date *<input type="date" min={todayStr()} value={f.startDate} onChange={set('startDate')} required /></label>
      <label>Duration (days) *<input type="number" min="1" max="365" value={f.durationDays} onChange={set('durationDays')} required /></label>
      <label>Instructions<input value={f.instructions} onChange={set('instructions')} /></label>
      <Msg>{err}</Msg>
      <button disabled={busy}>{busy ? 'Saving…' : 'Save medicine'}</button> <button type="button" className="ghost" onClick={() => onDone(false)}>Cancel</button>
    </form>
  );
}

function Dashboard({ summary, reload, goUpload, onTaken }) {
  const [err, setErr] = useState(''); const [editing, setEditing] = useState(null); const [adding, setAdding] = useState(false);
  const remove = async m => { if (confirm(`Remove ${m.name}? Future doses will be deleted; history is kept.`)) try { await api(`/medications/${m.id}`, null, 'DELETE'); reload(); } catch (x) { setErr(x.message); } };
  return (
    <>
      <Msg>{err}</Msg>
      <Stats s={summary} />
      <section className="card"><button onClick={goUpload}>Upload prescription</button></section>
      <section className="card"><h2>Today's medications</h2>
        {!summary.today.length && <p className="muted">Nothing scheduled today. Upload a prescription to get started.</p>}
        {summary.today.map(d => <DoseRow key={d.id} d={d} onTaken={onTaken} />)}
      </section>
      {summary.missed.length > 0 && <section className="card"><h2>Missed doses</h2>
        {summary.missed.slice(0, 10).map(d => <DoseRow key={d.id} d={d} onTaken={onTaken} showDate />)}
      </section>}
      <section className="card"><h2>Upcoming</h2>
        {!summary.upcoming.length ? <p className="muted">No upcoming doses.</p> : summary.upcoming.map(d => <div className="row" key={d.id}><span>{d.name}</span><small>{fmtDate(d.scheduledAt)} {fmt(d.scheduledAt)}</small></div>)}
      </section>
      <section className="card"><h2>Medications</h2>
        {adding ? <ManualMed onDone={ok => { setAdding(false); if (ok) reload(); }} /> : <button className="ghost" onClick={() => setAdding(true)}>Add Medicine Manually</button>}
        {!summary.medications.length && <p className="muted">No medications yet.</p>}
        {summary.medications.map(m => editing === m.id
          ? <EditMed key={m.id} m={m} onDone={ok => { setEditing(null); if (ok) reload(); }} />
          : <div className="row" key={m.id}><div><b>{m.name}</b> {m.strength !== 'Unknown' && m.strength}<br /><small>{m.dose} · {m.frequency} · {m.timing} · {m.durationDays} days</small></div>
              <div><button className="ghost" onClick={() => setEditing(m.id)}>Edit</button> <button className="ghost" onClick={() => remove(m)}>Remove</button></div></div>)}
      </section>
      <section className="card"><h2>Recent history</h2>
        {!summary.history.length ? <p className="muted">No history yet.</p> : summary.history.slice(0, 5).map(d => <DoseRow key={d.id} d={d} showDate />)}
      </section>
    </>
  );
}

/* ---------- History + 7-day chart ---------- */
function History({ summary }) {
  const [f, setF] = useState('all');
  const rows = summary.history.filter(d => f === 'all' || (f === 'taken' ? d.status === 'taken' || d.status === 'delayed' : d.status === f));
  return (
    <>
      <Stats s={summary} />
      <section className="card"><h2>Last 7 days</h2><Chart week={summary.week} /></section>
      <section className="card"><h2>Medication history</h2>
        <label>Show<select value={f} onChange={e => setF(e.target.value)}><option value="all">All</option><option value="taken">Taken (incl. late)</option><option value="missed">Missed</option></select></label>
        {!rows.length ? <p className="muted">No records yet.</p> : rows.map(d => <DoseRow key={d.id} d={d} showDate />)}
      </section>
    </>
  );
}

/* ---------- Caregiver (read-only access, granted by the patient) ---------- */
function Caregiver() {
  const [mine, setMine] = useState([]); const [patients, setPatients] = useState([]); const [email, setEmail] = useState('');
  const [view, setView] = useState(null); const [err, setErr] = useState('');
  const load = useCallback(async () => { try { const [a, b] = await Promise.all([api('/caregivers'), api('/patients')]); setMine(a.caregivers); setPatients(b.patients); } catch (x) { setErr(x.message); } }, []);
  useEffect(() => { load(); }, [load]);
  const run = async fn => { setErr(''); try { await fn(); } catch (x) { setErr(x.message); } };
  const add = e => { e.preventDefault(); run(async () => { await api('/caregivers', { email }); setEmail(''); load(); }); };
  const revoke = id => run(async () => { await api('/caregivers/' + id, null, 'DELETE'); load(); });
  const open = id => run(async () => setView(await api(`/patients/${id}/report`)));
  return (
    <>
      <Msg>{err}</Msg>
      <section className="card"><h2>My caregivers</h2>
        <p className="muted">A caregiver can view your schedule, dose status, missed doses and adherence — they cannot change anything. They must have a MediSync account.</p>
        <form onSubmit={add}><label>Caregiver's email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required /></label><button>Give access</button></form>
        {mine.map(c => <div className="row" key={c.id}><span>{c.name} <small>{c.email}</small></span><button className="ghost" onClick={() => revoke(c.id)}>Revoke</button></div>)}
      </section>
      <section className="card"><h2>Patients I monitor</h2>
        {!patients.length && <p className="muted">No one has given you access yet.</p>}
        {patients.map(p => <div className="row" key={p.id}><span>{p.name}</span><button className="ghost" onClick={() => open(p.id)}>View</button></div>)}
      </section>
      {view && <section className="card"><h2>{view.patient.name} <small>(read-only)</small></h2>
        <Stats s={view} />
        <h3>Last 7 days</h3><Chart week={view.week} />
        <h3>Today</h3>{!view.today.length ? <p className="muted">Nothing scheduled today.</p> : view.today.map(d => <DoseRow key={d.id} d={d} />)}
        <h3>Missed doses</h3>{!view.missed.length ? <p className="muted">None.</p> : view.missed.slice(0, 10).map(d => <DoseRow key={d.id} d={d} showDate />)}
        <h3>Medication schedule</h3>{view.medications.map(m => <div className="row" key={m.id}><span><b>{m.name}</b> {m.strength !== 'Unknown' && m.strength}</span><small>{m.dose} · {m.frequency} · {m.timing}</small></div>)}
        <button className="ghost" onClick={() => open(view.patient.id)}>Refresh</button>
      </section>}
    </>
  );
}

/* ---------- Prescription upload -> review -> confirm ---------- */
const FIELDS = [['name', 'Medicine'], ['strength', 'Strength'], ['dose', 'Dose'], ['frequency', 'Frequency'], ['timing', 'Timing'], ['instructions', 'Instructions']];
const blank = () => ({ name: '', strength: '', dose: '', frequency: '', timing: '', instructions: '', durationDays: 7, uncertain: ['name'] });

function Upload({ done }) {
  const [img, setImg] = useState(null); const [rx, setRx] = useState(null); // rx = { prescriptionId, medicines }
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const pick = async e => {
    const file = e.target.files[0]; setErr(''); setRx(null); if (!file) return;
    try { setImg(await readImage(file)); } catch (x) { setImg(null); setErr(x.message); }
  };
  const process = async () => {
    setErr(''); setBusy(true);
    try { const r = await api('/extract', { image: img }); setRx(r.medicines.length ? r : { ...r, medicines: [blank()] }); if (!r.medicines.length) setErr('No medicines were detected. Please enter them manually below.'); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const edit = (i, k, v) => setRx({ ...rx, medicines: rx.medicines.map((m, j) => j === i ? { ...m, [k]: v, uncertain: m.uncertain.filter(u => u !== k) } : m) });
  const confirm = async () => {
    setErr(''); setBusy(true);
    try { await api('/medications', { prescriptionId: rx.prescriptionId, medications: rx.medicines }); done(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <h2>Upload prescription</h2>
      {!rx && <>
        <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={pick} />
        {img && <><img className="preview" src={img} alt="Prescription preview" /><br /><button disabled={busy} onClick={process}>{busy ? 'Reading prescription…' : 'Process prescription'}</button> <button className="ghost" onClick={() => { setImg(null); setErr(''); }}>Remove</button></>}
        <p className="muted">Tip: use a clear, well-lit photo. Prefer sample prescriptions without real personal details — images are sent to Google's free AI API.</p>
      </>}
      {rx && <>
        <Msg kind="warn">{DISCLAIMER} Highlighted fields could not be read — please check them.</Msg>
        {rx.medicines.map((m, i) => (
          <div className="card inner" key={i}>
            {FIELDS.map(([k, label]) => <label key={k} className={m.uncertain.includes(k) ? 'flag' : ''}>{label}<input value={m[k]} onChange={e => edit(i, k, e.target.value)} /></label>)}
            <label className={m.uncertain.includes('durationDays') ? 'flag' : ''}>Days<input type="number" min="1" max="365" value={m.durationDays ?? ''} onChange={e => edit(i, 'durationDays', e.target.value)} /></label>
            <button className="ghost" onClick={() => setRx({ ...rx, medicines: rx.medicines.filter((_, j) => j !== i) })}>Remove this medicine</button>
          </div>
        ))}
        <button disabled={busy || !rx.medicines.length} onClick={confirm}>{busy ? 'Saving…' : 'Confirm and create schedule'}</button> <button className="ghost" onClick={() => setRx(null)}>Back</button>
      </>}
      <Msg>{err}</Msg>
    </section>
  );
}

/* ---------- App shell ---------- */
const PAGES = [['dashboard', 'Dashboard'], ['upload', 'Prescriptions'], ['history', 'History'], ['caregiver', 'Caregiver']];
export default function App() {
  const [user, setUser] = useState(null); const [ready, setReady] = useState(!getToken());
  const [page, setPage] = useState('dashboard');
  const [summary, setSummary] = useState(null); const [err, setErr] = useState('');
  const reload = useCallback(async () => {
    try { setSummary(await api('/summary')); setErr(''); } catch (x) { setErr(x.message); }
  }, []);
  useEffect(() => { if (getToken()) api('/me').then(r => setUser(r.user)).catch(() => setToken(null)).finally(() => setReady(true)); }, []);
  useEffect(() => { if (user) { reload(); const t = setInterval(reload, 60000); return () => clearInterval(t); } }, [user, reload]);
  const doses = summary ? [...new Map([...summary.today, ...summary.missed].map(d => [d.id, d])).values()] : [];
  const { due, perm, enable } = useReminders(doses);
  const mark = async id => { try { await api(`/doses/${id}/taken`, {}); reload(); } catch (x) { setErr(x.message); } };
  if (!ready) return <p className="muted center">Loading…</p>;
  if (!user) return <Landing onAuth={setUser} />;
  return (
    <div className="app">
      <header>
        <b>Smart MediSync ID</b>
        <nav>
          {PAGES.map(([k, label]) => <button key={k} className={page === k ? '' : 'ghost'} onClick={() => setPage(k)}>{label}</button>)}
          <button className="ghost" onClick={() => { setToken(null); setUser(null); setSummary(null); setPage('dashboard'); }}>Logout ({user.name})</button>
        </nav>
      </header>
      <main>
        <Msg>{err}</Msg>
        {due.length > 0 && <div className="card banner" role="status"><b>Time to take your medicine</b>
          {due.map(d => <div className="row" key={d.id}><span>{d.name} {d.dose} <small>({fmt(d.scheduledAt)})</small></span><button onClick={() => mark(d.id)}>Mark taken</button></div>)}</div>}
        {perm === 'default' && <p className="muted small">Want phone/desktop alerts? <button className="link" onClick={enable}>Enable browser reminders</button> (they work while this page stays open).</p>}
        {(perm === 'denied' || perm === 'unsupported') && <p className="muted small">Browser notifications are unavailable here — reminders will appear on this page while it is open.</p>}
        {page === 'upload' ? <Upload done={() => { reload(); setPage('dashboard'); }} />
          : page === 'caregiver' ? <Caregiver />
          : !summary ? (!err && <p className="muted">Loading…</p>)
          : page === 'history' ? <History summary={summary} />
          : <Dashboard summary={summary} reload={reload} goUpload={() => setPage('upload')} onTaken={mark} />}
        <p className="muted small">{DISCLAIMER}</p>
      </main>
    </div>
  );
}
