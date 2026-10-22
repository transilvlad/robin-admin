# robin-agent

The unified fleet agent for robin-admin. One dependency-free Go binary, deployed
per host or container (or per combination of co-located applications). It **dials
out** to robin-admin, so it works behind NAT/firewalls and inside containers with
only outbound egress — robin-admin never connects into the host.

It enrolls once (or uses a pre-provisioned credential), then heartbeats, applies
managed config, ships metrics and new log lines, and runs allowlisted operational
commands — all over the same outbound channel. The agent stays a **thin
executor** — it runs commands and ships raw output, writes files robin-admin
renders, and follows logs; robin-admin keeps all rendering and parsing.

## Configuration (environment)

| Variable | Required | Description |
|---|---|---|
| `ROBIN_ADMIN_URL` | yes | Base URL of robin-admin, e.g. `http://admin-backend:3001` or `https://admin.example.com`. |
| `ROBIN_AGENT_ID` | first run | Agent id from robin-admin (Add agent). |
| `ROBIN_ENROLLMENT_TOKEN` | first run | One-time enrollment token from robin-admin. Consumed on enroll; the long-lived credential is then stored in the state file. |
| `ROBIN_AGENT_STATE` | no | State file path (default `/var/lib/robin-agent/state.json`). Persist this to survive restarts without re-enrolling. |
| `ROBIN_AGENT_PROBE` | no | Comma list of `type=host:port` to TCP-probe for discovery, e.g. `postfix=postfix:25,dovecot=dovecot:143,rspamd=spam-backend:11334`. |
| `ROBIN_AGENT_MANAGED_ROOT` | no | Prefix under which rendered config files are written (default `/`). Point it at a staging dir to preview without touching real config. |
| `ROBIN_AGENT_APPLY_ONLY` | no | `1`/`true` to deliver config files but skip postconf/validate/reload (a separate mechanism reloads the service, or for dev). |
| `ROBIN_AGENT_<TYPE>_LOG_{UNIT,FILE,DIR,GLOB,CONTAINER,FILTER}` | no | Override where a type's log is followed. `CONTAINER` follows a container's console output via `docker logs` (for services that log to stdout). |
| `ROBIN_AGENT_LOG_<SERVICE_ID>_{UNIT,FILE,DIR,GLOB,CONTAINER,FILTER}` | no | The same, for one service; takes precedence over the type-level setting. `<SERVICE_ID>` is the service id upper-cased with other characters as `_` (`mx-2` → `ROBIN_AGENT_LOG_MX_2_FILE`). Use it when one agent runs several services of a type. |
| `ROBIN_AGENT_EXEC_PREFIX` | no | Comma list of `serviceId=prefix` to prepend to a service's collect/validate/reload/command invocations, so the agent can reach a service that isn't a local host binary. Host package → no entry (`doveadm stats dump`); container → `suite-dovecot=docker exec suite-dovecot`; remote host → `mail1=ssh mail1`. Yields e.g. `docker exec suite-dovecot doveadm stats dump`. With a `docker exec`/`podman exec` prefix, config apply also copies rendered files into the container. |
| `ROBIN_AGENT_POSTGRES_DSN` | no | Postgres DSN the metrics collector runs `psql` with. |
| `ROBIN_AGENT_MARIADB_DSN` | no | `mysql://` / `mariadb://` DSN for the MariaDB/MySQL collector; `ROBIN_AGENT_MARIADB_DSN_<SERVICE_ID>` sets one service's. Passwords use `MYSQL_PWD` (forwarded by name through `docker exec`). Only `socket` and `ssl` options are supported. `ssl=true`/`required` verify identity; `skip-verify` disables verification; `false` disables TLS. Without `socket`, connections use TCP. |
| `ROBIN_AGENT_MARIADB_CLIENT` | no | Client binary for the MariaDB collector (default `mariadb`, or `mysql` when only that is installed locally). Set `mysql` for a MySQL container. |
| `ROBIN_AGENT_INSECURE` | no | `1`/`true` to skip TLS verification (self-signed dev suites only). |

## Config apply

Assign services to the agent in robin-admin (**Fleet → Agents → Services**). Each cycle the
agent lists its services, pulls each one's config manifest, and — when the manifest sha changes —
fetches the rendered text files and writes them to the service's config directory (per-type:
Dovecot `/etc/dovecot/conf.d`, Rspamd `/etc/rspamd/local.d`, Postfix `/etc/postfix`, …, under
`ROBIN_AGENT_MANAGED_ROOT`), then validates and reloads the service and reports status back.
Postfix has no include directive, so the agent first applies the `key = value` lines of each
managed `.cf` file with `postconf -e`. robin-admin renders the config; the agent only writes +
reloads. For a service in another container (a `docker exec` exec prefix) the agent also copies
each file into the container, creating the config directory there if it is missing.

