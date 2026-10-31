# Gmail Mailer — Premium Automated Campaign Workspace

A responsive midnight-navy email workspace with campaign drafts, CSV contacts, PDF attachments, paced background sending, progress tracking, API console, selectable server-side SMTP sender profiles, and an optional server-side AI writing assistant.

## Requirements
- Node.js 20+
- npm
- MongoDB 6+ (local or Atlas)
- Redis 6+ (local or managed Redis)

## Run locally
1. Extract the ZIP.
2. Open a terminal in the project folder.
3. Run `npm run install:all`
4. Copy `server/.env.example` to `server/.env`.
5. Start MongoDB and Redis.
6. Add `MONGODB_URI`, `REDIS_URL`, a unique `JWT_SECRET`, and a separate `OWNER_SETUP_TOKEN` (both secrets 32+ characters) to `server/.env`.
7. Run `npm run dev`. The Vite development server is pinned to `127.0.0.1:5173` with `strictPort`; if that port is occupied, Vite stops with a clear error instead of silently switching to 5174/5175/etc. Stop the other app using 5173 before restarting. The browser uses the same-origin `/api` path and Vite proxies API requests to `http://127.0.0.1:5000`.
8. Open http://localhost:5173 and create the first workspace Owner account. The setup screen is disabled after the first account is created. Enter the private `OWNER_SETUP_TOKEN` from `server/.env` during first-time setup.

If `concurrently` or `vite` is missing, run `npm run install:all` again and make sure it completes successfully. Keep only one backend process running: the development server intentionally does not use Node watch mode, so restart it manually after changing `server/.env` (Ctrl+C, then run `npm run dev --prefix server`).

## Manual API testing
The API Console supports GET, POST, PUT, PATCH, and DELETE requests, custom base URLs, JSON request bodies, HTTP status display, formatted response output, and quick endpoint presets. Default base URL: `/api` (goes through the Vite dev proxy to the backend, so there are no CORS problems). You can also use `http://localhost:5000/api` directly.

Examples:
- `GET /health`
- `GET /dashboard`
- `GET /campaigns`
- `POST /campaigns` with `{"name":"Test campaign","subject":"Hello {{name}}","body":"Hello {{name}}"}`
- `GET /recipients`
- `POST /recipients` with `{"name":"Test User","email":"you@example.com","group":"Newsletter"}`
- `POST /campaigns/PASTE_CAMPAIGN_ID/send`

## Configure real email delivery
Edit `server/.env` with SMTP credentials from your email provider. Restart the server after changing environment variables. Do not commit `.env` or expose SMTP credentials in frontend code. Gmail accounts typically require an App Password when 2-Step Verification is enabled; regular account passwords usually will not work.

Without SMTP settings, campaign sending stays in **demo mode** and does not deliver real email.

## Optional AI writing assistant

The campaign composer includes an AI assistant that can draft an email subject and message from a short brief. It is optional and does not send emails automatically. A human must review and save the draft before a campaign can be run.

To enable it, add these settings to `server/.env` and restart the API:

```dotenv
OPENAI_API_KEY=your-provider-api-key
OPENAI_MODEL=gpt-4o-mini
# Optional: leave empty to use the default OpenAI API endpoint
OPENAI_API_URL=
```

The API key stays on the server and is never returned to the browser. AI drafting sends the brief to the configured AI provider, so do not include passwords, personal secrets, or confidential recipient data in the brief. AI output can be inaccurate; verify every claim before sending. If no key is configured, the rest of the app continues to work and the AI feature shows a setup message.

## Multiple authorized sender profiles

The Settings page lists server-side SMTP profiles. To configure more than one, open `server/.env` and set `SMTP_SENDERS_JSON` to a JSON array. Each object accepts `id`, `name`, `host`, `port`, `user`, and `pass`. Use provider-approved credentials and choose one profile from the **Sending profile** selector on the Campaigns page. Passwords never go to the browser. The app deliberately does not rotate sender accounts to evade Gmail/Yahoo/Outlook sending quotas. Gmail accounts generally need an App Password; for larger campaigns, use a dedicated bulk-email provider with verified domain authentication and its approved quotas.

