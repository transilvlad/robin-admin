# Co-located agents & per-axis collection

This note covers running a robin-agent **alongside a service** and choosing, per
service, which of its three telemetry axes flow through the agent versus a direct
endpoint. It builds on [agent-deployment.md](agent-deployment.md) (how to install
and enroll the binary); read that first for the transport, install methods, and
the base environment reference.

## The three axes

A fleet service is collected on three **independent** axes. Each is chosen per
service, so nothing has to depend 100% on an agent — use the agent only where
robin-admin can't reach the service directly, and leave the rest on their direct
endpoints.

| Axis | Direct (endpoint) | Agent | Column |
|---|---|---|---|
| **Metrics** | robin-admin polls the service (HTTP/socket/DSN) | agent runs the collector and pushes raw output | `fleet_services.collection_mode` = `direct` \| `agent` (+ `agent_id`) |
| **Config** | robin-admin writes/reloads directly (co-located host deploy) | agent applies the rendered files and reloads in-process | `fleet_services.config_agent_id` |
| **Logs** | robin-admin reads journald/a file, or an HTTP `<TYPE>_LOG_URL` | agent tails the log and pushes the recent lines | `fleet_services.log_agent_id` |

Setting `collection_mode = 'agent'` (via `agent_id`) makes that agent the
**full** owner — it does metrics **and** config **and** logs. `config_agent_id`
and `log_agent_id` each opt a *single* axis onto an agent while the others stay
direct. So a service can mix modes: e.g. Rspamd with **direct** metrics (`/stat`)
and **direct** logs (`/errors`) but its **config** applied by a co-located agent.

robin-admin always owns the parsing and rendering. On every axis the agent is a
**thin executor**: it runs a command (or fetches an endpoint) and ships the raw
output, writes files robin-admin already rendered, and tails logs — it never
parses or renders.

### Assigning axes

- **UI:** Fleet → Agents → **Services** opens the agent's *Responsibilities*
  panel. Three assigners — **Full agent** / **Config only** / **Logs only** —
  and each row shows `metrics`/`config`/`logs` badges. *Release* / *Stop logs*
  detaches the agent from every axis it holds for that service.
- **API (admin):** `POST/DELETE /api/fleet/agents/:agentId/services` (full),
  `…/config-services` (config-only), `…/log-services` (logs-only).
- **Seeded (automation):** plain SQL `UPDATE fleet_services SET … WHERE
  service_id = …` (see the suite seed below) — idempotent, applied after the
  service rows and the agent exist.

An agent's `/services` response carries per-axis `collectMetrics` /
`collectConfig` / `collectLogs` flags; the agent only runs the collectors it is
told to.

## Provisioning: enrollment vs. a pre-set credential

Two ways an agent obtains its long-lived credential:

1. **Interactive enrollment** (see agent-deployment.md) — create the agent in the
   UI, run it once with the one-time `ROBIN_ENROLLMENT_TOKEN`; it exchanges the
   token for a credential cached in its state dir. Best for hand-installed hosts.

2. **Pre-provisioned credential** — for reproducible/automated fleets (compose,
   ansible, a fresh container that may lose its state volume). robin-admin
   provisions the agent with a **known id + credential**, and the agent is handed
   the same credential via `ROBIN_AGENT_CREDENTIAL` — no token dance, online
   immediately, and a restart with an empty state dir just re-uses the env
   credential.

   Declare the agents in robin-admin's `FLEET_AGENTS_BOOTSTRAP_JSON` (the agent
   analogue of `MODULES_BOOTSTRAP_JSON`), applied on startup, idempotent:

   ```json
   [{"agentId":"mta-inbound-1","name":"MTA inbound 1",
     "credential":"<high-entropy secret>","os":"linux","arch":"amd64"}]
   ```

   Then run the agent with `ROBIN_AGENT_ID=mta-inbound-1` and the matching
   `ROBIN_AGENT_CREDENTIAL`. Treat the credential like any secret (vault it in
   ansible; a compose `.env` for dev). Bootstrap only *provisions* the agents;
   assign their axes separately (SQL/API/UI), since that depends on the service
   rows existing.

