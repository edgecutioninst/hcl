// Seed: reference data, users, rule config, and the 60 sample applications (documents + mock extraction), then evaluate them.
process.env.CORE_BANKING_INPROC = '1';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma, env, runRules, loadRuleContext } = require('../src/core');
const { readCsv } = require('../src/rules/files');

const f = (n, ext = 'csv') => path.join(env.DATA_DIR, `case_02_${n}_V1.0.${ext}`);

async function main() {
  // Order matters for FKs.
  for (const m of ['auditLog', 'review', 'extractedField', 'document', 'application', 'user', 'watchlistEntry', 'existingCustomer', 'occupation', 'ruleConfig']) await prisma[m].deleteMany();

  const hash = await bcrypt.hash('Password@123', 10);
  const users = {};
  for (const [email, role, name] of [
    ['applicant@test.com', 'APPLICANT', 'Demo Applicant'], ['applicant2@test.com', 'APPLICANT', 'Sample Applicants'],
    ['officer@test.com', 'KYC_OFFICER', 'Officer U1'], ['officer2@test.com', 'KYC_OFFICER', 'Officer U2'],
    ['checker@test.com', 'COMPLIANCE_OFFICER', 'Checker C1'],
  ]) users[email] = await prisma.user.create({ data: { email, role, name, passwordHash: hash } });

  await prisma.occupation.createMany({ data: readCsv(f('occupations')).map((o) => ({ code: o.occupation_code, description: o.description, riskLevel: o.risk_level })) });
  await prisma.existingCustomer.createMany({ data: readCsv(f('existing_customers')).map((c) => ({ customerId: c.customer_id, fullName: c.full_name, panNumber: c.pan_number, dob: c.dob })) });
  await prisma.watchlistEntry.createMany({ data: [
    ...readCsv(f('sanctions_list')).map((s) => ({ id: s.list_id, list: 'SANCTIONS', name: s.name, alias: s.alias || null, dob: s.dob || null, nationality: s.nationality, program: s.program })),
    ...readCsv(f('pep_list')).map((p) => ({ id: p.pep_id, list: 'PEP', name: p.name, dob: p.dob || null, position: p.position, category: p.category })),
  ] });
  const cfg = JSON.parse(fs.readFileSync(f('rules_config', 'json')));
  await prisma.ruleConfig.create({ data: { version: cfg.version, values: cfg } });

  // Sample applications + documents + mock extraction
  fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
  const texts = Object.fromEntries(fs.readFileSync(f('document_text_sample', 'jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((t) => [t.doc_id, t.text]));
  const mock = {};
  for (const r of readCsv(f('extraction_mock_sample'))) (mock[r.doc_id] ||= []).push(r);
  const docs = readCsv(f('documents_sample'));
  const apps = readCsv(f('applications_sample'));
  const submittedAt = new Date();

  for (const a of apps) {
    const owner = a.application_id <= 'A2000010' ? users['applicant@test.com'] : users['applicant2@test.com'];
    await prisma.application.create({ data: {
      id: a.application_id, userId: owner.id, applicationDate: a.application_date, fullName: a.full_name, dob: a.dob, gender: a.gender,
      panNumber: a.pan_number, aadhaarLast4: a.aadhaar_last4, mobile: a.mobile, email: a.email, address: a.address, city: a.city,
      state: a.state, pincode: a.pincode, occupationCode: a.occupation_code, annualIncome: Number(a.annual_income), consent: true,
      status: 'EXTRACTING', submittedAt,
    } });
    for (const d of docs.filter((x) => x.application_id === a.application_id)) {
      const text = texts[d.doc_id];
      const storedName = crypto.randomUUID();
      fs.writeFileSync(path.join(env.UPLOAD_DIR, storedName), text);
      const rows = mock[d.doc_id] || [];
      const t = rows.find((r) => r.field_name === 'doc_type');
      await prisma.document.create({ data: {
        id: d.doc_id, applicationId: a.application_id, fileName: d.file_name, storedName, mimeType: 'text/plain', size: Buffer.byteLength(text),
        sha256: crypto.createHash('sha256').update(text).digest('hex'), declaredDocType: d.declared_doc_type,
        classifiedDocType: t?.value || 'OTHER', docTypeConfidence: t ? Number(t.confidence) : 0, extractionStatus: 'DONE', extractorVersion: 'mock-1.0', ocrText: text,
        fields: { create: rows.filter((r) => r.field_name !== 'doc_type').map((r) => ({ fieldName: r.field_name, value: r.value, confidence: Number(r.confidence), source: 'MOCK' })) },
      } });
    }
  }

  const ctx = await loadRuleContext();
  let match = 0;
  for (const a of apps) {
    ctx.existingByPan = (await loadRuleContext()).existingByPan; // approvals add customers
    const r = await runRules(a.application_id, { ctx });
    if (r.decision === a.expected_decision && r.reasonCodes.join('|') === a.expected_reason_codes) match++;
    else console.log('diverges from expected:', a.application_id, r.decision, r.reasonCodes);
  }
  const byStatus = await prisma.application.groupBy({ by: ['status'], _count: true });
  console.log(`seeded ${apps.length} applications (${match} match expected); statuses:`, Object.fromEntries(byStatus.map((s) => [s.status, s._count])));
  console.log('users: applicant@test.com, officer@test.com, officer2@test.com, checker@test.com  password: Password@123');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