Example (replace every value; keep the whole JSON array on one line):

```dotenv
SMTP_SENDERS_JSON=[{"id":"gmail-work","name":"Work Gmail","host":"smtp.gmail.com","port":587,"user":"work@example.com","pass":"your-app-password"},{"id":"company-mail","name":"Company Mail","host":"smtp.example.com","port":587,"user":"mailer@example.com","pass":"your-smtp-password"}]
```

Restart the API after editing `.env`. The app only reports a message as sent when the SMTP provider accepts the send request; that does not guarantee inbox placement. PDF attachments are validated and limited to 10 MB.

## Data survives restarts
Recipients, campaigns, their attachments, templates, activity, and sender settings are saved to MongoDB (collection `app_store`) after every change and reloaded on startup. If you are upgrading from a version that used `server/data.json`, the file is imported automatically on first start and kept as `data.json.migrated-<timestamp>`. To reset the workspace to the sample data, drop the `app_store` collection.

## Auto-send to a whole list, with a PDF attachment
Open a campaign in **Campaigns**, click **Attach PDF** to add a file (it goes out with every message), then click **Run**. Sending starts in the background automatically — every subscribed recipient gets a message one after another, about 1.2 seconds apart, with no manual per-recipient clicking. A progress bar on the campaign row shows live sent/skipped/failed counts until it finishes. This pacing is intentional: firing hundreds of messages at once is the single biggest reason Gmail, Yahoo, Outlook, AOL and Hotmail mark a sender as spam, throttle it, or suspend the account — pacing protects your ability to keep sending at all. For large lists (hundreds of recipients), use a transactional email provider (SendGrid, Mailgun, Amazon SES) instead of a personal Gmail account.


## New campaign controls and safer retries

The Campaigns page now supports:
- **Pause / Resume / Cancel** for an active send. Cancel stops before the next recipient; a currently running SMTP request may finish first.
- **Recipient-level results** showing each address, outcome, timestamp, and provider/error detail.
- **Retry failed recipients** without re-sending to recipients already marked as accepted by SMTP. The retry uses the currently selected sender profile and only retries addresses that remain subscribed.
- **Export results to CSV** for reporting and reconciliation.
- **Duplicate-send guard**: running the same campaign again excludes recipients already marked `Sent`; create a new campaign if you intentionally need to send again.
- **Restart awareness**: BullMQ keeps queued jobs in Redis and recovers them after a worker restart. If a crash happens during an SMTP request, provider acceptance can be uncertain; inspect provider logs before retrying to avoid duplicate delivery.

SMTP acceptance is not the same as inbox placement or a confirmed read. Provider webhooks are required to track downstream delivery, bounces, complaints, and opens/clicks where available.

## Mail not arriving? Checklist
1. **`server/.env` must exist** (copy it from `server/.env.example`) and contain `SMTP_USER` + `SMTP_PASS`. Restart the API after editing. Without it the app is in DEMO mode and nothing is delivered.
2. **Gmail needs an App Password** (2-Step Verification on) — not your normal password.
3. Open **Settings → Send test email** (or `POST /api/test-email`) and use **Verify login** to see the exact error.
4. The sample recipients use `@example.com`, which cannot receive mail. They are skipped; **add your own email as a recipient**.
5. Not in Inbox? Check Spam/Promotions, mark "Not spam", and avoid mass-sending from a new Gmail account (limit ~500/day).

## Managing data
- **Recipients**: unsubscribe / resubscribe and delete from the Recipients page (`PATCH` / `DELETE /api/recipients/:id`). Unsubscribed contacts are never emailed.
- **Campaigns and templates** can be deleted (`DELETE /api/campaigns/:id`, `DELETE /api/templates/:id`). **Use template** pre-fills the new-campaign form.
- **CSV import** needs a header row with an `email` column (optional: `name`, `group`); quoted fields and commas inside quotes are supported.
- If `server/.env` still has the example values (`yourname@gmail.com`, `abcd efgh ijkl mnop`) the app stays in demo mode and tells you so.

## Recommended pre-send checklist

