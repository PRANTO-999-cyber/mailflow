import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import crypto from "node:crypto";
import multer from "multer";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import {
  User,
  ROLE_PERMISSIONS,
  hashPassword,
  checkPassword,
  signToken,
  publicUser,
  authMiddleware,
  requirePermission,
} from "./security.js";
import {
  addEmailJob,
  addEmailJobsBulk,
  createEmailWorker,
  closeEmailQueue,
  getEmailQueueStats,
} from "./emailQueue.js";
import { Delivery, ProviderEvent, Suppression } from "./deliveryModels.js";
import { sendThroughProvider, verifyProvider } from "./providers.js";
import { createStore } from "./store.js";
import { validateEnv } from "./envCheck.js";
import { cleanToken, tokenFingerprint } from "./ownerToken.js";

const app = express();
const allowedOrigins = new Set([
  process.env.CLIENT_URL || "http://localhost:5173",
]);
if (process.env.NODE_ENV === "production" && !process.env.CLIENT_URL)
  throw new Error("Set an exact CLIENT_URL origin in production.");
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
  }),
);
app.use((req, res, next) => {
  // Cookie-authenticated state changes must originate from the configured frontend.
  // Requests without Origin remain available for local CLI/API testing.
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
    req.headers.origin &&
    !allowedOrigins.has(req.headers.origin)
  ) {
    return res.status(403).json({ error: "Request origin is not allowed." });
  }
  next();
});
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }),
);
app.use(cookieParser());
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down." },
  }),
);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}); // 10MB max PDF
// Minimum gap between messages to one provider (ms). Sending too fast is the #1 reason
// Gmail/Yahoo/Outlook mark a sender as spam and throttle or block the account.
const MIN_SEND_DELAY_MS = Math.max(
  1000,
  Number(process.env.MIN_SEND_DELAY_MS || 1200),
);
const MAX_SEND_DELAY_MS = Math.max(
  MIN_SEND_DELAY_MS,
  Number(process.env.MAX_SEND_DELAY_MS || 60000),
);
const PUBLIC_API_URL = String(
  process.env.PUBLIC_API_URL || "http://localhost:5000",
).replace(/\/$/, "");
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// ---------- Persistence ----------
// Every restart used to wipe recipients/campaigns/activity back to the sample data. That's
// why "4 skipped" kept happening after adding a real recipient — the recipient only lived
// in server memory. Everything is now saved to server/data.json after every change and
// reloaded on startup, so restarting `npm run dev` no longer loses your data.
const DATA_FILE = path.resolve(__dirname, "../data.json"); // legacy file, only read once to migrate into MongoDB
let recipients = [],
  campaigns = [],
  activity = [],
  templates = [],
  savedSenderSettings = {};
let settings; // assigned below once sender settings are loaded

function defaults() {
  return {
    recipients: [
      {
        id: id(),
        name: "Ava Thompson",
        email: "ava@example.com",
        group: "Newsletter",
        status: "Needs consent",
        addedAt: now(),
      },
      {
        id: id(),
        name: "Noah Williams",
        email: "noah@example.com",
        group: "Product updates",
        status: "Needs consent",
        addedAt: now(),
      },
      {
        id: id(),
        name: "Mia Chen",
        email: "mia@example.com",
        group: "Newsletter",
        status: "Needs consent",
        addedAt: now(),
      },
      {
        id: id(),
        name: "Liam Patel",
        email: "liam@example.com",
        group: "VIP customers",
        status: "Needs consent",
        addedAt: now(),
      },
    ],
    campaigns: [
      {
        id: id(),
        name: "October product update",
        subject: "What’s new this month",
        body: "Hello {{name}},\n\nHere are the latest updates from our team.\n\nThanks for being with us!",
        status: "Draft",
        recipients: 4,
        createdAt: now(),
        sentAt: null,
      },
    ],
    activity: [
      {
        id: id(),
        type: "System",
        title: "Workspace initialized",
        detail: "Your email workspace is ready to configure.",
        time: now(),
        status: "Complete",
      },
    ],
    templates: [
      {
        id: id(),
        name: "Welcome email",
        subject: "Welcome aboard, {{name}}!",
        body: "Hi {{name}},\n\nWelcome! We’re glad you’re here.\n\nBest,\nThe team",
      },
      {
        id: id(),
        name: "Monthly update",
        subject: "Your monthly update",
        body: "Hi {{name}},\n\nHere is what is new this month.\n\nThanks for reading.",
      },
    ],
    settings: {},
  };
}

// ---------- Fail fast on bad configuration, then connect and load saved data ----------
{
  const problems = validateEnv(process.env);
  for (const w of problems.warnings) console.warn("Config warning:", w);
  if (problems.errors.length)
    throw new Error(
      "Invalid server/.env configuration:\n - " +
        problems.errors.join("\n - ") +
        "\nRun 'npm run doctor' in server/ for a full check.",
    );
}
try {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
} catch (e) {
  throw new Error(
    `Cannot connect to MongoDB (${e.message}). Check MONGODB_URI in server/.env, that MongoDB is running, and - for MongoDB Atlas - that your current IP address is allowed under Network Access. Run 'npm run doctor' for details.`,
  );
}
console.log("MongoDB connected.");
const store = createStore();
function applyLoaded(d) {
  recipients = (d.recipients || []).map((r) =>
    r.status === "Subscribed" && !r.consentAt
      ? { ...r, status: "Needs consent" }
      : r,
  );
  campaigns = (d.campaigns || []).map((c) => {
    // Keep recipient outcomes after restart so operators can review results and retry failures.
    // Do not auto-resume an in-flight SMTP job: the last message may have been accepted before the process stopped.
    if (c.sendProgress?.running) {
      c.sendProgress.running = false;
      c.sendProgress.paused = false;
      c.sendProgress.cancelRequested = false;
      c.sendProgress.interruptedAt = now();
      c.status = "Interrupted";
    }
    return c;
  });
  activity = d.activity || [];
  templates = d.templates || [];
  savedSenderSettings = d.settings || {};
}
let loadedSource;
{
  const loaded = await store.load({ legacyFile: DATA_FILE, defaults });
  loadedSource = loaded.source;
  applyLoaded(loaded);
  console.log(
    `Loaded ${loaded.recipients.length} recipients and ${loaded.campaigns.length} campaigns (source: ${loaded.source}).`,
  );
  if (loaded.source === "defaults")
    console.log("No saved data yet — starting with sample data.");
}
// Live references are re-read on every save, so route handlers can keep mutating the arrays directly.
store.bind({
  get recipients() {
    return recipients;
  },
  get campaigns() {
    return campaigns;
  },
  get activity() {
    return activity;
  },
  get templates() {
    return templates;
  },
  settings: () => ({
    fromName: settings.fromName,
    fromEmail: settings.fromEmail,
  }),
});
// Debounced save after every change; flushStore() waits until MongoDB has acknowledged.
const persist = () => store.schedule();
const flushStore = () => store.flush();
{
  const t = cleanToken(process.env.OWNER_SETUP_TOKEN);
  console.log(
    `Owner setup token: ${t.length >= 32 ? "configured" : "MISSING/INVALID"} | length=${t.length} | fingerprint=${t ? tokenFingerprint(t) : "-"} | .env=${path.resolve(__dirname, "../.env")} (secret value hidden).`,
  );
}
let emailWorker = null;
// Flush state and close worker/queue/database connections cleanly; stalled jobs can still recover if killed forcibly.
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, async () => {
    try {
      await emailWorker?.close();
      await store.flush();
      await closeEmailQueue();
      await mongoose.disconnect();
    } catch (e) {
      console.error("Shutdown cleanup:", e.message);
    }
    process.exit(0);
  });
