// Extraction providers behind one interface: extract(doc) -> {doc_type, doc_type_confidence, fields[], extractor_version}
const fs = require("fs");
const path = require("path");
const { env } = require("./core");
const { loadExtraction } = require("./rules/files");

const FAIL = (version, error) => ({
  doc_type: "OTHER",
  doc_type_confidence: 0,
  fields: [],
  extractor_version: version,
  error,
});

let mock;
function mockTable() {
  if (!mock) {
    mock = {};
    for (const n of ["sample", "eval"])
      Object.assign(
        mock,
        loadExtraction(
          path.join(env.DATA_DIR, `case_02_extraction_mock_${n}_V1.0.csv`),
        ),
      );
  }
  return mock;
}

// The mock is keyed by data-pack doc_id. Uploaded copies of pack files carry their original name (D3000025.txt).
function mockExtract(doc) {
  const key =
    (doc.id.match(/^D\d{7}$/) && doc.id) ||
    path.basename(doc.fileName || "", path.extname(doc.fileName || ""));
  const row = mockTable()[key];
  if (!row) return FAIL("mock-1.0", "unknown doc");
  const { doc_type, ...rest } = row;
  return {
    doc_type: doc_type?.value || "OTHER",
    doc_type_confidence: doc_type?.confidence ?? 0,
    extractor_version: "mock-1.0",
    fields: Object.entries(rest).map(([field_name, v]) => ({
      field_name,
      value: v.value,
      confidence: v.confidence,
    })),
  };
}

async function callAi(pathname, init, timeoutMs) {
  const res = await fetch(env.AI_SERVICE_URL + pathname, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ai-service ${pathname} ${res.status}`);
  return res.json();
}

async function aiExtract(doc, text) {
  try {
    return await callAi(
      "/extract",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-service-key": env.SERVICE_KEY,
        },
        body: JSON.stringify({
          doc_id: doc.id,
          text,
          ocr_confidence: doc.ocrConfidence ?? null,
        }),
      },
      10000,
    );
  } catch (e) {
    return FAIL("ai-unavailable", e.message); // AI down or >10 s: confidence 0 -> R3 REVIEW
  }
}

async function ocr(doc) {
  const buf = fs.readFileSync(path.join(env.UPLOAD_DIR, doc.storedName));
  const form = new FormData();
  form.append("file", new Blob([buf], { type: doc.mimeType }), doc.fileName);
  return callAi(
    "/ocr",
    {
      method: "POST",
      body: form,
      headers: { "x-service-key": env.SERVICE_KEY },
    },
    30000,
  );
}

async function summarise(app) {
  try {
    const fields = app.documents
      .filter((d) => d.active)
      .flatMap((d) =>
        d.fields
          .filter((f) => f.active)
          .map((f) => ({
            doc_id: d.id,
            doc_type: d.classifiedDocType,
            field: f.fieldName,
            value: f.value,
            confidence: f.confidence,
          })),
      );
    const r = await callAi(
      "/summary",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-service-key": env.SERVICE_KEY,
        },
        body: JSON.stringify({
          application_id: app.id,
          reason_codes: app.reasonCodes,
          rule_details: app.ruleDetails,
          fields,
        }),
      },
      15000,
    );
    return r.summary;
  } catch {
    return null;
  }
}

const extract = (doc, text) =>
  env.EXTRACTION_PROVIDER === "ai" ? aiExtract(doc, text) : mockExtract(doc);

module.exports = { extract, ocr, summarise, mockExtract };
