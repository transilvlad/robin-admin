# Configuration reference

Robin Admin reads its startup configuration from environment variables. Most
day-to-day settings (alerting, reporting thresholds, monitoring policy, status
page, integrations) live in the database and are edited under
**Administration**; the variables below cover what must be known before the
server starts, plus a few tuning knobs.

The Docker Compose files read a `.env` file next to them. Start from
[`.env.example`](../.env.example), which lists the variables a typical install
sets. Everything else has a working default.

## Required in production

With `NODE_ENV=production` the server refuses to start while any of these is
missing or left at a known default.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SESSION_SECRET` | development placeholder | Signs session cookies. Use a long random value. |
| `ROBIN_ADMIN_ENCRYPTION_KEY` | none | Encrypts stored secrets (webhook URLs, API tokens, service credentials). At least 32 characters. Keep it with your backups: stored secrets cannot be read without it. |
| `DB_PASSWORD` | `robin` | PostgreSQL password. The default is refused in production. |
| `ROBIN_ADMIN_PUBLIC_URL` | `https://localhost:3443` | The browser-facing URL, including any base path (for example `https://admin.example.com/admin`); not a localhost address. Links in emails, feeds and alerts are built from it, never from request headers. |
| `COOKIE_SECURE` | on in production | Must stay on. |
| `MODULE_PROXY_SECRETS_JSON` | `{}` | JSON object of per-module proxy secrets, for example `{"robin-tools":"..."}`. Required when `MODULES_BOOTSTRAP_JSON` lists modules with a backend. |
| `FLEET_AGENTS_BOOTSTRAP_JSON`, `SUITE_AGENT_CREDENTIAL` | none | When set, agent credentials must not be the demo or placeholder values. |

## Server

| Variable | Default | Purpose |
|----------|---------|---------|
| `NODE_ENV` | `development` | `production` enables secure cookies, CSP and the production secret checks. |
| `HOST` | `0.0.0.0` | Address the API listens on. |
| `PORT` | `3000` | Port the API listens on. |
| `SERVE_STATIC` | on in production | Set to `false` when a separate web container serves the UI (the Compose layout does). |
| `ALLOWED_ORIGINS` | none | Extra comma-separated origins allowed to call the API cross-origin. More can be added under Administration. |
| `BODY_LIMIT` | `50mb` | Largest JSON or form body for signed-in API calls. Sign-in, setup, recovery, public subscriptions and agent enrollment are limited to 64 KB, and report ingest has its own limit (see below). |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. |
| `LOG_FILE_ROTATION` | `size` | `size` rotates log files itself; `external` leaves rotation to logrotate or the container runtime. |

## Sessions and rate limits

| Variable | Default | Purpose |
|----------|---------|---------|
| `COOKIE_SECURE` | on in production | Marks the session cookie HTTPS-only. Turn off only for plain-HTTP development. |
| `COOKIE_DOMAIN` | `localhost` | Cookie domain in production. |
| `COOKIE_PATH` | `/` | Cookie path; set it to the base path when the UI is served under one. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window for the API rate limits. |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Requests per window per client IP; signed-in admins get five times this, per account. Agents and telemetry senders get ten times this. Loopback requests are not limited. |
| `LOGIN_RATE_LIMIT_MAX` | `5` | Sign-in attempts per window per client IP. |

## Database

| Variable | Default | Purpose |
|----------|---------|---------|
| `DB_HOST` | `localhost` | PostgreSQL host. |
| `DB_PORT` | `5432` | PostgreSQL port. |
| `DB_NAME` | `robin` | Database name. |
| `DB_USER` | `robin` | Database user. |
| `DB_POOL_MAX` | `30` | Most connections the API holds. Sessions use a separate pool of up to 10. |
| `DB_POOL_MIN` | `4` | Connections kept open when idle. |
| `DB_IDLE_TIMEOUT_MS` | `60000` | How long an idle connection is kept. |
| `DB_CONNECTION_TIMEOUT_MS` | `10000` | How long a query waits for a free connection before failing. |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | Longest a single statement may run. |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `30000` | Ends sessions left idle inside a transaction. |

## Robin MTA

| Variable | Default | Purpose |
|----------|---------|---------|
| `ROBIN_API_ENABLED` | `true` | Whether Robin Admin talks to a Robin MTA API at all. |
| `ROBIN_API_URL` | `http://localhost:8090` | Robin's API base URL. |
| `ROBIN_API_AUTH` | none | Authorization header value for Robin's API, if it needs one. |
| `ROBIN_METRICS_URL` | `http://localhost:8080` | Robin's Prometheus metrics endpoint. |
| `ROBIN_CONFIG_TABLE` | `robin_config_store` | Table Robin reads its stored configuration from. |
| `METRICS_POLL_INTERVAL` | `60000` | How often service metrics are collected, in milliseconds. |
| `METRICS_RETENTION_DAYS` | `14` | Days of collected service metrics kept. |

