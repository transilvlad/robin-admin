# Deploying robin-agent

`robin-agent` is a single dependency-free Go binary that runs on a mail-server
host or container and **dials out** to robin-admin. Because the agent initiates
the connection, it works behind NAT, firewalls, and inside containers with only
outbound egress — robin-admin never connects into the host.

You only need an agent where robin-admin **cannot reach the service directly**:
remote hosts, and services whose tooling only runs on the host — Postfix
(`postqueue`/`postsuper`/`postfix`), Dovecot (`doveadm`), and host logs. The
agent also runs the operational actions those pages offer (queue control,
sessions, reloads) over its outbound command channel. Services robin-admin can already reach — the bundled
suite, or any reachable Redis/Postgres/Robin/Rspamd — stay in **direct mode** and
need no agent.

This page covers installing and enrolling the binary. For choosing, *per service*,
which of its three telemetry axes (metrics / config / logs) go through the agent
versus a direct endpoint — plus co-locating the agent inside a service image,
pre-provisioned credentials for automated fleets, and the per-type collector
settings — see [agent-co-location.md](agent-co-location.md).

## Where the binary comes from

`robin-agent` lives in the `agent/` directory of the robin-admin repository.

- **GitHub Releases (CI-built):** every `v*` tag builds `robin-agent-<os>-<arch>`
  for linux/darwin × amd64/arm64 with a `SHA256SUMS.agent`, attached to the
  robin-admin release (`.github/workflows/agent-release.yml`).
- **Container image:** `ghcr.io/transilvlad/robin-admin-agent:<version>` (multi-arch).
- **From source:** from the robin-admin checkout, run `cd agent && CGO_ENABLED=0 go build -o robin-agent .`

The Fleet enrollment page reads its image, installer, release-asset, and guide
URLs from **Administration -> Integrations -> Agent deployment artifacts**. Use
those settings to point snippets at an internal mirror, pinned image, or forked
robin-admin release source.
Commands preserve the client build's path prefix (for example `/admin`). Missing
settings block issuing enrollment commands rather than substituting frontend
defaults. Automatic certificate exceptions apply only to exact localhost/loopback
destinations, not hostnames that merely contain `localhost`.

## Enrolling

1. In robin-admin open **Fleet → Agents**, create an agent named for the host.
2. Copy the one-time enrollment command it shows (the page offers Docker,
   Compose, systemd, and manual variants — all with the token filled in).
3. Run it on the host. The agent exchanges the token for a long-lived credential
   (cached in its state dir) and checks in. The enrollment token is single-use
   and short-lived; use **New token** if it expires before you enroll.

## Deployment methods

### 1. systemd on the host (recommended for co-located mail servers)

```bash
curl -fsSL https://raw.githubusercontent.com/transilvlad/robin-admin/main/agent/install.sh \
  | sudo ROBIN_ADMIN_URL=https://admin.example.com \
         ROBIN_AGENT_ID=<id> ROBIN_ENROLLMENT_TOKEN=<token> sh
```

The installer detects the OS/arch, downloads + checksum-verifies the release
binary, installs `/usr/local/bin/robin-agent`, writes `/etc/robin-agent/agent.env`
(0600), and enables a `robin-agent.service` unit. Re-running upgrades in place;
the cached credential means no token is needed again.

Manage it with `systemctl status robin-agent` and `journalctl -u robin-agent`.
The unit runs as **root** by default so it can write managed config and run the
service tools (`doveadm`, `postqueue`, `postsuper`, `postcat`, `postfix reload`, …). For an
observability-only agent, set `User=` to a low-privilege account with read access
to the logs/sockets it needs.

### 2. Docker / Compose sidecar

```bash
docker run -d --name robin-agent --restart unless-stopped \
  -e ROBIN_ADMIN_URL=https://admin.example.com \
  -e ROBIN_AGENT_ID=<id> -e ROBIN_ENROLLMENT_TOKEN=<token> \
  -v robin-agent-state:/var/lib/robin-agent \
  ghcr.io/transilvlad/robin-admin-agent:latest
```

