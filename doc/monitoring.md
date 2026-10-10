# Monitoring and status page

The scheduler checks for due work every half second and claims only as many
due checks as there are free probe slots, starting each without waiting for
the others; when a claim fills every slot it claims again as soon as one frees.
A slow or timing-out target therefore holds only its own slot. Each run is
scheduled one interval after the previous run started, so probe duration does
not push the schedule back. Manual and scheduled checks share
the UI-managed concurrent probe slots (default 24), counting check lookup,
probe and observation write. Defaults allow eight concurrent manual requests,
twenty waiting requests and thirty seconds of queue wait. Manage these policies
under **Administration -> Monitoring -> Policy**; validation reserves at least
one scheduled slot. Saved limits apply to new work immediately; lowering a limit
does not cancel active probes or discard their observations. Queue admission time
sets the deadline for that request. The manual API returns 503 with Retry-After
when its capacity or waiting limit is exceeded. Repeated
requests for one check share its execution and observation. Accepted work
continues if a browser disconnects; this does not cancel the recorded check.
These limits apply to the supported single Admin process, not multiple replicas.
With 150 checks on a 10-second interval, a fifth of them slow or timing out,
every check starts within half a second of its due time
(`scheduler.integration.test.ts`).

Each combined check evaluation updates a per-check daily rollup (UTC days: up,
warning and down counts, average and maximum response time), and individual
probe results update per-location daily rollups. These histories outlive raw
observations. Raw observations are kept for
30 days by default and daily rollups for 400 days; both retention policies are
managed under **Administration -> Monitoring -> Policy** and pruned hourly in
batches. Daily retention cannot be shorter than raw retention. Reducing retention
permanently prunes older evidence on subsequent maintenance; increasing it cannot
recover already deleted evidence. The corresponding `MONITORING_*` environment
variables provide initial defaults only, not overrides of saved policies.
`GET /api/monitoring/checks/:id/history?days=90` (admin, bounded to 1-400 days per read)
returns the daily rollup with availability; ordinary warnings count as reachable.
Certificate errors configured as warnings remain in the warning total but are
excluded from availability; near-expiry certificates remain reachable.
The history button on each row of **Monitoring -> Checks** shows combined history for 7, 30,
90 or 365 days: overall availability, a bar per day (green at 99.9% or more,
amber at 99% or more, red below) and the average and slowest response time per
day. It also lists daily availability and response times for each probe location.
`GET /api/monitoring/checks/:id/location-history?days=90` returns those
per-location rollups. Status page components that show history use the combined
rollups.

Targets, endpoints, probe type, interval, timeout, confirmation/recovery windows,
probe placement and quorum, TLS mode, certificate-error policy and certificate-warning threshold are
persisted and edited in the Monitoring check/target forms; their form defaults
are not fixed runtime policy.
Status-page branding, publication, subscriptions, timezone, theme and history
window live under **Administration -> Monitoring -> Status Page**. Operational
components, incidents, updates, maintenance and subscribers stay in Monitoring.
Scheduler tick/maintenance timing and hard API/protocol safety ceilings are
implementation limits, not unrestricted operator knobs. Container/database
resources and external mail delivery remain deployment-managed.

Email batches are limited to four deliveries; webhook batches use
the saved **Administration -> Alerts** concurrency policy. Database outages are logged and retried on later ticks; a failed
observation cannot be used as proof that the remote service is healthy.

Robin Admin has two Monitoring surfaces:

- **Monitoring -> Checks** is the private operator view for external checks,
  observations, open issues, issue history, and alert delivery history.
- **Monitoring -> Status Page** is the public-facing projection of selected
  Monitoring checks into customer-friendly components, incidents, and
  maintenance windows.

Monitoring is intentionally independent from Fleet metrics and Telemetry, which
remain the place for dashboards, graphs, and service telemetry; Telemetry
dashboards can shade Monitoring incidents on their charts for admins. Monitoring is for external
reachability checks and issue lifecycles.