## Reports (DMARC, TLS-RPT, forensic)

| Variable | Default | Purpose |
|----------|---------|---------|
| `REPORTING_ANALYSIS_DEBOUNCE_MS` | `10000` | Wait after a report before analysing its domain, so a batch for one domain runs once. Also editable under Administration. |
| `REPORTING_ANALYSIS_CONCURRENCY` | `4` | Analyses that may run at once; a burst of reports for many domains queues instead of taking every database connection. Also editable under Administration. |
| `DNS_RESOLVERS` | `1.1.1.1,8.8.8.8,9.9.9.9` | Resolvers used to enrich report sources. |
| `ROBIN_DETECT_UNKNOWN_MIN_VOLUME` | `50` | Messages before an unknown sender is flagged. |
| `ROBIN_DETECT_SPOOFING_MIN_FAILS` | `100` | Failures before possible spoofing is flagged. |
| `ROBIN_DETECT_MISCONFIGURED_MIN_VOLUME` | `1000` | Volume before a misconfigured sender is flagged. |
| `ROBIN_DETECT_DMARC_FAIL_RATE` | `0.95` | Pass rate below which a domain's DMARC is flagged as failing. |
| `ROBIN_DETECT_TLS_FAILURE_RATE` | `0.1` | TLS failure rate that is flagged. |
| `ROBIN_DETECT_TLS_MIN_FAILURES` | `10` | TLS failures before the rate is considered. |
| `ROBIN_DETECT_FORENSIC_SPIKE` | `2` | Multiple of the usual forensic report rate that counts as a spike. |
| `ROBIN_DETECT_FORENSIC_SPIKE_MIN` | `3` | Recent forensic reports needed for a spike. |
| `ROBIN_DETECT_FORENSIC_CLUSTER_MIN` | `2` | Repeats that make a forensic cluster. |
| `ROBIN_DETECT_FORENSIC_CLUSTER_MAX` | `10` | Most forensic cluster issues opened per run. |
| `ROBIN_DETECT_REQUIRED_RUNS` | `2` | Consecutive analyses a finding must appear in before an issue opens. |
| `ROBIN_DETECT_GRACE_RUNS` | `2` | Analyses an issue may be missing from before it closes. |

The detection thresholds are also editable under Administration; the variables
set their starting values.

## Monitoring heartbeat

| Variable | Default | Purpose |
|----------|---------|---------|
| `ROBIN_HEARTBEAT_LOOP_MS` | `5000` | How often heartbeat targets are checked for being due. |
| `ROBIN_HEARTBEAT_HEALTH_CACHE_MS` | `10000` | How long a health verdict is reused. |
| `ROBIN_HEARTBEAT_SCHEDULER_STALE_MS` | `10000` | Scheduler silence that counts as lag. |
| `ROBIN_HEARTBEAT_ALERT_STALE_MS` | `120000` | Alert-worker silence that counts as a backlog. |

## Telemetry

| Variable | Default | Purpose |
|----------|---------|---------|
| `TELEMETRY_STORE_URL` | `http://metrics-backend:8428` | VictoriaMetrics (or compatible) store for telemetry. |

## Rspamd uploads

| Variable | Default | Purpose |
|----------|---------|---------|
| `RSPAMD_SCAN_UPLOAD_LIMIT` | `25mb` | Largest message accepted for a manual scan. |
| `RSPAMD_SCAN_HISTORY_MAX_BYTES` | 25 MiB | Largest message kept in scan history. |
| `RSPAMD_TRAINING_UPLOAD_LIMIT` | `100mb` | Largest training upload. |
| `RSPAMD_TRAINING_SAMPLE_MAX_BYTES` | 25 MiB | Largest single training sample. |
| `RSPAMD_TRAINING_ARCHIVE_MAX_INPUT_BYTES` | 100 MiB | Largest training archive. |
| `RSPAMD_TRAINING_ARCHIVE_MAX_UNPACKED_BYTES` | 250 MiB | Most data a training archive may unpack to. |
| `RSPAMD_TRAINING_ARCHIVE_MAX_FILES` | `2000` | Most files in a training archive. |

## Agents

| Variable | Default | Purpose |
|----------|---------|---------|
| `ROBIN_AGENT_IMAGE` | `ghcr.io/transilvlad/robin-admin-agent:latest` | Agent image shown in the enrollment instructions. |
| `ROBIN_AGENT_INSTALL_URL` | the project's `agent/install.sh` | Install script shown in the enrollment instructions. |
| `ROBIN_AGENT_RELEASE_URL` | the project's latest release | Where agent binaries are downloaded from. |
| `ROBIN_AGENT_DEPLOY_GUIDE_URL` | the project's deployment guide | Link shown with the enrollment instructions. |