// ---------- SMTP configuration (read from server/.env) ----------
const RESERVED = /@(example\.(com|org|net)|test|invalid|localhost)$/i;
const isEligibleRecipient = (r) =>
  r.status === "Subscribed" &&
  Boolean(r.consentAt) &&
  /^\S+@\S+\.\S+$/.test(String(r.email || "")) &&
  !r.suppressedAt &&
  !["bounced", "complained"].includes(r.lastProviderEvent) &&
  !RESERVED.test(r.email);
function normalizeSender(sender, index = 0) {
  const user = String(sender.user || "").trim();
  const pass = String(sender.pass || "").replace(/\s+/g, "");
  let host = String(sender.host || "").trim();
  if (!host && /@(gmail|googlemail)\.com$/i.test(user)) host = "smtp.gmail.com";
  const port = Number(sender.port || 587);
  const placeholder =
    /^(yourname@gmail\.com|you@example\.com)$/i.test(user) ||
    /^abcdefghijklmnop$/i.test(pass);
  const provider = String(
    sender.provider || process.env.EMAIL_PROVIDER || "smtp",
  ).toLowerCase();
  const apiReady =
    provider === "brevo"
      ? Boolean(
          process.env.BREVO_API_KEY &&
          (sender.fromEmail ||
            process.env.BREVO_FROM_EMAIL ||
            process.env.SMTP_FROM_EMAIL),
        )
      : provider === "ses"
        ? Boolean(
            process.env.AWS_ACCESS_KEY_ID &&
            process.env.AWS_SECRET_ACCESS_KEY &&
            (sender.fromEmail ||
              process.env.SES_FROM_EMAIL ||
              process.env.SMTP_FROM_EMAIL),
          )
        : false;
  return {
    id: String(sender.id || `sender-${index + 1}`),
    name: String(sender.name || user || `Sender ${index + 1}`),
    provider,
    host,
    port,
    secure: port === 465,
    user,
    pass,
    fromEmail:
      sender.fromEmail ||
      process.env.BREVO_FROM_EMAIL ||
      process.env.SES_FROM_EMAIL ||
      process.env.SMTP_FROM_EMAIL ||
      user,
    placeholder,
    configured: ["brevo", "ses"].includes(provider)
      ? apiReady
      : Boolean(host && user && pass) && !placeholder,
  };
}
function allSenderConfigs() {
  let configured = [];
  if (process.env.SMTP_SENDERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.SMTP_SENDERS_JSON);
      if (Array.isArray(parsed)) configured = parsed.map(normalizeSender);
    } catch {
      console.error(
        "SMTP_SENDERS_JSON is invalid JSON. Falling back to the default SMTP_* settings.",
      );
    }
  }
  if (!configured.length)
    configured = [
      normalizeSender({
        id: "default",
        name: process.env.SMTP_FROM_NAME || "Default sender",
        provider: process.env.EMAIL_PROVIDER,
        fromEmail: process.env.BREVO_FROM_EMAIL || process.env.SMTP_FROM_EMAIL,
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        user:
          process.env.SMTP_USER ||
          process.env.BREVO_FROM_EMAIL ||
          process.env.SES_FROM_EMAIL,
        pass: process.env.SMTP_PASS,
      }),
    ];
  return configured;
}
function smtpConfig(senderId) {
  const senders = allSenderConfigs();
  return senders.find((s) => s.id === senderId) || senders[0];
}
const notConfiguredMessage = (sender = smtpConfig()) =>
  sender.placeholder
    ? "server/.env still contains example values. Add valid SMTP credentials and restart the API."
    : "SMTP is not configured. Set SMTP_USER/SMTP_PASS or SMTP_SENDERS_JSON in server/.env and restart the API.";
settings = {
  fromName:
    savedSenderSettings.fromName ||
    process.env.SMTP_FROM_NAME ||
    "Gmail Mailer",
  fromEmail: savedSenderSettings.fromEmail ?? process.env.SMTP_FROM_EMAIL ?? "",
  get host() {
    return smtpConfig().host;
  },
  get port() {
    return smtpConfig().port;
  },
  get secure() {
    return smtpConfig().secure;
  },
  get user() {
    return smtpConfig().user;
  },
  get configured() {
    return smtpConfig().configured;
  },
};
const publicSettings = () => ({
  fromName: settings.fromName,
  fromEmail: settings.fromEmail,
  host: settings.host,
  port: settings.port,
  secure: settings.secure,
  configured: settings.configured,
  user: settings.user ? `${settings.user.slice(0, 2)}••••` : "",
});
// First start after upgrading: write migrated/sample data to MongoDB, then keep the old JSON file as a backup.
await store.flush();
if (loadedSource === "legacy-json" && fs.existsSync(DATA_FILE)) {
  try {
    const backup = `${DATA_FILE}.migrated-${Date.now()}`;
    fs.renameSync(DATA_FILE, backup);
    console.log(
      `Legacy data.json migrated to MongoDB. Backup kept at ${backup}`,
    );
  } catch (e) {
    console.warn("Could not rename legacy data.json:", e.message);
  }
}
function createTransporter(senderId) {
  const c = smtpConfig(senderId);
  if (!c.configured) return null;
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}
function friendlyError(e) {
  const msg = e?.message || String(e);
  if (
    e?.code === "EAUTH" ||
    /535|Invalid login|Username and Password not accepted|BadCredentials/i.test(
      msg,
    )
  )
    return "SMTP login rejected. For Gmail you must turn on 2-Step Verification and use a 16-character App Password (https://myaccount.google.com/apppasswords) in SMTP_PASS — your normal Gmail password will not work. Check SMTP_USER too.";
  if (
    [
      "ETIMEDOUT",
      "ECONNECTION",
      "ESOCKET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EDNS",
    ].includes(e?.code)
  )
    return `Cannot reach the SMTP server (${e.code}). Check SMTP_HOST / internet / firewall. If port 587 is blocked, set SMTP_PORT=465.`;
  if (/5\.4\.5|Daily user sending|quota/i.test(msg))
    return "Gmail daily sending limit reached. Try again in 24 hours.";
  if (/5\.7\.0|Authentication Required/i.test(msg))
    return "Gmail requires authentication. Check SMTP_USER and SMTP_PASS (App Password).";
  return msg;
}
function unsubscribeToken(recipient) {
  const payload = Buffer.from(
    JSON.stringify({ id: recipient.id, email: recipient.email.toLowerCase() }),
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}
function verifyUnsubscribeToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;
  const expected = crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(payload)
    .digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  )
    return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