The agent reports `dovecot --version` with its Dovecot metrics, and robin-admin renders Dovecot
config in that version's syntax (2.3 and 2.4 name some settings differently).

## Logs

The agent follows each owned service's log (container console, file, newest file in a dir, or
journald) and ships only the lines written since its previous push. The first push after start is
the recent tail with `reset: true`, so robin-admin replaces its buffer and never double-counts
(Postfix message counters are derived from these lines).

## Commands

`commands.go` holds an outbound long-poll (`GET /api/fleet/agent/commands?actions=…`) that
advertises the actions the agent can run for the services it owns, runs each queued action, and
posts the output to `POST /api/fleet/agent/commands/:id/result`. robin-admin sends only an action
name and arguments; the agent maps each to a fixed command and validates queue IDs and usernames:

| Action | Command |
|---|---|
| `postfix.queue.list` / `postfix.queue.show` | `postqueue -j` / `postcat -ehbq <id>` |
| `postfix.queue.hold` / `release` / `requeue` / `delete` | `postsuper -h` / `-H` / `-r` / `-d <id>…` |
| `postfix.queue.deliver` / `postfix.queue.flush` | `postqueue -i <id>` / `postqueue -f` |
| `postfix.reload` | `postfix check` + `postfix reload` |
| `dovecot.reload` | `doveconf -n` + `doveadm reload` |
| `dovecot.who` / `dovecot.kick` | `doveadm who -1` / `doveadm kick <user>` |
| `dovecot.quota` / `dovecot.user` | `doveadm -f tab quota get -u <user>` (or `-A`) / `doveadm user <user>` |

Command-channel limits:

- robin-admin stores queued commands in PostgreSQL, so API replicas that share
  the same database can serve agent-backed controls and queued commands survive
  robin-admin process restarts until they expire.
- PostgreSQL is the durability boundary. If robin-admin cannot reach its
  database, commands cannot be queued or completed.
- A command is accepted only while the agent is polling and advertising that
  action.
- Delivery is retried until the agent acknowledges receipt; the agent skips
  duplicate command ids so a resent command is not run twice.
- If a result is lost after the agent already ran the command, robin-admin
  expires the command at its timeout; verify service state before retrying
  non-idempotent actions.
- robin-admin waits about 20 seconds for a result, and the agent gives each
  local command about 15 seconds.
- Output posted back to robin-admin is capped at 4 MiB.

Once enrolled, the credential is cached in the state file; `ROBIN_ENROLLMENT_TOKEN`
is no longer needed and the agent resumes automatically on restart.

## Run

```bash
docker run -d --name robin-agent \
  -e ROBIN_ADMIN_URL=http://admin-backend:3001 \
  -e ROBIN_AGENT_ID=<id> \
  -e ROBIN_ENROLLMENT_TOKEN=<token> \
  -v robin-agent-state:/var/lib/robin-agent \
  robin-agent:dev
```

Or as a static binary via systemd on a bare host — set the same env in the unit.

## Build

```bash
docker build -t robin-agent:dev .
# or, with a local go toolchain:
CGO_ENABLED=0 go build -o robin-agent .
```

## Cyrus IMAP collection

Cyrus IMAP 3.6+ supports agent-backed metrics, sessions, quota, mailbox lookup,
and logs, but not managed configuration, reload, or disconnect operations.
Assign the registered `cyrus` service to an agent with the Cyrus tools on
`PATH`, or use `ROBIN_AGENT_EXEC_PREFIX` to run them in its container or host.
The agent probes for the tools before advertising these fixed actions:

| Action | Command |
| --- | --- |
| `cyrus.sessions` | `cyr_info proc` |
| `cyrus.quota` | `quota`, or `quota user/<user>` |
| `cyrus.user` | `mbpath -u -- <user>` |

Mailbox user arguments are validated and passed as separate command arguments.
The metrics collectors read `/var/lib/cyrus/config/stats/report.txt`, run
`cyr_info proc`, and report `master -V`. Set `prometheus_enabled: yes` in
`imapd.conf` and enable `promstatsd` in the `DAEMON` section of
`cyrus.conf`. The primary report must be readable. Missing optional process/version tools or
nonzero command exits do not discard a valid report; collection timeouts and
output-limit failures still report a collection failure.

The default log source is the `cyrus-imapd` journal unit or
`/var/log/mail.log`, filtered by `cyrus/` syslog tags. Set
`ROBIN_AGENT_CYRUS_LOG_FILE=/var/log/cyrus.log` for a dedicated file; an
explicit file override removes the shared syslog filter. A mounted log can use
another path, such as `/logs/cyrus/cyrus.log`. Log paths are resolved on the
agent, independently of the command exec prefix. For logs read by robin-admin
itself, the equivalent override is `CYRUS_LOG_FILE`.
