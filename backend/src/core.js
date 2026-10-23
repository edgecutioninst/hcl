// Shared backend core: env, prisma, audit, masking, rule context, rule run + routing, core-banking mock client.
const path = require("path");
require("dotenv").config({
  path: process.env.ENV_FILE || path.join(__dirname, "..", "..", ".env"),
});
const { PrismaClient } = require("@prisma/client");
const { evaluate, route } = require("./rules/engine");

const prisma = new PrismaClient();
const env = {
  JWT_SECRET:
    process.env.JWT_SECRET ||
    (() => {
      throw new Error("JWT_SECRET missing");
    })(),
  REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
  EXTRACTION_PROVIDER: process.env.EXTRACTION_PROVIDER || "mock",
  AI_SERVICE_URL: process.env.AI_SERVICE_URL || "http://localhost:8000",
  SERVICE_KEY: process.env.SERVICE_KEY || "",
  CORE_BANKING_URL:
    process.env.CORE_BANKING_URL ||
    `http://localhost:${process.env.PORT || 4000}/internal/core-banking`,
  UPLOAD_DIR: path.resolve(
    __dirname,
    "..",
    process.env.UPLOAD_DIR || "../storage",
  ),
  DATA_DIR: path.resolve(__dirname, "..", process.env.DATA_DIR || "../data"),
};
process.env.DATA_DIR = env.DATA_DIR;

const maskPan = (p) =>
  p && p.length === 10 ? `${p.slice(0, 3)}XXXXX${p.slice(8)}` : p;

async function audit(
  tx,
  { applicationId, user, action, entityType, entityId, before, after },
) {
  return (tx || prisma).auditLog.create({
    data: {
      applicationId,
      userId: user?.id || null,
      role: user?.role || "SYSTEM",
      action,
      entityType,
      entityId,
      before: before ?? undefined,
      after: after ?? undefined,
    },
  });
}

async function loadRuleContext() {
  const [cfgRow, occ, wl, ex] = await Promise.all([
    prisma.ruleConfig.findFirst({
      where: { active: true },
      orderBy: { id: "desc" },
    }),
    prisma.occupation.findMany(),
    prisma.watchlistEntry.findMany(),
    prisma.existingCustomer.findMany({
      select: { panNumber: true, applicationId: true },
    }),
  ]);
  if (!cfgRow) throw new Error("No active RuleConfig; run the seed");
  const config = {
    ...cfgRow.values,
    occupations: Object.fromEntries(occ.map((o) => [o.code, o.riskLevel])),
  };
  return {
    config,
    watchlist: wl,
    existingByPan: new Map(ex.map((e) => [e.panNumber, e.applicationId])),
  };
}

// DB application + documents -> engine inputs.
function toEngineInputs(app) {
  const docs = app.documents.filter((d) => d.active);
  const application = {
    application_id: app.id,
    application_date: app.applicationDate,
    full_name: app.fullName,
    dob: app.dob,
    pan_number: app.panNumber,
    aadhaar_last4: app.aadhaarLast4,
    pincode: app.pincode,
    occupation_code: app.occupationCode,
    annual_income: app.annualIncome,
  };
  const documents = docs.map((d) => ({
    doc_id: d.id,
    declared_doc_type: d.declaredDocType,
  }));
  const extracted = {};
  for (const d of docs) {
    const m = (extracted[d.id] = {
      doc_type: {
        value: d.classifiedDocType || "OTHER",
        confidence: d.docTypeConfidence ?? 0,
      },
    });
    for (const f of d.fields)
      if (f.active)
        m[f.fieldName] = { value: f.value, confidence: f.confidence };
  }
  return { application, documents, extracted };
}

const appInclude = {
  documents: { include: { fields: true }, orderBy: { id: "asc" } },
};