Fresh installs contain no targets, checks, sections or components. Status-page
branding is neutral, no custom domain/logo is configured, and public publication
is off until an admin explicitly enables it. Schema initialization never creates
inventory or replaces operator configuration. Create targets/checks and link
selected checks to components through the UI.

Fresh installs keep Monitoring disabled until an admin enables it under
**Administration -> Integrations -> Capabilities**. Enabling it shows the
Monitoring navigation directly after Fleet and starts the background scheduler
that runs due checks.

## Configuration transfer

Administrators can download a versioned JSON configuration from
`GET /api/monitoring/export` or use **Export** on the Monitoring page. The export
includes targets, checks, status-page sections and components, but excludes
observations, issues, status-page history and all secret-header names and values.
`POST /api/monitoring/import` accepts that document with `dryRun: true` to preview
creates, updates, conflicts and invalid rows; send `dryRun: false` to apply a
conflict-free import. The UI always previews before enabling **Apply import**.
Each collection and each component's linked checks are limited to 500 entries;
imports are limited to a 1 MB request body. Exports enforce those same bounds
and fail with a clear message rather than creating a file the importer cannot
accept.
Targets match by name and environment, checks by name within their target,
sections by name and components by public name within their section. Imports
never delete configuration that is absent from the file. Check options are
validated with the same protocol rules as the editor. Updating a check preserves
its locally stored secret headers; newly imported checks have no secret headers
until they are added in the editor.

## Upgrading

Existing checks are migrated to preserve their former unrestricted private
target access. New checks still default to **Allow private network targets**
off. Stale certificate settings on checks that do not use TLS are cleared so
those checks continue to run. Checks migrated from the legacy certificate
policy use **Certificate errors: warning**; review this policy if certificate
failures should mark a check down instead. SMTP checks on port 587 and IMAP
checks on port 143 default to STARTTLS when no explicit option is saved, so
their certificates are now validated and tracked under the check's TLS policy.
Review mail checks and explicitly disable STARTTLS only when the server requires
plaintext.
Monitoring's alert-delivery banner indicates when Monitoring is active but
alert evaluation or delivery is disabled.
The additive probe-location schema migration seeds the built-in **Local**
location. Existing checks default to **All enabled locations** with majority
quorum; newly granted remote locations therefore join those checks unless an
admin chooses a specific set in the check editor. Revoke/disable a location to
remove it from assignments and quorum without deleting its history.

## External heartbeats

Monitoring can send outbound HTTPS heartbeats to up to ten external uptime
services. Configure one under **Administration -> Monitoring -> Heartbeats**.
The ping URL is called only while the database, Monitoring scheduler and (when
enabled) alert-delivery worker are healthy. An optional failure URL receives a
short reason code (`database`, `monitoring_disabled`, `scheduler_lag`, or
`alert_backlog`) when a
health criterion fails; without one, the heartbeat is silenced so the external
service can alert on missed pings. Each target can require a minimum number of
fresh probe locations (0 disables this criterion); a failure reports
`locations`. Targets have an independent interval
(15 seconds to one hour), with a 60-second default.

A target's format is **Generic** (a POST with `status` and `reason`) or
**Sentry Crons**. Sentry Crons targets take a Sentry check-in URL
(`https://o<org>.ingest.sentry.io/api/<project>/cron/<monitor>/<key>/`) and send
`ok` while healthy and `error` (on the same URL) when not, with an interval
schedule, so the Sentry monitor is created on the first check-in. They have no
failure URL.

Heartbeat URLs are encrypted at rest and are never returned by the management
API. Delivery is HTTPS-only, DNS-pinned to public addresses, does not follow
redirects, has a 10-second deadline and a bounded response body. A failed
delivery is recorded and logged, then retried on the next configured interval
without a burst retry. Use **Send test ping** to verify a destination.

