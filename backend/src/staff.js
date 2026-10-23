// Staff routes: KYC officer review (maker), compliance checker, audit, dashboard, watchlist, rule config, CKYC, re-KYC.
const fs = require("fs");
const path = require("path");
const express = require("express");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const {
  prisma,
  env,
  maskPan,
  audit,
  runRules,
  loadRuleContext,
  withPanLock,
  openAccount,
  appInclude,
} = require("./core");
const { summarise } = require("./extraction");
const { REQUIRED_FIELDS } = require("./rules/engine");

const OPEN = ["IN_REVIEW", "PENDING_CHECKER", "RESUBMISSION_REQUESTED"];
const RISK_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const PAN_RE = /\b([A-Z]{3})[A-Z]{2}[0-9]{3}([0-9][A-Z])\b/g;
const maskAll = (s) => String(s).replace(PAN_RE, "$1XXXXX$2");
const EDITABLE = [
  "doc_type",
  "name",
  "dob",
  "gender",
  "pan_number",
  "aadhaar_last4",
  "address",
  "pincode",
  "document_date",
  "valid_until",
];

module.exports = ({ role, httpError }) => {
  const r = express.Router();
  const OFFICER = role("KYC_OFFICER");
  const CHECKER = role("COMPLIANCE_OFFICER");
  const STAFF = role("KYC_OFFICER", "COMPLIANCE_OFFICER");

  const getApp = async (id) => {
    const a = await prisma.application.findUnique({
      where: { id },
      include: { ...appInclude, reviews: { orderBy: { id: "asc" } } },
    });
    if (!a) throw httpError(404, "Application not found");
    return a;
  };
  // Optimistic lock: the second of two concurrent actions sees a changed version and gets 409.
  const bump = async (a, data, clientVersion) => {
    const version = clientVersion != null ? Number(clientVersion) : a.version;
    const u = await prisma.application.updateMany({
      where: { id: a.id, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (!u.count)
      throw httpError(
        409,
        "This case was changed by someone else. Reload and try again.",
      );
  };
  const statusChange = (a, user, to) =>
    audit(null, {
      applicationId: a.id,
      user,
      action: "STATUS_CHANGE",
      entityType: "Application",
      entityId: a.id,
      before: { status: a.status },
      after: { status: to },
    });
  const listItem = (a) => ({
    id: a.id,
    fullName: a.fullName,
    panNumber: maskPan(a.panNumber),
    status: a.status,
    decision: a.decision,
    reasonCodes: a.reasonCodes,
    riskCategory: a.riskCategory,
    submittedAt: a.submittedAt,
    checkerSlaDue: a.checkerSlaDue,
    version: a.version,
  });

  // ---------------- Maker (KYC officer) ----------------
  r.get("/review/queue", OFFICER, async (_req, res) => {
    const apps = await prisma.application.findMany({
      where: { status: "IN_REVIEW" },
      orderBy: { submittedAt: "asc" },
    });
    apps.sort(
      (x, y) =>
        (RISK_ORDER[x.riskCategory] ?? 3) - (RISK_ORDER[y.riskCategory] ?? 3) ||
        x.submittedAt - y.submittedAt,
    );
    res.json(apps.map(listItem));
  });

  r.get("/review/:id", STAFF, async (req, res) => {
    const a = await getApp(req.params.id);
    const { config } = await loadRuleContext();
    if (!a.aiSummary && a.status === "IN_REVIEW" && a.reasonCodes.length) {
      a.aiSummary = await summarise(a);
      if (a.aiSummary)
        await prisma.application.update({
          where: { id: a.id },
          data: { aiSummary: a.aiSummary },
        });
    }
    const docs = a.documents.filter((d) => d.active);
    for (const d of docs)
      await audit(null, {
        applicationId: a.id,
        user: req.user,
        action: "DOCUMENT_VIEW",
        entityType: "Document",
        entityId: d.id,
      });
    res.json({
      application: {
        ...a,
        documents: undefined,
        reviews: undefined,
        ruleDetails: undefined,
      },
      ruleDetails: a.ruleDetails,
      reviews: a.reviews,
      minConfidence: config.min_field_confidence,
      documents: docs.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        mimeType: d.mimeType,
        declaredDocType: d.declaredDocType,
        classifiedDocType: d.classifiedDocType,
        docTypeConfidence: d.docTypeConfidence,
        docTypeLow: (d.docTypeConfidence ?? 0) < config.min_field_confidence,
        extractionStatus: d.extractionStatus,
        extractorVersion: d.extractorVersion,
        ocrConfidence: d.ocrConfidence,
        text: d.ocrText,
        contentUrl: d.mimeType.startsWith("text/")
          ? null
          : `/documents/${d.id}/content`,
        requiredFields: REQUIRED_FIELDS[d.classifiedDocType] || [],
        fields: d.fields
          .filter((f) => f.active)
          .map((f) => ({
            ...f,
            low: f.confidence < config.min_field_confidence,
          })),
      })),
    });
  });

  // Raw file (images/PDF) for officers and the owner; every view is audited.
  r.get("/documents/:docId/content", async (req, res) => {
    const d = await prisma.document.findUnique({
      where: { id: req.params.docId },
      include: { application: true },
    });
    const allowed =
      d &&
      (["KYC_OFFICER", "COMPLIANCE_OFFICER"].includes(req.user.role) ||
        d.application.userId === req.user.id);
    if (!allowed) throw httpError(404, "Document not found");
    await audit(null, {
      applicationId: d.applicationId,
      user: req.user,
      action: "DOCUMENT_VIEW",
      entityType: "Document",
      entityId: d.id,
    });
    res.set({
      "content-type": d.mimeType,
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "cache-control": "no-store",
    });
    res.send(
      fs.readFileSync(path.join(env.UPLOAD_DIR, path.basename(d.storedName))),
    );
  });

  r.patch("/review/:id/fields", OFFICER, async (req, res) => {
    const { documentId, field, newValue, reason, version } = req.body || {};
    const a = await getApp(req.params.id);
    if (a.status !== "IN_REVIEW")
      throw httpError(
        409,
        `Fields can only be corrected while IN_REVIEW (now ${a.status})`,
      );
    const doc = a.documents.find((d) => d.id === documentId && d.active);
    const errors = {};
    if (!doc) errors.documentId = "Unknown document for this application";
    if (!EDITABLE.includes(field)) errors.field = "Unknown field";
    if (newValue == null || String(newValue).trim() === "")
      errors.newValue = "Required";
    if (!reason || String(reason).trim().length < 5)
      errors.reason = "Give a reason (at least 5 characters)";
    if (Object.keys(errors).length)
      throw httpError(422, "Validation failed", { errors });
    const value = String(newValue).trim();
    await bump(a, {}, version);
    let before;
    if (field === "doc_type") {
      before = {
        value: doc.classifiedDocType,
        confidence: doc.docTypeConfidence,
      };
      await prisma.document.update({
        where: { id: doc.id },
        data: { classifiedDocType: value, docTypeConfidence: 1 },
      });
    } else {
      const old = doc.fields.find((f) => f.active && f.fieldName === field);
      before = old
        ? { value: old.value, confidence: old.confidence, source: old.source }
        : null;
      await prisma.$transaction([
        prisma.extractedField.updateMany({
          where: { documentId: doc.id, fieldName: field, active: true },
          data: { active: false },
        }),
        prisma.extractedField.create({
          data: {
            documentId: doc.id,
            fieldName: field,
            value,
            confidence: 1,
            source: "OFFICER",
            createdBy: req.user.id,
            reason,
          },
        }),
      ]);
    }
    await audit(null, {
      applicationId: a.id,
      user: req.user,
      action: "FIELD_CORRECTED",
      entityType: "Document",
      entityId: doc.id,
      before: { field, ...before },
      after: { field, value, confidence: 1, source: "OFFICER", reason },
    });
    const result = await runRules(a.id, { user: req.user, routeIt: false }); // case stays with maker -> checker
    await prisma.application.update({
      where: { id: a.id },
      data: { aiSummary: null },
    });
    const fresh = await prisma.application.findUnique({ where: { id: a.id } });
    res.json({
      decision: result.decision,
      reasonCodes: result.reasonCodes,
      nameMatchScore: result.nameMatchScore,
      riskCategory: result.riskCategory,
      rekycDueDate: result.rekycDueDate,
      status: fresh.status,
      version: fresh.version,
    });
  });

  r.post("/review/:id/recommend", OFFICER, async (req, res) => {
    const { action, comment, version } = req.body || {};
    if (!["APPROVE", "REJECT", "REQUEST_RESUBMISSION"].includes(action))
      throw httpError(422, "Validation failed", {
        errors: { action: "APPROVE, REJECT or REQUEST_RESUBMISSION" },
      });
    if (!comment || String(comment).trim().length < 10)
      throw httpError(422, "Validation failed", {
        errors: { comment: "Comment of at least 10 characters required" },
      });
    const a = await getApp(req.params.id);
    if (a.status !== "IN_REVIEW")
      throw httpError(409, `Case is ${a.status}, not IN_REVIEW`);
    const { config } = await loadRuleContext();
    const to =
      action === "REQUEST_RESUBMISSION"
        ? "RESUBMISSION_REQUESTED"
        : "PENDING_CHECKER";
    await bump(
      a,
      {
        status: to,
        reviewEndedAt: new Date(),
        ...(to === "PENDING_CHECKER"
          ? {
              checkerSlaDue: new Date(
                Date.now() + config.checker_sla_hours * 3600e3,
              ),
            }
          : {
              resubmissionDue: new Date(
                Date.now() + config.resubmission_sla_days * 86400e3,
              ),
            }),
      },
      version,
    );
    await prisma.review.create({
      data: {
        applicationId: a.id,
        userId: req.user.id,
        stage: "MAKER",
        action,
        comment: String(comment).trim(),
      },
    });
    await audit(null, {
      applicationId: a.id,
      user: req.user,
      action: "RECOMMENDATION",
      entityType: "Application",
      entityId: a.id,
      after: { action, comment },
    });
    await statusChange(a, req.user, to);
    res.json({ status: to });
  });

  // ---------------- Checker ----------------
  r.get("/checker/queue", CHECKER, async (_req, res) => {
    const apps = await prisma.application.findMany({
      where: { status: "PENDING_CHECKER" },
      include: { reviews: { orderBy: { id: "desc" }, take: 1 } },
      orderBy: { checkerSlaDue: "asc" },
    });
    res.json(
      apps.map((a) => ({
        ...listItem(a),
        recommendation: a.reviews[0]
          ? {
              action: a.reviews[0].action,
              comment: a.reviews[0].comment,
              by: a.reviews[0].userId,
            }
          : null,
      })),
    );
  });

  r.post("/checker/:id/decide", CHECKER, async (req, res) => {
    const { action, comment, version } = req.body || {};
    if (!["APPROVE", "REJECT", "SEND_BACK"].includes(action))
      throw httpError(422, "Validation failed", {
        errors: { action: "APPROVE, REJECT or SEND_BACK" },
      });
    if (!comment || String(comment).trim().length < 10)
      throw httpError(422, "Validation failed", {
        errors: { comment: "Comment of at least 10 characters required" },
      });
    const a = await getApp(req.params.id);
    if (a.status !== "PENDING_CHECKER")
      throw httpError(409, `Case is ${a.status}, not PENDING_CHECKER`);
    if (a.reviews.some((v) => v.userId === req.user.id && v.stage === "MAKER"))
      throw httpError(403, "Maker and checker must be different users");
    const slaMet = !a.checkerSlaDue || new Date() <= a.checkerSlaDue;
    let data, to;
    if (action === "APPROVE") {
      to = "APPROVED";
      const out = await withPanLock(a.panNumber, async () => {
        const other = await prisma.application.findFirst({
          where: {
            panNumber: a.panNumber,
            id: { not: a.id },
            status: { in: ["AUTO_APPROVED", "APPROVED"] },
          },
        });
        if (other)
          throw httpError(
            409,
            "Another application with this PAN is already approved",
          );
        await bump(a, { status: "APPROVED", decidedAt: new Date() }, version);
        const acct = await openAccount(a);
        await prisma.application.update({ where: { id: a.id }, data: acct });
        return acct;
      });
      data = { account: out };
    } else {
      to = action === "REJECT" ? "REJECTED" : "IN_REVIEW";
      await bump(
        a,
        action === "REJECT"
          ? { status: to, decidedAt: new Date() }
          : {
              status: to,
              reviewStartedAt: new Date(),
              reviewEndedAt: null,
              checkerSlaDue: null,
            },
        version,
      );
    }
    await prisma.review.create({
      data: {
        applicationId: a.id,
        userId: req.user.id,
        stage: "CHECKER",
        action,
        comment: String(comment).trim(),
      },
    });
    await audit(null, {
      applicationId: a.id,
      user: req.user,
      action: "CHECKER_DECISION",
      entityType: "Application",
      entityId: a.id,
      after: { action, comment, slaMet },
    });
    await statusChange(a, req.user, to);
    res.json({ status: to, checkerSlaDue: a.checkerSlaDue, slaMet, ...data });
  });

  // ---------------- Audit (read-only; no update/delete routes exist) ----------------
  r.get("/audit/:applicationId", STAFF, async (req, res) => {
    const rows = await prisma.auditLog.findMany({
      where: { applicationId: req.params.applicationId },
      orderBy: { id: "asc" },
    });
    const users = Object.fromEntries(
      (await prisma.user.findMany({ select: { id: true, email: true } })).map(
        (u) => [u.id, u.email],
      ),
    );
    const out = rows.map((x) => ({
      id: x.id,
      at: x.createdAt.toISOString(),
      user: users[x.userId] || "system",
      role: x.role,
      action: x.action,
      entityType: x.entityType,
      entityId: x.entityId,
      before: x.before ? maskAll(JSON.stringify(x.before)) : "",
      after: x.after ? maskAll(JSON.stringify(x.after)) : "",
    }));
    if (req.query.format === "csv") {
      res.set({
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="audit_${req.params.applicationId}.csv"`,
      });
      return res.send(stringify(out, { header: true }));
    }
    res.json(out);
  });

  // ---------------- Dashboard ----------------
  r.get("/dashboard", CHECKER, async (req, res) => {
    const where = {};
    if (req.query.from || req.query.to)
      where.submittedAt = {
        ...(req.query.from && { gte: new Date(req.query.from) }),
        ...(req.query.to && {
          lt: new Date(new Date(req.query.to).getTime() + 86400e3),
        }),
      };
    const apps = await prisma.application.findMany({
      where,
      select: {
        status: true,
        decision: true,
        reasonCodes: true,
        reviewStartedAt: true,
        reviewEndedAt: true,
      },
    });
    const byStatus = {},
      reasons = {};
    for (const a of apps) {
      byStatus[a.status] = (byStatus[a.status] || 0) + 1;
      for (const c of a.reasonCodes) reasons[c] = (reasons[c] || 0) + 1;
    }
    const decided = apps.filter((a) => a.decision).length;
    const rate = (n) => (decided ? +(n / decided).toFixed(4) : 0);
    const reviewed = apps.filter((a) => a.reviewStartedAt && a.reviewEndedAt);
    res.json({
      total: apps.length,
      decided,
      byStatus,
      straightThroughRate: rate(byStatus.AUTO_APPROVED || 0),
      reviewRate: rate(apps.filter((a) => a.decision === "REVIEW").length),
      rejectRate: rate(apps.filter((a) => a.decision === "REJECT").length),
      topReasonCodes: Object.entries(reasons)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 5)
        .map(([code, count]) => ({ code, count })),
      avgTimeInReviewHours: reviewed.length
        ? +(
            reviewed.reduce(
              (s, a) => s + (a.reviewEndedAt - a.reviewStartedAt),
              0,
            ) /
            reviewed.length /
            3600e3
          ).toFixed(2)
        : null,
      pendingChecker: byStatus.PENDING_CHECKER || 0,
    });
  });

  // ---------------- Watchlist + rule config (checker) ----------------
  r.get("/watchlist", CHECKER, async (_req, res) =>
    res.json(await prisma.watchlistEntry.findMany({ orderBy: { id: "asc" } })),
  );

  // Body: {entries:[{id,list,name,alias,dob,...}]} or {list:'SANCTIONS'|'PEP', csv:'<file contents>'} (data-pack column names).
  r.post("/watchlist", CHECKER, async (req, res) => {
    let entries = req.body?.entries;
    if (req.body?.csv) {
      const rows = parse(req.body.csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
      entries = rows.map((x) =>
        req.body.list === "PEP"
          ? {
              id: x.pep_id,
              list: "PEP",
              name: x.name,
              dob: x.dob,
              position: x.position,
              category: x.category,
            }
          : {
              id: x.list_id,
              list: "SANCTIONS",
              name: x.name,
              alias: x.alias,
              dob: x.dob,
              nationality: x.nationality,
              program: x.program,
            },
      );
    }
    if (!Array.isArray(entries) || !entries.length)
      throw httpError(422, "Validation failed", {
        errors: { entries: "Provide entries or csv" },
      });
    const bad = entries.findIndex(
      (e) => !e.id || !["SANCTIONS", "PEP"].includes(e.list) || !e.name,
    );
    if (bad >= 0)
      throw httpError(422, "Validation failed", {
        errors: {
          [`entries[${bad}]`]: "id, list (SANCTIONS|PEP) and name are required",
        },
      });
    for (const e of entries) {
      const data = {
        list: e.list,
        name: e.name,
        alias: e.alias || null,
        dob: e.dob || null,
        nationality: e.nationality || null,
        program: e.program || null,
        position: e.position || null,
        category: e.category || null,
      };
      await prisma.watchlistEntry.upsert({
        where: { id: e.id },
        create: { id: e.id, ...data },
        update: data,
      });
    }
    await audit(null, {
      user: req.user,
      action: "WATCHLIST_UPDATED",
      entityType: "WatchlistEntry",
      after: {
        count: entries.length,
        ids: entries.map((e) => e.id).slice(0, 50),
      },
    });
    res.json({ upserted: entries.length });
  });

  r.post("/watchlist/rescreen", CHECKER, async (req, res) => {
    const ctx = await loadRuleContext();
    const open = await prisma.application.findMany({
      where: { status: { in: OPEN } },
      select: { id: true, reasonCodes: true },
    });
    const changed = [];
    for (const a of open) {
      const r2 = await runRules(a.id, { user: req.user, routeIt: false, ctx });
      const before = a.reasonCodes.join("|"),
        after = r2.reasonCodes.join("|");
      if (before !== after) {
        changed.push({ id: a.id, before, after, decision: r2.decision });
        await audit(null, {
          applicationId: a.id,
          user: req.user,
          action: "WATCHLIST_HIT",
          entityType: "Application",
          entityId: a.id,
          before: { reasonCodes: a.reasonCodes },
          after: {
            reasonCodes: r2.reasonCodes,
            sanctions: r2.ruleDetails.sanctions,
            pep: r2.ruleDetails.pep,
          },
        });
      }
    }
    res.json({ rescreened: open.length, changed });
  });

  r.get("/config", STAFF, async (_req, res) =>
    res.json(
      await prisma.ruleConfig.findFirst({
        where: { active: true },
        orderBy: { id: "desc" },
      }),
    ),
  );
  r.put("/config", CHECKER, async (req, res) => {
    const cur = await prisma.ruleConfig.findFirst({
      where: { active: true },
      orderBy: { id: "desc" },
    });
    const values = { ...cur.values, ...(req.body?.values || {}) };
    for (const k of [
      "min_field_confidence",
      "name_match_threshold",
      "name_reject_below",
      "watchlist_match_threshold",
      "watchlist_possible_threshold",
    ])
      if (typeof values[k] !== "number" || values[k] < 0 || values[k] > 1)
        throw httpError(422, "Validation failed", {
          errors: { [k]: "Number between 0 and 1" },
        });
    const next = await prisma.$transaction(async (tx) => {
      await tx.ruleConfig.updateMany({
        where: { active: true },
        data: { active: false },
      });
      return tx.ruleConfig.create({
        data: {
          version: (Number(cur.version) + 0.1).toFixed(1),
          values,
          updatedBy: req.user.id,
        },
      });
    });
    await audit(null, {
      user: req.user,
      action: "RULE_CONFIG_UPDATED",
      entityType: "RuleConfig",
      entityId: String(next.id),
      before: cur.values,
      after: values,
    });
    res.json(next);
  });

  // ---------------- Mock CKYC + re-KYC ----------------
  r.get("/ckyc/search", STAFF, async (req, res) => {
    const c = await prisma.existingCustomer.findUnique({
      where: { panNumber: String(req.query.pan || "").toUpperCase() },
    });
    await audit(null, {
      user: req.user,
      action: "CKYC_SEARCH",
      entityType: "ExistingCustomer",
      after: { pan: maskPan(String(req.query.pan || "")), found: !!c },
    });
    if (!c) return res.status(404).json({ found: false });
    res.json({
      found: true,
      ckycNumber: "CKYC" + c.customerId,
      customerId: c.customerId,
      fullName: c.fullName,
      dob: c.dob,
      panNumber: maskPan(c.panNumber),
      kycStatus: "VERIFIED",
      rekycDueDate: c.rekycDueDate,
    });
  });

  r.get("/rekyc/due", CHECKER, async (_req, res) =>
    res.json(
      (await require("./cron").rekycDue()).map((c) => ({
        ...c,
        panNumber: maskPan(c.panNumber),
      })),
    ),
  );

  return r;
};
