# Fleet management

## Operational policy

Administration > Fleet Operations stores the agent online window, command poll
wait, commands per poll, command lease and default response timeout. Changes
apply to new polls and commands without restart; existing leases and deadlines
are preserved. The lease must exceed the poll wait by at least one second, and
the online window by at least five seconds. Action-specific API deadlines and
the agent's fixed execution/output limits remain safety boundaries. Extending
the default response timeout does not extend a running agent process deadline.
The metrics poll interval also applies live, without overlapping active cycles.

Robin Admin manages a fleet of co-located mail services from one dashboard. A
fleet is a set of **services**, each with a type — `robin`, `rspamd`, `clamav`,
`dovecot`, `postfix`, `redis`, `postgres` or `mariadb` — registered in the
`fleet_services` registry.

## Overview

Agent command results retry transient HTTP/network failures for up to fifteen
seconds after execution, without executing the command again. Authentication,
authorization and terminal command-state rejections stop retries. Repeated poll
delivery is deduplicated in the running agent. A process crash can still lose its
in-memory result/deduplication state, so external command side effects are not
guaranteed exactly-once across restarts. Inspect the actual service state before
retrying an operation whose outcome is uncertain.

The Fleet feature provides:

- **Service registry**: central record of every managed service and its endpoints
- **Health monitoring**: real-time health of each service
- **Aggregated metrics**: fleet-wide metrics across all services
- **Service-aware pages**: per-service Metrics, Config, and (for Robin) Queue views
- **Config sync**: robin-admin is the source of truth for each service's managed
  config; a pull agent applies it on the service and reports status back (see
  the Sync tab on each service's Config page)
- **Collection axes**: each service is collected on three **independent** axes —
  **metrics**, **config**, and **logs** — and each axis is either **direct**
  (robin-admin connects to it — used by the bundled suite and any reachable
  service) or via an **agent** (a robin-agent on the host reports it — for remote
  hosts robin-admin can't reach inbound, and Postfix/Dovecot host tooling). A service can
  mix modes per axis. See **Fleet agents** below and
  [agent-co-location.md](agent-co-location.md) for the full model, and the in-app
  **Fleet → Docs** page for a quick reference.

## Managing services

Open the **Fleet** page to add, edit, enable/disable, and health-check services.

### Adding a service

Provide:

- **Service ID**: unique identifier (e.g. `production`, `staging`, `eu-west`)
- **Service type**: `robin` / `rspamd` / `clamav` / `dovecot` / `postfix` / `redis` / `postgres` / `mariadb`
- **Name** and optional **description**
- **API URL**: the service's API/health endpoint (Robin, Rspamd and ClamAV only)
- **Metrics URL**: optional OpenMetrics/exporter URL (defaults to the API URL).
  For the database types this is the connection string: `redis://`,
  `postgresql://` or `mysql://`/`mariadb://`. Its password is masked in
  every API response; saving the masked value keeps the stored password. The
  `*_ADMIN_DSN` environment variables are a fallback for services without one.
  Saved database DSNs use authenticated encryption with `ROBIN_ADMIN_ENCRYPTION_KEY`.
  Existing saved DSNs are sealed during startup; retain the same encryption key
  with your backups. API responses mask passwords, including query-string passwords.
- **Telemetry source**: optional source identity (`telemetrySource` in the API); links open [Telemetry Explore](telemetry.md) with the saved discovery label and selector
- **Enabled**: whether it counts toward dashboards and health checks

### Health checks

**Check Health** verifies connectivity to every service:

- 🟢 Healthy and responding
- 🔴 Unreachable or returning errors
- ⚪ Not yet checked

## Fleet agents (robin-agent)

**Fleet → Agents** manages `robin-agent` — one dependency-free binary deployed per
host or container that **dials out** to robin-admin. Because the agent initiates the
connection, it works behind NAT and firewalls and inside containers with only outbound
egress; robin-admin never connects into the host. An agent is required to manage remote
hosts, and for Postfix and Dovecot, whose tooling (`postqueue`/`postsuper`, `doveadm`)
and logs only exist on their host — including queue control, session tools, and reloads.

Directly-reachable services (the bundled suite — robin, postgres, redis, rspamd, clamav
on one network) need **no agent**: robin-admin connects to them in direct mode.

### Adding an agent

1. Open **Fleet → Agents** and create an agent, naming the host it will run on
   (e.g. `mta-inbound-1`).
2. Copy the one-time enrollment command shown (a `docker run`, or set the same
   environment variables in a systemd unit on a bare host).
3. Run it on the host. The agent exchanges its enrollment token for a long-lived
   credential (cached in its state volume), then checks in every 30 s.
4. The agent appears **online** with its discovered services. Re-issue a fresh token
   with **New token** if the original expired before enrolling.

Agent states: **pending** (created, never checked in), **online** (heartbeat within the
last 90 s), **offline** (enrolled but silent). Deleting an agent drops its credential;
its services fall back to direct mode and it must re-enroll to return.

### Probe capability

Monitoring can separately grant an enrolled agent the **probe** capability from
**Monitoring → Locations**. Probe capability is independent of Fleet service
assignments: a probe-only agent cannot collect Fleet data, receive managed
configuration, or use the command channel. Grant and revoke it explicitly; a
revoked location can no longer pull probe manifests or upload observations.

Probe agents make outbound authenticated requests to Admin, poll only checks
assigned to their location, execute the shared bounded probe contract, and
upload results. Check credentials are delivered only in the in-memory manifest
response and are not persisted by the agent. Admin does not initiate connections
to probe hosts. See [Monitoring probe locations](monitoring.md#probe-locations)
for assignment, quorum, freshness, privacy, and alert behavior.

### Assigning services to an agent

Click **Services** on an agent to assign the services it should manage. Assigning a service
switches it to **agent** collection mode: the agent pulls that service's managed config
(the same manifest/pull protocol the Config page's Sync tab shows), writes the rendered files
to the service's config directory, then validates and reloads — no co-location with
robin-admin required. **Release** returns a service to direct mode. Apply status and
drift for an agent-managed service appear on that service's Config → Sync tab.

An agent-mode service is not polled by robin-admin — the agent pushes its metrics and new log
lines each cycle, and runs operational commands (Postfix queue control, Dovecot sessions and
users, reloads) over an outbound long-poll. Pages show those actions only while the agent is
connected. See [fleet-service-capabilities.md](fleet-service-capabilities.md#agent-command-channel).

## Per-instance config overrides

Every fleet service type shares **one config model**: a **`default` base** plus
per-**instance** overrides that store only the values they change. This is the
same layered model Robin's own config uses.

- **`default` (base)** is the shared configuration for every instance of that
  type. Editing the `default` scope changes the base for all of them.
- An **instance scope** is any instance id (e.g. `inbound-mta-1`, `inbound-spam-2`).
  Saving on an instance stores **only the fields that differ from the base** — a
  delta. Everything else is inherited from `default`, so a later change to the
  base flows through to every instance that didn't override that field.
- The **effective config** an instance runs with is `base` deep-merged with its
  override delta (override wins per field; unset fields fall through to base).
  That is exactly what the co-located agent pulls and applies.

On a service's **Config** page:

- The **Scope** selector lists `Default (base)` plus every instance — the
  registered services of that type and any instance that already has an override.
- **Save As** stores the current edits as an override for a new instance id you
  type in. The id must match the **service id the instance's agent enrolls with**
  for the override to take effect (a not-yet-registered id is staged until an
  instance with that id pulls config — like Robin's per-server overrides).
- **Diff** (shown on a non-`default` scope) compares the instance against the
  base, field by field — the red/green rows are exactly the stored delta.
- **Reset to base** drops an instance's override for the current file so it
  inherits the base again.

Redis, Postgres and MariaDB apply the effective config **live** (`CONFIG SET` /
`ALTER SYSTEM` / `SET GLOBAL`); the file-based services (rspamd, dovecot, postfix, clamav)
render the effective config to their real config files, which the co-located
agent writes and reloads.

## Metrics

MariaDB and MySQL use the `mariadb` service type. Direct metrics, configuration
and operations require a per-service `mysql://` or `mariadb://` DSN reachable
from Admin. An agent can collect metrics and logs for an unreachable database,
but cannot apply database configuration or run admin operations. See the
[container deployment recipe](agent-co-location.md#mariadb-in-a-container) and
[capability limits](fleet-service-capabilities.md).

Snapshots cache schema/table size totals for ten minutes. Missing privileges
can make a snapshot partial; inspect raw output before treating missing counters
as zero activity. Statement digests require `performance_schema`. Routine queries
have an eight-second client deadline; ANALYZE uses a dedicated session with a
sixty-second deadline. These client deadlines do not guarantee cancellation of
work already executing on the database server.
The agent collector shares the fifteen-second collection deadline and four-MiB
output cap with other subprocess collectors. Cancelling a Docker or SSH client
does not guarantee cancellation of a query already running remotely.

**Fleet -> Metrics** shows aggregated metrics across all services — the
most active services by throughput and resource use, combined throughput charts,
and rejection rates. Choose how many services to display (Top 5, 10, or 25).

## Service selector

Per-service pages (for example **Fleet -> Robin -> Queue** or a service's **Metrics**)
show a selector in the page header to switch between services of that type and
scope the data to the selected service. The selection persists across page
navigation.

## API endpoints

### List Services
```
GET /api/fleet/services
GET /api/fleet/services?serviceType=robin&enabled=true
```

### Get service
```
GET /api/fleet/services/:serviceId
```

### Create service
```
POST /api/fleet/services
Content-Type: application/json

{
  "serviceId": "production",
  "serviceType": "robin",
  "name": "Production Server",
  "apiUrl": "http://robin:8090",
  "metricsUrl": "http://robin:8080",
  "enabled": true
}
```

### Update service
```
PUT /api/fleet/services/:serviceId
Content-Type: application/json

{
  "name": "Updated Name",
  "enabled": false
}
```

### Delete service
```
DELETE /api/fleet/services/:serviceId
```

### Check service health
```
GET /api/fleet/services/:serviceId/health
```

## Reliability verification

Admin and agent log correlated command lifecycle metadata: queueing, leasing,
acknowledgement, requeueing, execution, result-delivery attempts/outcomes and
expiry. Use `commandId` across both logs; timing and acknowledgement timestamps
distinguish a command never received from one executed but not reported. These
events omit arguments, executable output, credentials and URLs. Command output
remains available only through the existing authenticated command-result path.
Production Admin rotates each of its combined/error files at 5 MiB with three
files each; production deployments must persist that private directory across
container replacements. Agent stdout requires the host's own bounded retention.
Logging does not establish exactly-once side effects or replay a lost result.
A lost poll reply can still outlive the twenty-second command deadline before
the HTTP client retries; timeout is not proof that an action never executed.
No automatic destructive-action replay is introduced.
PostgreSQL's stored deadline controls expiry; a result already recorded when
the API's final expiry check loses the race is returned, not hidden by a timeout.

Agent execution has one 15-second budget for the entire action, including all
validation/reload steps; shutdown cancellation also stops the local command.
After cancellation or direct-child exit, inherited output pipes are given at
most one additional second to drain. Missing EOF or output over 4 MiB is an
explicit failure, never a successful partial queue listing. Capture memory is
bounded per step. Result delivery retries for up to 15 seconds, but Admin still
accepts results only before the original twenty-second queue deadline: queue
delay, execution and delivery share that server deadline. A timeout does not
prove absence of external effects. Killing a local Docker/SSH wrapper does not
guarantee cancellation of the command running inside the container/remote host;
inspect that service before retrying a modifying action.

Background subprocesses use the same bounded capture: metrics share a
15-second budget per service, config fetch/copy/validate/reload share 30 seconds,
and each journal/container log read has 15 seconds. Shutdown cancels these
operations. Each captured stream is limited to 4 MiB (combined capture shares
one limit); inherited pipes have the same one-second drain bound. Collector
timeout/overflow fails the observation, including failures in optional samples;
ordinary nonzero exits in optional samples may still be omitted. Failed config
execution does not advance the applied manifest, but files or external effects
already written are not rolled back. Failed subprocess log reads retain the
last cursor and send no healthy batch; they may remain stale until the source
recovers, and oversized backlogs require operator attention. Logs are a recent
buffer, not guaranteed lossless archival. Capability probes have ten seconds
and bounded output; failed capture cannot advertise an action. Service work is
serial: these per-operation bounds do not guarantee a fixed whole-fleet cycle.
Native network collectors retain their own transport deadlines; killing a
wrapper still does not guarantee remote/container cancellation.

CI runs a five-minute disposable real-agent fault smoke. The `Reliability drill`
manual workflow runs the same harness for five or sixty minutes. It uses an
isolated database. Its separate `steady` workload combines dense-identity
reporting with real Fleet/Monitoring/email without Admin or agent restarts;
see [reliability validation](reliability.md) for controls and limits. The fault
workload uses an
isolated database, harmless queue executable, HTTPS probe and SMTP sink; it
cycles probe/command failures, lost poll/result responses, agent/Admin restarts
and database disconnections. The webhook transport has separate real-network
rejection/timeout tests: the drill does not disable private-webhook protections
to route its production worker to a local receiver. A passing drill proves the
tested paths, not exactly-once external side effects or arbitrary fleet capacity.

For a local run, build the server and agent, provide a disposable local Postgres
superuser using `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, then run
`node scripts/reliability-soak.mjs` from `server`. Docker and OpenSSL are required.
The default agent image is `robin-agent:reliability`; override with
`RELIABILITY_AGENT_IMAGE`. `SOAK_MINUTES` accepts 1..120. The harness creates and
drops only its timestamped `robin_test_reliability_*` database; it never starts
license renewal against a licensing authority. Reserve ports 3566, 3567
and 3579, or use `RELIABILITY_PORT` to choose a different base port.

## Best practices

1. **Naming**: use descriptive service IDs like `prod-us-east`, `staging`, `dev`.
2. **Health monitoring**: check service health regularly from the Fleet page.
3. **Metrics retention**: metrics are stored per service with 14-day retention.
4. **Credentials**: service secrets are encrypted at rest.

## Troubleshooting

### A service shows unhealthy

1. Verify the API URL is correct and reachable.
2. Check that the service is running.
3. Verify any required credentials.
4. Check network connectivity between Robin Admin and the service.

### Metrics not loading

1. Ensure the service is enabled.
2. Verify the metrics URL is correct.
3. Check the metrics poller logs: `docker logs suite-admin`.
4. Confirm the service is exposing its metrics endpoint (e.g. Robin's
   `/actuator/prometheus`).