For an unauthenticated pull check, configure an external uptime service to
request `https://<robin-admin-host>/api/health/monitoring` (also available at
`/health/monitoring`). It returns only `ok` with HTTP 200 or `unhealthy` with
HTTP 503, using a verdict cached for ten seconds and a rate limit. Every
replica answers: scheduler and alert-worker freshness is only required on the
current leader, while overdue checks and stuck alert deliveries (unsent past
three alert intervals, at least five minutes) are derived from the database and
count everywhere. It reports `unhealthy` when Monitoring is switched off. The public status
page is a separate check and reports monitored-target state rather than
whether Robin Admin itself is healthy. Use independent providers and locations
for the push heartbeat and pull check.

Heartbeat timing can be tuned with environment variables, in milliseconds.
A value outside its range, or not a number, is ignored with a warning and the
default is used.

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `ROBIN_HEARTBEAT_LOOP_MS` | 5000 | 1000-300000 | How often targets are checked for being due. |
| `ROBIN_HEARTBEAT_HEALTH_CACHE_MS` | 10000 | 0-300000 | How long a health verdict is reused. |
| `ROBIN_HEARTBEAT_SCHEDULER_STALE_MS` | 10000 | 1000-3600000 | Scheduler silence after which the leader is unhealthy (the scheduler ticks every 500 ms). |
| `ROBIN_HEARTBEAT_ALERT_STALE_MS` | 120000 | 1000-3600000 | Minimum alert-worker silence treated as unhealthy; the effective limit is the larger of this and three alert intervals. |

## Push checks

A push check monitors a job that calls Robin Admin, instead of Robin Admin
probing a target: backups, certificate renewals, scheduled scripts. Each push
check has a secret ping URL, shown to administrators in the check editor
(**Create a new URL** replaces it):

    GET or POST https://<robin-admin>/api/monitoring/ping/<token>       the job succeeded
    GET or POST https://<robin-admin>/api/monitoring/ping/<token>/fail  the job failed

The check is down once no ping has arrived for its expected interval (up to 30
days) or after a `/fail` ping, and up again with the next successful ping. The
confirmation window is the grace period before an issue opens, so issues,
alerts, Sentry and the status page work as for any check. Push checks are
evaluated every minute, only on the Robin Admin server (never on remote probe
locations), and are not included in configuration export or import, because
they are tied to their URL. Unknown tokens get a plain 404; the token is the
only credential, so treat the URL as a secret.

## Checks and assertions

One `http` check supports both `http://` and `https://`. Existing HTTPS checks
are migrated forward without changing their IDs, observations or components;
the API no longer accepts `https` as a check type. Check settings live in
**Monitoring -> Checks**, not deployment-specific seeds.

- HTTP: GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS; request headers and body;
  expected status codes; redirect policy; optional maximum total response time.
  The editor accepts comma-separated codes/ranges, such as `200-299, 404`.
  GET/HEAD cannot carry a body. The API stores explicit integer status codes.
- Assertions: response-body literal contains/does-not-contain/equals; header
  exists/equals/contains/does-not-contain; JSON pointer exists, strict scalar
  equality/inequality, numeric comparisons or string contains. JSON pointers
  use RFC 6901 syntax, such as `/ready` or `/services/0/state`; an empty pointer
  selects the whole document. Types are not coerced. Missing headers/fields and
  malformed JSON fail their assertions. There are no scripts, eval or regexes.
- TCP: required port, optional TLS and optional literal banner match. With no
  banner assertion, a successful connection is sufficient; matching reads are
  bounded. Checks never send arbitrary TCP commands.
- DNS: A, AAAA, CNAME, MX, TXT or NS; optional resolver IP and port (default 53).
  Without a resolver, the operating system's configured DNS servers are used;
  those host-configured servers are not restricted by the check's private-target
  setting. An explicitly selected resolver is subject to that setting.
  Enter one expected record per line; every expected record must be present,
  but additional answers are allowed. MX values are `priority exchange`, such as
  `10 mail.example.com`; TXT fragments are joined and compared case-sensitively.
  DNS names are case-insensitive and ignore a final dot; IPs are normalized.
  Empty answers fail even when no expected records are configured.
