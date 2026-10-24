import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4300 + Math.floor(Math.random() * 500), base = `http://localhost:${PORT}/api`;
let proc, dir;
const call = async (p, token, body, method) => {
  const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const reg = async n => (await call('/register', null, { name: n, email: `${n}@x.com`, password: 'secret1' })).data;
const med = { name: 'Paracetamol', strength: '500 mg', dose: '1 tablet', frequency: 'twice daily', timing: 'after food', durationDays: 3 };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medisync-'));
  proc = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, DATA_DIR: dir, AUTH_SECRET: 'test', GEMINI_API_KEY: '' }, stdio: 'pipe' });
  await new Promise(ok => proc.stdout.on('data', ok));
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('auth, medication CRUD, summary', async () => {
  const a = await reg('alice');
  assert.equal(a.user.password, undefined);
  assert.equal((await call('/summary')).status, 401);
  assert.equal((await call('/login', null, { email: 'alice@x.com', password: 'bad' })).status, 401);
  assert.equal((await call('/medications', a.token, { medications: [{ ...med, frequency: 'Unknown' }] })).status, 400);
  assert.equal((await call('/medications', a.token, { medications: [med] })).data.saved, 1);
  let s = (await call('/summary', a.token)).data;
  assert.equal(s.week.length, 7);
  assert.equal(s.medications.length, 1);
  // edit: change to once daily -> future doses regenerated, schedule still valid
  const id = s.medications[0].id;
  assert.equal((await call('/medications/' + id, a.token, { ...med, frequency: 'once daily', durationDays: 2 }, 'PUT')).status, 200);
  assert.equal((await call('/medications/' + id, a.token, { ...med, frequency: 'nonsense' }, 'PUT')).status, 400);
  s = (await call('/summary', a.token)).data;
  assert.equal(s.medications[0].frequency, 'once daily');
  // mark a past dose taken late -> shows in history as delayed
  const missed = s.missed[0] || s.today.find(d => d.status === 'missed' || d.status === 'due');
  if (missed) {
    await call(`/doses/${missed.id}/taken`, a.token, {});
    assert.ok(['taken', 'delayed'].includes((await call('/summary', a.token)).data.history.find(d => d.id === missed.id).status));
  }
});

test('users cannot touch each other\'s data', async () => {
  const a = await reg('pat'), b = await reg('other');
  await call('/medications', a.token, { medications: [med] });
  const id = (await call('/summary', a.token)).data.medications[0].id;
  assert.equal((await call('/medications/' + id, b.token, med, 'PUT')).status, 404);
  assert.equal((await call('/medications/' + id, b.token, null, 'DELETE')).status, 404);
  const dose = (await call('/summary', a.token)).data.today[0] || { id: 'x' };
  assert.equal((await call(`/doses/${dose.id}/taken`, b.token, {})).status, 404);
  assert.equal((await call(`/patients/${a.user.id}/report`, b.token)).status, 403);
});

test('caregiver access is explicit, read-only and revocable', async () => {
  const p = await reg('patient2'), c = await reg('carer'), x = await reg('stranger');
  await call('/medications', p.token, { medications: [med] });
  assert.equal((await call('/caregivers', p.token, { email: 'nobody@x.com' })).status, 404);
  assert.equal((await call('/caregivers', p.token, { email: 'patient2@x.com' })).status, 400);
  assert.equal((await call('/caregivers', p.token, { email: 'carer@x.com' })).status, 200);
  assert.equal((await call('/caregivers', p.token, { email: 'carer@x.com' })).status, 409);
  const list = (await call('/patients', c.token)).data.patients;
  assert.equal(list[0].id, p.user.id);
  const rep = await call(`/patients/${p.user.id}/report`, c.token);
  assert.equal(rep.status, 200);
  assert.equal(rep.data.medications.length, 1);
  assert.equal(rep.data.patient.password, undefined);
  assert.equal((await call(`/patients/${p.user.id}/report`, x.token)).status, 403);
  assert.equal((await call('/patients', x.token)).data.patients.length, 0);
  // caregiver cannot edit the patient's medication
  const medId = rep.data.medications[0].id;
  assert.equal((await call('/medications/' + medId, c.token, med, 'PUT')).status, 404);
  // revoke
  const rel = (await call('/caregivers', p.token)).data.caregivers[0].id;
  assert.equal((await call('/caregivers/' + rel, p.token, null, 'DELETE')).status, 200);
  assert.equal((await call(`/patients/${p.user.id}/report`, c.token)).status, 403);
});

test('extract rejects bad files and reports missing AI key without leaking it', async () => {
  const a = await reg('uploader');
  assert.equal((await call('/extract', a.token, { image: 'data:application/pdf;base64,AAAA' })).status, 400);
  const r = await call('/extract', a.token, { image: 'data:image/png;base64,AAAA' });
  assert.equal(r.status, 503);
});

test('manual medicine: start date, same schedule logic, no AI key needed', async () => {
  const a = await reg('manual');
  const ymd = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
  const post = startDate => call('/medications', a.token, { medications: [{ ...med, startDate, durationDays: 2 }] });
  assert.equal((await post(ymd(-1))).status, 400);        // past start date rejected
  assert.equal((await post('not-a-date')).status, 400);
  assert.equal((await post(ymd(3))).status, 200);          // future start accepted
  const s = (await call('/summary', a.token)).data;
  assert.equal(s.medications[0].startDate, ymd(3));
  assert.equal(s.medications[0].sourcePrescription, null);
  assert.equal(s.today.length, 0);                         // nothing today
  assert.equal(s.upcoming.length, 3);                      // 2 days x 2 doses = 4 future doses, first 3 shown
  assert.ok(s.upcoming.every(d => d.scheduledAt.length && new Date(d.scheduledAt) > new Date()));
  assert.equal(s.upcoming[0].name, 'Paracetamol');
});
