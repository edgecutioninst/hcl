// BullMQ extraction queue: one `extract` job per document; when an application's documents are all done, run the rules.
const { Queue, Worker } = require("bullmq");
const IORedis = require("ioredis");
const { prisma, env, audit, runRules, withLock } = require("./core");
const { extract, ocr } = require("./extraction");

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const prefix = process.env.QUEUE_PREFIX || "bull";
const queue = new Queue("extract", { connection, prefix });

const enqueue = (docId) =>
  queue.add(
    "extract",
    { docId },
    {
      jobId: `extract-${docId}-${Date.now()}`,
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );

async function processDocument(docId) {
  const doc = await prisma.document.update({
    where: { id: docId },
    data: { extractionStatus: "PROCESSING" },
  });
  let status = "DONE";
  try {
    let text = doc.ocrText;
    if (!doc.mimeType.startsWith("text/")) {
      const o = await ocr(doc); // image / pdf -> text
      text = o.text;
      await prisma.document.update({
        where: { id: docId },
        data: { ocrText: text, ocrConfidence: o.ocr_confidence },
      });
      doc.ocrConfidence = o.ocr_confidence;
    }
    const r = await extract(doc, text || "");
    if (r.error) status = "FAILED";
    await saveExtraction(docId, r);
  } catch (e) {
    status = "FAILED";
    await saveExtraction(docId, {
      doc_type: "OTHER",
      doc_type_confidence: 0,
      fields: [],
      extractor_version: "failed:" + e.message.slice(0, 60),
    });
  }
  await prisma.document.update({
    where: { id: docId },
    data: { extractionStatus: status },
  });
  await audit(null, {
    applicationId: doc.applicationId,
    action: "DOCUMENT_EXTRACTED",
    entityType: "Document",
    entityId: docId,
    after: { status, provider: env.EXTRACTION_PROVIDER },
  });
  await maybeEvaluate(doc.applicationId);
}

async function saveExtraction(docId, r) {
  await prisma.$transaction([
    prisma.extractedField.updateMany({
      where: { documentId: docId, active: true, source: { not: "OFFICER" } },
      data: { active: false },
    }),
    prisma.extractedField.createMany({
      data: r.fields.map((f) => ({
        documentId: docId,
        fieldName: f.field_name,
        value: f.value ?? null,
        confidence: Number(f.confidence) || 0,
        source: r.extractor_version?.startsWith("mock") ? "MOCK" : "AI",
        sourceStart: f.source_span?.start ?? null,
        sourceEnd: f.source_span?.end ?? null,
      })),
    }),
    prisma.document.update({
      where: { id: docId },
      data: {
        classifiedDocType: r.doc_type,
        docTypeConfidence: Number(r.doc_type_confidence) || 0,
        extractorVersion: r.extractor_version,
      },
    }),
  ]);
}

async function maybeEvaluate(applicationId) {
  await withLock(`eval:${applicationId}`, async () => {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { documents: { where: { active: true } } },
    });
    if (app.status !== "EXTRACTING") return;
    if (
      app.documents.some(
        (d) => !["DONE", "FAILED"].includes(d.extractionStatus),
      )
    )
      return;
    await runRules(applicationId);
  });
}

function startWorker() {
  const w = new Worker("extract", (job) => processDocument(job.data.docId), {
    connection,
    prefix,
    concurrency: 4,
  });
  w.on("failed", (job, err) =>
    console.error("extract job failed", job?.data, err.message),
  );
  return w;
}

module.exports = { queue, enqueue, startWorker, processDocument };