function buildMail(c, r, sender) {
  const transportUser = sender.user;
  const personalize = (t) => t.replaceAll("{{name}}", r.name);
  const esc = (t) =>
    t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const isGmail =
    /gmail\.com$/i.test(sender.host) && sender.provider !== "brevo";
  // Gmail overwrites From with the authenticated account unless the alias is verified in Gmail settings.
  const fromAddr =
    isGmail || !settings.fromEmail
      ? sender.fromEmail || transportUser
      : settings.fromEmail;
  const replyTo =
    settings.fromEmail && settings.fromEmail !== fromAddr
      ? settings.fromEmail
      : undefined;
  const token = unsubscribeToken(r);
  const unsubscribeUrl = `${PUBLIC_API_URL}/api/public/unsubscribe/${encodeURIComponent(token)}`;
  const footer = `You are receiving this because you gave permission to receive these messages. Unsubscribe: ${unsubscribeUrl}`;
  const text = `${personalize(c.body)}\n\n--\n${footer}`;
  const mail = {
    from: `"${settings.fromName.replace(/"/g, "")}" <${fromAddr}>`,
    to: r.email,
    replyTo,
    subject: personalize(c.subject).replace(/[\r\n]+/g, " "),
    text,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;white-space:pre-wrap">${esc(personalize(c.body))}</div><hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px"><p style="font-size:12px;color:#777">${esc(footer)}</p>`,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:${replyTo || fromAddr}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
  if (c.attachment?.buffer)
    mail.attachments = [
      {
        filename: c.attachment.filename,
        content: c.attachment.buffer,
        contentType: c.attachment.mimetype,
      },
    ];
  return mail;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRetryableSmtpError = (e) => {
  const code = String(e?.code || "").toUpperCase();
  const status = Number(e?.responseCode || e?.statusCode || 0);
  return (
    [
      "ETIMEDOUT",
      "ECONNECTION",
      "ESOCKET",
      "ECONNRESET",
      "EPIPE",
      "EAI_AGAIN",
    ].includes(code) || [421, 450, 451, 452].includes(status)
  );
};
async function sendMailWithRetry(transporter, mail) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await transporter.sendMail(mail);
    } catch (e) {
      last = e;
      if (!isRetryableSmtpError(e) || attempt === 2) throw e;
      await sleep(5000 * 2 ** attempt);
    }
  }
  throw last;
}
// Never send raw attachment bytes to the browser — JSON-encoding a Buffer turned a 5 MB PDF into a ~25 MB response.
const publicCampaign = (c) => {
  const { attachment, ...rest } = c;
  return attachment
    ? {
        ...rest,
        attachment: {
          filename: attachment.filename,
          mimetype: attachment.mimetype,
          size: attachment.size,
        },
      }
    : rest;
};
function logActivity(entry) {
  activity.unshift(entry);
  if (activity.length > 1000) activity.length = 1000;
}
const safeError = (e) => ({ error: e?.message || "Unexpected server error" });
const DIST = path.resolve(__dirname, "../../client/dist");
const hasDist = fs.existsSync(path.join(DIST, "index.html"));
if (!hasDist)
  app.get("/", (_, res) =>
    res.json({
      service: "Gmail Mailer API",
      health: "/api/health",
      docs: "Open the API Console in the web app.",
    }),
  );
app.get("/api/health", async (_, res) => {
  try {
    await mongoose.connection.db.admin().ping();
    let queue = "unknown";
    try {
      const q = await Promise.race([
        getEmailQueueStats(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 1500),
        ),
      ]);
      queue = { status: "connected", ...q };
    } catch {
      queue = { status: "unavailable" };
    }
    res.json({
      ok: true,
      service: "Gmail Mailer API",
      database: "connected",
      storage: store.status(),
      queue,
      mode: settings.configured ? smtpConfig().provider || "smtp" : "demo",
      smtpHost: settings.host || null,
    });
  } catch {
    res
      .status(503)
      .json({
        ok: false,
        service: "Gmail Mailer API",
        database: "unavailable",
      });
  }
});

// ---------- Multi-admin authentication ----------
// Keep first-run Owner setup separate from ordinary sign-in attempts. Successful
// requests do not consume the limit; failed attempts remain throttled.
const bootstrapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: "Too many Owner setup attempts. Wait 15 minutes and try again.",
  },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts. Wait 15 minutes and try again." },
});
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/",
  maxAge: 8 * 60 * 60 * 1000,
};
app.get("/api/public/unsubscribe/:token", (req, res) => {
  const data = verifyUnsubscribeToken(req.params.token);
  if (!data)
    return res.status(400).send("Invalid or expired unsubscribe link.");
  const recipient = recipients.find(
    (r) => r.id === data.id && r.email.toLowerCase() === data.email,
  );
  if (!recipient)
    return res.status(404).send("This subscription could not be found.");
  res
    .type("html")
    .send(
      `<main style="font:16px system-ui;max-width:560px;margin:12vh auto;padding:24px"><h1>Unsubscribe from emails</h1><p>Confirm that you no longer want to receive campaign emails at ${String(recipient.email).replace(/[&<>\"']/g, "")}.</p><form method="post" action="/api/public/unsubscribe/${encodeURIComponent(req.params.token)}"><button style="padding:12px 18px">Unsubscribe</button></form></main>`,
    );
});
app.post(
  "/api/public/unsubscribe/:token",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const data = verifyUnsubscribeToken(req.params.token);
    if (!data)
      return res.status(400).send("Invalid or expired unsubscribe link.");
    const recipient = recipients.find(
      (r) => r.id === data.id && r.email.toLowerCase() === data.email,
    );
    if (!recipient) return res.status(404).send("Subscription not found.");
    // RFC 8058 mailbox-provider POSTs are one-click: no login or extra confirmation step.
    recipient.status = "Unsubscribed";
    recipient.unsubscribedAt = recipient.unsubscribedAt || now();
    recipient.unsubscribeSource = "one-click";
    recipient.suppressedAt = now();
    recipient.suppressionReason = "unsubscribe";
    await Suppression.updateOne(
      { email: String(recipient.email).toLowerCase() },
      {
        $setOnInsert: {
          email: String(recipient.email).toLowerCase(),
          reason: "unsubscribe",
          source: "RFC 8058 one-click",
        },
      },
      { upsert: true },
    );
    persist();
    res.status(200).send("You have been unsubscribed successfully.");
  },
);

// Provider adapters should normalize their verified webhook payloads to this small event contract.
// Signature: HMAC-SHA256(raw request body, PROVIDER_WEBHOOK_SECRET), hex, in x-gm-webhook-signature.
app.post("/api/webhooks/normalized", async (req, res) => {
  const secret = String(process.env.PROVIDER_WEBHOOK_SECRET || "");
  const signature = String(req.headers["x-gm-webhook-signature"] || "").replace(
    /^sha256=/i,
    "",
  );
  if (secret.length < 32 || !req.rawBody || !/^[a-f0-9]{64}$/i.test(signature))
    return res
      .status(401)
      .json({
        error:
          "Webhook authentication is not configured or signature is missing.",
      });
  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest();
  const actual = Buffer.from(signature, "hex");
  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  )
    return res.status(401).json({ error: "Invalid webhook signature." });
  const {
    event,
    email,
    providerMessageId = "",
    provider = "normalized",
    providerEventId = `${event || "unknown"}:${providerMessageId}:${email || ""}:${req.body?.occurredAt || ""}`,
  } = req.body || {};
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();
  if (
    !["delivered", "bounced", "complained", "deferred"].includes(event) ||
    !/^\S+@\S+\.\S+$/.test(normalizedEmail)
  )
    return res
      .status(400)
      .json({
        error:
          "Expected event (delivered, bounced, complained, deferred) and a valid email.",
      });
  try {
    await ProviderEvent.create({
      provider: String(provider).slice(0, 60),
      providerEventId: String(providerEventId).slice(0, 200),
      event,
      email: normalizedEmail,
      providerMessageId: String(providerMessageId).slice(0, 200),
      occurredAt: req.body?.occurredAt
        ? new Date(req.body.occurredAt)
        : new Date(),
      payload: req.body,
    });
  } catch (e) {
    if (e.code === 11000)
      return res.status(200).json({ accepted: true, duplicate: true });
    throw e;
  }
  const recipient = recipients.find(
    (r) => r.email.toLowerCase() === normalizedEmail,
  );
  if (!recipient)
    return res.status(202).json({ accepted: true, matched: false });
  recipient.lastProviderEvent = event;
  recipient.lastProviderEventAt = now();
  recipient.providerMessageId = String(providerMessageId).slice(0, 200);
  if (providerMessageId)
    await Delivery.updateOne(
      { providerMessageId: String(providerMessageId) },
      {
        $set: {
          status: event === "delivered" ? "delivered" : event,
          ...(event === "delivered" ? { deliveredAt: new Date() } : {}),
        },
      },
    );
  if (event === "bounced" || event === "complained") {
    await Suppression.updateOne(
      { email: normalizedEmail },
      {
        $setOnInsert: {
          email: normalizedEmail,
          reason: event === "bounced" ? "hard_bounce" : "complaint",
          source: String(provider).slice(0, 60),
        },
      },
      { upsert: true },
    );
    recipient.status = "Suppressed";
    recipient.suppressionReason = event;
    recipient.suppressedAt = now();
  }
  logActivity({
    id: id(),
    type: "Deliverability",
    title: `Provider event: ${event}`,
    detail: normalizedEmail,
    time: now(),
    status:
      event === "bounced" || event === "complained" ? "Suppressed" : event,
  });
  persist();
  res
    .status(200)
    .json({ accepted: true, matched: true, status: recipient.status, event });
});
// Brevo native webhook adapter. Configure the webhook's custom header token as BREVO_WEBHOOK_TOKEN.
app.post("/api/webhooks/brevo", async (req, res) => {
  const expected = String(process.env.BREVO_WEBHOOK_TOKEN || "");
  const supplied = String(req.headers["x-brevo-webhook-token"] || "");
  if (
    expected.length < 32 ||
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  )
    return res
      .status(401)
      .json({ error: "Invalid Brevo webhook authentication." });
  const items = Array.isArray(req.body) ? req.body : [req.body || {}];
  const mapped = {
    delivered: "delivered",
    hard_bounce: "bounced",
    hardbounce: "bounced",
    soft_bounce: "deferred",
    softbounce: "deferred",
    spam: "complained",
    complaint: "complained",
    unsubscribed: "complained",
    blocked: "deferred",
  };
  let accepted = 0;
  for (const item of items) {
    const event = mapped[String(item.event || "").toLowerCase()];
    const email = String(item.email || item.to || "")
      .trim()
      .toLowerCase();
    if (!event || !/^\S+@\S+\.\S+$/.test(email)) continue;
    const eventId = String(
      item.id ||
        item["message-id"] ||
        `${event}:${email}:${item.date || item.ts || ""}`,
    ).slice(0, 200);
    try {
      await ProviderEvent.create({
        provider: "brevo",
        providerEventId: eventId,
        event,
        email,
        providerMessageId: String(item["message-id"] || "").slice(0, 200),
        occurredAt: item.date ? new Date(item.date) : new Date(),
        payload: item,
      });
    } catch (e) {
      if (e.code === 11000) continue;
      throw e;
    }
    const recipient = recipients.find((r) => r.email.toLowerCase() === email);
    if (recipient) {
      recipient.lastProviderEvent = event;
      recipient.lastProviderEventAt = now();
      recipient.providerMessageId = String(item["message-id"] || "").slice(
        0,
        200,
      );
      if (event === "bounced" || event === "complained") {
        await Suppression.updateOne(
          { email },
          {
            $setOnInsert: {
              email,
              reason: event === "bounced" ? "hard_bounce" : "complaint",
              source: "brevo webhook",
            },
          },
          { upsert: true },
        );
        recipient.status = "Suppressed";
        recipient.suppressedAt = now();
        recipient.suppressionReason = event;
      }
    }
    if (item["message-id"])
      await Delivery.updateOne(
        { providerMessageId: String(item["message-id"]) },
        {
          $set: {
            status: event,
            ...(event === "delivered" ? { deliveredAt: new Date() } : {}),
          },
        },
      );
    logActivity({
      id: id(),
      type: "Deliverability",
      title: `Brevo event: ${event}`,
      detail: email,
      time: now(),
      status: event,
    });
    accepted++;
  }
  persist();
  res.json({ accepted });
});
app.get("/api/auth/bootstrap-status", async (_req, res) => {
  res.json({ needsOwner: (await User.countDocuments()) === 0 });
});
app.post("/api/auth/bootstrap", bootstrapLimiter, async (req, res) => {
  try {
    if (await User.countDocuments())
      return res
        .status(409)
        .json({ error: "Initial Owner has already been created." });

    // Read the value from the explicitly loaded server/.env. Trim accidental whitespace
    // from copied values, then compare equal-length UTF-8 buffers in constant time.
    const expected = cleanToken(process.env.OWNER_SETUP_TOKEN);
    const supplied = cleanToken(req.body?.setupToken);
    const expectedBytes = Buffer.from(expected, "utf8");
    const suppliedBytes = Buffer.from(supplied, "utf8");
    if (expectedBytes.length < 32) {
      console.error(
        "Owner setup is disabled: OWNER_SETUP_TOKEN is missing or shorter than 32 bytes in server/.env.",
      );
      return res
        .status(503)
        .json({
          error:
            "Owner setup is not configured on the server. Check server/.env for one OWNER_SETUP_TOKEN value (32+ characters), then restart the backend.",
        });
    }
    if (
      suppliedBytes.length !== expectedBytes.length ||
      !crypto.timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
      return res
        .status(403)
        .json({
          error: `The Owner setup token does not match. You entered ${suppliedBytes.length} characters (fingerprint ${suppliedBytes.length ? tokenFingerprint(supplied) : "-"}); the backend expects ${expectedBytes.length} characters (fingerprint ${tokenFingerprint(expected)}). Run 'npm run owner-token' in server/, restart the backend, and paste the printed token.`,
        });
    }

    const { name, email, password } = req.body || {};
    if (
      !name ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "")) ||
      String(password || "").length < 12
    ) {
      return res
        .status(400)
        .json({
          error:
            "Provide a name, valid email, and password of at least 12 characters.",
        });
    }
    const user = await User.create({
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      passwordHash: await hashPassword(password),
      role: "Owner",
    });
    res.cookie("gm_session", signToken(user), cookieOptions);
    logActivity({
      id: id(),
      type: "Security",
      title: "Workspace Owner created",
      detail: `Initial Owner account ${user.email} was created.`,
      time: now(),
      status: "Complete",
    });
    persist();
    res.status(201).json({ user: publicUser(user) });
  } catch (e) {
    console.error("Owner setup failed:", e.message);
    res
      .status(400)
      .json({
        error:
          e.code === 11000 ? "This email is already registered." : e.message,
      });
  }
});
app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();
    const user = await User.findOne({ email }).select("+passwordHash");
    if (
      !user ||
      !user.active ||
      !(await checkPassword(
        String(req.body?.password || ""),
        user.passwordHash,
      ))
    )
      return res.status(401).json({ error: "Email or password is incorrect." });
    user.lastLoginAt = new Date();
    await user.save();
    logActivity({
      id: id(),
      type: "Security",
      title: "Admin signed in",
      detail: user.email,
      time: now(),
      status: "Complete",
    });
    persist();
    res.cookie("gm_session", signToken(user), cookieOptions);
    res.json({ user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: "Could not sign in." });
  }
});
app.use("/api", (req, res, next) => {
  if (
    [
      "/health",
      "/auth/bootstrap-status",
      "/auth/bootstrap",
      "/auth/login",
      "/webhooks/normalized",
      "/webhooks/brevo",
    ].includes(req.path) ||
    req.path.startsWith("/public/unsubscribe/")
  )
    return next();
  return authMiddleware(req, res, next);
});
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("gm_session", { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
});
app.get("/api/auth/me", (req, res) => res.json({ user: publicUser(req.user) }));
app.post("/api/auth/change-password", loginLimiter, async (req, res) => {
  try {
    const current = String(req.body?.currentPassword || "");
    const next = String(req.body?.newPassword || "");
    if (next.length < 12)
      return res
        .status(400)
        .json({ error: "New password must be at least 12 characters." });
    const user = await User.findById(req.user._id).select("+passwordHash");
    if (!user || !(await checkPassword(current, user.passwordHash)))
      return res.status(400).json({ error: "Current password is incorrect." });
    user.passwordHash = await hashPassword(next);
    user.tokenVersion++;
    await user.save();
    res.clearCookie("gm_session", { ...cookieOptions, maxAge: undefined });
    res.json({ ok: true, message: "Password changed. Please sign in again." });
  } catch (e) {
    res.status(500).json({ error: "Could not change password." });
  }
});
app.get(
  "/api/admin/users",
  requirePermission("users:read"),
  async (_req, res) =>
    res.json((await User.find().sort({ createdAt: 1 })).map(publicUser)),
);
app.post(
  "/api/admin/users",
  requirePermission("users:write"),
  async (req, res) => {
    try {
      const { name, email, password, role } = req.body || {};
      if (
        !name ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "")) ||
        String(password || "").length < 12 ||
        !ROLE_PERMISSIONS[role] ||
        role === "Owner" ||
        (req.user.role === "Admin" && role === "Admin")
      )
        return res
          .status(400)
          .json({
            error:
              "Valid name/email, 12+ character password, and an allowed non-Owner role are required. Only the Owner can create another Admin.",
          });
      const user = await User.create({
        name,
        email,
        passwordHash: await hashPassword(password),
        role,
      });
      logActivity({
        id: id(),
        type: "Security",
        title: "Admin account created",
        detail: `${user.email} · ${role} · by ${req.user.email}`,
        time: now(),
        status: "Complete",
      });
      persist();
      res.status(201).json(publicUser(user));
    } catch (e) {
      res
        .status(400)
        .json({
          error:
            e.code === 11000 ? "This email is already registered." : e.message,
        });
    }
  },
);
app.patch(
  "/api/admin/users/:id",
  requirePermission("users:write"),
  async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Admin not found." });
    if (user.role === "Owner")
      return res
        .status(403)
        .json({ error: "Owner account cannot be changed here." });
    if (
      req.body.role &&
      req.body.role !== "Owner" &&
      ROLE_PERMISSIONS[req.body.role]
    )
      user.role = req.body.role;
    if (typeof req.body.active === "boolean") user.active = req.body.active;
    if (req.body.password) {
      if (String(req.body.password).length < 12)
        return res
          .status(400)
          .json({ error: "Password must be at least 12 characters." });
      user.passwordHash = await hashPassword(req.body.password);
      user.tokenVersion++;
    }
    await user.save();
    logActivity({
      id: id(),
      type: "Security",
      title: "Admin account updated",
      detail: `${user.email} · by ${req.user.email}`,
      time: now(),
      status: "Complete",
    });
    persist();
    res.json(publicUser(user));
  },
);
app.delete(
  "/api/admin/users/:id",
  requirePermission("users:write"),
  async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Admin not found." });
    if (user.role === "Owner" || user.id === req.user.id)
      return res
        .status(403)
        .json({ error: "Owner or your own account cannot be deleted." });
    await user.deleteOne();
    logActivity({
      id: id(),
      type: "Security",
      title: "Admin account deleted",
      detail: `${user.email} · by ${req.user.email}`,
      time: now(),
      status: "Complete",
    });
    persist();
    res.json({ ok: true });
  },
);
// Route-level permissions: authentication alone never grants write or send access.
app.use("/api", (req, res, next) => {
  const p = req.path,
    m = req.method;
  let permission = null;
  if (p.startsWith("/admin/users"))
    permission = m === "GET" ? "users:read" : "users:write";
  else if (p.includes("/send") && m === "POST") permission = "campaigns:send";
  else if (p.startsWith("/campaigns"))
    permission = ["POST", "DELETE", "PATCH", "PUT"].includes(m)
      ? "campaigns:write"
      : "campaigns:read";
  else if (p.startsWith("/recipients"))
    permission = ["POST", "DELETE", "PATCH", "PUT"].includes(m)
      ? "recipients:write"
      : "recipients:read";
  else if (p.startsWith("/templates"))
    permission = ["POST", "DELETE", "PATCH", "PUT"].includes(m)
      ? "templates:write"
      : "templates:read";
  else if (p === "/settings")
    permission = m === "PUT" ? "settings:write" : "settings:read";
  else if (p === "/senders" || p === "/smtp/verify") permission = "smtp:read";
  else if (p === "/test-email") permission = "smtp:send";
  else if (p === "/activity" || p === "/queue/status")
    permission = "activity:read";
  else if (p === "/ai/draft") permission = "campaigns:write";
  if (!permission) return next();
  return requirePermission(permission)(req, res, next);
});
app.get("/api/ai/status", (_, res) =>
  res.json({
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  }),
);
app.post("/api/ai/draft", async (req, res) => {
  const topic = String(req.body?.topic || "").trim();
  if (!topic || topic.length > 1000)
    return res
      .status(400)
      .json({ error: "Describe the email in 1–1000 characters." });
  if (!process.env.OPENAI_API_KEY)
    return res
      .status(503)
      .json({
        error:
          "AI writing is not configured. Add OPENAI_API_KEY to server/.env and restart the API. You can still write and save campaigns manually.",
      });
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  try {
    const response = await fetch(
      process.env.OPENAI_API_URL ||
        "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.5,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You help draft clear, honest, permission-based business emails. Never invent facts, false urgency, testimonials, or claims. Do not write deceptive subject lines. Return JSON only with keys subject and body. Keep subject under 100 characters, body concise, use {{name}} for recipient personalization when natural, and include a simple unsubscribe reminder only if this is marketing. This is a draft for human review, never send it.",
            },
            {
              role: "user",
              content: `Create an email draft based on this brief. If business facts are missing, use neutral wording and placeholders instead of inventing details. Brief: ${topic}`,
            },
          ],
        }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      return res
        .status(response.status === 429 ? 429 : 502)
        .json({
          error:
            data?.error?.message ||
            "AI provider request failed. Check API key, billing, and model settings.",
        });
    const content = data?.choices?.[0]?.message?.content;
    let draft;
    try {
      draft = JSON.parse(content || "{}");
    } catch {
      throw new Error(
        "AI provider returned an invalid draft format. Please try again.",
      );
    }
    const subject = String(draft.subject || "")
      .trim()
      .slice(0, 180);
    const body = String(draft.body || "")
      .trim()
      .slice(0, 10000);
    if (!subject || !body)
      throw new Error(
        "AI provider returned an incomplete draft. Please try again.",
      );
    res.json({ subject, body, model });
  } catch (e) {
    res
      .status(502)
      .json({ error: e.message || "Could not generate an AI draft." });
  }
});
// Credentials remain server-side. The browser receives profile labels and masked usernames only.
app.get("/api/senders", (_, res) =>
  res.json(
    allSenderConfigs().map((s) => ({
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      configured: s.configured,
      user: s.user ? `${s.user.slice(0, 2)}••••` : "",
    })),
  ),
);
app.get("/api/dashboard", (_, res) => {
  const emails = activity.filter((a) => a.type === "Email");
  res.json({
    recipients: recipients.length,
    campaigns: campaigns.length,
    sent: emails.filter(
      (a) => a.status === "Accepted by provider" || a.status === "Sent",
    ).length,
    acceptedByProvider: emails.filter(
      (a) => a.status === "Accepted by provider" || a.status === "Sent",
    ).length,
    delivered: recipients.filter((r) => r.lastProviderEvent === "delivered")
      .length,
    bounced: recipients.filter((r) => r.lastProviderEvent === "bounced").length,
    complained: recipients.filter((r) => r.lastProviderEvent === "complained")
      .length,
    suppressed: recipients.filter(
      (r) => r.status === "Suppressed" || r.status === "Unsubscribed",
    ).length,
    failed: emails.filter((a) => a.status === "Failed").length,
    configured: settings.configured,
    recent: activity.slice(0, 6),
  });
});
app.get("/api/queue/status", async (_req, res) => {
  try {
    res.json({
      queue: "gmail-mailer-delivery",
      ...(await getEmailQueueStats()),
    });
  } catch {
    res
      .status(503)
      .json({ error: "Queue status unavailable. Check Redis connectivity." });
  }
});
app.get("/api/recipients", (_, res) => res.json(recipients));
app.post("/api/recipients", (req, res) => {
  const {
    name = "",
    email = "",
    group = "Newsletter",
    consentConfirmed = false,
    consentSource = "manual",
  } = req.body || {};
  if (!/^\S+@\S+\.\S+$/.test(email))
    return res.status(400).json({ error: "Enter a valid email address." });
  if (consentConfirmed !== true)
    return res
      .status(400)
      .json({
        error:
          "Confirm that this contact explicitly agreed to receive your emails.",
      });
  if (recipients.some((r) => r.email.toLowerCase() === email.toLowerCase()))
    return res
      .status(409)
      .json({ error: "That email address already exists." });
  const r = {
    id: id(),
    name: name.trim() || email.split("@")[0],
    email: email.trim(),
    group,
    status: "Subscribed",
    consentAt: now(),
    consentSource: String(consentSource).slice(0, 80),
    addedAt: now(),
  };
  recipients.unshift(r);
  persist();
  res.status(201).json(r);
});
app.post("/api/recipients/import", (req, res) => {
  if (!Array.isArray(req.body?.recipients))
    return res.status(400).json({ error: "Expected recipients array." });
  let added = 0,
    withoutConsent = 0;
  for (const x of req.body.recipients) {
    const email = String(x.email || "").trim();
    const consent = ["true", "yes", "1", "subscribed"].includes(
      String(x.consent || "")
        .trim()
        .toLowerCase(),
    );
    if (
      !/^\S+@\S+\.\S+$/.test(email) ||
      recipients.some((r) => r.email.toLowerCase() === email.toLowerCase())
    )
      continue;
    if (!consent) {
      withoutConsent++;
      continue;
    }
    recipients.push({
      id: id(),
      name: String(x.name || email.split("@")[0]),
      email,
      group: String(x.group || "Imported"),
      status: "Subscribed",
      consentAt: now(),
      consentSource: "CSV import",
      addedAt: now(),
    });
    added++;
  }
  persist();
  res.json({ added, withoutConsent, total: recipients.length });
});
app.get("/api/campaigns", (_, res) => res.json(campaigns.map(publicCampaign)));
app.post("/api/campaigns", (req, res) => {
  const { name, subject, body } = req.body || {};
  if (
    !String(name || "").trim() ||
    !String(subject || "").trim() ||
    !String(body || "").trim()
  )
    return res
      .status(400)
      .json({ error: "Campaign name, subject, and message are required." });
  const c = {
    id: id(),
    name: String(name).trim(),
    subject: String(subject).trim(),
    body: String(body),
    status: "Draft",
    recipients: recipients.filter(isEligibleRecipient).length,
    createdAt: now(),
    sentAt: null,
  };
  campaigns.unshift(c);
  persist();
  res.status(201).json(publicCampaign(c));
});
// Attach a PDF (or other file) to a campaign. Stored in server memory, sent with every message.
app.post("/api/campaigns/:id/attachment", upload.single("file"), (req, res) => {
  const c = campaigns.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Campaign not found." });
  if (!req.file)
    return res
      .status(400)
      .json({ error: 'No file uploaded. Field name must be "file".' });
  if (
    !req.file.originalname.toLowerCase().endsWith(".pdf") ||
    req.file.buffer.subarray(0, 5).toString() !== "%PDF-"
  )
    return res
      .status(415)
      .json({ error: "Only valid PDF attachments are supported." });
  c.attachment = {
    filename: Buffer.from(req.file.originalname, "latin1").toString("utf8"),
    mimetype: req.file.mimetype,
    buffer: req.file.buffer,
    size: req.file.size,
  };
  persist();
  res.json({
    ok: true,
    filename: c.attachment.filename,
    size: c.attachment.size,
  });
});
app.delete("/api/campaigns/:id/attachment", (req, res) => {
  const c = campaigns.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Campaign not found." });
  delete c.attachment;
  persist();
  res.json({ ok: true });
});

