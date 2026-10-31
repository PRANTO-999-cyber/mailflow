# Changelog

## 1.6.0 — MongoDB persistence, safer startup, diagnostics
- Campaigns, recipients, templates, activity, sender settings and PDF attachments are now saved in MongoDB (collection `app_store`) instead of `server/data.json`. Saves are diff-based (only changed documents are written), chunked for large lists, retried on failure, and flushed before a campaign is enqueued and on shutdown.
- Automatic one-time migration: if MongoDB has no app data and `server/data.json` exists, it is imported and the file is renamed to `data.json.migrated-<timestamp>` (kept as a backup). A corrupt `data.json` is copied to `data.json.corrupt-<timestamp>`.
- Startup now validates `server/.env` and stops with a clear message (JWT_SECRET, MONGODB_URI, EMAIL_PROVIDER, SMTP_SENDERS_JSON, production CLIENT_URL). Example secrets only warn in development, but are errors in production.
- Friendly MongoDB connection error (mentions Atlas Network Access).
- New `npm run doctor` (checks .env mistakes such as duplicate keys, MongoDB and Redis) and `npm run owner-token` (writes a fresh OWNER_SETUP_TOKEN).
- Owner setup: token is normalised (pasted `OWNER_SETUP_TOKEN=` prefix and quotes removed), `.env` overrides stale OS environment variables, and a mismatch reports expected/entered length and fingerprint (never the token).
- `/api/health` also reports save status and Redis queue status.
- Optional `Dockerfile` and `docker compose --profile app` service (not tested in the build environment).
- Added unit tests for the store, environment validation and token handling (`npm test`).
- Still true: route handlers work on in-memory copies loaded from MongoDB at start, so run ONE API instance per workspace. Running several instances needs the handlers rewritten to read/write MongoDB directly.

## 1.5.2 — Automated recipient batches and PDF API support
- Added selectable recipient batch sizes (100, 250, 400, 500) with a default of 400 per campaign run.
- Campaigns enqueue recipient jobs automatically; accepted recipients are excluded from subsequent runs, allowing the next eligible batch to be started without manual per-recipient sending.
- Enforced one globally active delivery job and a maximum queue start rate of one message per second across workers sharing the Redis queue. Provider-specific lower quotas still take precedence.
- Added Amazon SES v2 Raw MIME sending for PDF attachments, retaining the Simple API path for attachment-free messages.
- Existing CSV consent checks, PDF upload validation, pause/resume/cancel controls, and SMTP/Brevo/SES provider selection are retained.

## Important limitations
- The application still stores core campaign and recipient records in `server/data.json`; multi-instance API/worker operation is not certified.
- SES/Brevo production credentials, domain verification, provider webhooks, and account quotas must be configured by the operator.
- No inbox placement percentage is promised. Provider acceptance is not proof of mailbox delivery or Inbox placement.
