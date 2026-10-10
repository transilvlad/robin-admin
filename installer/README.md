# Robin Admin host installer

The installer is a dedicated Node.js service on the Docker host. Robin Admin
never receives the Docker socket. Module requests can submit only a version and
an explicit maintenance downtime acknowledgement.
Admin obtains up to two repository-scoped, short-lived Sheriff grants from a
stored valid lease and sends those internal credentials with the job.
Container details come exclusively from a local policy file protected with
mode `0600` (or the read-only equivalent `0400`). Startup rejects symlinks,
non-regular files, and any group/world-readable, writable, or executable mode.

## Install with systemd

1. Install Node.js 26.10.0 or newer and the Docker CLI.
2. Copy this repository (or `installer/`) to `/opt/robin-admin`.
3. Create a locked service account and state/config directories:

   ```sh
   sudo useradd --system --home /var/lib/robin-admin-installer --shell /usr/sbin/nologin robin-installer
   sudo install -d -o robin-installer -g docker -m 0700 /var/lib/robin-admin-installer
   sudo install -d -o root -g root -m 0755 /etc/robin-admin
   sudo install -o root -g root -m 0600 installer/examples/installer-policy.json /etc/robin-admin/installer-policy.json
   sudo install -o root -g root -m 0600 installer/examples/robin-admin-installer.env /etc/robin-admin/installer.env
   sudo install -o root -g root -m 0644 installer/examples/robin-admin-installer.service /etc/systemd/system/robin-admin-installer.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now robin-admin-installer
   ```

Replace the example policy, image digest, and secret first. Keep the source
policy root-owned with mode `0600`. The systemd unit supplies it to the
unprivileged service through `LoadCredential` as a read-only `0400` file.
Its `ExecStartPre` check rejects an unsafe source-policy mode before startup.
Images must use `image@sha256:<64 hex>`; tags are rejected.

## Runtime addresses

Every approved module version defines `runtime` beside `services`:

```json
{
  "runtime": {
    "backendUrl": "http://example-api:4000/module",
    "assetBaseUrl": "http://example-ui:80",
    "probeUrl": "http://example-api:4000/ready"
  },
  "services": []
}
```

The service list must contain the actual approved containers. Addresses are
operator-owned deployment coordinates, reachable **from Admin**, not from the
installer or the browser. They work for named bridge networks, host networking,
and published ports without depending on container names or service order.
For host networking with containerized Admin, use the reachable host gateway
(for example `host.docker.internal:4000`), not container-local `127.0.0.1`.
An all-interface bind such as `0.0.0.0` is not a connection target.

All three keys are required. `backendUrl` may be `null` for a frontend-only
module. Backend base paths are allowed; `assetBaseUrl` must be an origin because
assets use the module's absolute remote-entry path. `probeUrl` specifies an
independent readiness endpoint which must accept HEAD without authentication.
Only absolute HTTP(S) addresses are accepted, without credentials, query strings
or fragments. Private addresses are expected here: the root-owned policy is the
approval boundary, not module catalogue metadata or a browser-supplied target.

Executed successful jobs durably return `data.mode = "docker"` and `data.runtime`.
Admin validates and persists these targets before it records an installation.
Dry runs never register an install. There is no module-specific target map,
port-order guessing or default `/health` path. Deploy Admin and its installer
together, and update policies to this contract; old incomplete job results are
rejected rather than silently creating an unusable installation. Existing valid
stored targets are retained until a successful upgrade replaces them.

`robin-tools-1.0-policy.template.json` is an operator template, not a usable
default. Replace both digest placeholders and every `REPLACE_...` database or
`MODULE_PROXY_SECRET` value before installing it. The parser deliberately
rejects unreplaced environment placeholders.

## Compose connectivity

The `installer` profile of `docker-compose.yaml` runs the same service as
`suite-admin-installer` in a hardened container on Admin's private network
(alias `installer-backend`). Its fixed policy defaults to no module
installations. The Windows bind-mounted policy is copied to private tmpfs
before mode validation.

The installer manages modules only. The telemetry store (`suite-victoriametrics`)
is part of Admin's Compose stack; see [Telemetry](../doc/telemetry.md).

The private `stateDir` contains job records and any interrupted transaction.
Do not edit it while a job is running. Invalid durable job records are quarantined
in a private subdirectory beside the job files so they do not crash-loop the
installer; retain them for operator inspection. A failed recovery is deliberately blocked;
repair Docker/the reported container state, then restart the service. Do not delete
the journal or data volumes to force a new apply.

For a host installer (systemd), every Admin service maps `host.docker.internal`
to `host-gateway`. A service bound to the default `127.0.0.1` is suitable when
Admin runs on the host network (`docker-compose.host.yaml`, which points Admin
at `127.0.0.1:3041`). For a containerized Admin on a bridge network, bind the
installer to the Docker bridge gateway address (not `0.0.0.0`), for example:

