// End-to-end API checks against two throwaway servers (mock provider, and "ai" provider with the AI service down).
// Needs Postgres + Redis from .env. Reseeds the database.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { readCsv, DATA } = require('../src/rules/files');

const root = path.join(__dirname, '..');
execFileSync('node', ['prisma/seed.js'], { cwd: root, stdio: 'ignore' });

const servers = [];
function server(port, extra) {
  const p = spawn('node', ['src/server.js'], { cwd: root, env: { ...process.env, DEMO_APPLICATION_DATE: '2026-03-04', PORT: String(port), QUEUE_PREFIX: `t${port}`, CORE_BANKING_URL: `http://localhost:${port}/internal/core-banking`, ...extra }, stdio: ['ignore', 'ignore', 'inherit'] });
  servers.push(p);
  return `http://localhost:${port}`;
}
const MOCK = server(4101, { EXTRACTION_PROVIDER: 'mock' });
const AIDOWN = server(4102, { EXTRACTION_PROVIDER: 'ai', AI_SERVICE_URL: 'http://127.0.0.1:9' });
const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const AI = server(4103, { EXTRACTION_PROVIDER: 'ai', AI_SERVICE_URL: AI_URL });

const csv = (n) => readCsv(path.join(DATA, `case_02_${n}_V1.0.csv`));
const apps = Object.fromEntries([...csv('applications_sample'), ...csv('applications_eval')].map((a) => [a.application_id, a]));
const docs = [...csv('documents_sample'), ...csv('documents_eval')];
const texts = {};
for (const n of ['sample', 'eval']) for (const l of fs.readFileSync(path.join(DATA, `case_02_document_text_${n}_V1.0.jsonl`), 'utf8').trim().split('\n')) { const j = JSON.parse(l); texts[j.doc_id] = j.text; }

async function call(base, method, url, token, body, raw) {
  const res = await fetch(base + url, { method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && !raw && { 'content-type': 'application/json' }) }, body: raw ? body : body && JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}
const login = async (base, email) => (await call(base, 'POST', '/auth/login', null, { email, password: 'Password@123' })).body.token;

function form(files) {
  const f = new FormData();
  for (const { name, content, type } of files) { f.append('files', new Blob([content]), name); f.append('declared_doc_type', type); }
  return f;
}
const packFiles = (appId) => docs.filter((d) => d.application_id === appId).map((d) => ({ name: d.file_name, content: texts[d.doc_id], type: d.declared_doc_type }));
const appBody = (id) => { const a = apps[id]; return { full_name: a.full_name, dob: a.dob, gender: a.gender, pan_number: a.pan_number, aadhaar_last4: a.aadhaar_last4, mobile: a.mobile, email: a.email, address: a.address, city: a.city, state: a.state, pincode: a.pincode, occupation_code: a.occupation_code, annual_income: a.annual_income, consent: true }; };

