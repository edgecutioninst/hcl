// File-based loaders shared by batch.js and the sample test (no DB needed).
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');
const readCsv = (p) => parse(fs.readFileSync(p), { columns: true, skip_empty_lines: true, trim: true });
const dataFile = (name) => path.join(DATA, `case_02_${name}_V1.0.${name === 'rules_config' ? 'json' : 'csv'}`);

function loadReference() {
  const config = JSON.parse(fs.readFileSync(dataFile('rules_config')));
  config.occupations = Object.fromEntries(readCsv(dataFile('occupations')).map((o) => [o.occupation_code, o.risk_level]));
  const watchlist = [
    ...readCsv(dataFile('sanctions_list')).map((s) => ({ id: s.list_id, list: 'SANCTIONS', name: s.name, alias: s.alias, dob: s.dob })),
    ...readCsv(dataFile('pep_list')).map((p) => ({ id: p.pep_id, list: 'PEP', name: p.name, alias: '', dob: p.dob })),
  ];
  const existing = new Set(readCsv(dataFile('existing_customers')).map((c) => c.pan_number));
  return { config, watchlist, existing };
}

// Long-format extraction CSV -> {doc_id: {field: {value, confidence}}}
function loadExtraction(p) {
  const out = {};
  for (const r of readCsv(p)) (out[r.doc_id] ||= {})[r.field_name] = { value: r.value, confidence: Number(r.confidence) };
  return out;
}

module.exports = { DATA, readCsv, dataFile, loadReference, loadExtraction };
