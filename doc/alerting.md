# Service webhook alerts

Robin Admin evaluates the latest observations for every enabled fleet service and sends matching notifications to configured Slack or generic HTTPS webhooks, or to Sentry.

## Webhook settings

Each webhook has its own:

- Alert type selection and thresholds
- Number of consecutive failed observations required before the first notification
- Repeat interval while the condition remains active
- Recovery notification preference
- Optional pause reason and end time

The defaults are three consecutive failures, a four-hour repeat interval, and recovery notifications enabled. Paused webhooks continue tracking service state but do not create notifications. A timed pause resumes automatically.

Webhook URLs are encrypted at rest with `ROBIN_ADMIN_ENCRYPTION_KEY` and are write-only through the API. Preview renders a sample payload without making a network request. Test requires explicit confirmation and sends a live request only when alerting and the webhook are enabled.

## Alert types

| Alert | Applies to | Default |
| --- | --- | --- |
| Service availability | All registered Fleet service types | Unreachable |
| Telemetry stale | All registered Fleet service types | Older than 180 seconds |
| Postfix queue | Postfix | More than 1,000 messages |
| Oldest deferred message | Postfix | Older than 900 seconds |
| Postfix bounce/deferral rate | Postfix | Bounced + deferred above 20% of delivery attempts over 15 minutes (needs at least 20 attempts) |
| Dovecot auth failure spike | Dovecot | More than 100 failed authentications over 15 minutes |
| PostgreSQL connection use | PostgreSQL | Above 80% |
| PostgreSQL cache hit ratio | PostgreSQL | Below 95% |
| MariaDB connection use | MariaDB | Above 80% of `max_connections` |
| MariaDB buffer pool hit ratio | MariaDB | Below 95% over 15 minutes (needs at least 1,000 buffer pool reads) |
| MariaDB long-running transaction | MariaDB | Oldest open transaction older than 300 seconds |
| MariaDB replica lag | MariaDB | More than 60 seconds behind, or replication stopped (replicas only) |
| Redis cache hit ratio | Redis | Below 80% |
| ClamAV database age | ClamAV | Older than 24 hours |
| Monitoring issue | External Monitoring checks | Issue opened or recovered |
| Telemetry rule | Telemetry alert rules | A rule fires or recovers for a series |
| Email delivery failure | Robin Admin outbound email | All relays failed |

Telemetry rules track each result series on its own. Editing a rule keeps that state: on the next evaluation, a firing series that no longer matches, or that the edited query no longer returns, recovers through the normal path (Slack recovery, Sentry issue resolved). Disabling or deleting a rule sends a recovery for each series it had firing.

Missing timestamps, unknown deferred-message ages, and cache ratios with no request or block evidence are ignored. A bounce rate over fewer than 20 attempts counts as healthy, so a quiet relay recovers rather than alerting on a handful of messages. They do not count as failures or recoveries.

## Delivery

The evaluator records one state per webhook, service, and alert type. Generation-based delivery keys prevent repeated evaluator ticks or process restarts from creating duplicate notifications. Repeat notifications use the configured interval, and recovery is sent only after a failure notification.

The delivery worker validates HTTPS destinations, blocks unsafe outbound addresses, disables redirects, applies a timeout, and retries transient network, 408, 429, and server errors up to five attempts. Delivery is at-least-once: a process failure after the remote endpoint accepts a request but before Robin Admin records success can produce a duplicate. Every request includes `X-Robin-Notification-Id` for receiver-side deduplication.

Delivery history contains only compact status, attempt, response, and bounded
error details. Webhook secrets and payload secrets are never returned.

External Monitoring owns its own target, check, observation, and issue state.
When a Monitoring issue opens or recovers, Robin Admin can enqueue a
`monitoring_issue` notification through the same delivery worker. Monitoring
does not use `alert_state`; alert delivery is only the notification transport.

## Sentry destinations

A destination with the **Sentry** format sends alerts to a Sentry project instead
of a webhook. Robin Admin still decides when something is wrong; Sentry receives
that decision and tracks it as an issue:

