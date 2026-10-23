// Runs evaluate() on the 60 sample applications and compares to the expected columns.
const path = require('path');
const assert = require('assert');
const { runBatch, toRow } = require('../batch');
const { evaluate } = require('../src/rules/engine');
const { DATA, loadReference } = require('../src/rules/files');

const f = (n) => path.join(DATA, `case_02_${n}_V1.0.csv`);
const rows = runBatch(f('applications_sample'), f('documents_sample'), f('extraction_mock_sample'));
let bad = 0;
for (const row of rows) {
  const [, decision, codes, score, risk, rekyc] = toRow(row);
  const a = row.app;
  const exp = [a.expected_decision, a.expected_reason_codes, a.expected_name_match_score, a.expected_risk_category, a.expected_rekyc_due_date];
  const got = [decision, codes, score, risk, rekyc];
  if (exp.join() !== got.join()) { bad++; console.log(a.application_id, '\n  expected', exp, '\n  got     ', got); }
}
console.log(`${rows.length - bad}/${rows.length} sample applications match`);

// Worked checks
const by = Object.fromEntries(rows.map((r) => [r.app.application_id, r]));
assert.equal(by.A2000004.result.nameMatchScore.toFixed(4), '0.7647');
assert.equal(by.A2000006.result.ruleDetails.sanctions.entry, 'SAN0002');
assert.equal(by.A2000007.result.ruleDetails.pep.entry, 'PEP0001');
assert.equal(by.A2000007.result.rekycDueDate, '2028-03-04');

// Config-driven: lowering name_match_threshold below 0.7647 flips A2000004 to APPROVE with no code change.
const { config, watchlist, existing } = loadReference();
const r4 = by.A2000004;
const docs = require('../src/rules/files').readCsv(f('documents_sample')).filter((d) => d.application_id === 'A2000004');
const ext = require('../src/rules/files').loadExtraction(f('extraction_mock_sample'));
assert.equal(evaluate(r4.app, docs, ext, { ...config, name_match_threshold: 0.75 }, watchlist, existing).decision, 'APPROVE');

// A2000009: an extractor that reads the PAN correctly at >=0.80 gives APPROVE.
const ext9 = JSON.parse(JSON.stringify(ext));
ext9.D3000025.pan_number = { value: 'ZZTPS9012Y', confidence: 0.95 };
const docs9 = require('../src/rules/files').readCsv(f('documents_sample')).filter((d) => d.application_id === 'A2000009');
assert.equal(evaluate(by.A2000009.app, docs9, ext9, config, watchlist, existing).decision, 'APPROVE');

if (bad) process.exit(1);
console.log('worked checks OK');
