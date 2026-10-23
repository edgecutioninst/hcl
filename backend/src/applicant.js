// Applicant routes: create application, upload documents, track status.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { prisma, env, maskPan, audit } = require("./core");
const { enqueue } = require("./queue");

const DOC_TYPES = [
  "PAN_CARD",
  "AADHAAR_CARD",
  "ELECTRICITY_BILL",
  "BANK_STATEMENT",
  "DRIVING_LICENCE",
];
const MB = 1024 * 1024;

// Plain-language reasons for the applicant (no scores, no watchlist details).
const REASON_TEXT = {
  DOCUMENT_MISSING:
    "A required document (PAN card, Aadhaar card or an address proof) is missing.",
  DOCUMENT_TYPE_MISMATCH:
    "One of your files does not match the document type you selected.",
  LOW_EXTRACTION_CONFIDENCE:
    "Some details on your documents could not be read clearly. An officer will check them.",
  AGE_BELOW_18: "You must be at least 18 years old to open this account.",
  PAN_INVALID: "The PAN entered is not a valid individual PAN.",
  PAN_MISMATCH: "The PAN on your PAN card does not match the PAN you entered.",
  DOB_MISMATCH:
    "The date of birth on your documents does not match the one you entered.",
  AADHAAR_MISMATCH:
    "The Aadhaar number on your card does not match the one you entered.",
  NAME_MISMATCH:
    "The name on your documents does not match the name you entered.",
  SANCTIONS_MATCH:
    "We are unable to open an account based on our compliance checks.",
  NAME_MISMATCH_MINOR:
    "The name on your documents differs slightly from the name you entered. An officer will check it.",
  DOCUMENT_EXPIRED:
    "Your driving licence has expired. Please provide a valid address proof.",
  ADDRESS_PROOF_STALE:
    "Your address proof must be dated within the last 90 days.",
  ADDRESS_MISMATCH:
    "The pincode on your address proof does not match the one you entered.",
  SANCTIONS_POSSIBLE_MATCH:
    "Your application needs an additional compliance check.",
  PEP_MATCH: "Your application needs an additional compliance check.",
  DUPLICATE_CUSTOMER:
    "You may already be a customer of the bank. An officer will check this.",
};
const STATUS_TEXT = {
  DRAFT: "Application started - upload your documents",
  SUBMITTED: "Received",
  EXTRACTING: "Checking your documents",
  AUTO_APPROVED: "Approved - account opened",
  APPROVED: "Approved - account opened",
  IN_REVIEW: "Under review by our team",
  PENDING_CHECKER: "Under final review",
  RESUBMISSION_REQUESTED: "Please upload new documents",
  REJECTED: "Rejected",
  AUTO_REJECTED: "Rejected",
  CLOSED_EXPIRED: "Closed - no documents received in time",
};

// A9xxxxxxx / D9xxxxxxx: never collide with data-pack IDs (A2..., D3...), sort in upload order.
const nextId = async (prefix, seq) =>
  prefix +
  "9" +
  String(
    (await prisma.$queryRawUnsafe(`SELECT nextval('${seq}')::int AS n`))[0].n,
  ).padStart(7, "0");
const todayIST = () =>
  new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