Set these when you build and host your own agent.

## Modules

| Variable | Default | Purpose |
|----------|---------|---------|
| `MODULE_INSTALLER_URL` | `http://installer-backend:3041` | The host module installer. |
| `MODULE_INSTALLER_SIGNING_SECRET` | none | Shared secret for requests to the installer; the same value goes into the installer's configuration. |
| `SHERIFF_BASE_URL` | `https://sheriff.robinmta.com` | Module catalog and licence service. It is contacted only when an admin syncs the module catalog from the Modules page. |
| `SHERIFF_ROOT_PUBLIC_KEY_PEM` | none | Root key the catalog's signatures are verified against. Required in production before syncing modules. |
| `MODULES_BOOTSTRAP_JSON` | none | Modules to register at startup, with their backend and frontend URLs. |
| `ROBIN_ADMIN_IDENTITY_TRUST_FILE` | none | File holding pinned module identity keys, instead of the built-in ones. |
| `MODULE_IDENTITY_TRUST_EXPORT_FILE` | none | Where Robin Admin publishes its own identity keys for modules to read. |

## Error reporting (Sentry)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SENTRY_DSN` | none | Reports server errors to Sentry. Nothing is sent without it. |
| `SENTRY_BROWSER_DSN` | `SENTRY_DSN` | DSN handed to the web UI; the browser SDK loads only when one is set. |
| `SENTRY_ENVIRONMENT` | `NODE_ENV` | Environment name on reported events. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.05` | Share of requests traced. |
| `ROBIN_ADMIN_RELEASE` | none | Release name on reported events, usually the commit. |

## First start only

These seed settings into the database the first time the server starts with an
empty settings table. After that, change them under Administration; the
variables are ignored.

| Variable | Seeds |
|----------|-------|
| `ALERTING_ENABLED` | Whether operational alerting is on. |
| `ALERT_INSTANCE_NAME` | The instance name shown in alerts. |
| `ALERT_EVALUATION_INTERVAL_MS`, `ALERT_DELIVERY_INTERVAL_MS`, `ALERT_DELIVERY_CONCURRENCY`, `ALERT_DELIVERY_MAX_ATTEMPTS`, `ALERT_RETRY_BASE_MS`, `ALERT_RETRY_MAX_MS` | Alert evaluation and delivery timing. |
| `REPORT_INGEST_BODY_LIMIT_BYTES` | Largest report accepted by the ingest endpoints (5 MiB by default, up to 20 MiB). |

## Provisioning

Used by the Docker suite and automated installs to create agents and services
without clicking through the UI.

| Variable | Purpose |
|----------|---------|
| `FLEET_AGENTS_BOOTSTRAP_JSON` | Agents to create at startup, with their credentials. |
| `FLEET_SERVICES_BOOTSTRAP_JSON` | Fleet services to register at startup. |
| `SUITE_AGENT_CREDENTIAL` | Credential of the agent bundled with the Docker suite. |
| `SETUP_ID_FILE` | Where the one-time setup ID is written until the first admin exists (a temporary file by default). |

## Maintenance scripts

| Variable | Purpose |
|----------|---------|
| `ROBIN_ADMIN_NEW_PASSWORD` | New password for `reset-admin-password` when it is not given on standard input. |

## Compose variables

These are read by the Compose files rather than the server; see
[`.env.example`](../.env.example).

| Variable | Default | Purpose |
|----------|---------|---------|
| `ROBIN_ADMIN_VERSION` | `latest` | Image tag to run. |
| `ADMIN_HTTPS_PORT` | `3443` | Port the bundled gateway listens on. |
| `BASE_PATH` | `/` | Path the UI is served under. |
| `CONTENT_SECURITY_POLICY` | see below | The UI's Content-Security-Policy. |
| `CONTENT_SECURITY_POLICY_MODE` | `enforce` | `enforce`, `report-only` (browsers only report what the policy would block) or `off`. |
| `TELEMETRY_RETENTION_DAYS` | `90` | Telemetry kept by the bundled store. |
| `TELEMETRY_STORE_MEMORY` | `1g` | Memory limit of the bundled store. |

### Content-Security-Policy

The web UI container sends this policy by default:

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:; font-src 'self' data:;
connect-src 'self' https://*.sentry.io; worker-src 'self' blob:;
frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'
```

Modules load through Robin Admin's own origin, so they need nothing extra.
Images may come from any HTTPS address because status page logos and avatars
are external. If you report UI errors to a self-hosted Sentry, set
`CONTENT_SECURITY_POLICY` to the policy above with your Sentry host added to
`connect-src`. To try a change safely, set `CONTENT_SECURITY_POLICY_MODE` to
`report-only` and watch the browser console. The policy is one line and may not
contain quotes, `$`, braces or backslashes.