## Co-locating the agent inside a service image

Host-tool axes and commands — Dovecot `doveadm`, Postfix `postqueue`/`postsuper`/
`postfix reload`, Rspamd `rspamadm reload` — need the service's own tools and a
live daemon. On a host, the systemd agent (running as root) has them. For a
service in its own container, either give the agent the Docker CLI and socket and
set `ROBIN_AGENT_EXEC_PREFIX=<serviceId>=docker exec <container>` (what the suite
does), or bundle the agent **into** the image and start both from a small
wrapper: background the agent, then `exec` the service so it stays PID 1 (or
under the base image's init).

`Dockerfile`:

```dockerfile
FROM ghcr.io/transilvlad/robin-admin-agent:latest AS agent
FROM <service-image>          # e.g. dovecot/dovecot:latest, rspamd/rspamd:latest
COPY --from=agent /usr/local/bin/robin-agent /usr/local/bin/robin-agent
COPY --chmod=0755 start-with-agent.sh /usr/local/bin/start-with-agent.sh
CMD ["/usr/local/bin/start-with-agent.sh"]   # keep the base ENTRYPOINT/init
```

`start-with-agent.sh`:

```sh
#!/bin/sh
export PATH="/path/to/service/tools:${PATH}"   # so doveadm/rspamadm/postqueue resolve
[ -x /usr/local/bin/robin-agent ] && /usr/local/bin/robin-agent &
exec <service foreground command>              # e.g. /dovecot/sbin/dovecot -F
```

Notes from the reference suite:

- **Config dir must be writable** by the agent. If the service mounts its config
  read-only, add a narrower read-write mount for just the managed subtree (e.g.
  Dovecot's `conf.d`) — the more-specific mount overrides the `:ro` parent.
- **Run as the user that can write config + read logs.** Root-owned `0600` logs
  (Dovecot/ClamAV/Postgres) and root-owned managed files require the agent to run
  as **root**; where the service must *not* run as root (Rspamd), run the
  container as root and drop the service back to its own uid in the wrapper
  (`setpriv --reuid=<uid> --regid=<uid> --clear-groups <cmd>`).
- **Reload timing:** a controller-socket reload (`rspamadm control reload`) can
  fail on the very first cycle before the socket is up; the agent retries and
  succeeds the next cycle.

### Logs-only sidecar (no service tools needed)

Reading root-owned log files needs no service binaries — just root and the files.
One robin-agent (run as root, mounting the log tree read-only) can be the
`log_agent_id` for several services at once. It reads natively (no `tail`/`grep`),
ships only the lines written since its previous push (its first push after start
is the recent tail, marked as a reset), bounds each read to 1 MiB, and follows
rotated files.

## Collector configuration

Each agent-owned axis reads a few env vars. Metrics collectors, by type:

| Type | How the agent collects | Env (default) |
|---|---|---|
| Dovecot | `doveadm stats dump` / `doveadm who` | tools on `PATH`, or `ROBIN_AGENT_EXEC_PREFIX` |
| Postfix | `postqueue -j` | tools on `PATH`, or `ROBIN_AGENT_EXEC_PREFIX` |
| Redis | `INFO` over RESP (no `redis-cli`) | `ROBIN_AGENT_REDIS_ADDR` (`127.0.0.1:6379`) |
| ClamAV | `VERSION` + `STATS` over the clamd socket | `ROBIN_AGENT_CLAMAV_ADDR` (`127.0.0.1:3310`) |
| Rspamd | HTTP `GET /metrics` + `/stat` | `ROBIN_AGENT_RSPAMD_URL` (`http://127.0.0.1:11334`), `ROBIN_AGENT_RSPAMD_PASSWORD` |
| Robin | HTTP `GET /metrics/prometheus` | `ROBIN_AGENT_ROBIN_METRICS_URL` (`http://127.0.0.1:8080`) |
| Postgres | one consolidated `psql -tAqc` query → JSON | `ROBIN_AGENT_POSTGRES_DSN` (**requires `psql` on the host**; the container image bundles it) |
| MariaDB | one statistics batch through `mariadb -B --force` (locally, or inside the container through `ROBIN_AGENT_EXEC_PREFIX`) | `ROBIN_AGENT_MARIADB_DSN` (per service: `ROBIN_AGENT_MARIADB_DSN_<SERVICE_ID>`); `ROBIN_AGENT_MARIADB_CLIENT=mysql` for a MySQL container |

Config apply writes rendered files under `ROBIN_AGENT_MANAGED_ROOT` (per-type
dir) then validates + reloads; for Postfix it first applies the `key = value`
lines of each managed `.cf` file with `postconf -e`. `ROBIN_AGENT_APPLY_ONLY=1`
stages the files and skips postconf/reload (for a metrics/logs-only agent, or
where something else reloads).

When a service's exec prefix is `docker exec <container>` (or `podman exec`),
the agent also copies each rendered file into the container at the per-type
config dir (`docker cp`) before validating and reloading, since the service reads
its config from the container's filesystem, not the agent's. Nothing runs inside
the container to do this, so minimal images without a shell or `mkdir` work: a
missing config dir (the `dovecot/dovecot` 2.3 image ships no `conf.d`) is
created by `docker cp` itself, and an existing one keeps its owner and mode. A
config dir mounted read-only into the container fails the apply with that error.
Apply-only mode skips the copy. For `ssh` prefixes the agent can't deliver files
remotely: mount the service's config dir at `ROBIN_AGENT_MANAGED_ROOT` instead.

Dovecot renamed settings in 2.4 and rejects a whole include over one unknown
setting, so the agent reports `dovecot --version` with each metrics push and
robin-admin renders Dovecot config in that version's syntax. The Dovecot
version setting on the config page only applies until a version has been
reported (for example, a direct-mode service with no agent).

Log collectors default to the standard journald unit / file / dated-dir per type
and are overridable with `ROBIN_AGENT_<TYPE>_LOG_{UNIT,FILE,DIR,GLOB,CONTAINER,FILTER}` —
useful when the log is mounted at a non-standard path. `CONTAINER` follows a
container's console output (`docker logs`) for services that log to stdout. An agent
running several services of one type sets them per service with
`ROBIN_AGENT_LOG_<SERVICE_ID>_…` (id upper-cased, other characters as `_`),
which takes precedence over the type-level setting.

Operational commands (queue control, sessions, reloads) arrive over the agent's
command long-poll and run through the same exec prefix; see
[fleet-service-capabilities.md](fleet-service-capabilities.md#agent-command-channel).

## Worked reference: the bundled suite

The suite overlay (`docker-compose.suite.yaml`) runs one pre-provisioned
`suite-admin-agent` (robin-agent + Docker CLI, root, Docker socket, the suite
log tree mounted read-only). Services are registered by
`FLEET_SERVICES_BOOTSTRAP_JSON`:

| Service | metrics | config | logs | How |
|---|---|---|---|---|
| Dovecot | agent | agent (apply-only) | agent | `docker exec suite-dovecot …`; logs from `/logs/dovecot` |
| Rspamd | direct | agent (apply-only) | direct | `docker exec suite-rspamd …` for config reloads |
| ClamAV | direct (dial clamd) | agent (apply-only) | **agent** | root-owned log from `/logs/clamav` |
| PostgreSQL | direct (DSN) | direct | **agent** | root-owned logs from `/logs/postgres` |
| Redis | direct (DSN) | direct | **agent** | `docker logs suite-redis` via `ROBIN_AGENT_REDIS_LOG_CONTAINER` |
| Robin | direct | direct | direct | none |

Dovecot sessions and users run through the same `docker exec` prefix. The
Docker socket grants high privilege, so keep this on a trusted local host or
behind a Docker socket proxy.

Postfix is not part of the Robin suite (Robin is its MTA). To test Robin
Admin's Postfix support, the development overlay's `postfix-dev` profile runs
`suite-admin-postfix-dev` with its own co-located agent,
`suite-admin-postfix-agent-dev` (`docker exec suite-admin-postfix-dev …`, logs
via `ROBIN_AGENT_POSTFIX_LOG_CONTAINER`). Enroll that agent under **Fleet ->
Agents** and register the service as `postfix-dev`.

## When you do *not* need an agent

For any service robin-admin can reach directly — a reachable Redis/Postgres with
an admin DSN, an Rspamd controller, a Robin OpenMetrics endpoint, a world-readable
log — keep it **direct**. Agents earn their keep for remote/NAT'd hosts and
Postfix/Dovecot, whose tooling only runs on the host; every service type supports both, so start direct and move an
individual axis onto an agent only when a host is out of reach.

## MariaDB in a container

A MariaDB container (`app-database`, MariaDB 10.11) publishes its port on host
loopback only (`127.0.0.1:3306`), so robin-admin usually cannot reach it and an
agent on the database host collects it. Create a least-privilege monitoring user
once:

```sql
CREATE USER 'robin_monitor'@'localhost' IDENTIFIED BY '…';
CREATE USER 'robin_monitor'@'127.0.0.1' IDENTIFIED BY '…';
GRANT PROCESS, REPLICATION CLIENT, SLAVE MONITOR, SHOW DATABASES ON *.* TO 'robin_monitor'@'localhost', 'robin_monitor'@'127.0.0.1';
-- Table sizes without read access to application data (choose your own schema pattern):
GRANT REFERENCES ON `app%`.* TO 'robin_monitor'@'localhost', 'robin_monitor'@'127.0.0.1';
-- Statement digests, only if performance_schema is ON:
GRANT SELECT ON performance_schema.* TO 'robin_monitor'@'localhost', 'robin_monitor'@'127.0.0.1';
```

`PROCESS` covers the process list and InnoDB transactions. `information_schema`
lists only objects the user holds some privilege on: `SHOW DATABASES` makes every
schema count, and `REFERENCES` on the application databases makes their tables' sizes
visible while `SELECT` on application data stays denied.

Agent environment:

```
ROBIN_AGENT_MARIADB_DSN=mysql://robin_monitor:…@127.0.0.1:3306/
ROBIN_AGENT_EXEC_PREFIX=app-db=docker exec app-database
ROBIN_AGENT_MARIADB_LOG_CONTAINER=app-database
```

The client runs inside the container (it ships one), so the agent needs no
published port and no client of its own. The password goes in `MYSQL_PWD`,
which `docker exec -e MYSQL_PWD` forwards by name: it never appears on a
command line. Register the service as type `mariadb` and assign it to the
agent; metrics, raw output and logs then work from the agent. Config and the
admin tools (processes, transactions, kill, ANALYZE) need robin-admin to reach
the server directly with a DSN whose user holds the admin grants:

```sql
GRANT PROCESS, RELOAD, SUPER, CONNECTION ADMIN,
      REPLICATION CLIENT, SLAVE MONITOR ON *.* TO 'robin_admin'@'<robin-admin host>';
GRANT SELECT, INSERT ON `app%`.* TO 'robin_admin'@'<robin-admin host>';
GRANT SELECT ON performance_schema.* TO 'robin_admin'@'<robin-admin host>';
```

`SUPER` covers `SET GLOBAL`, `CONNECTION ADMIN` killing other users'
connections, `RELOAD` `FLUSH STATUS`, and `SELECT, INSERT` `ANALYZE TABLE`.

These grants are for MariaDB 10.11. MySQL uses its own privilege names; assign
only the privileges required for the operations you enable, scoped to your
application schemas. Agent-only services provide metrics and logs, not managed
configuration or database operations.

Only `socket` and `ssl` DSN options are supported. Without `socket`, localhost
uses TCP and respects the port. Use `ssl=true` or `ssl=required` to verify the
server certificate and hostname; `ssl=skip-verify` explicitly disables verification,
and `ssl=false` disables TLS. Set `ROBIN_AGENT_MARIADB_CLIENT=mysql` when executing
the MySQL client in a container. Trust roots must be available on the collector host.