- Import only recipients who have permissioned/consented to receive the message.
- Review the recipient list and remove duplicates, invalid addresses, and suppressed/unsubscribed contacts.
- Send a test message to an inbox you control and inspect the PDF attachment.
- Confirm sender identity and domain authentication (SPF, DKIM, DMARC) with your provider.
- Start with a small approved test batch; use the provider's documented quotas and rate limits.
- Check provider logs for accepted/rejected messages. SMTP acceptance does not guarantee Inbox placement.
- Do not use multiple sender accounts to evade provider limits or spam controls.

## Production build
`npm run build` builds the client; `npm start` then serves the built app and the API together on port 5000.

## Multi-admin security and durable delivery (v1.2)

This version adds:
- Individual admin accounts stored in MongoDB; passwords are hashed with bcrypt.
- First-run Owner setup, sign-in, sign-out, eight-hour HttpOnly/SameSite session cookies, and rate-limited login attempts.
- Role-based permissions: Owner, Admin, Campaign Manager, Analyst, and Support. The API enforces permissions server-side.
- Owner/Admin team screen to create accounts with role assignments. Admin passwords must be at least 12 characters.
- BullMQ + Redis delivery queue with persistent jobs, one worker by default, controlled pacing, retry/backoff for worker-level failures, and restart recovery.
- Campaign/contact/template content is stored in MongoDB but the API works on an in-memory copy, so run one API instance against the shared Redis queue; this release does not provide multi-tenant workspace isolation.

### Required services

- **MongoDB** stores admin identities and authentication state.
- **Redis** stores durable BullMQ jobs. If Redis is unavailable, queue submission returns an error rather than silently sending in-process.
- Set a strong random `JWT_SECRET` and a separate `OWNER_SETUP_TOKEN` (each at least 32 characters). The setup token is required only to create the first Owner; keep it private. Never commit `server/.env`.

### Roles

| Role | Access |
|---|---|
| Owner | Full access, including team management |
| Admin | Workspace management, sending, and team administration (cannot edit/delete Owner) |
| Campaign Manager | Campaigns, sending, contacts, templates, activity, SMTP read |
| Analyst | Read-only campaign/contact/template/activity and configuration |
| Support | Read-only campaign/contact/activity and SMTP status |

### Important security limitations

This is a stronger team-ready foundation, not a fully audited enterprise deployment. MFA, password reset/email verification, audit trail for every admin action, centralized secrets vault, tenant isolation, MongoDB migration of campaign/contact data, and production deployment hardening are still future work. Use HTTPS in production, restrict network access to MongoDB/Redis, rotate credentials if exposed, and back up both MongoDB and `server/data.json`. To let other computers access the app, set `HOST=0.0.0.0` only on a trusted private network behind HTTPS/reverse-proxy controls and configure the exact frontend origin in `CLIENT_URL`; do not expose the development server directly to the public internet. SMTP acceptance is not guaranteed inbox placement. Follow provider quotas and send only to opted-in recipients.



## Security and reliability hardening (v1.3.0)

This update hardens the existing v1.2 foundation:

- Fixed cookie-session authentication: the API now parses the `gm_session` HttpOnly cookie, and CORS explicitly allows credentials only from the exact configured `CLIENT_URL`.
- Added Helmet security headers, disabled the Express fingerprint header, and added a global API request limit.
- Added strict Origin checks for browser state-changing requests to reduce CSRF risk. Keep `CLIENT_URL` set to the exact frontend origin; do not add wildcard origins.
- Added a unique MongoDB Owner-role index to prevent two simultaneous first-run setup requests from creating multiple Owners.
- Added an authenticated password-change flow; changing a password invalidates prior sessions.
- Added admin security events to the workspace activity log, including account creation, updates, deletion, Owner setup, and sign-in.
- Added dedicated rate limits for campaign starts and test-email sends.
- Added `/api/queue/status` for authenticated operators and a database-aware `/api/health` check.
- Added bounded retry/backoff for clearly transient SMTP connection and temporary 4xx errors. Permanent authentication/recipient errors are not retried. A timeout after provider acceptance can still be ambiguous and may cause a duplicate on retry.
- Added role-aware navigation and an Account Security panel.

