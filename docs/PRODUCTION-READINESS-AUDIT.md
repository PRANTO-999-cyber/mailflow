# Production readiness audit — v1.6.0

## Implemented in this maintenance release

- Amazon SES v2 native HTTPS API adapter with AWS Signature Version 4 signing (no extra runtime dependency).
- SES account credential verification and SES-backed test email path.
- Existing Brevo API and SMTP/Gmail paths retained.
- API provider acceptance is still labelled as provider acceptance, not mailbox delivery or Inbox placement.
- MongoDB/Redis local infrastructure compose file supplied for repeatable development setup.

## Release-blocking items that are NOT represented as complete

This codebase still has a legacy `server/data.json` persistence layer for campaign, recipient, template, activity and sender settings. MongoDB currently stores admin users, delivery ledger, provider events and suppression records, but the app's main business records and worker lookups still depend on process memory loaded from JSON. Consequently:

1. Do not run multiple API/worker instances against this release for live campaigns. Their in-memory business state is not a shared source of truth.
2. A MongoDB migration is not complete until every API read/write and worker read/write uses MongoDB repositories and the JSON store is removed from runtime paths. Merely importing JSON once is not a multi-instance migration.
3. Recipient ledger unique indexes reduce duplicate work, but cannot guarantee exactly-once external email submission. A process crash after provider acceptance and before MongoDB acknowledgement creates an unavoidable ambiguous outcome unless the provider supports idempotency keys and reconciliation.
4. Brevo webhook currently uses a configured custom secret header. SES event webhooks require SNS signature verification and subscription confirmation; those are not implemented here. Do not point SES SNS notifications at the normalized HMAC endpoint.
5. SES API adapter supports text/HTML transactional messages without attachments. It does not yet implement SES event-destination/SNS lifecycle automation or configuration-set provisioning.
6. The app does not yet have a production-grade load-test suite proving 100,000 recipients/day, multi-region failover, disaster recovery, or provider quota approval.
7. Frontend production build must be run in an environment where npm dependencies can be installed. It could not be verified in the build environment used for this archive because Vite was unavailable after dependency installation timed out.

## Mandatory deployment gates before real high-volume use

- Complete MongoDB repository migration for campaigns, recipients, templates, activities, settings and all worker state; remove `data.json` runtime dependency.
- Run migrations with backup, count reconciliation, consent/suppression reconciliation and rollback plan.
- Move campaign attachment binaries to durable object storage (not process memory or JSON).
- Split API and worker processes; workers must load all state from MongoDB and use atomic claims/leases, unique delivery keys, bounded retry and dead-letter handling.
- Implement provider-specific webhook authentication: SES SNS certificate/signature verification and subscription confirmation; Brevo's documented signing mechanism where available; stable event deduplication and out-of-order event handling.
- Add provider-native SES/Brevo event mapping, bounce classification, complaint suppression, unsubscribe events and reconciliation jobs.
- Add integration tests with mocked provider responses, MongoDB replica set, Redis, crash injection at pre-send/post-acceptance boundaries, and concurrent duplicate enqueue.
- Run staged load tests with synthetic opted-in addresses only; ramp within the account's approved provider quota. Record latency, queue lag, 429/4xx, bounce, complaint, deferral and suppression metrics.
- Verify SPF, DKIM, DMARC alignment, custom MAIL FROM/return-path where applicable, TLS, unsubscribe and domain reputation. Monitor Gmail Postmaster Tools and provider reputation dashboards.
- Obtain explicit provider approval/quota for the intended daily volume. No software change can grant a sending quota or guarantee Inbox placement.

## Status

v1.5.1 is an improved development build with an SES API adapter, not a 100k/day production-certified release. Do not use the phrase "production-ready" until every release-blocking item above has been implemented and independently tested in the target deployment environment.

## v1.5.2 implementation notes
- Campaign UI now lets an operator choose 100, 250, 400, or 500 eligible recipients per run (default 400).
- The API enforces a 1–500 batch cap and returns the number of remaining eligible recipients. Run the campaign again to continue; contacts already marked accepted by provider are excluded.
- The shared BullMQ queue sets global concurrency to one and starts at most one job per second. This is intentionally conservative and does not bypass any provider quota.
- Amazon SES v2 now uses Raw MIME content when a campaign has attachments, allowing PDF attachments through the native API adapter.
- Frontend build was not verified in this environment because `npm ci --prefix client` timed out. Run `npm ci --prefix client && npm run build --prefix client` on a network-enabled machine before deployment.
- The existing JSON-backed campaign/recipient state remains a blocker for horizontally scaled production. This release does not certify 100k/day capacity.

## v1.6.0 notes
- Business records are now persisted in MongoDB (diff-based sync from in-memory state) with automatic migration from `data.json`. This removes the local-file persistence and crash-loss window, but it is NOT yet the full repository migration: handlers still read in-memory arrays, so multi-instance API/worker deployment remains uncertified.
- Store logic is unit-tested against a fake model; it has not been run against a live MongoDB in the build environment. Run `npm test` and `npm run doctor`, then smoke-test on a copy of your data before relying on it.