- SMTP: plaintext greeting (default 25), implicit TLS on port 465, and optional
  STARTTLS. STARTTLS defaults on for port 587; enable it explicitly on other
  plaintext SMTP ports. The probe sends EHLO, STARTTLS and EHLO after the TLS
  handshake. IMAP uses implicit TLS on port 993 (and custom ports unless
  STARTTLS is selected); STARTTLS defaults on for port 143. Port 993 uses
  implicit TLS and cannot use STARTTLS. The IMAP probe sends
  CAPABILITY and STARTTLS only. Both protocols validate TLS trust, hostname and
  certificate validity with the same policy as HTTPS. Reads share the 8 KiB
  protocol limit and total probe deadline. No authentication, message delivery,
  mailbox reads or other protocol commands are sent.

The `options` API object contains only the section matching the protocol:
`http`, `tcp`, `dns`, `smtp` or `imap`. Mail protocol options contain the
`startTls` boolean; its default is on only for SMTP 587 and IMAP 143. Unknown or incompatible fields,
invalid scalar types, separate HTTP ports and certificate settings on plaintext
checks are rejected. HTTP ports belong in the URL. Certificate warning days are optional; TLS trust and hostname/expiry verification always run. Certificate
errors default to `down`; setting **Certificate errors** to warning produces a
warning observation that is excluded from availability. Both policies block
application traffic on the failed TLS connection. A valid certificate near its
expiry threshold remains a reachable warning. Allowing a self-signed/local-CA
certificate never disables hostname or validity checks. Assertion/status/deadline
failures are down.

Mark credential request headers in the editor. They require HTTPS and use the
existing encrypted secret store; back up `ROBIN_ADMIN_ENCRYPTION_KEY`. APIs return
only `secretHeaderNames`, never credential values. `secretHeaders` is write-only:
omit a name to retain it, supply a string to replace it, or `null` to delete it.
Stored blank password inputs preserve existing values. Header names cannot be
both public and credential. Authorization/cookie/token/API-key/secret-like header
names must be credential headers. URLs, ordinary headers, bodies and assertion
expectations are configuration, not encrypted secret fields; do not put secrets
there. Create/update audits record metadata and whether credentials changed,
not header values, bodies or assertion expectations.

**Allow private network targets** is off for new checks and applies per check;
explicitly enable it on every check that needs access to private, unique-local
or loopback endpoints or an explicitly configured private DNS resolver.
Link-local/metadata, unspecified, multicast and other reserved ranges remain
blocked. Operating-system DNS servers are exempt because they are host
configuration. HTTP/TCP/mail DNS A and AAAA lookups run concurrently and probing
continues as soon as one permitted family returns; DNS duration is reported
separately from connection response time. The selected address is pinned to the
connection. Every HTTP redirect repeats address validation;
HTTPS-to-HTTP downgrades and URL credentials are forbidden. Cross-origin
redirects carrying any custom headers or a request body are rejected. GET/HEAD
redirects and 303-to-GET are supported; other methods require 307/308 responses
that preserve the method. These are application guards, not a substitute for
network egress rules; private-network permission grants broad private access.

