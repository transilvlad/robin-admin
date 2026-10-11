# Fleet service capabilities and limitations

Robin Admin manages mail infrastructure as **fleet services**. Each type exposes
a common operational surface plus service-specific capabilities. Availability
depends on the registered endpoints, credentials, host access, and deployment
topology.

## What works in each setup

Every feature is decided by one rule table
(`server/src/services/capability-rules.ts`), evaluated per service from its
setup: how metrics are collected, which agent works each axis and how that
agent reaches the service (on the host, `docker`/`podman exec`, or `ssh`), and
which endpoints robin-admin itself can reach. **A feature a setup can't
support is hidden, never shown broken:** the sidebar item, the route, the tab,
the button or the card goes away.

- `GET /api/fleet/capabilities` returns, per service, each feature with
  `available` and, when hidden, the `reason`; plus per type what at least one
  enabled service can do. The sidebar, route guards, service pickers and pages
  all read it.
- `GET /api/fleet/capabilities/matrix` evaluates the same rules for every
  setup. **Fleet → Docs** is built from it: pick a service and a setup to see
  what works, what is hidden and why, and what to configure.
- Agents report, with each heartbeat, how they reach each service and which
  command actions have their tools present there (probed through the exec
  prefix), so a missing `doveadm` or `postsuper` hides just the features that
  need it.

### Limits by setup

