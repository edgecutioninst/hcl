// Pure KYC rules engine (R1-R17). Every threshold comes from `config` (RuleConfig.values).
const { distance } = require("fastest-levenshtein");

const REQUIRED_FIELDS = {
  PAN_CARD: ["name", "dob", "pan_number"],
  AADHAAR_CARD: ["name", "dob", "aadhaar_last4"],
  ELECTRICITY_BILL: ["pincode", "document_date"],
  BANK_STATEMENT: ["pincode", "document_date"],
  DRIVING_LICENCE: ["pincode", "valid_until"],
};

const RULES = [
  ["R1", "DOCUMENT_MISSING", "REVIEW"],
  ["R2", "DOCUMENT_TYPE_MISMATCH", "REVIEW"],
  ["R3", "LOW_EXTRACTION_CONFIDENCE", "REVIEW"],
  ["R4", "AGE_BELOW_18", "REJECT"],
  ["R5", "PAN_INVALID", "REJECT"],
  ["R6", "PAN_MISMATCH", "REJECT"],
  ["R7", "DOB_MISMATCH", "REJECT"],
  ["R8", "AADHAAR_MISMATCH", "REJECT"],
  ["R9", "NAME_MISMATCH", "REJECT"],
  ["R10", "SANCTIONS_MATCH", "REJECT"],
  ["R11", "NAME_MISMATCH_MINOR", "REVIEW"],
  ["R12", "DOCUMENT_EXPIRED", "REVIEW"],
  ["R13", "ADDRESS_PROOF_STALE", "REVIEW"],
  ["R14", "ADDRESS_MISMATCH", "REVIEW"],
  ["R15", "SANCTIONS_POSSIBLE_MATCH", "REVIEW"],
  ["R16", "PEP_MATCH", "REVIEW"],
  ["R17", "DUPLICATE_CUSTOMER", "REVIEW"],
];

function normaliseName(s, titles) {
  const t = String(s || "")
    .toUpperCase()
    .replace(/[.-]/g, " ")
    .replace(/[^A-Z ]/g, "");
  return t
    .split(/\s+/)
    .filter((x) => x && !titles.includes(x))
    .sort()
    .join(" ");
}

function similarity(a, b) {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - distance(a, b) / m;
}

// Calendar dates as YYYY-MM-DD strings -> UTC day numbers (no TZ drift; IST calendar dates are what's stored).
const day = (s) =>
  Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;

function ageOn(dob, on) {
  let age = +on.slice(0, 4) - +dob.slice(0, 4);
  if (on.slice(5) < dob.slice(5)) age -= 1;
  return age;
}

function addYears(date, years) {
  let md = date.slice(5);
  if (md === "02-29") md = "02-28";
  return `${String(+date.slice(0, 4) + years).padStart(4, "0")}-${md}`;
}

// Screen a name/dob against a list. Returns {result: MATCH|POSSIBLE|NONE, entry, similarity, dobMatch}.
function screen(name, dob, entries, cfg, titles) {
  const n = normaliseName(name, titles);
  let best = { result: "NONE", entry: null, similarity: 0 };
  const rank = { NONE: 0, POSSIBLE: 1, MATCH: 2 };
  for (const e of entries) {
    for (const cand of [e.name, e.alias]) {
      if (!cand) continue;
      const sim = similarity(n, normaliseName(cand, titles));
      let result = "NONE";
      if (sim >= cfg.watchlist_match_threshold)
        result = !e.dob || e.dob === dob ? "MATCH" : "POSSIBLE";
      else if (sim >= cfg.watchlist_possible_threshold) result = "POSSIBLE";
      if (
        rank[result] > rank[best.result] ||
        (rank[result] === rank[best.result] &&
          result !== "NONE" &&
          sim > best.similarity)
      ) {
        best = {
          result,
          entry: e.id || e.listId,
          matchedOn: cand,
          similarity: +sim.toFixed(4),
          entryDob: e.dob || null,
          dobMatch: !e.dob || e.dob === dob,
        };
      }
    }
  }
  return best;
}

