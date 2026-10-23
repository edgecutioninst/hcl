// Express app: auth, role middleware, internal core-banking mock, error handling. Routes live in applicant.js / staff.js.
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { prisma, env } = require("./core");
const { createAccount } = require("./coreBanking");

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const httpError = (status, message, extra) =>
  Object.assign(new Error(message), { status, extra });

async function auth(req, _res, next) {
  const h = req.headers.authorization || "";
  let p;
  try {
    p = jwt.verify(h.replace(/^Bearer /, ""), env.JWT_SECRET);
  } catch {
    return next(httpError(401, "Not authenticated"));
  }
  // Role comes from the database, not the token, so a removed user or changed role takes effect immediately.
  const u = await prisma.user
    .findUnique({ where: { id: p.sub } })
    .catch(() => null);
  if (!u) return next(httpError(401, "Not authenticated"));
  req.user = { id: u.id, role: u.role, email: u.email };
  next();
}
const role =
  (...roles) =>
  (req, _res, next) =>
    roles.includes(req.user.role)
      ? next()
      : next(httpError(403, "Forbidden for role " + req.user.role));
const sign = (u) =>
  jwt.sign({ sub: u.id, role: u.role, email: u.email }, env.JWT_SECRET, {
    expiresIn: "8h",
  });

app.get("/health", (_req, res) =>
  res.json({ ok: true, provider: env.EXTRACTION_PROVIDER }),
);

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const u =
    email &&
    (await prisma.user.findUnique({
      where: { email: String(email).toLowerCase() },
    }));
  if (!u || !(await bcrypt.compare(String(password || ""), u.passwordHash)))
    throw httpError(401, "Invalid email or password");
  res.json({
    token: sign(u),
    user: { id: u.id, email: u.email, role: u.role, name: u.name },
  });
});

app.post("/auth/register", async (req, res) => {
  const { email, password, name } = req.body || {};
  const errors = {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || ""))
    errors.email = "Valid email required";
  if (String(password || "").length < 8)
    errors.password = "At least 8 characters";
  if (!name) errors.name = "Required";
  if (Object.keys(errors).length)
    throw httpError(422, "Validation failed", { errors });
  if (await prisma.user.findUnique({ where: { email: email.toLowerCase() } }))
    throw httpError(409, "Email already registered");
  const u = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      name,
      role: "APPLICANT",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  res
    .status(201)
    .json({
      token: sign(u),
      user: { id: u.id, email: u.email, role: u.role, name: u.name },
    });
});

// Mock core banking, reachable only with the service key.
app.post("/internal/core-banking/accounts", async (req, res) => {
  if (!env.SERVICE_KEY || req.headers["x-service-key"] !== env.SERVICE_KEY)
    throw httpError(401, "Bad service key");
  res.status(201).json(await createAccount(req.body));
});

app.use(auth);
app.use(require("./applicant")({ role, httpError }));
app.use(require("./staff")({ role, httpError }));

app.use((_req, _res, next) => next(httpError(404, "Not found")));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 422 : 500);
  if (status >= 500) console.error(err);
  res
    .status(status)
    .json({
      error: status >= 500 ? "Internal error" : err.message,
      ...(err.extra || {}),
    });
});

module.exports = { app, httpError };