| Setup | What it can't do |
|---|---|
| No agent | Anything that runs on the service's host: Postfix queue, counters and reload; Dovecot sessions, quota and reload; managed config files for Rspamd, ClamAV, Dovecot and Postfix. Logs need a `<TYPE>_LOG_URL` or a mounted log file. |
| Agent on the host / next to the container | Nothing on the agent's side. Features robin-admin performs itself still need robin-admin to reach the service: Robin queue and delivery test, Rspamd scan, training and classifiers, ClamAV scan and signature reload, Redis, PostgreSQL and MariaDB config and admin tools. |
| Agent over ssh | Commands run, but files can't be placed: no managed config, config sync, Rspamd rules or DKIM keys. |
| Agent only (robin-admin can't reach the service) | The robin-admin-side features above. Raw metrics stay available from the agent's stored snapshot for ClamAV, Dovecot, Postfix, Redis, PostgreSQL and MariaDB; Robin and Rspamd agents ship parsed metrics only. |

### Per service

- **Robin** pulls its config from the database, so Config needs no agent.
  Queue and Delivery Test use the Robin API (`ROBIN_API_ENABLED`).
- **Rspamd** Training needs a training directory, set with the controller
  password in Fleet → Services → Edit. DKIM keys are stored encrypted and
  delivered by the config agent to `local.d/dkim/`, with the selector map in
  `dkim_signing.conf`.
- **ClamAV** reads `clamd.conf` only at start: a config change needs a clamd
  restart. The Reload button reloads the signature database.
- **Dovecot** sessions, user and quota counts come from `doveadm` through an
  agent; OpenMetrics carries counters only.
- **Postfix** exporter mode reports queue depth only: no deferral age, queue
  browser or message counters.
- **Redis / PostgreSQL / MariaDB** config and admin tools use robin-admin's own
  connection (the service's DSN, else `REDIS_ADMIN_DSN`, `POSTGRES_ADMIN_DSN`
  or `MARIADB_ADMIN_DSN`).

## Metrics topology

Metrics are read one of three ways per fleet service:

- **Agent** (`collection_mode = agent`): the service's robin-agent runs the
  collector on the host and pushes raw output — `doveadm stats dump` + `doveadm who`
  (Dovecot), `postqueue -j` (Postfix), or any other type's endpoint/socket.
  Robin Admin parses it. This is the only path for Postfix queue control, message
  counters, and Dovecot session/user tools.
- **HTTP** (`metrics_url` set): Robin Admin scrapes the endpoint — Dovecot's
  OpenMetrics exporter, a postfix_exporter (queue depth only; no message
  counters), Rspamd's controller.
- **Native client:** Redis, PostgreSQL and MariaDB connect with the registered
  `metrics_url` DSN, falling back to `REDIS_ADMIN_DSN` / `POSTGRES_ADMIN_DSN` /
  `MARIADB_ADMIN_DSN`.

A Postfix or Dovecot service with neither an agent nor a `metrics_url` reports as
unreachable.

## Agent command channel

Operational actions run on the service's host through its robin-agent. The agent
holds an outbound long-poll (`GET /api/fleet/agent/commands`), runs the command
an action maps to, and posts the output back. Robin Admin sends only an action
name plus validated arguments — never argv — and the agent accepts only its
allowlist:

| Action | Command on the host |
|---|---|
| `postfix.queue.list` / `.show` | `postqueue -j` / `postcat -ehbq <id>` |
| `postfix.queue.hold` / `.release` / `.requeue` / `.delete` | `postsuper -h` / `-H` / `-r` / `-d <id>…` (≤500 IDs) |
| `postfix.queue.deliver` / `.flush` | `postqueue -i <id>` / `postqueue -f` |
| `postfix.reload` | `postfix check`, then `postfix reload` |
| `dovecot.reload` | `doveconf -n`, then `doveadm reload` |
| `dovecot.who` / `.kick` | `doveadm who -1` / `doveadm kick <user>` |
| `dovecot.quota` / `.user` | `doveadm -f tab quota get -u <user>` (or `-A`) / `doveadm user <user>` |

Operational actions go to the service's metrics agent; reloads go to its config
agent. Queue IDs and usernames are pattern-checked by the agent, and the
service's exec prefix (`docker exec …`, `ssh …`) applies. Every action is
admin-only and audited.

### Agent command-channel limits

- The command queue is stored in PostgreSQL (`fleet_agent_commands`), so API
  replicas that share the same database can all serve agent-backed controls and
  queued commands survive robin-admin process restarts until they expire.
- PostgreSQL is the durability boundary. If robin-admin cannot reach its
  database, new commands cannot be queued and waiting commands cannot complete.
- The agent must be actively polling and must advertise the requested action.
  A live agent is considered connected only while it has polled recently.
- Command delivery is at-least-once until acknowledged. The agent remembers
  recently seen command ids and skips duplicates, so a resent command is not
  executed twice.
- A command whose HTTP response is delivered to the agent but whose result is
  lost still finishes from the agent's point of view; robin-admin marks it
  expired when its server-side timeout elapses and the UI action should be
  retried if the outcome cannot be verified from service state.
- robin-admin waits about 20 seconds for a command result; the agent gives each
  local command about 15 seconds. Slow host commands fail rather than leaving
  the UI waiting indefinitely.
- Command output is capped by the agent before it is posted back (large queue
  listings are truncated at 4 MiB).
- The channel is not arbitrary remote execution. robin-admin sends action names
  and validated arguments only; the agent maps them to the fixed allowlist above.

## Service limitations

- **Postfix** has no admin socket or API. Metrics, queue control, and reload run
  through the agent; a postfix_exporter provides queue depth alone. The agent
  applies config by writing the rendered files to `/etc/postfix`, running
  `postconf -e` with the `key = value` lines of each managed `.cf` file (Postfix
  has no include directive), then `postfix check` and `postfix reload`.
- **Postfix message counters** are derived from the log: delivered/deferred/bounced
  count per-recipient `status=` lines from the delivery agents, skipping SMTP
  handoffs to a loopback content filter (the message is counted when it leaves);
  rejected counts `reject:` lines from smtpd, postscreen, and cleanup. They need
  the agent to stream the service's log.
- **Dovecot metrics** only report counters someone defined, so the managed
  `50-robin-managed.conf` include always ships `robin_*` metric blocks (auth
  success/failure, logins, IMAP commands, deliveries).
- **Dovecot config syntax** follows the version the agent reports
  (`dovecot --version`): 2.4 renamed settings such as `disable_plaintext_auth`
  (now `auth_allow_cleartext`) and rejects the whole include over one unknown
  setting. The config page's version setting is only the fallback until a
  version is reported.
  `doveadm stats dump` needs a readable `stats-reader` socket.
- **Dovecot quota** needs the quota plugin (`mail_plugins = quota`); the
  all-users view also needs a userdb that can iterate users. Otherwise the Quota
  tab explains why instead of showing quota.
- **ClamAV** talks over a local socket; remote requires a TCP clamd or an agent.
- **Redis, PostgreSQL and MariaDB** use their native admin protocols. Managed settings apply
  live and operational actions are admin-only and audited. Data-loss operations such
  as Redis flush, PostgreSQL drop/truncate and MariaDB drop/truncate/OPTIMIZE are not exposed.
- **MariaDB managed variables are opt-in.** Only variables an operator sets are applied;
  an empty field leaves the server's own value (its `my.cnf`) alone. `SET GLOBAL` does
  not survive a restart (Admin stores the intended values for both MariaDB and MySQL), so after every
  snapshot robin-admin compares the running values with the stored ones and re-applies
  any that drifted (retrying a failing apply at most every five minutes). Server-managed
  variables (`innodb_buffer_pool_size`, `innodb_log_file_size`, `performance_schema`, …)
  are shown read-only; whether changes require a restart depends on the engine and version.
  Statement digests need `performance_schema=ON`. Clearing a managed value stops
  enforcing it but does not undo the last live value; a restart restores the server's
  configuration. Admin does not write MySQL's separate persisted-variable file.
- **Config is operational-only, by design.** Structural config (TLS, virtual maps,
  `mail_location`, restriction chains, `myhostname`/`mynetworks`, master.cf,
  relay.py) stays **ansible/root-owned** and is never writable from robin-admin.
  Each service manages a bounded knob set + (Dovecot/Postfix) managed include files.
- **Writable file config needs an agent on the host.** Redis, PostgreSQL and MariaDB are the
  exception: their native protocols apply managed settings directly.
- **Shared base + per-instance overrides.** Every service type has a `default` base
  config; each instance stores only the values it changes and inherits the rest.
  The effective config an instance runs with is the base deep-merged with its
  override delta. See [fleet.md](fleet.md#per-instance-config-overrides).

## Log access and limitations

Logs are a **conditional sidebar item** — `<service>/logs` renders a dedicated
`ServiceLogsPage`, and the nav item only appears when some enabled service's logs
are actually **readable** (the `logs` capability): an agent streaming them within
the last five minutes, or a readable direct source.
(Metrics pages add operational tabs — e.g. Dovecot Sessions/Quota,
Redis Slowlog/Clients — only where the deployment supports them. Workspaces such
as Postfix → Queue get their own sidebar item, shown when a service's
capabilities include it.)

Robin Admin selects a log source per service. When an agent ships the service's
logs (its metrics agent or a logs-only agent), the Logs page serves the agent's
buffer. Otherwise a configured **`<TYPE>_LOG_URL`** takes precedence, Rspamd uses
its controller, and other services use a co-located host file when available:

1. **Agent** — the agent follows the log on the service's host and ships only new
   lines each cycle (its first push after start is the recent tail, marked as a
   reset). Sources, in order: a container's console log
   (`ROBIN_AGENT_<TYPE>_LOG_CONTAINER`, via `docker logs`), a file, the newest file
   in a dir, then journald. Robin Admin keeps a rolling buffer per service and
   derives Postfix message counters from the new lines.
2. **HTTP endpoint** — read over the network, works cross-container / off-host:
   - **Rspamd** → the controller's authenticated **`/errors`** endpoint (needs the
     controller password, set in **Fleet → Services → Edit**).
   - **Any type** → a plain **`<TYPE>_LOG_URL`** that returns recent log text. This is
     provided by a restricted log-tail sidecar when the hardened Robin Admin
     container cannot read a root- or service-owned log directly.
3. **Co-located file / dir** — robin-admin shells `tail` on the host:
   - Fixed **file** (`<TYPE>_LOG_FILE`), optionally via `journalctl -u <unit>`
     (`<TYPE>_LOG_UNIT`) first.
   - Newest file in a **dir** (`<TYPE>_LOG_DIR` + glob) — for logs rotated by filename.
     **Robin** uses this: its Java app writes world-readable `YYYYMMDD.log` files and has
     no log endpoint, so robin-admin tails the newest. In the suite the host `../log/robin`
     directory is bind-mounted read-only into the Robin Admin container.

**Limitations:**
- **Console-only services need the container source.** A Postfix or Dovecot
  container that logs to stdout has no file; point the agent at it with
  `ROBIN_AGENT_<TYPE>_LOG_CONTAINER` (the agent needs the Docker CLI and socket).
- **Root-owned logs need an agent, a sidecar, or host log access.** A bind-mounted
  `0600` or `0640` log remains unreadable by the container's unprivileged user.
- **Rspamd logs need the controller password** (set in **Fleet → Services → Edit**); without it `/errors` 401s and the item hides.
- Read-only, tail-style, capped at 1000 lines. No follow/stream, no full-text search.
