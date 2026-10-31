# 100k/day architecture — v1.5 implementation boundary

## What v1.5 implements

- Campaign fan-out now creates one durable BullMQ job per recipient in bounded batches of 500, using stable `campaignId:recipientId` job IDs.
- A MongoDB `Delivery` ledger has a unique `(campaignId, recipientId)` index, records provider acceptance separately from delivery, and prevents a second accepted send for the same campaign/recipient pair.
- MongoDB `ProviderEvent` has a unique `(provider, providerEventId)` index to deduplicate provider webhook events.
- MongoDB `Suppression` has a unique normalized email index. Unsubscribe, hard-bounce and complaint events are written to it and checked immediately before a queued send.
- Brevo transactional email is sent through its native REST API (`/v3/smtp/email`). Gmail and other SMTP profiles continue through SMTP. Credentials stay server-side.
- A Brevo webhook adapter authenticates a configured custom header token, normalizes delivery/bounce/complaint events, deduplicates event IDs, and updates delivery/suppression state.
- Worker concurrency is configurable but capped at 20 in this application; the queue limiter remains a shared BullMQ limiter for this queue. Keep the configured rate within the provider's written account/domain quota.

## Still not a horizontally scalable 100k/day production service

**Campaign, recipient, activity, template and settings records still use `server/data.json` and process memory.** The MongoDB ledger added in v1.5 does not migrate those source-of-truth records. The current worker also reads campaign and recipient snapshots from its process memory. Therefore do not run multiple API/worker replicas or separate worker hosts yet: their in-memory snapshots can diverge. The recipient-level jobs and ledger are a foundation, not a substitute for migrating all application data and worker reads to MongoDB.

The Brevo adapter is implemented. Gmail uses SMTP, not a consumer Gmail API bulk-sending integration. Other ESPs (including Amazon SES native API) are not wired in this release. The generic signed normalized webhook remains available; the Brevo custom-token adapter is not a universal provider signature verifier. Add provider-specific verification for each additional ESP before enabling its webhooks.

## Throughput planning

100,000/day averages 1.16 messages/second across 24 hours. This is only arithmetic, not a recommended rate or a promise. The actual allowed rate is the lowest of provider account quota, domain/IP reputation capacity, recipient engagement and your approved warm-up plan. Do not increase queue rate to work around throttling. Respect `Retry-After`, back off on 4xx throttling responses, pause on sustained failures, and keep Gmail consumer SMTP for low-volume permission-based use rather than bulk throughput.

## Remaining release gates

1. Migrate campaigns, recipients, templates, settings, activity and consent evidence from JSON into indexed MongoDB collections; update all API routes to query MongoDB rather than process arrays.
2. Make worker processing fully stateless: load campaign/recipient/consent/suppression from MongoDB for every job. Add atomic delivery lease claims with recovery for crashed workers and idempotent provider idempotency where supported.
3. Add per-provider/per-account distributed token buckets, daily quota accounting, circuit breakers, retry-after support, jitter, dead-letter queue and operator pause controls.
4. Add native adapters and signature verification for each selected provider (SES, Mailgun, SendGrid, etc.) and test event mappings against real provider payload samples.
5. Add transactional outbox or equivalent atomic campaign fan-out, tenant isolation, audit log, MFA, secret manager, backups and restore drills.
6. Add load tests (100k queued recipients), concurrency/race tests, duplicate webhook tests, crash/restart tests, suppression race tests, and staging delivery tests using a provider-approved quota.
7. Complete frontend production build and end-to-end test in CI. This environment's `npm ci` timed out, so the Vite build is not certified here.

## Delivery semantics

`accepted_by_provider` means the ESP accepted the API/SMTP request. `delivered` means the ESP reported a delivery event. Neither proves Inbox placement. Spam-folder placement, filtering, engagement, and mailbox-provider decisions are not reliably observable from SMTP acceptance alone. Never advertise a guaranteed Inbox percentage.