### Important deployment boundaries

This remains a single-workspace application with campaign, recipient, template, and activity records stored in `server/data.json`. Run one API process/instance for this release; multiple API instances or horizontally scaled workers are not safe until workspace data and send-progress state are moved to shared MongoDB storage with atomic/idempotent delivery records. Redis/BullMQ makes queued jobs durable, but it does not make the current JSON data store multi-instance safe.

The current implementation is not a fully audited enterprise SaaS: MFA, email-based password reset, verified email onboarding, per-workspace tenant isolation, a dedicated immutable audit collection, automated bounce/complaint webhooks, and a real one-click unsubscribe landing page are not implemented. Do not expose this starter directly to the public internet. Use HTTPS behind a reverse proxy, restrict MongoDB/Redis network access, rotate any previously exposed credentials, and keep backups.

### Configuration notes

- `CLIENT_URL` must exactly match the browser frontend origin (scheme, host, and port). For the supplied local setup use `CLIENT_URL=http://localhost:5173` and open the app at exactly `http://localhost:5173` (not the `127.0.0.1` alias). Vite proxies `/api` to `http://127.0.0.1:5000`, so the browser does not call the API on a separate origin.
- `NODE_ENV=production` requires an exact `CLIENT_URL`; session cookies become Secure in production and therefore require HTTPS.
- Use a long random `JWT_SECRET` and a separate one-time `OWNER_SETUP_TOKEN`. Never commit `server/.env`.
- Redis must be reachable for campaign queueing. `/api/queue/status` reports waiting, active, delayed, completed, failed, and paused job counts.
- Run `npm run check` for backend syntax checks. Run `npm run build` after dependencies are installed to validate the frontend production build.


## High-volume safety foundation (v1.4.0)

This release adds:
- Consent confirmation is required when adding a recipient. CSV imports require a `consent` column (`yes`, `true`, `1`, or `subscribed`); contacts without recorded consent are skipped. Existing legacy `Subscribed` contacts without a `consentAt` timestamp are downgraded to `Needs consent` on load and are not eligible for campaign sending until permission is confirmed again.
- Resubscription requires an explicit confirmation. Unsubscribes are retained with a timestamp.
- RFC 8058-style one-click unsubscribe headers (`List-Unsubscribe` and `List-Unsubscribe-Post`) and a signed public unsubscribe endpoint are added. Set `PUBLIC_API_URL` to the public HTTPS API origin before production.
- Temporary SMTP throttling/transient errors increase the campaign's sending delay up to `MAX_SEND_DELAY_MS`; after a run of successful messages, the delay gradually decreases toward `MIN_SEND_DELAY_MS`. This is conservative adaptive pacing, not a provider quota bypass.
- Queue rate limiter can be configured with `QUEUE_MAX_PER_SECOND`; default remains 1 job/second.

### 100,000+ messages/day: deployment requirements and limits

The supplied project is **not yet a production-certified 100k/day multi-instance system**. The current campaign data and progress are still stored in `server/data.json`, and the campaign worker processes a campaign as one sequential job. Redis makes jobs durable, but it does not make this JSON state safe for multiple API instances or horizontally scaled workers. Do not deploy multiple API instances against this version.

At the default 1,200 ms gap, one sequential worker has a theoretical ceiling of about 72,000 messages per 24 hours before SMTP latency, retries, pauses, provider limits, and failures. Actual throughput will be lower. The new minimum is configurable down to 1,000 ms, but that still does not guarantee 100k/day. Do not lower it unless the selected provider has explicitly approved the corresponding throughput.

To reach 100k/day responsibly, the next production milestone must move recipients, campaigns, consent records, suppressions, and per-recipient delivery attempts into MongoDB with unique indexes and atomic state transitions; enqueue individual recipient jobs in bounded batches; use multiple workers with provider-specific token-bucket limits and distributed locks; add idempotency keys; and integrate authenticated bounce/complaint/delivery webhooks from the selected ESP. Configure an email service provider account (for example Amazon SES, Brevo, Mailgun, or another approved ESP) with an approved daily quota of at least the required volume, verified sending domain, DKIM, SPF, DMARC, and gradual reputation warm-up. Gmail SMTP remains suitable for low-volume one-to-one or small permission-based mail, not as the engine for 100k/day.