To manage a service running in another container, give the agent the Docker CLI
and socket and set `ROBIN_AGENT_EXEC_PREFIX=<serviceId>=docker exec <container>`
so it runs `doveadm`/`postqueue`/`postfix` inside that container, and copies
rendered config into it before reloading; point
`ROBIN_AGENT_<TYPE>_LOG_CONTAINER` at it when the service logs to its console.
Alternatively run the agent inside the service image. For metrics-only over the network
(Redis/Postgres), prefer **direct mode** instead of an agent.

Compose:

```yaml
services:
  robin-agent:
    image: ghcr.io/transilvlad/robin-admin-agent:latest
    restart: unless-stopped
    environment:
      ROBIN_ADMIN_URL: https://admin.example.com
      ROBIN_AGENT_ID: <id>
      ROBIN_ENROLLMENT_TOKEN: <token>
    volumes:
      - robin-agent-state:/var/lib/robin-agent
volumes:
  robin-agent-state:
```

### 3. Kubernetes

Run it as a **DaemonSet** (one agent per node) or a **sidecar** in the mail
service's pod, with the enrollment token from a Secret and a `hostPath`/PVC for
`/var/lib/robin-agent`. The agent needs whatever the managed service needs
(config mount + tooling); mirror the co-location notes above.

### 4. Manual / restricted networks / air-gapped (outage fallback)

When the host can't reach GitHub (or during an outage), install by hand:

```bash
# On a machine with access, download + verify, then copy both files over:
os=linux; arch=amd64                    # match the target
curl -fsSLO https://github.com/transilvlad/robin-admin/releases/latest/download/robin-agent-${os}-${arch}
curl -fsSLO https://github.com/transilvlad/robin-admin/releases/latest/download/SHA256SUMS.agent
sha256sum -c --ignore-missing SHA256SUMS.agent

# On the target host:
install -m 0755 robin-agent-${os}-${arch} /usr/local/bin/robin-agent
```

Then run it under the systemd unit above, or point the installer at an **internal
mirror** of the release assets:

```bash
curl -fsSL .../install.sh | sudo ROBIN_AGENT_DOWNLOAD_BASE=https://mirror.internal/robin-agent \
  ROBIN_ADMIN_URL=... ROBIN_AGENT_ID=... ROBIN_ENROLLMENT_TOKEN=... sh
```

If robin-admin itself uses a self-signed certificate on an internal network, add
`ROBIN_AGENT_INSECURE=1` (drop it once a trusted certificate is in place).

## Environment reference