// Starts sending to the whole subscribed list automatically, one message at a time, paced so
// Gmail/Yahoo/Outlook don't flag the sender as a spam blaster. Returns immediately; poll
// GET /api/campaigns/:id/send/status for progress — no manual per-recipient clicking needed.
app.post(
  "/api/campaigns/:id/send",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Too many campaign start requests. Wait before trying again.",
    },
  }),
  async (req, res) => {
    const c = campaigns.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "Campaign not found." });
    if (c.sendProgress?.running)
      return res
        .status(409)
        .json({ error: "This campaign is already sending." });
    const retryFailed = req.body?.retryFailed === true;
    const previousProgress = c.sendProgress;
    const failedEmails = retryFailed
      ? (previousProgress?.results || [])
          .filter((x) => x.status === "Failed")
          .map((x) => x.email)
      : [];
    const alreadySent = new Set(
      (previousProgress?.results || [])
        .filter((x) => ["Sent", "Accepted by provider"].includes(x.status))
        .map((x) => x.email.toLowerCase()),
    );
    const batchSize = Math.min(
      500,
      Math.max(1, Number.parseInt(req.body?.batchSize, 10) || 400),
    );
    const eligibleAudience = retryFailed
      ? recipients.filter(
          (r) => isEligibleRecipient(r) && failedEmails.includes(r.email),
        )
      : recipients.filter(
          (r) =>
            isEligibleRecipient(r) && !alreadySent.has(r.email.toLowerCase()),
        );
    // A campaign run is intentionally capped at 500 opted-in recipients. Run it again
    // to continue with the next page; accepted recipients are excluded from later runs.
    const audience = eligibleAudience.slice(0, batchSize);
    if (!audience.length)
      return res
        .status(400)
        .json({
          error: retryFailed
            ? "There are no failed, currently subscribed recipients to retry."
            : alreadySent.size
              ? "All currently subscribed recipients already received this campaign. Create a new campaign if you intentionally want to send it again."
              : "No eligible, consented, non-suppressed recipients are available.",
        });
    const senderProfiles = allSenderConfigs();
    if (
      req.body?.senderId &&
      !senderProfiles.some((s) => s.id === req.body.senderId)
    )
      return res
        .status(400)
        .json({
          error:
            "Unknown sender profile. Refresh Settings and select a configured profile.",
        });
    const sender = smtpConfig(req.body?.senderId);
    const live = Boolean(sender.configured);
    if (live) {
      try {
        await verifyProvider({ provider: sender.provider, sender });
      } catch (e) {
        console.error("Provider verify failed:", e);
        return res.status(400).json({ error: friendlyError(e) });
      }
    }
    const delayMs = Math.max(
      MIN_SEND_DELAY_MS,
      Number(req.body?.delayMs) || MIN_SEND_DELAY_MS,
    );
    c.sendProgress = {
      running: true,
      paused: false,
      cancelRequested: false,
      retryingFailed: retryFailed,
      total: audience.length,
      done: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      firstError: "",
      senderId: sender.id,
      senderName: sender.name,
      startedAt: now(),
      results: previousProgress?.results || [],
    };
    c.status = "Sending";
    await flushStore();
    try {
      // Fan out one durable BullMQ job per recipient. Stable job IDs prevent duplicate enqueue.
      for (let offset = 0; offset < audience.length; offset += 500) {
        const batch = audience.slice(offset, offset + 500);
        await addEmailJobsBulk(
          batch.map((r) => ({
            name: "send-recipient",
            data: {
              campaignId: c.id,
              recipientId: r.id,
              senderId: sender.id,
              delayMs,
              live,
            },
            opts: {
              jobId: `delivery-${c.id}-${r.id}`,
              attempts: 5,
              backoff: { type: "exponential", delay: 5000 },
            },
          })),
        );
      }
    } catch (e) {
      c.sendProgress.running = false;
      c.status = "Queue error";
      await flushStore();
      return res
        .status(503)
        .json({
          error:
            "Could not enqueue campaign. Confirm Redis is running and retry.",
        });
    }
    res.json({
      started: true,
      total: audience.length,
      batchSize,
      remainingEligible: Math.max(0, eligibleAudience.length - audience.length),
      mode: live ? sender.provider : "demo",
      delayMs,
      message: live
        ? `${retryFailed ? "Retrying failed recipients" : "Sending campaign"} to ${audience.length} recipient(s), paced by ${delayMs} ms. You can pause, resume, or cancel from Campaigns.`
        : "DEMO MODE — SMTP not configured, nothing will be delivered.",
    });
  },
);
app.post("/api/campaigns/:id/send/pause", (req, res) => {
  const c = campaigns.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Campaign not found." });
  if (!c.sendProgress?.running)
    return res
      .status(409)
      .json({ error: "This campaign is not currently running." });
  c.sendProgress.paused = true;
  c.status = "Paused";
  persist();
  logActivity({
    id: id(),
    type: "Campaign",
    title: `Campaign paused: ${c.name}`,
    detail: "Sending paused by workspace operator.",
    time: now(),
    status: "Paused",
  });
  res.json({ ok: true, status: c.status, progress: c.sendProgress });
});
app.post("/api/campaigns/:id/send/resume", (req, res) => {
  const c = campaigns.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Campaign not found." });
  if (!c.sendProgress?.running || !c.sendProgress.paused)
    return res.status(409).json({ error: "This campaign is not paused." });
  c.sendProgress.paused = false;
  c.status = "Sending";
  persist();
  logActivity({
    id: id(),
    type: "Campaign",
    title: `Campaign resumed: ${c.name}`,
    detail: "Sending resumed by workspace operator.",
    time: now(),
    status: "Sending",
  });
  res.json({ ok: true, status: c.status, progress: c.sendProgress });
});
app.post("/api/campaigns/:id/send/cancel", (req, res) => {
  const c = campaigns.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Campaign not found." });
  if (!c.sendProgress?.running)
    return res
      .status(409)
      .json({ error: "This campaign is not currently running." });
  c.sendProgress.cancelRequested = true;
  c.sendProgress.paused = false;
  persist();
  logActivity({
    id: id(),
    type: "Campaign",
    title: `Campaign cancellation requested: ${c.name}`,
    detail: "The worker will stop before processing the next recipient.",
    time: now(),
    status: "Cancelled",
  });
  res.json({
    ok: true,
    message:
      "Cancellation requested. The current SMTP operation, if any, may finish first.",
  });
});
app.get("/api/campaigns/:id/send/status", (req, res) => {
  const c = campaigns.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Campaign not found." });
  res.json({ progress: c.sendProgress || null, status: c.status });
});
app.get("/api/smtp/verify", async (req, res) => {
  const sender = smtpConfig(req.query.senderId);
  if (!sender.configured)
    return res
      .status(400)
      .json({ ok: false, error: notConfiguredMessage(sender) });
  try {
    await verifyProvider({ provider: sender.provider, sender });
    res.json({
      ok: true,
      message: `${sender.provider.toUpperCase()} provider credentials verified. This does not verify inbox placement.`,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: friendlyError(e) });
  }
});
app.post(
  "/api/test-email",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many test emails. Wait before trying again." },
  }),
  async (req, res) => {
    const sender = smtpConfig(req.body?.senderId);
    if (!sender.configured)
      return res.status(400).json({ error: notConfiguredMessage(sender) });
    const to = String(req.body?.to || sender.fromEmail || sender.user).trim();
    if (!/^\S+@\S+\.\S+$/.test(to))
      return res.status(400).json({ error: "Enter a valid email address." });
    try {
      const mail = buildMail(
        {
          subject: "Test email from Gmail Mailer",
          body: "Hi {{name}},\n\nThis is a test message. If you can read this, sending works.",
        },
        { name: to.split("@")[0], email: to },
        sender,
      );
      const info = await sendThroughProvider({
        provider: sender.provider,
        sender,
        mail,
      });
      if (info.rejected?.length)
        throw new Error(`Recipient rejected: ${info.rejected.join(", ")}`);
      logActivity({
        id: id(),
        type: "Email",
        title: `Test email accepted by provider: ${to}`,
        detail: `${info.response || ""} · SMTP acceptance is not delivery or Inbox placement.`,
        time: now(),
        status: "Accepted by provider",
      });
      persist();
      res.json({
        ok: true,
        message: `The SMTP provider accepted the test message for ${to}. This does not confirm mailbox delivery or Inbox placement. Check provider events and the recipient's Inbox/Spam folders.`,
        response: info.response,
      });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: friendlyError(e) });
    }
  },
);
app.patch("/api/recipients/:id", (req, res) => {
  const r = recipients.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Recipient not found." });
  const { status, name, group, consentConfirmed } = req.body || {};
  if (status !== undefined) {
    if (!["Subscribed", "Unsubscribed"].includes(status))
      return res
        .status(400)
        .json({ error: "Status must be Subscribed or Unsubscribed." });
    if (status === "Subscribed" && consentConfirmed !== true)
      return res
        .status(400)
        .json({
          error:
            "Explicitly confirm renewed consent before resubscribing this contact.",
        });
    r.status = status;
    if (status === "Subscribed") {
      if (
        r.suppressedAt ||
        ["bounced", "complained"].includes(r.lastProviderEvent)
      )
        return res
          .status(409)
          .json({
            error:
              "This address is suppressed after a bounce or complaint and cannot be re-subscribed from this screen.",
          });
      r.consentAt = now();
      r.consentSource = "manual resubscription confirmation";
      delete r.unsubscribedAt;
    } else {
      r.unsubscribedAt = now();
    }
  }
  if (name !== undefined && String(name).trim()) r.name = String(name).trim();
  if (group !== undefined && String(group).trim())
    r.group = String(group).trim();
  persist();
  res.json(r);
});
app.delete("/api/recipients/:id", (req, res) => {
  const i = recipients.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Recipient not found." });
  recipients.splice(i, 1);
  persist();
  res.json({ ok: true });
});
app.delete("/api/campaigns/:id", (req, res) => {
  const i = campaigns.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Campaign not found." });
  if (campaigns[i].sendProgress?.running)
    return res
      .status(409)
      .json({
        error: "This campaign is sending right now. Wait until it finishes.",
      });
  campaigns.splice(i, 1);
  persist();
  res.json({ ok: true });
});
app.delete("/api/templates/:id", (req, res) => {
  const i = templates.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Template not found." });
  templates.splice(i, 1);
  persist();
  res.json({ ok: true });
});
app.get("/api/activity", (_, res) => res.json(activity));
app.get("/api/templates", (_, res) => res.json(templates));
app.post("/api/templates", (req, res) => {
  const { name, subject, body } = req.body || {};
  if (!name || !subject || !body)
    return res
      .status(400)
      .json({ error: "Name, subject, and body are required." });
  const t = { id: id(), name, subject, body };
  templates.unshift(t);
  persist();
  res.status(201).json(t);
});
app.get("/api/settings", (_, res) => res.json(publicSettings()));
app.put("/api/settings", (req, res) => {
  const { fromName, fromEmail } = req.body || {};
  if (fromName !== undefined) settings.fromName = String(fromName);
  if (fromEmail !== undefined) settings.fromEmail = String(fromEmail);
  persist();
  res.json(publicSettings());
});
// Durable worker: BullMQ persists the job in Redis and recovers stalled work after restart.
emailWorker = createEmailWorker(async (job) => {
  const { campaignId, recipientId, senderId, delayMs, live } = job.data;
  const c = campaigns.find((x) => x.id === campaignId);
  if (!c || !c.sendProgress) return;
  const r = recipients.find((x) => x.id === recipientId);
  if (!r) return;
  c.sendProgress.running = true;
  c.status = "Sending";
  while (c.sendProgress?.paused && !c.sendProgress?.cancelRequested)
    await sleep(300);
  if (!c.sendProgress || c.sendProgress.cancelRequested) return;
  const dbSuppressed = await Suppression.exists({
    email: String(r.email).toLowerCase(),
  });
  if (!isEligibleRecipient(r) || dbSuppressed) {
    const outcome = {
      recipientId: r.id,
      email: r.email,
      status: "Skipped",
      detail:
        "Consent withdrawn, invalid, unsubscribed, bounced, or complained before send.",
      time: now(),
    };
    c.sendProgress.done++;
    c.sendProgress.skipped++;
    c.sendProgress.results.push(outcome);
    logActivity({
      id: id(),
      type: "Email",
      title: `Skipped: ${r.email}`,
      detail: outcome.detail,
      time: now(),
      status: "Skipped",
    });
    persist();
  } else {
    const sender = smtpConfig(senderId);
    if (live && !sender.configured)
      throw new Error("Selected provider is no longer configured.");
    let delivery = null;
    if (live) {
      delivery = await Delivery.findOne({ campaignId, recipientId });
      if (
        delivery?.status === "accepted_by_provider" ||
        delivery?.status === "delivered"
      ) {
        c.sendProgress.done++;
        c.sendProgress.sent++;
      } else {
        if (
          delivery?.status === "sending" &&
          job.attemptsMade === 0 &&
          delivery.leaseAt &&
          Date.now() - delivery.leaseAt.getTime() < 10 * 60 * 1000
        )
          return;
        try {
          if (delivery) {
            delivery.status = "sending";
            delivery.leaseAt = new Date();
            delivery.attempts += 1;
            delivery.provider = sender.provider;
            await delivery.save();
          } else
            delivery = await Delivery.create({
              campaignId,
              recipientId,
              email: r.email,
              provider: sender.provider,
              status: "sending",
              leaseAt: new Date(),
              attempts: 1,
            });
        } catch (e) {
          if (e.code === 11000) return;
          throw e;
        }
        try {
          const info = await sendThroughProvider({
            provider: sender.provider,
            sender,
            mail: buildMail(c, r, sender),
          });
          const detail = `${sender.provider} accepted the message; mailbox delivery and Inbox placement are not confirmed. ${info.messageId || ""}`;
          delivery.status = "accepted_by_provider";
          delivery.providerMessageId = info.messageId || "";
          delivery.acceptedAt = new Date();
          delivery.lastError = "";
          await delivery.save();
          c.sendProgress.done++;
          c.sendProgress.sent++;
          const outcome = {
            recipientId: r.id,
            email: r.email,
            status: "Accepted by provider",
            detail,
            time: now(),
          };
          c.sendProgress.results.push(outcome);
          logActivity({
            id: id(),
            type: "Email",
            title: `Accepted by provider: ${r.email}`,
            detail,
            time: now(),
            status: "Accepted by provider",
          });
        } catch (e) {
          const detail = friendlyError(e);
          delivery.status = "failed";
          delivery.lastError = detail;
          await delivery.save();
          c.sendProgress.done++;
          c.sendProgress.failed++;
          c.sendProgress.firstError ||= detail;
          c.sendProgress.results.push({
            recipientId: r.id,
            email: r.email,
            status: "Failed",
            detail,
            time: now(),
          });
          logActivity({
            id: id(),
            type: "Email",
            title: `Failed: ${r.email}`,
            detail,
            time: now(),
            status: "Failed",
          });
          const retryAfter = Number(e?.retryAfter || 0);
          const backoff =
            retryAfter > 0
              ? retryAfter * 1000
              : Math.min(
                  MAX_SEND_DELAY_MS,
                  Math.max(
                    MIN_SEND_DELAY_MS,
                    Number(delayMs) || MIN_SEND_DELAY_MS,
                  ) * 2,
                );
          if (
            e?.code === "RATE_LIMIT" ||
            [421, 429, 450, 451, 452].includes(
              Number(e?.statusCode || e?.responseCode || 0),
            ) ||
            isRetryableSmtpError(e)
          )
            await sleep(Math.min(120000, backoff));
        }
      }
    } else {
      c.sendProgress.done++;
      c.sendProgress.sent++;
      c.sendProgress.results.push({
        recipientId: r.id,
        email: r.email,
        status: "Demo",
        detail: `${c.name} · ${c.subject}`,
        time: now(),
      });
    }
    persist();
    const idx = c.sendProgress.results.findIndex(
      (x, i) =>
        x.email.toLowerCase() === r.email.toLowerCase() &&
        i < c.sendProgress.results.length - 1,
    );
    if (idx >= 0) c.sendProgress.results.splice(idx, 1);
  }
  if (c.sendProgress.done >= c.sendProgress.total) {
    c.sendProgress.running = false;
    c.sendProgress.paused = false;
    c.sendProgress.finishedAt = now();
    c.status = c.sendProgress.cancelRequested
      ? "Cancelled"
      : !live
        ? "Demo complete"
        : c.sendProgress.failed
          ? "Completed with errors"
          : c.sendProgress.sent
            ? "Accepted by provider"
            : "Not sent";
    c.sentAt = now();
    persist();
  }
});
emailWorker.on("error", (err) =>
  console.error("BullMQ worker error:", err.message),
);
emailWorker.on("failed", (job, err) => {
  if (job && job.attemptsMade >= Number(job.opts.attempts || 1)) {
    console.error("Durable email job failed:", job.id, err.message);
    const c = campaigns.find((x) => x.id === job.data?.campaignId);
    if (c?.sendProgress) {
      c.sendProgress.running = false;
      c.status = "Interrupted";
      c.sendProgress.firstError ||= friendlyError(err);
      persist();
    }
  }
});
app.use("/api", (_, res) =>
  res.status(404).json({ error: "Unknown API endpoint." }),
);
if (hasDist) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api\/).*/, (_, res) =>
    res.sendFile(path.join(DIST, "index.html")),
  );
}
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError)
    return res
      .status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      .json({
        error:
          err.code === "LIMIT_FILE_SIZE"
            ? "File is too large. The maximum size is 10 MB."
            : err.message,
      });
  if (err?.type === "entity.parse.failed")
    return res.status(400).json({ error: "Invalid JSON body." });
  if (err?.type === "entity.too.large")
    return res.status(413).json({ error: "Request body is too large." });
  console.error(err);
  res.status(500).json(safeError(err));
});
const port = Number(process.env.PORT || 5000);
const host = process.env.HOST || "127.0.0.1";
app.listen(port, host, () =>
  console.log(`Gmail Mailer API listening on http://${host}:${port}`),
);