function validateApplication(b) {
  const e = {};
  const req = (k) => {
    if (b[k] == null || String(b[k]).trim() === "") e[k] = "Required";
  };
  [
    "full_name",
    "dob",
    "gender",
    "pan_number",
    "aadhaar_last4",
    "mobile",
    "email",
    "address",
    "city",
    "state",
    "pincode",
    "occupation_code",
    "annual_income",
  ].forEach(req);
  if (b.pan_number && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(b.pan_number))
    e.pan_number = "PAN must look like ABCDE1234F (upper case)";
  if (b.aadhaar_last4 != null && !/^[0-9]{4}$/.test(String(b.aadhaar_last4)))
    e.aadhaar_last4 = /^[0-9]{12}$/.test(
      String(b.aadhaar_last4).replace(/\s/g, ""),
    )
      ? "Enter only the last 4 digits of Aadhaar, never the full number"
      : "Must be exactly 4 digits";
  if (b.mobile && !/^[6-9][0-9]{9}$/.test(b.mobile))
    e.mobile = "Must be a 10-digit Indian mobile number starting 6-9";
  if (b.pincode && !/^[1-9][0-9]{5}$/.test(String(b.pincode)))
    e.pincode = "Must be a 6-digit pincode";
  if (b.dob && (!/^\d{4}-\d{2}-\d{2}$/.test(b.dob) || isNaN(Date.parse(b.dob))))
    e.dob = "Use YYYY-MM-DD";
  else if (b.dob && b.dob > todayIST())
    e.dob = "Date of birth cannot be in the future";
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email))
    e.email = "Invalid email";
  if (b.gender && !["M", "F", "O"].includes(b.gender)) e.gender = "M, F or O";
  if (
    b.annual_income != null &&
    !(Number.isInteger(Number(b.annual_income)) && Number(b.annual_income) >= 0)
  )
    e.annual_income = "Must be a whole number of rupees";
  if (b.consent !== true) e.consent = "Consent to KYC checks is required";
  return e;
}

// Content checks: extension, size, magic bytes, UTF-8. Returns mime or throws message.
function checkFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const b = file.buffer;
  const starts = (sig) => b.subarray(0, sig.length).equals(Buffer.from(sig));
  const binary = [
    [0x4d, 0x5a],
    [0x7f, 0x45, 0x4c, 0x46],
    [0x50, 0x4b, 0x03, 0x04],
    [0x25, 0x50, 0x44, 0x46],
    [0x89, 0x50, 0x4e, 0x47],
    [0xff, 0xd8, 0xff],
    [0x23, 0x21],
  ];
  if (ext === ".txt") {
    if (b.length > MB) return "Text files must be at most 1 MB";
    if (binary.some(starts) || b.includes(0))
      return "File content is not plain text";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(b);
    } catch {
      return "Text file must be UTF-8 encoded";
    }
    return { mime: "text/plain" };
  }
  if (b.length > 5 * MB) return "Images and PDFs must be at most 5 MB";
  if (ext === ".png")
    return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? { mime: "image/png" }
      : "File content is not a PNG image";
  if (ext === ".jpg" || ext === ".jpeg")
    return starts([0xff, 0xd8, 0xff])
      ? { mime: "image/jpeg" }
      : "File content is not a JPEG image";
  if (ext === ".pdf")
    return starts([0x25, 0x50, 0x44, 0x46, 0x2d])
      ? { mime: "application/pdf" }
      : "File content is not a PDF";
  return "Only .txt, .png, .jpg and .pdf files are accepted";
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * MB + 1, files: 10 },
});