```sh
docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'
```

Set that address as `MODULE_INSTALLER_HOST`, restrict TCP/3041 to Docker bridge
traffic with the host firewall, and set these in Admin's `.env`:

```sh
MODULE_INSTALLER_URL=http://host.docker.internal:3041
MODULE_INSTALLER_SIGNING_SECRET=<the installer's secret>
```

## Manual run

```sh
install -d -m 0700 installer/state
install -m 0600 installer/examples/installer-policy.json installer/state/policy.json
MODULE_INSTALLER_SIGNING_SECRET='at-least-32-random-characters' \
MODULE_INSTALLER_POLICY_FILE="$PWD/installer/state/policy.json" \
MODULE_INSTALLER_STATE_DIR="$PWD/installer/state" \
node installer/src/index.js
```

`GET /health` is unauthenticated. All `/api` requests require a timestamped
HMAC signature. Job records are atomically persisted without registry
credentials. Every module policy must explicitly select `upgradeStrategy`:
`stage-first` for parallel-safe services, or `maintenance` for services that
cannot coexist. Missing strategies are rejected; empty port mappings do not
prove isolation. Sheriff-generated policy asks the operator for this choice.
All image digests are pulled and all original ownership labels and container
identities are checked before mutation. Stage-first health-checks every service before
switching any original. Maintenance stops and preserves every original before
creating replacements, then health-checks every replacement within the job deadline.
Maintenance upgrades require `maintenanceAcknowledged: true`; the Modules UI
discloses downtime and requires a deliberate checkbox before dispatch.
Approved images must define a Docker health check. A merely running process
without a health check is not considered a ready replacement.
Failed switches restore all original services
and their prior running/stopped state, and remove staged containers. A private,
credential-free transaction journal lets startup recover an interrupted switch.
Completed jobs are reported only after their result is durably stored. An
incomplete rollback blocks further actions until the Docker failure is repaired
and the installer is restarted; recovery failures are never silently ignored.
Corrupted durable job records also block startup rather than forgetting a job ID
and allowing its side effects to run again. Journal creation and removal are
directory-fsynced on Linux, including the recovered terminal result.
Uninstall removes
containers but preserves named volumes.

`GET /api/capabilities` returns the execution mode, approved module/version
identifiers and `upgradeStrategies` keyed by module slug, never policy environment values. Robin Admin uses this authenticated
endpoint to gate controls. Compose/bootstrap modules remain externally managed.
Start, stop and uninstall verify every target's `robin.admin.managed` and
`robin.admin.module` labels before changing any container. Lifecycle actions do
not require the installed image version to remain approved for pulling; canonical
container names must remain stable, or the operator must retain the old policy.
Docker deletion failures are reported, not treated as successful uninstall.
Final module containers use `unless-stopped` so they recover after Docker or
host restarts. Temporary staged health-check containers do not auto-restart.

Fixed-port host-network services should use `maintenance`. This is intentionally
not zero downtime. `stage-first` remains available only when the operator has
verified parallel execution is safe; a failed staging check leaves originals intact.
Rollback removes all transaction-owned replacements before restarting originals
so fixed ports do not collide during recovery. Original container IDs, images,
names, volumes and prior running/stopped states are preserved. Rollback containers
are retained after success for operator inspection; they are not database snapshots.
Container/job labels prevent recovery from deleting a foreign container that
has taken a transaction name. Older interrupted journals without those labels
may need operator-assisted recovery; never delete a journal to bypass this check.

Container rollback is not database rollback. Staged backends use the configured
database, and migrations can change it before container switching. Back up the
database and encryption keys first; ship backward-compatible migrations or use
a planned maintenance/restore procedure for incompatible changes.

For `sheriff.robinmta.com` images, every approved service must have one matching
credential. The installer creates a separate `DOCKER_CONFIG`, performs
`docker login --password-stdin`, pulls only that service digest, and removes the
credential directory before handling the next service. Public images require
no credential.

## Bounded local fixed-port proof

`npm test` runs the unit/restart regressions and skips the Docker proof by default.
To run the disposable Linux host-network collision/success/failure proof:

```sh
ROBIN_INSTALLER_DOCKER_PROOF=1 node --test test/fixed-port-docker.test.js
```

The proof uses a uniquely named local registry, an immutable test image, an
unused host port and its own named data volume. It never upgrades suite containers.
It checks that stage-first cannot bind the occupied port, maintenance succeeds,
and an unhealthy upgrade restores the exact prior container and volume data.
Docker Desktop must support host networking; public fixture images may be pulled.
This is not a workload or downtime SLA.