- **URL:** the project's DSN. Events are sent as envelopes to the DSN's ingest
  endpoint (built with Sentry's own `@sentry/core` helpers), with the same HTTPS,
  address and retry rules as webhooks.
- **One issue per alert subject:** a check, a telemetry rule series, a fleet
  service alert type or a probe location. Events use a stable fingerprint and an
  `alert_key` tag, the monitoring target's environment (`production` when none),
  the severity as the level, and a `robin_admin` context with the detail and a
  link back built from `ROBIN_ADMIN_PUBLIC_URL`.
- **Recoveries resolve the issue** through Sentry's REST API when the destination
  has an organization slug and an API token with `event:write`. The API host is
  derived from the DSN region (for example `us.sentry.io`) unless an API URL is
  set. Without a token, recoveries are recorded as skipped and Sentry's
  auto-resolve applies. A new failure on a resolved issue shows as a regression.
- **Repeats are not sent:** Sentry's own alert rules handle re-notification.
- **No personal data:** email delivery failures omit the recipient address.

Sentry and webhook destinations can subscribe to the same alert types at the
same time. If Sentry's alert rules also post to Slack, use a different channel
from the Slack webhook, or each alert arrives twice.

## Robin Admin's own errors

Separately from alert destinations, Robin Admin can report its own errors to
Sentry with the standard Node and React SDKs. It is off unless `SENTRY_DSN` is
set.

- **Server:** unhandled request errors (5xx only), crashes and failures of the
  background jobs (alert evaluator, alert delivery, telemetry rules and the
  Monitoring scheduler), with sampled traces (`SENTRY_TRACES_SAMPLE_RATE`,
  default 0.05).
- **UI:** errors caught by the application's error boundary. The UI loads the
  Sentry SDK only when the server reports a DSN, from the public
  `/api/health/client-config` endpoint. There is no session replay.
- **Privacy:** no request bodies, cookies, query strings, credentials or user
  details are collected, and a `beforeSend` scrubber removes them again.
- **Release and environment:** images carry their commit (or release tag) as
  the release. `SENTRY_ENVIRONMENT` defaults to `NODE_ENV`.

| Variable | Use |
|----------|-----|
| `SENTRY_DSN` | Turns reporting on for the server and, unless overridden, the UI |
| `SENTRY_BROWSER_DSN` | A separate project for UI errors |
| `SENTRY_ENVIRONMENT` | The environment events are filed under |
| `SENTRY_TRACES_SAMPLE_RATE` | Share of requests traced, 0 to 1 |

## Configuration

- `ROBIN_ADMIN_ENCRYPTION_KEY` encrypts webhook URLs, like every other stored secret, and must be backed up.

Production startup refuses to run without `ROBIN_ADMIN_ENCRYPTION_KEY`.

### Upgrading

On first schema initialization, when no Operations policy has been saved, legacy
`ALERTING_ENABLED`, `ALERT_EVALUATION_INTERVAL_MS`,
`ALERT_DELIVERY_INTERVAL_MS`, `ALERT_DELIVERY_CONCURRENCY`,
`ALERT_DELIVERY_MAX_ATTEMPTS`, `ALERT_RETRY_BASE_MS`, `ALERT_RETRY_MAX_MS` and
`ALERT_INSTANCE_NAME` values are imported into `admin_config` once. Review
**Administration -> Alerts -> Policy**; later environment changes do not
override the saved policy. Monitoring issue notifications are not queued while
alert delivery is disabled. Pending deliveries older than the configurable
expiry age (one hour by default) are marked expired before delivery if they
have not yet been attempted. Deliveries already in the retry schedule are not
expired by this backlog cutoff.

Administrators configure alert enablement, instance name, evaluation and delivery
intervals, concurrency, maximum attempts, retry delays and delivery-history
retention in **Administration -> Alerts**. Policy is persisted in `admin_config`
and applies without restarting. Disabling alerts stops new work; an accepted
delivery batch finishes. Maximum retry delay must be at least the base delay.
Secrets are never shown. HTTPS-only destinations, public-address DNS pinning,
transport deadlines and response-size limits remain security boundaries, not
editable settings. Environment variables do not override saved alert policy.
With multiple API replicas, configuration writes broadcast changed keys through
PostgreSQL `LISTEN/NOTIFY`; each replica invalidates its config cache and the
background-jobs leader reapplies worker settings. A five-second leader refresh
reconciles changes if a notification is missed.

Delivery pins its TLS socket to the validated DNS answer on every attempt,
rejects mixed public/private answers and IPv4-mapped private addresses, follows
no redirects, and bounds DNS/connection/body time to ten seconds. Response bodies
are capped at 64 KiB; remote content and secret-bearing URLs are never returned
as delivery errors. Unsafe destinations/oversized acknowledgements fail without
retry; connection/deadline failures and HTTP 408/429/5xx use the saved retry policy.

## API

Administrators use:

- `GET/POST /api/alert-webhooks`
- `PATCH/DELETE /api/alert-webhooks/:id`
- `POST /api/alert-webhooks/:id/pause`
- `POST /api/alert-webhooks/:id/resume`
- `POST /api/alert-webhooks/:id/preview`
- `POST /api/alert-webhooks/:id/test`
- `GET /api/alert-deliveries`

The interface is available at **Administration → Alerts**.
