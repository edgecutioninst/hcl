#!/usr/bin/env node
// Usage: node batch.js apps.csv docs.csv extraction.csv [out.csv]
const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');
const { evaluate } = require('./src/rules/engine');
const { readCsv, loadReference, loadExtraction } = require('./src/rules/files');

function runBatch(appsPath, docsPath, extPath) {
  const { config, watchlist, existing } = loadReference();
  const ext = loadExtraction(extPath);
  const docsByApp = {};
  for (const d of readCsv(docsPath)) (docsByApp[d.application_id] ||= []).push(d);
  return readCsv(appsPath).map((a) => ({ app: a, result: evaluate(a, docsByApp[a.application_id] || [], ext, config, watchlist, existing) }));
}

const toRow = ({ app, result: r }) => [
  app.application_id, r.decision, r.reasonCodes.join('|'),
  r.nameMatchScore == null ? '' : r.nameMatchScore.toFixed(4), r.riskCategory || '', r.rekycDueDate || '',
];
const HEADER = ['application_id', 'decision', 'reason_codes', 'name_match_score', 'risk_category', 'rekyc_due_date'];

if (require.main === module) {
  const [apps, docs, ext, out = path.join(__dirname, '..', 'output', 'decisions_output.csv')] = process.argv.slice(2);
  if (!apps || !docs || !ext) { console.error('usage: node batch.js apps.csv docs.csv extraction.csv [out.csv]'); process.exit(2); }
  const t = Date.now();
  const rows = runBatch(apps, docs, ext);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, stringify([HEADER, ...rows.map(toRow)]));
  console.log(`wrote ${rows.length} decisions to ${out} in ${Date.now() - t} ms`);
}

module.exports = { runBatch, toRow, HEADER };