`SMTP_SENDERS_JSON` supports both Gmail SMTP and professional providers that expose SMTP credentials (such as SES SMTP or Brevo SMTP). Select a profile for a campaign; this is not automatic account rotation and must never be used to evade provider limits. For a real 100k/day launch, prefer the provider's native API/official SDK and webhook integration over generic SMTP.

### Provider configuration

Example profile shape (use the exact host, port, username, and password from the provider console; never copy sample credentials):

```dotenv
SMTP_SENDERS_JSON=[{"id":"gmail-low-volume","name":"Gmail small-volume","host":"smtp.gmail.com","port":587,"user":"your-account@gmail.com","pass":"your-app-password"},{"id":"ses-production","name":"Amazon SES production","host":"email-smtp.us-east-1.amazonaws.com","port":587,"user":"SES_SMTP_USERNAME","pass":"SES_SMTP_PASSWORD"}]
PUBLIC_API_URL=https://api.yourdomain.com
MIN_SEND_DELAY_MS=1200
MAX_SEND_DELAY_MS=60000
QUEUE_MAX_PER_SECOND=1
EMAIL_WORKER_CONCURRENCY=1
```

### Important status semantics

The dashboard's `Sent` status means the SMTP server accepted the message for processing. It does **not** mean the message was delivered to the mailbox or placed in Inbox. Inbox placement requires provider delivery/bounce/complaint events plus mailbox-provider reputation signals. Bounce and complaint webhook ingestion, provider-specific native APIs, domain-level analytics, and true multi-tenant MongoDB storage remain required production work.


## Deliverability and consent hardening (v1.4.1)

- Campaign audience selection now requires `status=Subscribed`, a recorded `consentAt`, a syntactically valid address, and no unsubscribe, suppression, hard-bounce, or complaint flag. Eligibility is rechecked immediately before each individual send so a recipient who unsubscribes while a campaign is queued is skipped.
- RFC 8058 one-click unsubscribe POSTs now suppress the address immediately without requiring an extra confirmation click. The GET URL remains a human-readable unsubscribe page.
- SMTP success is now labeled **Accepted by provider**, not Delivered or Inbox. Dashboard copy explicitly distinguishes provider acceptance from delivery and Inbox placement.
- Added a signed normalized provider-event endpoint (`POST /api/webhooks/normalized`). It accepts `delivered`, `bounced`, `complained`, and `deferred` events using an HMAC-SHA256 signature in `x-gm-webhook-signature` (hex, optionally prefixed `sha256=`). Set `PROVIDER_WEBHOOK_SECRET` to a random secret of at least 32 characters. A provider-specific adapter must first verify the original provider signature and normalize its event before forwarding it here. Hard bounces and complaints are suppressed automatically.
- Dashboard now separates provider acceptance, provider-reported delivery events, bounces, complaints, and suppressed/unsubscribed contacts.

### Normalized webhook example

```json
{
  "event": "bounced",
  "email": "person@example.org",
  "providerMessageId": "provider-message-id"
}
```

Sign the exact raw JSON request body with HMAC-SHA256 using `PROVIDER_WEBHOOK_SECRET`; send the lowercase hexadecimal digest in `x-gm-webhook-signature`. Do not expose this secret in the browser. Never accept unsigned provider events.

### Remaining production gates

This update does **not** make the app production-certified for 100,000+ emails/day. The current system still uses `server/data.json` for campaign/contact state and sequential campaign processing. Native Amazon SES/Brevo/Mailgun/etc. provider adapters, each provider's real webhook signature verification, MongoDB recipient/campaign migration, per-recipient idempotent jobs, distributed provider rate limiting, load/recovery testing, and operational monitoring are still required. Inbox placement is never guaranteed; monitor reputation and provider signals and follow the provider-approved quota.

## Version 1.5.0 — recipient-level queue and provider integration

