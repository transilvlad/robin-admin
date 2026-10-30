# Robin MTA

Management interfaces for the Robin Mail Transfer Agent.

## Queue management

The Queue page displays emails currently in Robin's delivery queue.

### Queue item fields

| Field | Description |
|-------|-------------|
| **UID** | Unique identifier for the queue item |
| **From** | Envelope sender address |
| **To** | Envelope recipient address |
| **State** | Current delivery state |
| **Retries** | Number of delivery attempts |
| **Created** | When the email entered the queue |
| **Next Retry** | Scheduled time for next delivery attempt |

### Queue states

| State | Description |
|-------|-------------|
| `pending` | Awaiting first delivery attempt |
| `retry` | Previous attempt failed, waiting to retry |
| `delivering` | Currently being delivered |
| `delivered` | Successfully delivered (brief) |
| `bounced` | Permanently failed, bounce sent |

### Queue actions

- **Retry**: Immediately attempt delivery again
- **Delete**: Remove from queue without delivering
- **Bounce**: Generate bounce message and remove

> **Gotcha**: Queue data comes from Robin's API, not directly from the database. Robin must be running for queue management to work.

### Hybrid approach

The Queue page uses both:
1. **Robin API** (`/client/queue/*`): For actions (retry, delete, bounce)
2. **Database**: For listing and filtering

This provides real-time queue state from Robin while enabling rich filtering.

### Filtering

Filter queue items by:
- **State**: pending, retry, etc.
- **Sender**: Filter by from address
- **Recipient**: Filter by to address

---

## Configuration

The Config page provides a form-based interface for Robin MTA configuration.

### Configuration files

Robin uses JSON5 configuration files in the `cfg/` directory:

| File | Purpose |
|------|---------|
| `server.json5` | SMTP server settings |
| `client.json5` | SMTP client defaults |
| `queue.json5` | Queue processing settings |
| `storage.json5` | Email storage settings |
| `dovecot.json5` | Dovecot integration |
| `relay.json5` | Relay settings |
| `clamav.json5` | Virus scanning |
| `rspamd.json5` | Robin's consumer-side Rspamd scan/signing settings |
| `bots.json5` | Bot configurations |
| `properties.json5` | General properties |

### Config tabs

Each configuration file has its own tab with a form-based UI:
- Boolean options show as toggles
- Text options show as inputs or textareas
- Arrays show as editable lists
- Objects show as nested forms

### Server overrides

Robin supports per-server configuration overrides:
1. Default configuration applies to all servers
2. Server-specific overrides are saved with a server ID
3. Use "Save As Override" to create server-specific config