// Evaluate and persist. `routeIt`: apply automatic routing (false for officer re-runs, where the case stays with the maker/checker).
async function runRules(applicationId, { user, routeIt = true, ctx } = {}) {
  ctx ||= await loadRuleContext();
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: appInclude,
  });
  const { application, documents, extracted } = toEngineInputs(app);
  // R17: a customer record this application itself created is not a duplicate of it.
  const owner = ctx.existingByPan.get(app.panNumber);
  const existing = new Set(
    owner !== undefined && owner !== app.id ? [app.panNumber] : [],
  );
  const r = evaluate(
    application,
    documents,
    extracted,
    ctx.config,
    ctx.watchlist,
    existing,
  );
  const data = {
    decision: r.decision,
    reasonCodes: r.reasonCodes,
    nameMatchScore: r.nameMatchScore,
    riskCategory: r.riskCategory,
    rekycDueDate: r.rekycDueDate,
    ruleDetails: r.ruleDetails,
    version: { increment: 1 },
  };
  let status = app.status;
  if (routeIt) {
    status = route(r.decision, r.riskCategory);
    // Never auto-approve two applications with the same PAN: lock, then check for another approved one.
    if (status === "AUTO_APPROVED")
      status = await withPanLock(app.panNumber, async () => {
        const other = await prisma.application.findFirst({
          where: {
            panNumber: app.panNumber,
            id: { not: app.id },
            status: { in: ["AUTO_APPROVED", "APPROVED"] },
          },
        });
        if (other) {
          data.reasonCodes = [...r.reasonCodes, "DUPLICATE_CUSTOMER"];
          data.decision = "REVIEW";
          return "IN_REVIEW";
        }
        Object.assign(
          data,
          await openAccount({ ...app, rekycDueDate: r.rekycDueDate }),
        );
        await prisma.application.update({
          where: { id: app.id },
          data: { ...data, status: "AUTO_APPROVED", decidedAt: new Date() },
        });
        return "AUTO_APPROVED";
      });
    if (status !== "AUTO_APPROVED") {
      Object.assign(data, { status });
      if (status === "IN_REVIEW") data.reviewStartedAt = new Date();
      if (status === "PENDING_CHECKER")
        data.checkerSlaDue = new Date(
          Date.now() + ctx.config.checker_sla_hours * 3600e3,
        );
      if (status === "AUTO_REJECTED") data.decidedAt = new Date();
      await prisma.application.update({ where: { id: app.id }, data });
    }
  } else {
    await prisma.application.update({ where: { id: app.id }, data });
  }
  await audit(null, {
    applicationId,
    user,
    action: "RULES_EVALUATED",
    entityType: "Application",
    entityId: applicationId,
    after: {
      decision: data.decision,
      reasonCodes: data.reasonCodes,
      nameMatchScore: r.nameMatchScore,
      riskCategory: r.riskCategory,
      sanctions: r.ruleDetails.sanctions.result,
      pep: r.ruleDetails.pep.result,
    },
  });
  if (status !== app.status)
    await audit(null, {
      applicationId,
      user,
      action: "STATUS_CHANGE",
      entityType: "Application",
      entityId: applicationId,
      before: { status: app.status },
      after: { status },
    });
  return {
    ...r,
    reasonCodes: data.reasonCodes,
    decision: data.decision,
    status,
  };
}

// ---- Redis lock on PAN (SET NX PX) ----
let redis;
const getRedis = () =>
  (redis ||= new (require("ioredis"))(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  }));
const withPanLock = (pan, fn) => withLock(`pan:${pan}`, fn);
async function withLock(name, fn) {
  const key = `lock:${name}`,
    token = String(Math.random());
  for (let i = 0; i < 50; i++) {
    if (await getRedis().set(key, token, "PX", 10000, "NX")) {
      try {
        return await fn();
      } finally {
        await getRedis().eval(
          "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0",
          1,
          key,
          token,
        );
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const e = new Error(`${name} is locked by another operation in progress`);
  e.status = 409;
  throw e;
}

// Mock core banking is called over HTTP with the service key; CORE_BANKING_INPROC=1 (seed only) calls it directly.
async function openAccount(app) {
  if (process.env.CORE_BANKING_INPROC)
    return require("./coreBanking").createAccount(app);
  const res = await fetch(env.CORE_BANKING_URL + "/accounts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-service-key": env.SERVICE_KEY,
    },
    body: JSON.stringify({
      id: app.id,
      panNumber: app.panNumber,
      fullName: app.fullName,
      dob: app.dob,
      rekycDueDate: app.rekycDueDate,
    }),
  }).catch(() => null);
  if (!res || !res.ok)
    throw Object.assign(new Error("core banking unavailable"), { status: 503 });
  const { customerId, accountNumber } = await res.json();
  return { customerId, accountNumber };
}

module.exports = {
  prisma,
  env,
  maskPan,
  audit,
  loadRuleContext,
  runRules,
  withPanLock,
  withLock,
  openAccount,
  appInclude,
  getRedis,
};
