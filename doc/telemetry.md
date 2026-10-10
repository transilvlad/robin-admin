# Telemetry

Telemetry stores arbitrary Prometheus-compatible metrics pushed by collectors such as
[Vector](https://vector.dev) in a Prometheus-compatible time-series store.
The bundled store is VictoriaMetrics.

This is a metrics workspace, not a universal logs/traces ingest service. It does
not accept OTLP, syslog, Graphite, arbitrary JSON or collector configuration.
Collectors own collection, metric names, labels, buffering and retries.

The store is never exposed directly. Agents write through Robin Admin's
authenticated ingest routes; Robin Admin reads from the store on behalf of
signed-in admins.

## Upgrading

Existing installs with prior telemetry state but no saved discovery policy
retain the `host` / `role` source and group labels; fresh installs use
`instance` / `job`.

## Store

The bundled store, `suite-victoriametrics` (alias `metrics-backend`), is part of
Robin Admin's Compose stack in every layout: it starts with Admin, on Admin's
private network, with a named volume (`suite-victoriametrics-data`), a pinned
image digest and a healthcheck. It publishes no ports, except on loopback in
the host-networked layout. Nothing needs provisioning: enable Telemetry and it
works.

Configure the store under **Administration > Telemetry**. Connection settings
are stored in PostgreSQL, not in deployment environment variables. They survive
container rebuilds and deployments. Changing a connection takes effect without
restarting Admin; a one-second cache bounds configuration reads across workers.

- **Connection**: choose Bundled VictoriaMetrics (the default), External store
  or Disabled. Bundled uses the address the deployment sets in
  `TELEMETRY_STORE_URL` (default `http://metrics-backend:8428`; the
  host-networked layout uses `http://127.0.0.1:8428`). It is a deployment
  coordinate, so it is trusted, including loopback.
  External stores accept an HTTP(S) base URL and none/basic/bearer authentication.
  Authentication requires HTTPS with normal certificate validation. Credentials
  are encrypted with the existing Admin encryption root; the API never returns
  the credential or envelope. An empty replacement retains the existing secret;
  clearing is explicit. Changing authentication mode or destination origin
  requires a new credential.
  Test checks the unsaved connection; Save tests before applying. Concurrent
  edits return 409 and require reloading.
- **Policy**: discovery, silence, refresh, ingest size, request timeout, query
  series/points/range are editable within fixed safety ceilings. Query policy
  applies to interactive queries; source discovery has its own source limit.
  Discovery labels/selectors and dashboard content are separate settings;
  sources and groups are discovered, not registered in a hardcoded list.
  Saved telemetry and Monitoring settings are validated together when loaded.
  If a persisted cross-field combination becomes invalid after startup, the
  last valid configuration stays active and an Administration warning identifies
  the problem; invalid persisted settings still fail closed before a valid
  configuration has loaded.
- **Storage**: the store's version, retention, memory limit, data on disk and
  free disk, read from the store itself. For the bundled store it also creates,
  lists and deletes snapshots.

### Retention and memory

Bundled store retention and memory are deployment settings in `.env`, shown
read-only under Storage:

| Variable | Default | Meaning |
|----------|---------|---------|
| `TELEMETRY_RETENTION_DAYS` | `90` | Days of samples kept (`-retentionPeriod`) |
| `TELEMETRY_STORE_MEMORY` | `1g` | Container memory limit; the store sizes its caches from it |

Apply a change with `docker compose up -d suite-victoriametrics` (include the
same `-f` files as the deployment). This restarts the store, not Admin; senders
retry while it restarts. Reducing retention permanently deletes samples older
than the new period, so take a snapshot first if they may be needed.

### Snapshots and backups

**Create snapshot** (Storage, bundled store) calls VictoriaMetrics' online
snapshot API. The store keeps serving ingest and queries. A snapshot is a
consistent, hard-linked copy under `snapshots/<name>` in the store's data
volume, so it costs little space at first but grows as the live data changes.
It protects against operator mistakes such as a retention cut, not against
losing the volume or host. Delete snapshots you no longer need.

To keep a backup off the host, copy a snapshot out of the volume:

```bash
docker run --rm -v suite-victoriametrics-data:/storage:ro -v "$PWD":/backup alpine \
  tar -h -C /storage/snapshots -czf /backup/telemetry-<name>.tar.gz <name>
```

To restore, stop the store, replace the volume's data with the snapshot and
start it again:

```bash
docker compose stop suite-victoriametrics
docker run --rm -v suite-victoriametrics-data:/storage -v "$PWD":/backup alpine sh -c \
  'mkdir /storage/restore && tar -C /storage/restore -xzf /backup/telemetry-<name>.tar.gz &&
   find /storage -mindepth 1 -maxdepth 1 ! -name restore -exec rm -rf {} + &&
   mv /storage/restore/<name>/* /storage/ && rm -rf /storage/restore'
docker compose start suite-victoriametrics
```

Samples written between the snapshot and the restore are lost.

External stores manage their own retention, resources and backups; Storage shows
what the store reports and offers no snapshots.

External connections resolve and validate DNS on every request, pin the socket
to a validated address, block redirects, bound responses to 32 MiB and obey the
saved request timeout. Private destinations require an explicit selection;
loopback, link-local/metadata, multicast and other reserved addresses remain
blocked even then.

External stores need the query/label/TSDB/health endpoints used by this workspace
as well as the ingest endpoints they will receive. Prometheus-compatible does
not mean every store implements every endpoint: remote write goes to
`/api/v1/write`, text import to `/api/v1/import/prometheus`. Text import is a
VictoriaMetrics API and must be supported by the chosen store; Robin Admin does
not translate unsupported protocols. Detailed storage counters are available
only for VictoriaMetrics; other compatible stores expose less health detail.

## Ingest

Ingest requires an API key with the `telemetry:write` scope. Admin sessions
cannot write. Create one key per sender or sender group under
**Administration -> Access -> API Keys**. The API keys link from Telemetry
selects a viewer-role `telemetry:write` preset in this same manager; it does not
create a second key store or host registration. Keys can be restricted to the
sender's CIDRs and given an expiry. Revoking a key immediately stops its writes.

| Method | Path | Body |
|--------|------|------|
| POST | `/api/telemetry/write` | Prometheus remote write (snappy-compressed protobuf) |
| POST | `/api/telemetry/import` | Prometheus text exposition, with optional millisecond timestamps |
| GET | `/api/telemetry/write`, `/api/telemetry/import` | Sender health check: `200` when the store is healthy |

Successful writes return `204`: the store accepted the batch, not a guarantee
that every sample was valid. Store validation errors return a redacted `4xx`;
also inspect rejected sample counters where available. An unconfigured store
returns `503`; store request failures return `503` with `Retry-After: 5`.
Senders should retain their buffered data and retry temporary failures.

Ingest uses the fleet-agent rate-limit bucket (ten times the default per IP).

### First metrics to a Dashboard

1. Enable Telemetry under **Administration -> Integrations -> Capabilities**.
2. Under **Administration -> Telemetry**, keep the bundled store or save/test
   an external connection. Set Discovery to labels your sender uses.
   Existing label names are suggestions, not an allowlist; custom labels and
   an empty grouping label are valid. An unavailable store does not prevent
   saving discovery settings. Discovery does not change or require ingest labels.
3. Create a scoped ingest key under **Administration -> Access -> API Keys**.
   Send metrics to one of the two supported routes. For a neutral text example,
   use a trusted HTTPS destination and a scoped key:

   ```bash
   printf '%s\n' 'app_queue_depth{instance="worker-a.example.test",job="worker"} 3' |
     curl --fail-with-body --request POST \
       --header "Authorization: Bearer $ROBIN_ADMIN_TELEMETRY_KEY" \
       --header 'Content-Type: text/plain; version=0.0.4' \
       --data-binary @- https://admin.example.com/api/telemetry/import
   ```

   Omitted timestamps use the store's receipt time. Explicit timestamps in text
   are Unix milliseconds. Remote-write producers use snappy-compressed protobuf
   with `Content-Type: application/x-protobuf`, `Content-Encoding: snappy` and
   `X-Prometheus-Remote-Write-Version: 0.1.0`; do not send text to `/write`.
   Admin forwards these format headers and raw bytes to the store, which validates
   the format. Request-size limits apply to received bytes, not to decompressed
   protobuf size; the store needs its own decoding/cardinality limits.
4. Open **Telemetry -> Sources** and follow a sender to Explore. Or query
   `app_queue_depth` directly: matching discovery labels are never a prerequisite
   for querying data. Metric suggestions use the selected time window.
5. **Add to dashboard** explicitly selects an existing destination or creates
   a new named dashboard and its panel in one save. Choose units/visualisation;
   arbitrary queries do not need a `host` variable or exporter template.

The text sample above is opt-in example data, not automatically installed data.
API keys authenticate writes; they do not restrict which series/labels a sender
can submit or provide tenant isolation inside a shared store.

### Vector

```yaml
sinks:
  robin_admin:
    type: prometheus_remote_write
    inputs: [host_metrics]
    endpoint: https://admin.example.com/api/telemetry/write
    auth:
      strategy: bearer
      token: "${ROBIN_ADMIN_TELEMETRY_KEY}"
    batch:
      max_events: 1000
      timeout_secs: 10
    buffer:
      type: disk
      max_size: 268435488
      when_full: drop_newest
```

Telemetry accepts arbitrary Prometheus metric/label schemas, not just Vector.
Under **Administration -> Telemetry -> Discovery**, configure the source identity
label, optional grouping label and series selector. Defaults are `instance`,
`job` and `{__name__=~".+"}`. Vector's `host`/`role` is another explicit option;
no ingest relabeling is required. Only bounded metric names/label selectors are
accepted, not arbitrary query fragments. Sources and the recent-data banner use
the same saved selector and silence policy. Source links open scoped Explore;
they do not require any dashboard or a variable named `host`.

Vector 0.5x does not interpolate environment variables in config files unless
started with `--dangerously-allow-env-var-interpolation`. Render the key into
the config with your deployment tool, or load it with a Vector secret backend.

## Dashboards

Turn Telemetry on under **Administration -> Integrations -> Capabilities**.
Dashboards are stored by Robin Admin and managed entirely in the UI: anyone
signed in can view them, and editors and admins can change them. While the
capability is off, reads return `403`; ingest keeps working so data
accumulates before the UI is enabled.

### Viewing

**Telemetry -> Dashboard** shows one dashboard at a time. Pick the dashboard,
its variables (options follow earlier variables and the selected time window) and a time
range: a preset, a custom window, or drag across any chart to zoom in. Charts
share a crosshair. Click a legend entry to hide or show a series; hover it to
highlight. Auto refresh applies to relative ranges. The dashboard, variables,
range and refresh interval are kept in the URL, so a view can be bookmarked or
shared; a dashboard can set the range and refresh it opens with, which a range
in the URL overrides. The page explains a missing or unreachable store, checks
again by itself until the store is back, and warns when no matching source has reported
within the configured silence threshold.

- **Incidents** (admins, like Monitoring itself) shades the time Monitoring
  issues were open on every chart (amber for warning, red for critical) and
  lists them in the chart tooltip.
- A panel's **View** button opens it full screen; **Open in Explore** opens its
  queries, with variables filled in, in Explore.
- Panels with a link make their series names clickable: the click opens the
  linked dashboard with a variable set from the series, for example from the
  one custom dashboard to another using a device label.
- Rows set to repeat are drawn once per selected value of a variable (or every
  value when none is selected), each with the variable set to that value.
- When an explicitly added template has a newer layout, editors see
  **Use updated template** (the current version stays in the history) or
  **Keep mine**, which hides the notice until the template changes again.
  A dashboard that already matches its template shows no notice.

Stat and table panels show each series' value at the end of the range. A
series with no sample for the last two steps (and at least five minutes), for
example a host that went silent, shows "No data for …" instead of its last
reading, and gets no threshold badge.

Series colours come from a fixed eight-colour palette, assigned by series name
so a series keeps its colour across refreshes. Series past the eighth are drawn
in a muted grey and identified by the legend and tooltip.

### Editing

Choose **Edit** to change the open dashboard. In edit mode:

- Drag a panel by its header to move it and resize it from its bottom-right
  corner. Each row is a 12-column grid.
- **Add panel** (per row) or a panel's pencil opens the panel editor: title,
  description, visualisation (time series, stat or table), unit, one or more
  PromQL queries with legends, minimum and maximum, warning and critical
  thresholds (optionally "lower is worse"), stacking, decimals, legend (list,
  table with min, max, mean and last, or hidden), logarithmic scale, whether
  the panel may be empty on some hosts, its position and size, and the row it
  belongs to. Tables can show one row per value of a label with one column
  per query, each with its own unit. A link sends clicks on a series to
  another dashboard with a variable set from one of the series' labels. A
  live preview runs the panel against the current range and variables.
- Rows can be added, renamed, reordered, set to start collapsed, set to
  repeat for each value of a variable, and removed.
- **Variables** edits the pickers: name, label, the label their values come
  from, an optional series selector (which may use earlier variables), and
  whether several values may be chosen. **Preview values** shows what a
  variable would offer.
- **Details** changes the title, description, and the range and refresh the
  dashboard opens with.

Panels show the unsaved draft while editing. **Save** stores a new version;
if someone else saved first, Robin Admin offers to reload their version or
save yours over it. Leaving with unsaved changes asks first.

The **More** menu has: **Manage dashboards** (order, delete, create a blank
dashboard, import JSON, add an optional template), **Duplicate**, **Export
JSON**, **Version history** (the last 20 versions; **View** lists what
restoring one would change, and any can be restored as a new version),
**Restore template** (for dashboards explicitly added from a template) and
**Delete**.

### Explore

**Telemetry -> Explore** runs ad-hoc PromQL. Up to five queries run together
on one chart, their series prefixed A, B, C and so on. **Metrics and labels**
browses metric names, their labels and label values; clicking a value inserts
the selector into the focused query. Results can be shown as a chart or as a
table of each series' latest, minimum, maximum and average value, in a chosen
display unit. The last 20 runs are kept under **Recent queries** in this
browser. Editors can turn the queries into a panel with **Add to dashboard**,
including a new dashboard on an empty installation. Existing destinations must
be chosen explicitly; the first dashboard is never silently edited.

### Sources

**Telemetry -> Sources** discovers sources using the identity label, optional
grouping label and selector saved in **Administration -> Telemetry -> Discovery**.
The defaults are `instance` and `job`; no host inventory or collector is required.
Creating an API key does not deploy an agent or constrain the labels it can send.
Configure labels and collection on the sender; Fleet
service bindings can be edited in the Fleet service form. Default discovery is
seven days and silence is 15 minutes; both are managed under
**Administration -> Telemetry -> Policy**, together with source refresh, source
limit, ingest request size and store request timeout. Saved policies take effect
without a restart. Source and dashboard summary statuses use the same policy.

An empty source list distinguishes no metrics in the discovery window, a selector
that matches no metrics, and matching metrics lacking the configured non-empty
source label. It links to ingest keys or Discovery settings as appropriate.
Disconnected stores have their own Connection state, not a misleading empty list.
Older queries remain usable when no recent source matches. Silent source links
open the full discovery window rather than an empty recent-hour view. Query range
ceilings still apply; adjust the range or policy when needed.

Editors also see the store: address, kind and version, retention, active
series, data size and free disk, ingest and rejected sample rates (averaged since
a read one to ten minutes earlier, so they appear a minute after the first), and
the metrics with the most series. API key creation, last use, expiry and revocation
are available only in the existing Administration Access manager.

Source responses explicitly report truncation when query results or the bounded
source union exceed their limits; incomplete counts are not a complete inventory.
Current sample timestamps are exact. Departed sources' timestamps are sampled to
five-minute precision for the last day; older timestamps are unknown, even when
the source remains in the discovery window. Historical groups are sampled hourly.
The source limit is not a guaranteed store/cardinality capacity envelope.

**Administration -> Telemetry** owns connection, policy and storage. Store usage
remains visible under **Telemetry -> Sources -> Store**.

A Fleet service can record its source identity (**Telemetry source** in the
service form, `telemetrySource` in the API). Links resolve the saved discovery
label/selector and open scoped Explore, independent of installed dashboards.

### Optional templates

A fresh installation has no dashboards. Create one, import JSON, or explicitly
add an exporter-specific example from **Manage dashboards**. Saved dashboards
and history survive upgrades/restarts; there is no startup seeding or forced
infrastructure layout. Optional examples are ordinary editable dashboards.

| Dashboard | For |
|-----------|-----|
| Linux host | CPU, memory, storage and network from Vector `host_metrics` |
| Docker containers | Per-container CPU, memory, network and block IO |

These examples have explicit exporter contracts: Linux host uses Vector metric
names with `host`/`role` labels; Docker uses the `docker_*` names shown in its
queries and `host`/`container` labels. They are not universal collector adapters.
Edit their queries/variables for other schemas. Panel-specific thresholds and
expressions are independent of the global Sources silence policy.

### Queries

Panel queries are PromQL with placeholders the server fills in:

- `$<variable>`: the selection as an escaped regular expression, for use in
  `=~` matchers (`host=~"$host"`); an empty or "all" selection matches any
  value.
- `$__interval`: the query step.
- `$__rate_interval`: a `rate()` window spanning at least four steps and four
  minutes.

Legends use `{{label}}` placeholders. Dashboards are validated on save: every
query may only use declared variables and must have balanced brackets and
quotes, and panels must fit the grid.

### API

Reads need a signed-in admin of any role or an API key with `telemetry:read`.
Changes need the editor role and, for API keys, `telemetry:manage`; ingest keys
(`telemetry:write`) cannot change dashboards.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/telemetry/status` | Capability state, store reachability, series count, sources within the configured silence window and `silentAfterSeconds` |
| GET | `/api/telemetry/dashboards` | Dashboard list, in navigation order |
| GET | `/api/telemetry/dashboards/:uid` | One dashboard |
| GET | `/api/telemetry/dashboards/:uid/panels/:panel` | One panel's series: `start`, `end`, optional `step`, and `var-<name>=<value>` (repeat for several values) |
| GET | `/api/telemetry/dashboards/:uid/panels/:panel/queries` | A panel's queries with variables substituted, for Explore: same parameters as the panel |
| GET | `/api/telemetry/dashboards/:uid/variables/:name` | Options for a dashboard variable, honouring earlier variables |
| GET | `/api/telemetry/dashboards/:uid/versions[/:version]` | Saved versions |
| GET | `/api/telemetry/templates` | Optional exporter templates that can be added explicitly |
| GET | `/api/telemetry/query_range` | Ad-hoc PromQL range query: `query`, `start`, `end`, optional `step` |
| GET | `/api/telemetry/query` | Ad-hoc PromQL instant query: `query`, optional `time` |
| GET | `/api/telemetry/labels` | Label names: optional `match` selector, `start`, `end` (default last hour) |
| GET | `/api/telemetry/labels/:name/values` | Label values: optional `match` selector, `start`, `end` (default last hour) |
| GET | `/api/telemetry/sources` | Discovery labels, sources, windows/limits, truncation and `emptyReason`; each source includes groups, its scoped query, current series, newest sample (`null` when over a day old) and `silent` |
| GET | `/api/telemetry/store` | Editors: store version, retention, size, disk, ingest and reject rates, top metrics |
| GET | `/api/telemetry/annotations` | Admins: Monitoring issues open between `start` and `end`; empty while Monitoring is off |
| POST | `/api/telemetry/dashboards` | Create: dashboard JSON, `{ "templateKey": … }` or `{ "duplicateOf": … }` |
| PUT | `/api/telemetry/dashboards/:uid` | Save: dashboard JSON plus the `version` it was edited from (`409` if someone saved since) |
| DELETE | `/api/telemetry/dashboards/:uid` | Delete with its history |
| POST | `/api/telemetry/dashboards/:uid/restore-default` | Reset to its default layout |
| POST | `/api/telemetry/dashboards/:uid/keep` | Keep the dashboard as it is and stop offering the current default |
| POST | `/api/telemetry/dashboards/:uid/versions/:version/restore` | Restore a version as a new version |
| PUT | `/api/telemetry/dashboard-order` | `{ "uids": [...] }` in navigation order |
| POST | `/api/telemetry/preview/panel`, `/api/telemetry/preview/variable` | Run unsaved editor state |

Dashboard JSON is `{ title, description, variables, rows, defaults }`, the same
shape **Export JSON** downloads. Invalid content returns `400` with every problem in
`problems`. Times are Unix seconds. Range results share one `timestamps` array,
with one `values` array per series (`null` where a series has no sample).
Responses are bounded: at most 1,500 points per series (the step is raised to
fit), 100 series per query, 400 days per range, and 4,000 characters per query.

`npm run telemetry:check` in `server` runs every panel of every dashboard
through the API and reports panels that fail or come back empty. Use
`--each host` to check every host, and point `TELEMETRY_CHECK_URL` at another
deployment with a `telemetry:read` key in `TELEMETRY_CHECK_API_KEY` to find
missing metrics there. API keys share the per-IP rate limit, so the script
waits when it is throttled.

## Local development

The `telemetry-dev` profile runs a local Vector that sends its container's host
metrics through the ingest route with `host="robin-admin-dev"` and
`role="container"`. Create a `telemetry:write` API key, put it in `.env` as
`TELEMETRY_DEV_API_KEY` (Compose passes it to Vector as a secret), then:

```bash
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml --profile telemetry-dev up -d suite-admin-vector-dev
```

For this optional Vector example, save `host` as the source identity label and
`role` as the grouping label in **Administration -> Telemetry -> Discovery**.
This is explicit instance configuration, not an application-wide requirement.

`npm run telemetry:seed` writes one hour of neutral `demo_*` metrics for two
`.example.test` instances with `instance`/`job` labels. It requires
`TELEMETRY_SEED_DISPOSABLE=1`, an explicit loopback HTTP `TELEMETRY_SEED_URL`
and a disposable `TELEMETRY_SEED_API_KEY`. It refuses remote destinations,
redirects and implicit credentials; never run it against a real deployment.
It does not create dashboards or run at startup.