| Variable | Description |
|---|---|
| `ROBIN_ADMIN_URL` | robin-admin base URL the agent dials out to. |
| `ROBIN_AGENT_ID` / `ROBIN_ENROLLMENT_TOKEN` | From **Fleet → Agents**; needed only for the first enrollment. |
| `ROBIN_AGENT_CREDENTIAL` | A pre-provisioned long-lived credential — skips enrollment (for automated/reproducible fleets; see [agent-co-location.md](agent-co-location.md#provisioning-enrollment-vs-a-pre-set-credential)). |
| `ROBIN_AGENT_STATE` | Credential/state file (default `/var/lib/robin-agent/state.json`). Persist it to avoid re-enrolling. |
| `ROBIN_AGENT_PROBE` | Comma list of `type=host:port` to TCP-probe for discovery. |
| `ROBIN_AGENT_MANAGED_ROOT` | Prefix for written config (default `/`; point at a staging dir to preview). |
| `ROBIN_AGENT_APPLY_ONLY` | `1` = deliver config but skip validate+reload (staging model). |
| `ROBIN_AGENT_EXEC_PREFIX` | Comma list of `serviceId=prefix` prepended to a service's commands (e.g. `mail=docker exec mail`, `mx1=ssh mx1`). |
| `ROBIN_AGENT_<TYPE>_LOG_{UNIT,FILE,DIR,GLOB,CONTAINER,FILTER}` | Override where the agent follows a type's log; `CONTAINER` follows a container's console output via `docker logs`. |
| `ROBIN_AGENT_LOG_<SERVICE_ID>_{UNIT,FILE,DIR,GLOB,CONTAINER,FILTER}` | The same for one service (id upper-cased, other characters as `_`), for an agent running several services of one type. |
| `ROBIN_AGENT_INSECURE` | `1` = skip TLS verification (self-signed dev only). |
| Installer-only: `ROBIN_AGENT_VERSION`, `ROBIN_AGENT_REPO`, `ROBIN_AGENT_DOWNLOAD_BASE` | Pin a version, change the repo, or mirror assets internally. |

## Command channel

Alongside its 30-second sync, the agent holds an outbound long-poll
(`GET /api/fleet/agent/commands`, ~25s) advertising the actions it can run for
the services it owns, and posts each result to
`POST /api/fleet/agent/commands/:id/result`. robin-admin sends only an action
name and validated arguments; the agent maps each to a fixed command (the
allowlist is in [fleet-service-capabilities.md](fleet-service-capabilities.md#agent-command-channel))
and applies the service's exec prefix.

With each heartbeat the agent also reports, per service, how it reaches it
(`local`, `container`, `ssh`), whether it can place config files there (not
over ssh), and which actions have their tools present, probed through the exec
prefix every few minutes. robin-admin shows an action only where that report
includes it; see [what works in each setup](fleet-service-capabilities.md#what-works-in-each-setup).

Each poll confirms the commands the previous poll returned. If a response is
lost in transit (the connection dropped just after robin-admin handed a command
over), robin-admin re-sends the unconfirmed command on the next poll, and the
agent skips any command id it has already run.

The command queue is stored in PostgreSQL (`fleet_agent_commands`), so
agent-backed controls work across API replicas that share the same database and
queued commands survive robin-admin process restarts until they expire.
PostgreSQL is the durability boundary: if robin-admin cannot reach the database,
commands cannot be queued or completed. The server waits about 20 seconds for a
result, while the agent gives each local command about 15 seconds and caps posted
output at 4 MiB. If a result is lost after the agent already ran the command,
robin-admin expires the command at its timeout; verify service state before
retrying non-idempotent actions.

## Per-service co-location requirements

Every type supports **both** a direct and an agent path on each axis — pick per
service (default direct; agent for remote/NAT'd hosts). Per-type collector
settings are in [agent-co-location.md](agent-co-location.md#collector-configuration).

| Service | Agent needs | Typical mode |
|---|---|---|
| Postfix | `postqueue`/`postsuper`/`postcat` (metrics, queue control); `postconf -e`, `postfix check`/`postfix reload` + write `/etc/postfix` (config); its log (message counters) | agent; a postfix_exporter gives queue depth only |
| Dovecot | `doveadm` (metrics, sessions, users/quota, reload); write `/etc/dovecot/conf.d` | agent; OpenMetrics gives metrics only |
| Rspamd | reach the controller (metrics/logs); `rspamadm` + write `/etc/rspamd/local.d` (config) | direct metrics/logs, agent config — or all direct |
| ClamAV | reach `clamd` (metrics); read the log file (logs) | direct metrics, agent logs if the log is root-owned |
| Redis / Postgres / MariaDB | admin DSN (direct) or, agent-side, RESP `INFO` / `psql` / `mariadb` | direct where reachable; agent for remote or loopback-only services |
| Robin | OpenMetrics endpoint (HTTP) | direct; agent only if unreachable |

## Common topologies

- **All-in-one mail host** (Postfix + Dovecot + Rspamd + ClamAV co-located): one
  agent via systemd manages config + metrics + logs + commands for Postfix and Dovecot;
  Redis/Postgres stay direct.
- **Dedicated mailbox hosts** (Dovecot, possibly a director): an agent per host.
- **Scanner pool** (many Rspamd/ClamAV): an agent per node, grouped by role in
  robin-admin.
- **Managed databases** (RDS-style Postgres/Redis): no agent — direct mode with
  an admin DSN.

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