One total deadline covers DNS resolution, connection, TLS, redirects and reads.
Hard safety ceilings: 64 KiB request body; 1 MiB response body; 8 KiB TCP/mail
banner; 32 request headers per public/credential set (16 KiB each); 20 assertions,
4 KiB expected value each; 5 redirects; 128 DNS records, 1 KiB each; JSON pointers
up to 16 segments. Header framing/Host/connection/proxy/encoding controls are
reserved. The full check-configuration API payload is limited to 1 MiB before
parsing; compressed configuration requests are rejected. Responses request
identity encoding; compressed bodies, streaming
protocols, browser rendering, client TLS certificates and custom CA bundles are
not supported. These ceilings are not UI settings. Checks run from the built-in **Local**
location (the Admin server) and from any enabled remote probe locations
(see [Probe Locations](#probe-locations)).

## Probe locations

**Monitoring -> Locations** enrolls already enrolled `robin-agent` instances as
probe locations. Granting the capability is explicit and revoking it disables
probe routes; a probe-only agent cannot use Fleet service assignments or the
command channel. Agents pull only checks assigned to their location and push
bounded observations over their authenticated outbound channel. Manifests,
including any credential headers, are memory-only on the agent. Admin never
connects inbound to a probe host.

A newly granted remote location starts in **shadow mode**: it receives the
checks assigned to it (without credential headers) and records history, but it
does not vote, alert, or change any check's quorum. Use **Promote to voting**
once its results look right; promoting adds it to quorum evaluation and sends
credential headers. Disabling the **Local** location stops the Admin server
from running checks itself, so enable at least one remote location first. A
check's quorum can never exceed its voting locations; if it does, the check
stays unknown and its last error explains the mismatch. One failing location
below quorum shows a warning but does not open an issue or page. If a location change leaves a check's quorum unreachable, Admin opens a warning issue so alerting never goes quiet silently. The Local location cannot be shadowed, a check must keep at least one voting location, and remote results older than 20 minutes are rejected so a restarted agent's buffer cannot outvote current state.

Upgrade note: remote locations granted before this release are moved to shadow mode once, on upgrade, and re-granting a location also resets it to shadow. Promote each one again after reviewing its results.

Checks default to **All enabled locations**. Alternatively, choose a fixed set
of enabled locations. Quorum `0` means a strict majority of the assigned,
enabled locations; a positive quorum is an explicit count. For example, with
three assigned locations, majority quorum is two: down is reported when two
fresh locations report down; warning means at least one location reports down
or warning but down quorum is not reached; up means every fresh location is up.
If fewer than quorum locations have a fresh result, the check is **unknown** and
does not open or recover a check issue. Freshness is two check intervals or two
minutes, whichever is longer, measured from when Admin received the result so
agent clock skew cannot make a location look silent. Check confirmation and recovery windows apply to
the combined state.

Each check issue includes the participating and failing locations, their
statuses and stable probe error codes; webhook alerts include that detail too.
A silent location raises one location issue instead of generating a check issue
for every assigned check. Its issue closes when fresh probe results resume.
Locations show heartbeat/version/clock information, assignment duty, recent
probe errors, and any open silence issue.

**Allow private network targets** is evaluated from every probe's network
position. A private target reachable from one location may not exist from
another; enable or place checks accordingly. Admin retains combined availability
and status-page state, while the history view exposes per-location daily
availability and response times. Per-location rollups are retained under the
same history retention policy.

## Probe capability on robin-agent

See [Fleet agents](fleet.md#probe-capability) for enrollment and permission
details. Probe-only agents dial out to Admin and run the Go implementation of
the shared probe protocol contract. The protocol reports per-location errors
and response times; drift between the TypeScript and Go probe engines is checked
by the shared conformance fixtures in CI.

Known differences between the engines:

- DNS: the Go agent resolves through the VM's resolver and honours its
  `/etc/hosts`; the Admin server queries DNS directly and ignores hosts files.
  Address guards apply to the result in both.
- Dual-stack connects: both engines try both address families with a
  per-attempt budget of at most 3 seconds. The Admin server starts with the
  family that resolves first; the agent walks its sorted address list.
- HTTP checks send `User-Agent: Robin-Admin-Monitor/1` unless the check sets
  its own. Response headers are capped at 16 KiB in both.
- The agent re-validates every option limit (methods, body size, redirects,
  assertions, JSON pointers, DNS values) and rejects out-of-range manifests.

Check history shows the latest 50 retained observations alongside daily rollups.
`GET /api/monitoring/checks/:id/observations` is admin-only and fixed to 50 rows.
Failure evidence names the assertion's one-based index and kind; observations
do not retain response bodies, credential values or actual DNS/TXT values.

## Status page model

The status page is built from public components. Each component can link to one
or more Monitoring checks. Component status is derived from those linked checks:

- `outage` when any linked check is down
- `degraded` when any linked check is warning
- `unknown` when no checks are linked or a linked check has not run
- `operational` when all linked checks are up
- `maintenance` while an active maintenance window applies

Monitoring issues linked through those checks automatically create and resolve
status page incidents. An issue that starts while an automatic incident is open,
or within the grouping window after it resolved (**Group failures into one
incident within**, 15 minutes by default, 0 to turn grouping off), joins that
incident, so one outage across several services is one incident titled after
them ("IMAP x, SMTP y, and 1 other service are down"). Its timeline records when
each service went down and recovered; the last recovery resolves it. Manual
incidents and maintenance windows are managed from **Monitoring -> Status Page**.

Deleting an incident removes it and its updates for good: the Monitoring issues
behind an automatic incident are dismissed so it is not recreated, and later
failures still open new incidents. Closed Monitoring issues can be deleted from
**Monitoring -> Issues**, for example after a test; open ones cannot.

### Public pages and feeds

Besides the main page, the public status page has these parts, each switched on
or off under **Administration -> Monitoring -> Status Page**:

| Setting | Public part |
|---------|-------------|
| Previous incidents page and a page per incident | `/status/incidents` lists incidents by month, three months a page, and `/status/incidents/:id` shows one incident's affected services and timeline |
| Maintenance page | `/status/maintenance` lists maintenance windows by month, upcoming and past |
| RSS and JSON feeds of incidents | `/api/status-page/public/feed.rss` and `/api/status-page/public/feed.json` (JSON Feed 1.1), offered under **Get updates** |
| Email subscriptions | the email form under **Get updates** |
| Recent incidents on the main page (days) | resolved incidents from that many days under the services; 0 lists none |

### Importing past incidents

Incidents from a previous status page can be imported under **Monitoring ->
Status Page -> Reports -> Import**, or posted as `{ "reports": [...] }` to
`POST /api/status-page/admin/reports/import`. Each incident is:

```json
{
  "title": "IMAP mail.example.com:993 is down",
  "impact": "outage",
  "openedAt": "2026-09-02T23:02:59Z",
  "resolvedAt": "2026-09-02T23:24:58Z",
  "components": ["IMAP mail.example.com:993"],
  "updates": [
    { "status": "investigating", "message": "IMAP mail.example.com:993 went down.", "createdAt": "2026-09-02T23:02:59Z" },
    { "status": "resolved", "message": "IMAP mail.example.com:993 recovered.", "createdAt": "2026-09-02T23:24:58Z" }
  ]
}
```

Components are matched to public components by name, ignoring case; names with
no match are listed in the result and left off the incident. An incident already
imported with the same title and start is skipped, so an import can be re-run.
Imports never notify subscribers.

## Local verification

The local Docker deployment serves the admin app, API, and public status page
through bundled Caddy:

```text
https://localhost:3443
https://localhost:3443/status
https://localhost:3443/api/status-page/public
```

For local review, use components linked to locally reachable suite containers
such as Robin SMTP, Dovecot IMAPS, and the Robin Admin HTTPS endpoint. The
local test components should be created explicitly and linked to test checks.

## Production routing

The public status page is a normal SPA route backed by the same public API:

```text
/status, /status/incidents, /status/incidents/:id, /status/maintenance
/api/status-page/public and the paths under it
```

For a dedicated production host such as `status.example.com`, point DNS at
the public reverse proxy and route that host to Robin Admin's UI and API. Example Caddy wiring, with the
proxy on the `suite-admin` network:

```caddy
status.example.com {
	encode zstd gzip

	handle /api/status-page/public* {
		reverse_proxy admin-backend:3001
	}

	handle /assets/* {
		reverse_proxy admin-frontend:80
	}

	handle {
		reverse_proxy admin-frontend:80
	}
}
```

Live validation of the custom domain requires production DNS and certificate
issuance. Locally, validate the same app and API behavior through
`https://localhost:3443/status` and `https://localhost:3443/api/status-page/public`.
Set `ROBIN_ADMIN_PUBLIC_URL` to the browser-facing Robin Admin URL; status
subscription confirmation and unsubscribe links are built from that trusted URL,
not from request headers or the editable status-page custom domain.