/**
 * @param application  {application_id, application_date, full_name, dob, pan_number, aadhaar_last4, pincode, occupation_code, annual_income}
 * @param documents    [{doc_id, declared_doc_type}]
 * @param extracted    {doc_id: {field_name: {value, confidence}}}  (doc_type is a field)
 * @param config       RuleConfig.values + {occupations: {code: risk_level}}
 * @param watchlist    [{id, list: 'SANCTIONS'|'PEP', name, alias, dob}]
 * @param existingCustomers  [{pan_number}] or a Set of PANs
 */
function evaluate(
  application,
  documents,
  extracted,
  config,
  watchlist,
  existingCustomers,
) {
  const cfg = config;
  const titles = cfg.name_title_tokens;
  const minConf = cfg.min_field_confidence;
  const addrTypes = cfg.address_proof_types;
  const a = application;
  const hit = new Set();
  const details = {};

  const field = (docId, f) => (extracted[docId] || {})[f];
  const usable = (docId, f) => {
    const x = field(docId, f);
    return x &&
      x.value != null &&
      String(x.value).trim() !== "" &&
      Number(x.confidence) >= minConf
      ? String(x.value).trim()
      : null;
  };
  const docs = [...documents]
    .map((d) => ({
      ...d,
      type: field(d.doc_id, "doc_type")?.value || "OTHER",
      typeConf: Number(field(d.doc_id, "doc_type")?.confidence || 0),
    }))
    .sort((x, y) => (x.doc_id < y.doc_id ? -1 : 1));

  const pick = (types) => docs.find((d) => types.includes(d.type)) || null;
  const pan = pick(["PAN_CARD"]);
  const aad = pick(["AADHAAR_CARD"]);
  const addr = pick(addrTypes);
  details.selected = {
    PAN_CARD: pan?.doc_id || null,
    AADHAAR_CARD: aad?.doc_id || null,
    ADDRESS_PROOF: addr?.doc_id || null,
  };

  // R1
  const missing = [
    ["PAN_CARD", pan],
    ["AADHAAR_CARD", aad],
    ["ADDRESS_PROOF", addr],
  ]
    .filter(([, d]) => !d)
    .map(([t]) => t);
  if (missing.length) {
    hit.add("R1");
    details.R1 = { missing };
  }

  // R2
  const mism = docs
    .filter((d) => d.type !== d.declared_doc_type)
    .map((d) => ({
      doc_id: d.doc_id,
      declared: d.declared_doc_type,
      classified: d.type,
    }));
  if (mism.length) {
    hit.add("R2");
    details.R2 = { mismatches: mism };
  }

  // R3
  const low = [];
  for (const d of docs)
    if (d.typeConf < minConf)
      low.push({ doc_id: d.doc_id, field: "doc_type", confidence: d.typeConf });
  for (const d of [pan, aad, addr].filter(Boolean)) {
    for (const f of REQUIRED_FIELDS[d.type])
      if (!usable(d.doc_id, f))
        low.push({
          doc_id: d.doc_id,
          field: f,
          confidence: Number(field(d.doc_id, f)?.confidence || 0),
        });
  }
  if (low.length) {
    hit.add("R3");
    details.R3 = { low };
  }

  // R4
  const age = ageOn(a.dob, a.application_date);
  details.R4 = { age, min: cfg.min_age };
  if (age < cfg.min_age) hit.add("R4");

  // R5
  const panOk =
    new RegExp(cfg.pan_pattern).test(a.pan_number || "") &&
    a.pan_number[3] === cfg.pan_holder_type_char;
  if (!panOk) {
    hit.add("R5");
    details.R5 = { declared: a.pan_number };
  }

  // R6
  const panRead = pan && usable(pan.doc_id, "pan_number");
  if (panRead) {
    details.R6 = { declared: a.pan_number, read: panRead.toUpperCase() };
    if (panRead.toUpperCase() !== a.pan_number) hit.add("R6");
  }

  // R7
  const dobs = [pan, aad]
    .filter(Boolean)
    .map((d) => ({ doc_id: d.doc_id, read: usable(d.doc_id, "dob") }))
    .filter((x) => x.read);
  if (dobs.length) {
    details.R7 = { declared: a.dob, read: dobs };
    if (dobs.some((x) => x.read !== a.dob)) hit.add("R7");
  }

  // R8
  const aRead = aad && usable(aad.doc_id, "aadhaar_last4");
  if (aRead) {
    details.R8 = { declared: a.aadhaar_last4, read: aRead };
    if (aRead !== String(a.aadhaar_last4)) hit.add("R8");
  }

  // R9 / R11
  const declN = normaliseName(a.full_name, titles);
  const sims = [pan, aad]
    .filter(Boolean)
    .map((d) => ({ doc_id: d.doc_id, name: usable(d.doc_id, "name") }))
    .filter((x) => x.name)
    .map((x) => ({
      ...x,
      similarity: similarity(declN, normaliseName(x.name, titles)),
    }));
  const nameMatchScore = sims.length
    ? Math.min(...sims.map((s) => s.similarity))
    : null;
  if (nameMatchScore != null) {
    details.name = {
      declared: a.full_name,
      compared: sims.map((s) => ({
        ...s,
        similarity: +s.similarity.toFixed(4),
      })),
    };
    if (nameMatchScore < cfg.name_reject_below) hit.add("R9");
    else if (nameMatchScore < cfg.name_match_threshold) hit.add("R11");
  }

  // R10 / R15 / R16
  const sanc = screen(
    a.full_name,
    a.dob,
    watchlist.filter((w) => w.list === "SANCTIONS"),
    cfg,
    titles,
  );
  const pep = screen(
    a.full_name,
    a.dob,
    watchlist.filter((w) => w.list === "PEP"),
    cfg,
    titles,
  );
  details.sanctions = sanc;
  details.pep = pep;
  if (sanc.result === "MATCH") hit.add("R10");
  if (sanc.result === "POSSIBLE") hit.add("R15");
  if (pep.result === "MATCH") hit.add("R16");

  // R12 / R13 / R14
  if (addr) {
    if (addr.type === "DRIVING_LICENCE") {
      const vu = usable(addr.doc_id, "valid_until");
      if (vu) {
        details.R12 = { valid_until: vu };
        if (day(vu) < day(a.application_date)) hit.add("R12");
      }
    } else {
      const dd = usable(addr.doc_id, "document_date");
      if (dd) {
        const ageDays = day(a.application_date) - day(dd);
        details.R13 = {
          document_date: dd,
          age_days: ageDays,
          max: cfg.address_proof_max_age_days,
        };
        if (ageDays > cfg.address_proof_max_age_days || ageDays < 0)
          hit.add("R13");
      }
    }
    const pin = usable(addr.doc_id, "pincode");
    if (pin) {
      details.R14 = { declared: String(a.pincode), read: pin };
      if (pin !== String(a.pincode)) hit.add("R14");
    }
  }

  // R17
  const pans =
    existingCustomers instanceof Set
      ? existingCustomers
      : new Set(existingCustomers.map((c) => c.pan_number || c.panNumber));
  if (pans.has(a.pan_number)) hit.add("R17");

  const triggered = RULES.filter(([r]) => hit.has(r));
  const reasonCodes = triggered.map(([, code]) => code);
  const decision = triggered.some(([, , o]) => o === "REJECT")
    ? "REJECT"
    : triggered.length
      ? "REVIEW"
      : "APPROVE";

  let riskCategory = null,
    rekycDueDate = null;
  if (decision !== "REJECT") {
    const occ = (cfg.occupations || {})[a.occupation_code];
    if (hit.has("R16") || hit.has("R15") || occ === "HIGH")
      riskCategory = "HIGH";
    else if (
      occ === "MEDIUM" ||
      Number(a.annual_income) >= cfg.medium_risk_income
    )
      riskCategory = "MEDIUM";
    else riskCategory = "LOW";
    rekycDueDate = addYears(a.application_date, cfg.rekyc_years[riskCategory]);
  }

  return {
    decision,
    reasonCodes,
    nameMatchScore,
    riskCategory,
    rekycDueDate,
    ruleDetails: details,
  };
}

// Status routing after evaluate().
function route(decision, risk) {
  if (decision === "REJECT") return "AUTO_REJECTED";
  if (decision === "REVIEW") return "IN_REVIEW";
  return risk === "HIGH" ? "PENDING_CHECKER" : "AUTO_APPROVED";
}

module.exports = {
  evaluate,
  route,
  normaliseName,
  similarity,
  REQUIRED_FIELDS,
  RULES,
};
