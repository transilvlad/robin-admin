# Logs

Logs adds searchable history for service logs shipped by Fleet agents and
external push integrations. Fleet keeps each service's recent tail
([log access](fleet-service-capabilities.md#log-access-and-limitations)); Logs
stores new lines in a bundled
[VictoriaLogs](https://docs.victoriametrics.com/victorialogs/) store and lets
admins search across services and time.

Logs is optional and off by default. When it is off, or the store is down,
agents, Fleet log tails and Postfix message counters work exactly as before.

## Enable

1. Run the bundled store. `suite-victorialogs` is part of `docker-compose.yaml`
   (role alias `logs-backend`, internal network only). Robin Admin does not wait
   for it at start-up.
2. In **Administration → Logs**, turn on **Enable logs** (the same switch is
   also on **Administration → Integrations**).
3. Use **Logs → Search** (including shared saved searches), **Health**,
   **Sources**, or **Alerts** (admins only), or open **Search history** on a
   service's Fleet log page.

## What is stored

- Only lines an agent ships **after** Logs is enabled. When an agent has no
  saved read position for a source (its first start, or after the source
  changes) it ships the recent tail as a reset batch; that tail refreshes the
  Fleet log page but is not stored, so it cannot duplicate stored lines.
- Services read directly by Robin Admin (a log file or directory, journald, a
  `<TYPE>_LOG_URL`, or Rspamd's controller) are not stored. To store one,
  assign a logs agent to it in Fleet.
- Each line is stored with `service_type`, `service_id`, `source` and
  `source_type`/`source_name`; Fleet lines also include `agent_id`. Fleet
  lines keep the timestamp the agent read from the log line or journal entry;
  a continuation line (such as a stack trace) takes the time of the line
  before it within a batch. Fleet timestamps outside the retention window or
  more than five minutes in the future are replaced with the arrival time.
  External entries with missing or invalid timestamps use the arrival time;
  otherwise their supplied timestamps are retained. Lines longer than 8 KiB
  are truncated. External service types are limited to 120 UTF-8 bytes.
- NUL characters and unpaired Unicode surrogates are replaced with the Unicode
  replacement character before storage, including in Fleet recent tails.
- Log lines are not redacted. Do not ship logs that contain secrets you would
  not show to every admin.

## Search

Pick a time range (up to 31 days), optionally a service and source name, and
type a filter:

| Filter | Matches |
|--------|---------|
| `error` | lines containing the word `error` |
| `"connection refused"` | the exact phrase |
| `error OR warn`, `error NOT debug` | boolean combinations |
| `source:file`, `service_type:dovecot` | stored fields |

Filters use [LogsQL](https://docs.victoriametrics.com/victorialogs/logsql/)
syntax. Pipes (`|`) are rejected: Robin Admin adds the service scope, newest-first
sort and the result limit (up to 1000 lines) itself. When more lines match than
the limit, the newest are shown and the page says so.

The API is `GET /api/logs/search?start&end&serviceId&serviceType&sourceName&q&limit`
(admin only; `start`/`end` are ISO times or Unix milliseconds). The singular
`serviceId` and `sourceName` parameters accept comma-separated lists. For exact
names containing commas, use repeated `serviceIds` and `sourceNames` parameters
instead. Use `GET /api/logs/status` for store reachability, data size, ingestion
counters, retention, and Robin Admin's ingestion queue.

## Saved searches

Administrators can save shared filters from **Logs → Search**. A saved search
keeps its name, query, optional service/source, and a relative time window; it
does not freeze an absolute date. Searches are shared with administrators;
apply one from the **Apply a saved search** menu, or open **Manage** under the
search bar to run or delete them. Robin Admin supports up to 100 saved searches.

## Health and sources

**Logs → Health** shows VictoriaLogs availability, stored data size
against the configured `LOGS_STORE_MAX_DISK` cap, logs matched over the last
24 hours, oldest stored timestamp, VictoriaLogs ingestion counters, and the
ingestion queue (queued and quarantined lines against its capacity, the oldest
queued line, retries, uncertain deliveries, and lines dropped, rejected, or
discarded in the last 24 hours). Rejected batches can be inspected, retried, or
explicitly discarded from Health; discard clears the payload but keeps its
deduplication receipt until normal retention cleanup. VictoriaLogs data size is
not physical volume usage.
Monitor the host volume separately and retain free-space headroom for
compaction.

**Logs → Sources** summarizes sources and services observed in the selected
1-, 7-, or 30-day window, including log count and last-seen time. It is an
observed-source inventory: it cannot list systems that have never sent data.
Sources with no log entry within the configured quiet threshold (15 minutes by
default) are marked quiet. Lines stored by Fleet agents before source
attribution existed are shown as **Fleet agent** sources named after their
service, and searching that source also matches them. The page links to Fleet
management and Logs API-key setup. Opening a source carries its source and
service type into the visible search filter, keeping similarly named sources
separate.

## Administration

**Administration → Logs** (admins only) has four tabs:

| Tab | Contents |
|-----|----------|
| Connection | Enable or disable collection, the store URL, and a connection test with ingestion-queue counts. |
| Ingestion | HTTP ingest and Sentry webhook endpoints, whether the Sentry signing secret is configured (never shown), and the maximum ingest request size. |
| Policy | Source quiet threshold, maximum listed sources, and the store request timeout. |
| Storage | Retention and disk cap (deployment-managed) and current stored size. |

| Setting | Default | Range | Environment override |
|---------|---------|-------|----------------------|
| Quiet after (seconds) | `900` | 60–86400 | — |
| Maximum listed sources | `200` | 10–1000 | — |
| Store request timeout (ms) | `15000` | 1000–60000 | `LOGS_REQUEST_TIMEOUT_MS` |
| Maximum ingest request (bytes) | `8388608` | 65536–33554432 | `LOGS_INGEST_BODY_LIMIT_BYTES` |

`GET /api/logs/configuration` (admins only) returns the deployment values
shown on this page.

## Log alerts

Create count-based rules under **Logs → Alerts**. A rule is a filter, a rolling
window (1 minute to 24 hours), a comparator/threshold, and a hold period (at
least 1 minute). The evaluator runs once per minute; query errors remain visible
on the rule and do not count as recovery. A failed evaluation restarts the hold
period for a pending rule, without clearing a firing rule. Editing a pending
rule's condition also restarts its hold period. A firing rule sends one failure
notification and a recovery when its condition clears or the rule is disabled
or deleted. There is no per-service grouping.

Rules and previews count what VictoriaLogs can currently search. Rule
evaluation pauses while the store is unavailable or ingestion is incomplete
(queued or quarantined batches, dropped, rejected, or discarded lines,
uncertain writes, or newly observed VictoriaLogs drops); a pending hold
restarts after data quality recovers, and a firing rule is not allowed to
recover based on incomplete data. The store's cumulative dropped-row counter
is baselined on first observation or reset; newly observed increases pause
evaluation for 24 hours. Retries with an uncertain outcome can also produce
duplicates. Monitor **Logs → Health** and avoid relying on these rules as the
sole source of critical alerts.

Enable the **Logs alert rule** subscription on an active Slack, generic, or
Sentry destination under **Administration → Alerts**. Enable **Logs pipeline
health** there as well to receive independent failure and recovery
notifications. Pipeline notifications require two consecutive unhealthy
evaluations and two consecutive healthy evaluations to avoid flapping.
Degradation includes an unreachable store, any persistent queue backlog,
rejected or discarded lines, uncertain writes, or newly observed store drops.
Recovery delivery follows the destination's recovery setting.
Rule evaluation continues while alert delivery is disabled, but notifications
are not queued while delivery is off.

`/api/logs/saved-searches` and `/api/logs/alerts` support administrator-only
list/create/update/delete operations; `/api/logs/sources` is an
administrator-only inventory read. Rule preview is available at
`POST /api/logs/alerts/preview`.

## Delivery

When Logs is enabled, accepted lines are written to a PostgreSQL ingestion
queue before the request is acknowledged. Queued lines survive a Robin Admin
process restart or a store outage as long as PostgreSQL retains its data. A
background worker retries with backoff (up to five minutes between attempts);
later batches can pass an older batch waiting for a retry, so delivery is not
strictly ordered. In a multi-replica deployment only the elected leader
delivers. Pending and quarantined batches share the
`LOGS_SPOOL_MAX_BYTES` capacity (256 MiB by default; minimum `64KiB` so one
maximum-size stored log row can be admitted).

- **Fleet agents** persist a batch and its id before sending, then resend that
  batch until Robin Admin acknowledges it. Robin Admin records the latest
  accepted batch id and its Postfix counters in the same transaction. If the
  queue is full, Robin Admin returns `503 Retry-After: 5` without advancing the
  receipt, Postfix counters, or recent log tail; the agent retains and retries
  its batch. If a batch exceeds queue capacity, Robin Admin returns `413` and
  the agent durably splits it into smaller uniquely identified fragments,
  advancing its source cursor only after every fragment is acknowledged.
  With one active agent shipping each service, this recognizes an
  agent's pending retry even after older queue receipts expire. Receipts for
  other recent batches are retained for 24 hours; an older replay outside that
  window is not guaranteed to be recognized.
- **HTTP senders** receive `204` once the lines are queued,
  `503 Retry-After: 5` when the queue is full or unavailable, and `413` when a
  single batch exceeds the configured capacity. Send an
  `Idempotency-Key` header (1–128 visible ASCII characters): a repeated key
  from the same API key within 24 hours is acknowledged without queueing the
  request again. Reusing a key for different content suppresses that content.
- **Sentry** deliveries with a `Request-ID` are deduplicated for 24 hours.
  Requests without one have no sender-side deduplication.

Delivery to VictoriaLogs is **at least once**, not exactly once. A timed-out
write may still complete after a retry. Each line carries `ingest_batch` and
`ingest_seq` fields; after an uncertain write the worker waits briefly, checks
what is currently searchable, and retries missing lines. This reduces ordinary
duplicates but cannot rule out a late original write. Duplicate rows can
appear in search and inflate alert counts. **Logs → Health** reports queued
and recently completed uncertain batches, and Search warns of the risk; these
indicators signal possible duplicates, not proof that duplicates occurred.

A batch explicitly rejected by the store as invalid is retained in quarantine
and continues to consume queue capacity. Administrators can inspect its error
and payload in **Logs → Health**, retry after correcting the cause, or
explicitly discard it; rejected batches are never removed by automatic
retention cleanup. The administrator-only `/api/logs/quarantine` routes expose
the same list, detail, retry, and discard actions, with retry and discard
audited. Even a successful VictoriaLogs response does not prove every row was
retained: for example, the store can drop rows whose timestamps are outside
its accepted range. Monitor its dropped-row counter in Health and ensure its
retention covers expected outage and source delays. A queue acknowledgement
does not guarantee immediate search visibility.

### Source retention and agent recovery

Persist the agent's state directory and keep source logs available long enough
for it to catch up. It follows available uncompressed numbered rotations of a
file and matching dated files; dated files are ordered by modification time,
then path. Rotation, truncation, deletion, compression, late writes to an old
file, or a changing modification order can still cause gaps. When the followed
file cannot be identified, the agent warns and resumes with the oldest
available candidate, which can replay lines as well as miss unavailable data.
File identity can also be ambiguous when an inode is reused and files have the
same prefix.
Incomplete trailing lines are skipped with a warning when the agent moves to
another file. Docker recovery depends on the daemon retaining records in
timestamp order; rotation, clock changes, or a skewed remote daemon can cause
gaps or replay. Journald recovery likewise depends on retained journal entries.
The first recent-tail reset is not stored, so this is not historical backfill.

The agent syncs its temporary state file before renaming it, but does not sync
the parent directory. Process restarts normally retain the saved position;
an operating-system crash or power failure may revert the rename depending on
the filesystem. Use durable storage and monitor agent warnings; neither source
recovery nor physical store delivery is a guarantee of gap-free, exactly-once
archival.

## External push integrations

Robin Admin does not poll Sentry, Better Stack, Falcon LogScale, or other vendor
APIs, and it does not fetch historical provider data. These sources (or their
collectors) push new entries to Robin Admin, which stores them in the same
VictoriaLogs backend and exposes them in **Logs → Search**.

### Generic HTTP

Create an API key with the `logs:write` scope and send a bearer token to
`POST /api/logs/ingest`. The API key name becomes the searchable source name.
Searching requires `logs:read`; saved-search and alert-rule changes require
`logs:manage`. Those administrator APIs also require an API key with the
`admin` role, so use a narrowly scoped key rather than granting a wildcard
scope. Read and write scopes cannot be combined to imply management access.
The endpoint accepts:

- `application/json`: one object, an array of objects, an object with a
  `records` array, or an OTLP Logs JSON-shaped body (`resourceLogs`). The
  latter is a parser convenience on this generic HTTP endpoint, not an
  OTLP/HTTP receiver: standard OTLP paths, response codes, protobuf encoding,
  gzip compression, and gRPC are not implemented. Configure collectors to
  export supported generic JSON/NDJSON to `/api/logs/ingest`; do not point an
  unmodified OTLP exporter at this endpoint.
- `application/x-ndjson` or `application/ndjson`: one JSON object per line.
- `text/plain`: one message per non-empty line.

Common fields such as `timestamp`, `message`, `service.name`, `service_id`,
`severity`, `host`, and `environment` are normalized; other bounded attributes
are retained as metadata. Request bodies default to an 8 MiB limit (configurable
under **Administration → Logs → Ingestion**) and are limited to 1,000 lines,
and individual messages are limited to 8 KiB. Compressed request bodies and
OTLP protobuf are not supported. Use HTTPS at the public ingress and restrict
the ingest key to this scope.

Use `Authorization: Bearer <your-api-key>` with the key created above. Example:

```sh
curl https://robin.example/api/logs/ingest \
  -H "Authorization: Bearer $ROBIN_LOGS_TOKEN" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary '{"service.name":"checkout","severity":"error","message":"payment failed"}'
```

### Sentry

Set `LOGS_SENTRY_CLIENT_SECRET` in the server environment to the Client Secret
from the Sentry webhook integration, then configure the Sentry webhook URL as
`https://robin.example/api/logs/sentry`. Robin Admin verifies
`Sentry-Hook-Signature` against the exact raw request body with HMAC-SHA256
before accepting supported Sentry webhook resources. Keep the secret out of
client configuration and logs. Sentry webhooks provide new notifications; this
does not mirror the Sentry issue database or replace Sentry's own alert history.

### Syslog and vendor collectors

There is no unauthenticated or native TCP syslog listener. Forward syslog using
a trusted Vector, Fluent Bit, or OpenTelemetry Collector pipeline that converts
entries to supported HTTP JSON/NDJSON, or OTLP Logs JSON, and sends them to
`/api/logs/ingest` with the `logs:write` key. Better Stack, Falcon LogScale, and
similar products are supported when configured to push through a compatible
webhook or collector; provider-specific API polling is intentionally out of
scope for this version.

## Deployment settings

Set in `.env`. Recreate `suite-victorialogs` after changing its resource or
retention settings. Recreate `suite-admin` after changing server settings or
the retention/cap values it displays.

| Variable | Default | Meaning |
|----------|---------|---------|
| `LOGS_RETENTION_DAYS` | `14` | Days kept; older lines are deleted. |
| `LOGS_STORE_MAX_DISK` | `10GiB` | Disk cap; the oldest days are dropped beyond it. |
| `LOGS_STORE_MEMORY` | `512m` | Container memory limit. |
| `LOGS_STORE_CPUS` | `0.5` | Container CPU limit. |
| `LOGS_STORE_URL` | `http://logs-backend:9428` | Store address used by Robin Admin. |
| `LOGS_STORE_PORT` | `9428` | Loopback port published by the host overlay. |
| `LOGS_SENTRY_CLIENT_SECRET` | empty | Server-only secret used to verify Sentry webhook signatures. |
| `LOGS_SPOOL_MAX_BYTES` | `256MiB` | Maximum line data held in the ingestion queue while the store is slow or down; minimum `64KiB`. |

The store image has no shell, so the container has no healthcheck; use
`GET /api/logs/status` (or the warning on the Logs page) instead. Only the
bundled store is supported; there is no external-store connection setting.

## Integration tests

The normal server and client suites cover normalization, access controls,
queries, alert transitions, and the Logs pages. CI also runs PostgreSQL and
VictoriaLogs integration tests automatically for code changes. These exercise
HTTP ingestion and search, queue capacity and retries, possible duplicates
after an uncertain write, Fleet receipts and counters, and a firing and
recovery delivered to a local TLS webhook.

To run those tests locally, set `LOGS_IT_DB=1`, the `DB_*` connection
variables, `LOGS_STORE_URL`, `LOGS_SENTRY_CLIENT_SECRET`,
`ROBIN_ADMIN_ENCRYPTION_KEY`, and `SESSION_SECRET`. OpenSSL is required for
the webhook test. The database must be disposable, on loopback, and have a
name beginning with `robin_test_logs` followed by an underscore or the end of
the name. These tests initialize the schema and modify or clear data; never
point them at an application database. Run the files separately and
sequentially because they reset shared tables:

```sh
npm --prefix server test -- --run src/db/queries/logs.integration.test.ts
npm --prefix server test -- --run src/services/logs-delivery.integration.test.ts
npm --prefix server test -- --run src/services/alerts/logs-webhook.integration.test.ts
```