async function submit(base, token, id, files = packFiles(id)) {
  const c = await call(base, 'POST', '/applications', token, appBody(id));
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const u = await call(base, 'POST', `/applications/${c.body.id}/documents`, token, form(files), true);
  assert.equal(u.status, 201, JSON.stringify(u.body));
  return c.body.id;
}
async function settle(base, token, id) {
  for (let i = 0; i < 100; i++) {
    const r = await call(base, 'GET', `/applications/${id}`, token);
    if (!['EXTRACTING', 'SUBMITTED'].includes(r.body.status)) return r.body;
    await new Promise((s) => setTimeout(s, 150));
  }
  throw new Error('extraction did not finish for ' + id);
}
const check = (name, fn) => fn().then(() => console.log('ok  ', name), (e) => { console.log('FAIL', name, '\n    ', e.message); process.exitCode = 1; });

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(MOCK + '/health'); await fetch(AIDOWN + '/health'); break; } catch { await new Promise((s) => setTimeout(s, 200)); } }
  let [ap, of1, of2, ch] = await Promise.all(['applicant@test.com', 'officer@test.com', 'officer2@test.com', 'checker@test.com'].map((e) => login(MOCK, e)));

  await check('FR-1 applicant on officer route -> 403; others\' application -> 404', async () => {
    assert.equal((await call(MOCK, 'GET', '/review/queue', ap)).status, 403);
    assert.equal((await call(MOCK, 'GET', '/checker/queue', of1)).status, 403);
    const other = await login(MOCK, 'applicant2@test.com');
    assert.equal((await call(MOCK, 'GET', '/applications/A2000004', other)).status, 404);
    assert.equal((await call(MOCK, 'GET', '/applications/A2000004', ap)).status, 200);
    assert.equal((await call(MOCK, 'GET', '/applications/mine', null)).status, 401);
  });

  await check('FR-2 validation: 12-digit Aadhaar, bad PAN/mobile/pincode, future dob, no consent -> 422 with field names', async () => {
    const r = await call(MOCK, 'POST', '/applications', ap, { ...appBody('A2000001'), aadhaar_last4: '123456784821', pan_number: 'zzkps1234q', mobile: '5876500000', pincode: '012345', dob: '2999-01-01', consent: false });
    assert.equal(r.status, 422);
    assert.match(r.body.errors.aadhaar_last4, /last 4/);
    for (const k of ['pan_number', 'mobile', 'pincode', 'dob', 'consent']) assert.ok(r.body.errors[k], k);
  });

  await check('uploads: >1 MB txt, binary txt, .exe renamed .txt, .exe, <3 files rejected and nothing stored; same file twice -> one document', async () => {
    const id = (await call(MOCK, 'POST', '/applications', ap, appBody('A2000001'))).body.id;
    const good = packFiles('A2000001');
    const bad = [
      { name: 'big.txt', content: 'A'.repeat(5 * 1024 * 1024), type: 'PAN_CARD' },
      { name: 'bin.txt', content: Buffer.from([0xc3, 0x28, 0xa0, 0xa1]), type: 'PAN_CARD' },
      { name: 'setup.txt', content: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 0x90)]), type: 'PAN_CARD' },
      { name: 'setup.exe', content: 'hello', type: 'PAN_CARD' },
      { name: 'big.png', content: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5 * 1024 * 1024)]), type: 'PAN_CARD' },
    ];
    for (const b of bad) {
      const r = await call(MOCK, 'POST', `/applications/${id}/documents`, ap, form([...good.slice(0, 2), b]), true);
      assert.equal(r.status, 422, b.name + ' ' + JSON.stringify(r.body));
    }
    assert.equal((await call(MOCK, 'POST', `/applications/${id}/documents`, ap, form(good.slice(0, 2)), true)).status, 422);
    let detail = (await call(MOCK, 'GET', `/applications/${id}`, ap)).body;
    assert.equal(detail.documents.length, 0);
    const dup = [good[0], good[0], good[1], good[2]];
    const r = await call(MOCK, 'POST', `/applications/${id}/documents`, ap, form(dup), true);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    detail = (await call(MOCK, 'GET', `/applications/${id}`, ap)).body;
    assert.equal(detail.documents.length, 3);
  });

  const aiUp = await fetch(AI_URL + '/health').then((r) => r.ok, () => false);
  if (!aiUp) console.log('skip AI-provider checks: ai-service not reachable at', AI_URL);
  else await check('AI provider: A2000009 poor-scan PAN read correctly -> AUTO_APPROVED; injection doc -> OTHER; PNG goes through OCR', async () => {
    const t = await login(AI, 'applicant@test.com');
    const id = await submit(AI, t, 'A2000009');
    assert.equal((await settle(AI, t, id)).status, 'AUTO_APPROVED');
    const id2 = await submit(AI, t, 'A2100100');
    assert.equal((await settle(AI, t, id2)).status, 'IN_REVIEW');
    const o = await login(AI, 'officer@test.com');
    const rv = (await call(AI, 'GET', `/review/${id2}`, o)).body;
    assert.deepEqual(rv.application.reasonCodes, ['DOCUMENT_MISSING', 'DOCUMENT_TYPE_MISMATCH']);
    assert.ok(rv.documents.some((d) => d.classifiedDocType === 'OTHER' && d.fields.length === 0));
    assert.ok(rv.documents.every((d) => d.extractorVersion.startsWith('rules-')));
    const span = rv.documents[0].fields.find((f) => f.fieldName === 'pan_number');
    assert.equal(rv.documents[0].text.slice(span.sourceStart, span.sourceEnd), apps.A2100100.pan_number);
    assert.ok(rv.application.aiSummary.includes('D3000486') || rv.application.aiSummary.includes('Discrepancies'));
    // Image upload: PNG rendered by the AI test fixture (tests/fixtures/pan_A2000001.png) -> OCR -> extract
    const png = fs.readFileSync(path.join(root, '..', 'ai-service', 'tests', 'fixtures', 'pan_A2000001.png'));
    const files = packFiles('A2000001').map((f) => (f.type === 'PAN_CARD' ? { name: 'pan.png', content: png, type: 'PAN_CARD' } : f));
    const id3 = await submit(AI, t, 'A2000001', files);
    await settle(AI, t, id3);
    const rv3 = (await call(AI, 'GET', `/review/${id3}`, o)).body;
    const panDoc = rv3.documents.find((d) => d.mimeType === 'image/png');
    assert.ok(panDoc.text.includes('RAVI KUMAR SHARMA') && panDoc.ocrConfidence > 0.5, JSON.stringify(panDoc).slice(0, 300));
    assert.equal(panDoc.classifiedDocType, 'PAN_CARD');
    // Real OCR may misread a character (e.g. Q -> 0); a repaired value must then be below the 0.80 trust threshold.
    const pf = panDoc.fields.find((f) => f.fieldName === 'pan_number');
    assert.ok(pf.value === 'ZZKPS1234Q' || pf.confidence < 0.8, JSON.stringify(pf));
    assert.equal(panDoc.contentUrl, `/documents/${panDoc.id}/content`);
    const img = await fetch(AI + panDoc.contentUrl, { headers: { authorization: `Bearer ${o}` } });
    assert.equal(img.headers.get('content-type'), 'image/png');
  });

  execFileSync('node', ['prisma/seed.js'], { cwd: root, stdio: 'ignore' }); // AI check opened accounts; start clean
  [ap, of1, of2, ch] = await Promise.all(['applicant@test.com', 'officer@test.com', 'officer2@test.com', 'checker@test.com'].map((e) => login(MOCK, e)));
  await check('A2000004 upload -> IN_REVIEW, NAME_MISMATCH_MINOR 0.7647; applicant sees plain reason only', async () => {
    const id = await submit(MOCK, ap, 'A2000004');
    const s = await settle(MOCK, ap, id);
    assert.equal(s.status, 'IN_REVIEW');
    assert.ok(s.reasons[0].includes('differs slightly'));
    assert.ok(!JSON.stringify(s).includes('0.7647') && !JSON.stringify(s).includes('confidence'));
    const rv = (await call(MOCK, 'GET', `/review/${id}`, of1)).body;
    assert.deepEqual(rv.application.reasonCodes, ['NAME_MISMATCH_MINOR']);
    assert.equal(rv.application.nameMatchScore.toFixed(4), '0.7647');
  });

  await check('examples 9/11/12: correct PAN -> APPROVE, recommend, maker cannot check (403), checker approves -> account; 409 on race', async () => {
    const id = await submit(MOCK, ap, 'A2000009');
    assert.equal((await settle(MOCK, ap, id)).status, 'IN_REVIEW');
    let rv = (await call(MOCK, 'GET', `/review/${id}`, of1)).body;
    assert.deepEqual(rv.application.reasonCodes, ['LOW_EXTRACTION_CONFIDENCE']);
    const pan = rv.documents.find((d) => d.classifiedDocType === 'PAN_CARD');
    assert.ok(pan.fields.find((f) => f.fieldName === 'pan_number').low);
    const fix = await call(MOCK, 'PATCH', `/review/${id}/fields`, of1, { documentId: pan.id, field: 'pan_number', newValue: 'ZZTPS9012Y', reason: 'Read from document text', version: rv.application.version });
    assert.equal(fix.status, 200, JSON.stringify(fix.body));
    assert.equal(fix.body.decision, 'APPROVE');
    assert.equal(fix.body.status, 'IN_REVIEW');
    const stale = await call(MOCK, 'PATCH', `/review/${id}/fields`, of2, { documentId: pan.id, field: 'pan_number', newValue: 'ZZTPS9012Y', reason: 'stale version', version: rv.application.version });
    assert.equal(stale.status, 409);
    const body = { action: 'APPROVE', comment: 'PAN corrected from document text', version: fix.body.version };
    const [r1, r2] = await Promise.all([call(MOCK, 'POST', `/review/${id}/recommend`, of1, body), call(MOCK, 'POST', `/review/${id}/recommend`, of2, body)]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    const maker = r1.status === 200 ? of1 : of2;
    assert.equal((await call(MOCK, 'POST', `/checker/${id}/decide`, maker, { action: 'APPROVE', comment: 'approving my own case' })).status, 403);
    const q = (await call(MOCK, 'GET', '/checker/queue', ch)).body;
    assert.ok(q.find((x) => x.id === id && x.checkerSlaDue && x.panNumber === 'ZZTXXXXX2Y'));
    const d = await call(MOCK, 'POST', `/checker/${id}/decide`, ch, { action: 'APPROVE', comment: 'Verified, maker correction OK' });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.status, 'APPROVED');
    assert.ok(d.body.account.customerId && d.body.account.accountNumber);
    const audit = (await call(MOCK, 'GET', `/audit/${id}`, ch)).body;
    const corr = audit.find((x) => x.action === 'FIELD_CORRECTED');
    assert.ok(corr.before.includes('ZZTXXXXXOY') || corr.before.includes('ZZTP59O12Y'));
    assert.ok(audit.some((x) => x.action === 'DOCUMENT_VIEW') && audit.some((x) => x.action === 'CHECKER_DECISION'));
    const csvOut = (await call(MOCK, 'GET', `/audit/${id}?format=csv`, ch)).body;
    assert.ok(csvOut.startsWith('id,at,user') && !csvOut.includes('ZZTPS9012Y'));
  });

  await check('example 10: HIGH-risk APPROVE waits in PENDING_CHECKER', async () => {
    const id = await submit(MOCK, ap, 'A2000010');
    assert.equal((await settle(MOCK, ap, id)).status, 'PENDING_CHECKER');
  });

  await check('two applications with the same PAN at once -> never two approvals', async () => {
    const [x, y] = await Promise.all([submit(MOCK, ap, 'A2100009'), submit(MOCK, ap, 'A2100009')]);
    const s = [await settle(MOCK, ap, x), await settle(MOCK, ap, y)];
    assert.ok(s.filter((a) => a.status === 'AUTO_APPROVED').length <= 1, JSON.stringify(s.map((a) => a.status)));
    assert.ok(s.some((a) => a.status === 'IN_REVIEW'));
  });

  await check('AI service down -> REVIEW with LOW_EXTRACTION_CONFIDENCE; officer can enter fields manually', async () => {
    const t = await login(AIDOWN, 'applicant@test.com');
    const id = await submit(AIDOWN, t, 'A2000001');
    assert.equal((await settle(AIDOWN, t, id)).status, 'IN_REVIEW');
    const o = await login(AIDOWN, 'officer@test.com');
    const rv = (await call(AIDOWN, 'GET', `/review/${id}`, o)).body;
    assert.ok(rv.application.reasonCodes.includes('LOW_EXTRACTION_CONFIDENCE'));
    let v = rv.application.version;
    for (const [type, fields] of [['PAN_CARD', { name: 'Ravi Kumar Sharma', dob: '1990-05-15', pan_number: 'ZZKPS1234Q' }], ['AADHAAR_CARD', { name: 'Ravi Kumar Sharma', dob: '1990-05-15', aadhaar_last4: '4821' }], ['ELECTRICITY_BILL', { pincode: '400001', document_date: '2026-02-12' }]]) {
      const doc = rv.documents.find((d) => d.declaredDocType === type);
      for (const [field, newValue] of Object.entries({ doc_type: type, ...fields })) {
        const r = await call(AIDOWN, 'PATCH', `/review/${id}/fields`, o, { documentId: doc.id, field, newValue, reason: 'manual entry, AI down', version: v });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        v = r.body.version;
      }
    }
    const after = (await call(AIDOWN, 'GET', `/review/${id}`, o)).body.application;
    assert.ok(!after.reasonCodes.includes('LOW_EXTRACTION_CONFIDENCE'), after.reasonCodes.join('|'));
  });

  await check('rule config change (name_match_threshold) changes decisions; watchlist add + rescreen flags open case', async () => {
    const cfg = (await call(MOCK, 'GET', '/config', ch)).body.values;
    await call(MOCK, 'PUT', '/config', ch, { values: { name_match_threshold: 0.75 } });
    const id = await submit(MOCK, ap, 'A2000004');
    assert.equal((await settle(MOCK, ap, id)).status, 'AUTO_APPROVED');
    await call(MOCK, 'PUT', '/config', ch, { values: { name_match_threshold: cfg.name_match_threshold } });
    const w = await call(MOCK, 'POST', '/watchlist', ch, { entries: [{ id: 'SAN9999', list: 'SANCTIONS', name: 'Fatima Khan', dob: '' }] });
    assert.equal(w.status, 200);
    const rs = (await call(MOCK, 'POST', '/watchlist/rescreen', ch)).body;
    assert.ok(rs.changed.some((c) => c.after.includes('SANCTIONS_MATCH')), JSON.stringify(rs.changed));
  });

  await check('FR-8 resubmission: stale bill -> officer requests new docs -> applicant uploads fresh bill -> re-evaluated; cron expires old ones', async () => {
    const id = await submit(MOCK, ap, 'A2000005');
    assert.equal((await settle(MOCK, ap, id)).status, 'IN_REVIEW');
    const v = (await call(MOCK, 'GET', `/review/${id}`, of1)).body.application.version;
    assert.equal((await call(MOCK, 'POST', `/review/${id}/recommend`, of1, { action: 'REQUEST_RESUBMISSION', comment: 'Please upload a recent electricity bill', version: v })).status, 200);
    const s = (await call(MOCK, 'GET', `/applications/${id}`, ap)).body;
    assert.equal(s.status, 'RESUBMISSION_REQUESTED');
    assert.ok(s.resubmissionDue && s.reasons.some((x) => x.includes('90 days')));
    // Fresh bill: A2000001's bill (dated 20 days before application_date, same address).
    const bill = packFiles('A2000001').find((f) => f.type === 'ELECTRICITY_BILL');
    const up = await call(MOCK, 'POST', `/applications/${id}/documents`, ap, form([{ ...bill, name: 'D3000003.txt' }]), true);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const after = await settle(MOCK, ap, id);
    assert.ok(['IN_REVIEW', 'AUTO_APPROVED'].includes(after.status));
    const rv = (await call(MOCK, 'GET', `/review/${id}`, of1)).body;
    assert.ok(!rv.application.reasonCodes.includes('ADDRESS_PROOF_STALE'), rv.application.reasonCodes.join('|'));
    assert.equal(rv.documents.length, 3);
    // Expiry job
    const id2 = await submit(MOCK, ap, 'A2000005');
    await settle(MOCK, ap, id2);
    const v2 = (await call(MOCK, 'GET', `/review/${id2}`, of1)).body.application.version;
    await call(MOCK, 'POST', `/review/${id2}/recommend`, of1, { action: 'REQUEST_RESUBMISSION', comment: 'Please upload a recent electricity bill', version: v2 });
    const { prisma } = require('../src/core');
    await prisma.application.update({ where: { id: id2 }, data: { resubmissionDue: new Date(Date.now() - 1000) } });
    await require('../src/cron').expireResubmissions();
    assert.equal((await call(MOCK, 'GET', `/applications/${id2}`, ap)).body.status, 'CLOSED_EXPIRED');
    assert.equal((await call(MOCK, 'POST', `/applications/${id2}/documents`, ap, form([bill]), true)).status, 409);
  });

  await check('dashboard, CKYC, audit has no update/delete', async () => {
    const d = (await call(MOCK, 'GET', '/dashboard?from=2020-01-01&to=2099-01-01', ch)).body;
    assert.ok(d.total >= 60 && d.straightThroughRate > 0 && d.topReasonCodes.length === 5);
    assert.equal((await call(MOCK, 'GET', '/ckyc/search?pan=ZZUPV6368Q', of1)).body.customerId, 'KB000001');
    assert.equal((await call(MOCK, 'DELETE', '/audit/A2000004', ch)).status, 404);
  });

  servers.forEach((s) => s.kill());
  setTimeout(() => process.exit(), 300);
})();