This release adds per-recipient BullMQ jobs (batched enqueue), a MongoDB delivery ledger with a unique campaign/recipient key, a provider-event ledger, a durable global suppression collection, a Brevo native transactional API adapter, and a Brevo webhook endpoint. Gmail/SMTP remains supported as a separate transport. Set `EMAIL_PROVIDER=brevo`, `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, and `BREVO_WEBHOOK_TOKEN` in `server/.env` to configure Brevo. Configure the Brevo webhook to send the same token in the `x-brevo-webhook-token` header.

**Important deployment boundary:** campaign, recipient, template, settings and activity source data still resides in `server/data.json`/process memory. The current application is not yet safe to scale across multiple API/worker replicas. The MongoDB delivery/suppression ledgers are persistent, but this release is not a certified 100,000/day production system. See `docs/PRODUCTION-100K-ARCHITECTURE.md` for mandatory remaining migration, provider, security, load-test and recovery gates.

SMTP/API acceptance is not Inbox placement. `Delivered` is only recorded from a provider event. No Inbox delivery percentage is guaranteed.

## Amazon SES native API (v1.5.1)

Set the following in `server/.env` after enabling SES sending and verifying your sender identity/domain in the same AWS Region:

```env
EMAIL_PROVIDER=ses
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=
SES_FROM_EMAIL=mailer@your-verified-domain.com
SES_CONFIGURATION_SET=
```

Use an IAM principal restricted to the SES actions the application needs. Prefer workload roles/temporary credentials over long-lived keys in production. The SES API adapter currently sends text/HTML messages without attachments. The API response means SES accepted the request; it does not prove mailbox delivery or Inbox placement.

## Local infrastructure

`docker compose up -d mongodb redis` starts local MongoDB and Redis. This does not by itself complete the app's legacy JSON-to-MongoDB business-data migration.

## Important production status

Read [`docs/PRODUCTION-READINESS-AUDIT.md`](docs/PRODUCTION-READINESS-AUDIT.md) before deployment. This v1.5.1 archive is not certified for 100,000 recipients/day. The current legacy campaign/recipient/template/activity runtime still reads from `server/data.json` and uses process memory. Do not run multiple API/worker instances for live campaigns until the full MongoDB repository migration and stateless worker refactor are complete and tested. SES SNS signature verification and provider webhook reconciliation are also outstanding.


## v1.5.2 campaign automation
- Import only contacts with explicit permission using CSV columns `email`, `consent` (`yes`/`true`/`1`), optional `name` and `group`.
- Create a campaign, attach a PDF from the Campaigns table, choose 100/250/400/500 recipients per run, then select **Run** once. BullMQ automatically processes each recipient; no per-recipient Send click is needed.
- After a batch finishes, run the same campaign again to continue with the next eligible contacts. Contacts already accepted by the provider are not re-enqueued. Failed recipients can be retried separately.
- Amazon SES API now supports PDF attachments through SES v2 Raw MIME messages. Keep attachments within the app's 10 MB upload limit and provider message-size limits.
- The queue is globally serialized to one active recipient delivery and at most one job start per second across workers sharing Redis. Follow the provider's approved quota if it is lower.
- Sender-account rotation to evade Gmail/Yahoo/Outlook limits is not supported. Use one verified sender identity/provider profile per campaign and authorized sending quotas.


### Owner setup token troubleshooting (v1.5.2 patch)

The backend explicitly loads `server/.env`. Put exactly one `OWNER_SETUP_TOKEN` entry in that file (32+ characters), restart the backend after changing it, and paste the same value into the Owner setup form. Surrounding whitespace is ignored. Startup prints only whether the token is configured; it never prints the secret. If the API reports that setup is not configured, check the file path and duplicate entries. Never send the token to anyone or commit `.env`.


## Troubleshooting
- `npm run doctor` (in `server/`) checks `server/.env`, MongoDB and Redis and says what to fix.
- Owner setup says the token does not match: run `npm run owner-token` in `server/`, restart the backend, and paste the printed token. The error shows the entered and expected lengths to help spot copy/paste problems.