module.exports = ({ role, httpError }) => {
  const r = express.Router();
  const own = async (req) => {
    const a = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: { documents: { orderBy: { id: "asc" } } },
    });
    if (!a || a.userId !== req.user.id)
      throw httpError(404, "Application not found"); // do not reveal others' IDs
    return a;
  };

  r.post("/applications", role("APPLICANT"), async (req, res) => {
    const b = {
      ...req.body,
      pan_number: req.body?.pan_number?.trim(),
      aadhaar_last4:
        req.body?.aadhaar_last4 != null
          ? String(req.body.aadhaar_last4).trim()
          : undefined,
    };
    const errors = validateApplication(b);
    if (Object.keys(errors).length)
      throw httpError(422, "Validation failed", { errors });
    const a = await prisma.application.create({
      data: {
        id: await nextId("A", "application_seq"),
        userId: req.user.id,
        applicationDate: process.env.DEMO_APPLICATION_DATE || todayIST(),
        /* demo-only: keeps data-pack bills in date */ fullName:
          b.full_name.trim(),
        dob: b.dob,
        gender: b.gender,
        panNumber: b.pan_number,
        aadhaarLast4: b.aadhaar_last4,
        mobile: b.mobile,
        email: b.email,
        address: b.address,
        city: b.city,
        state: b.state,
        pincode: String(b.pincode),
        occupationCode: b.occupation_code,
        annualIncome: Number(b.annual_income),
        consent: true,
        status: "DRAFT",
      },
    });
    await audit(null, {
      applicationId: a.id,
      user: req.user,
      action: "APPLICATION_CREATED",
      entityType: "Application",
      entityId: a.id,
      after: { status: "DRAFT" },
    });
    res.status(201).json({ id: a.id, status: a.status });
  });

  // multipart: files[] + declared_doc_type[] (same order) or declared_doc_types = JSON array
  r.post(
    "/applications/:id/documents",
    role("APPLICANT"),
    upload.array("files", 10),
    async (req, res) => {
      const a = await own(req);
      const resub = a.status === "RESUBMISSION_REQUESTED";
      if (a.status !== "DRAFT" && !resub)
        throw httpError(
          409,
          `Documents cannot be uploaded while the application is ${a.status}`,
        );
      if (resub && a.resubmissionDue && a.resubmissionDue < new Date())
        throw httpError(409, "The 7-day resubmission window has closed");
      const files = req.files || [];
      let types = req.body.declared_doc_types
        ? JSON.parse(req.body.declared_doc_types)
        : [].concat(req.body.declared_doc_type || []);
      const errors = {};
      if (!files.length) errors.files = "At least one file is required";
      if (types.length !== files.length)
        errors.declared_doc_type = "Choose a document type for each file";
      files.forEach((f, i) => {
        const c = checkFile(f);
        if (typeof c === "string")
          errors[`files[${i}]`] = `${f.originalname}: ${c}`;
        else f.mime = c.mime;
        if (!DOC_TYPES.includes(types[i]))
          errors[`declared_doc_type[${i}]`] = "Invalid document type";
      });
      if (Object.keys(errors).length)
        throw httpError(422, "Validation failed", { errors }); // nothing stored

      const existing = new Map(a.documents.map((d) => [d.sha256, d]));
      const items = [];
      for (const [i, f] of files.entries()) {
        const sha256 = crypto
          .createHash("sha256")
          .update(f.buffer)
          .digest("hex");
        if (existing.has(sha256)) {
          items.push({
            id: existing.get(sha256).id,
            fileName: f.originalname,
            duplicate: true,
          });
          continue;
        }
        existing.set(sha256, { id: null });
        items.push({ f, sha256, type: types[i] });
      }
      const fresh = items.filter((x) => x.f);
      const activeAfter =
        a.documents.filter(
          (d) =>
            d.active &&
            !(resub && fresh.some((x) => x.type === d.declaredDocType)),
        ).length + fresh.length;
      if (!resub && activeAfter < 3)
        throw httpError(422, "Validation failed", {
          errors: {
            files:
              "Upload at least 3 documents (PAN card, Aadhaar card and an address proof)",
          },
        });
      if (resub && !fresh.length)
        throw httpError(422, "Validation failed", {
          errors: { files: "Upload at least one new document" },
        });

      fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
      const created = [];
      for (const x of fresh) {
        const storedName = crypto.randomUUID(); // not guessable, outside the web root, never executed
        fs.writeFileSync(path.join(env.UPLOAD_DIR, storedName), x.f.buffer, {
          mode: 0o600,
        });
        const id = await nextId("D", "document_seq");
        if (resub)
          await prisma.document.updateMany({
            where: {
              applicationId: a.id,
              declaredDocType: x.type,
              active: true,
            },
            data: { active: false },
          });
        const d = await prisma.document.create({
          data: {
            id,
            applicationId: a.id,
            fileName: path.basename(x.f.originalname).slice(0, 200),
            storedName,
            mimeType: x.f.mime,
            size: x.f.size,
            sha256: x.sha256,
            declaredDocType: x.type,
            ocrText:
              x.f.mime === "text/plain" ? x.f.buffer.toString("utf8") : null,
          },
        });
        created.push(d);
        await audit(null, {
          applicationId: a.id,
          user: req.user,
          action: "DOCUMENT_UPLOADED",
          entityType: "Document",
          entityId: id,
          after: { declaredDocType: x.type, sha256: x.sha256, size: x.f.size },
        });
      }
      const upd = await prisma.application.updateMany({
        where: { id: a.id, version: a.version },
        data: {
          status: "EXTRACTING",
          submittedAt: a.submittedAt || new Date(),
          version: { increment: 1 },
        },
      });
      if (!upd.count)
        throw httpError(
          409,
          "Application was changed by another request; reload and retry",
        );
      await audit(null, {
        applicationId: a.id,
        user: req.user,
        action: "STATUS_CHANGE",
        entityType: "Application",
        entityId: a.id,
        before: { status: a.status },
        after: { status: "SUBMITTED" },
      });
      await audit(null, {
        applicationId: a.id,
        action: "STATUS_CHANGE",
        entityType: "Application",
        entityId: a.id,
        before: { status: "SUBMITTED" },
        after: { status: "EXTRACTING" },
      });
      // Re-extract every active document on resubmission so the whole case is re-evaluated.
      const toProcess = resub
        ? await prisma.document.findMany({
            where: { applicationId: a.id, active: true },
          })
        : created;
      for (const d of toProcess) {
        await prisma.document.update({
          where: { id: d.id },
          data: { extractionStatus: "PENDING" },
        });
        await enqueue(d.id);
      }
      res.status(201).json({
        status: "EXTRACTING",
        documents: items.map((x) =>
          x.f
            ? {
                id: created.find((c) => c.sha256 === x.sha256).id,
                fileName: x.f.originalname,
              }
            : x,
        ),
      });
    },
  );

  r.get("/applications/mine", role("APPLICANT"), async (req, res) => {
    const apps = await prisma.application.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      apps.map((a) => ({
        id: a.id,
        fullName: a.fullName,
        panNumber: maskPan(a.panNumber),
        status: a.status,
        statusText: STATUS_TEXT[a.status],
        applicationDate: a.applicationDate,
      })),
    );
  });

  r.get("/applications/:id", role("APPLICANT"), async (req, res) => {
    const a = await own(req);
    const timeline = await prisma.auditLog.findMany({
      where: { applicationId: a.id, action: "STATUS_CHANGE" },
      orderBy: { id: "asc" },
    });
    const final = [
      "AUTO_APPROVED",
      "APPROVED",
      "AUTO_REJECTED",
      "REJECTED",
    ].includes(a.status);
    // Reasons only once decided or when the applicant must act; never scores or watchlist details.
    const showReasons =
      final ||
      a.status === "RESUBMISSION_REQUESTED" ||
      a.status === "IN_REVIEW";
    res.json({
      id: a.id,
      status: a.status,
      statusText: STATUS_TEXT[a.status],
      applicationDate: a.applicationDate,
      fullName: a.fullName,
      panNumber: maskPan(a.panNumber),
      aadhaarLast4: a.aadhaarLast4,
      reasons:
        showReasons && !["AUTO_APPROVED", "APPROVED"].includes(a.status)
          ? [...new Set(a.reasonCodes.map((c) => REASON_TEXT[c] || c))]
          : [],
      resubmissionDue:
        a.status === "RESUBMISSION_REQUESTED" ? a.resubmissionDue : null,
      account: ["AUTO_APPROVED", "APPROVED"].includes(a.status)
        ? { customerId: a.customerId, accountNumber: a.accountNumber }
        : null,
      documents: a.documents
        .filter((d) => d.active)
        .map((d) => ({
          id: d.id,
          fileName: d.fileName,
          declaredDocType: d.declaredDocType,
          extractionStatus: d.extractionStatus,
        })),
      timeline: timeline.map((t) => ({
        at: t.createdAt,
        status: t.after?.status,
        text: STATUS_TEXT[t.after?.status],
      })),
    });
  });

  return r;
};

module.exports.REASON_TEXT = REASON_TEXT;