The **fleet services** (rspamd, dovecot, postfix, clamav, redis, postgres) now
share this same layered model — a `default` base plus per-instance delta
overrides. See [fleet.md](fleet.md#per-instance-config-overrides).

### Config diff

The Config Diff page shows differences between:
- Default configuration
- Server-specific overrides

This helps identify what's customized per server.

Saving configuration does not apply it to a running process. **Sync now**
requests an authenticated reload from the separately selected **Reload target**.
The configuration's server ID selects database overrides; it is not a fleet
service ID and is never used as an implicit management endpoint.

### Form field types

The config form automatically renders appropriate controls:
- `boolean` → Toggle switch
- `string` → Text input (textarea for long values)
- `number` → Number input
- `array` → List with add/remove buttons
- `object` → Nested form section

### Saving configuration

When you save configuration:
1. Form data is serialized to JSON
2. Sent to backend API
3. Written to the configured PostgreSQL config-store row
4. Reported as saved, with runtime application still unconfirmed

The UI parses JSON5 before saving structured JSON. Database save success is not
proof that Robin accepts the setting, has loaded it, or can hot-apply it.

### Applying and reading back configuration

Admin calls `POST /config/reload` on the selected Robin service's metrics base
URL. Both management APIs use the provisioned Basic credential in
`ROBIN_API_AUTH`; Admin will not issue anonymous reloads. The configured default
uses `ROBIN_METRICS_URL` (default `http://localhost:8080`). Explicit fleet targets
must be registered, enabled, and have a metrics URL; errors never fall back to a
different service. Requests have a 30-second timeout and do not follow redirects
with management credentials.

The Admin endpoint is `POST /api/robin-config/reload` with
`{ "serviceId": "fleet-west" }` or `{ "serviceId": "default" }`.
The former ambiguous `{ "serverId": ... }` body is rejected. An HTTP 200 from an
old Robin API without `applied: true` remains **unconfirmed**, not success.

Robin's `applied: true` and `scope: "configuration-snapshot"` confirm that its
configuration snapshot was replaced, not that listeners, SQL authentication,
queue workers or scanners were reconstructed. A `restartRequired: true`
response is shown as **restart needed**. Admin never restarts Robin as part of a
save or reload. Plan and verify restart-only changes separately.

**Check runtime** reads `GET /config/status` through the authenticated
`GET /api/robin-config/runtime-status?serviceId=...` proxy. It shows the selected
process's redacted loaded-source fingerprints, automatic/manual reload availability
and sync status. These are not inferred from database saves. Source hashes cover
successfully parsed source JSON with recursively sorted keys and compact UTF-8
encoding, before secret/magic expansion; they do not prove live listener or pool
settings. They need not equal order-dependent hashes of database rows. If the running Robin
version does not support readback, the UI reports that failure explicitly.
Apply state starts as unknown after reopening the page; an earlier browser
success message is not durable evidence of the current runtime.

Both proxy endpoints require the admin role and `admin:*` API-key scope.
Reload attempts record the actual target, upstream status, confirmation and
restart requirement in the audit log. Saved rows and reload outcomes are not
silently treated as an audited live migration.

### Rspamd relationship

Robin Admin exposes a separate **Fleet -> Rspamd** workspace for:

- native `local.d` Rspamd config management
- DKIM key generation and rotation
- training corpus upload and learn actions

Robin's own `rspamd.json5` remains under **Fleet -> Robin -> Config** because it
is Robin's consumer configuration. It is not synchronized from the Rspamd
workspace; operators update it as part of Robin-side configuration.

The production suite uses **Rspamd as the single DKIM signer**. Existing Admin
key generation, sealed storage, selector overlap and agent delivery remain at
Rspamd's `local.d/dkim/<domain>.<selector>.key`. Robin's independent local signer
must stay disabled for that deployment. Required authenticated outbound signing
must defer when Rspamd fails to return a signature; DNS TXT publication, a saved
key or an acknowledged file write alone does not prove signing. Verify a real
authenticated submission and its resulting DKIM signature before declaring a
domain operational.

---

## Metrics

The Metrics page displays real-time and historical metrics from Robin MTA's Prometheus endpoint.

### Overview tab

The Overview tab shows:

#### Health tiles
- **Memory**: JVM heap usage percentage with color-coded status
- **JVM Threads**: Current live thread count
- **Total Received**: Cumulative emails received since Robin start
- **Total Delivered**: Cumulative successful deliveries
- **Total Rejected**: Sum of all rejections (RBL, virus, spam, DoS)
- **Delivery Rate**: Current messages per minute

#### Charts
- **Email Throughput**: Stacked bar chart showing delivered vs rejected over time
- **Delivery Rate**: Line chart showing messages/minute trend
- **Memory Usage**: Historical JVM memory utilization

#### Protection statistics
Shows cumulative counts for all protection mechanisms:
- RBL Rejections
- Virus Rejections (ClamAV)
- Spam Rejections (Rspamd)
- Rate Limit Hits
- Connection Limit Rejections
- Tarpit Triggers
- GeoIP Blocks
- Whitelist Bypasses

### Time Windows

Select different time ranges for historical data:
- **1h**: Last hour
- **6h**: Last 6 hours
- **24h**: Last 24 hours (default)
- **7d**: Last 7 days

### Raw output tab

Displays the raw Prometheus text format output from Robin's `/metrics/prometheus` endpoint.

### Metrics collection

Metrics are collected by a background poller:
- **Poll Interval**: 60 seconds by default
- **Retention**: 14 days by default
- **Storage**: Historical data stored in `metrics_history` table

Administrators can change the poll interval and retention in
**Administration -> Integrations -> Fleet operations**. The
`METRICS_POLL_INTERVAL` and `METRICS_RETENTION_DAYS` environment variables remain
startup defaults when no persisted setting exists.

> **Gotcha**: Robin MTA must be running and accessible for live metrics. Historical data is available even when Robin is down.

> **Gotcha**: Rate calculations require at least two data points. The first sample after Robin restart shows 0 rates.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROBIN_API_URL` | `http://localhost:8090` | Robin's HTTP endpoint |
| `METRICS_POLL_INTERVAL` | `60000` | Poll interval in milliseconds |
| `METRICS_RETENTION_DAYS` | `14` | How long to keep historical data |
