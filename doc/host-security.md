# Host security telemetry

Host security is an opt-in, read-only Fleet source. The enrolled agent ID is
the host identifier. The server derives it from the agent credential. No
Fleet service assignment is required and an agent can write only its own
telemetry.

## Snapshots and heartbeats

A v1 snapshot is an object of named sections. Each section has a status of
`ok`, `not_permitted` or `not_available`, and an array of items keyed by
stable section-local IDs. Where a collector can return partial results it
sets `complete: false`. Incomplete sections are visible to operators and
never imply removals. IDs use stable identities such as a login name, a
file path or a protocol/address/port tuple. The shared type declarations
live in `contracts/host-security-v1.ts`.

| Section | Item value |
| --- | --- |
| `sshKeys` | User, file, SHA256 fingerprint, key type, bits, comment, options |
| `sshd` | Effective setting name and value from `sshd -T` |
| `accounts` | Login name, UID, shell and home |
| `privilegedGroups` | Group and members |
| `sudoers` | File, sanitized rule and whether it grants NOPASSWD |
| `cron` | File, SHA256 checksum and line count |
| `systemd` | Unit name and state |
| `listeners` | Protocol, non-loopback address, port and process name |
| `firewall` | Backend and default inbound policy of accept, drop or unknown |
| `patching` | Counts of pending and security upgrades, reboot status and its first observed time, kernel and OS |
| `integrity` | Absolute file path and SHA256 checksum, with a section root hash |

The agent sorts items and hashes the serialized sections. Observation time
is outside the content hash. It posts to `/api/fleet/agent/host-security/snapshot`
with `version`, `observedAt`, `intervalSeconds`, `hash` and optional
`sections`. Every cycle posts a hash even when unchanged. The server uses
receipt time for staleness and requests a full snapshot if it has no current
record for the hash. Each content transition receives a snapshot ID, including
a transition back to earlier content. Retries of the current hash refresh
the heartbeat without duplicating history.

Collection limits mark an inventory section incomplete. Long paths, excess
entries, and large inventories are bounded before transmission. This lets the
agent continue to send the other sections when one exceeds its limits.

Open **Fleet → Security** and follow the baseline link for the host. Use
**Review baseline** for the first snapshot. For an existing baseline, review
one change or use the **Review** button with the change count to select
several. Expand each comparison to see what will become expected. The host
page shows the last approval's time, approver, and recorded reason to
administrators.

Coverage gaps show sections that are unavailable, permission denied, or
partially collected. Follow **View inventory** to inspect the affected
section. A partially collected section can contribute observed changes.
Sections with an unavailable or permission-denied status cannot be approved.

Approvals are scoped to the current snapshot ID and baseline revision, so
stale approvals return HTTP 409. An approval records the approver, time,
reason, snapshot and items in the audit log. Partial approval applies only
the referenced diffs.

## Events and counters

Security events carry a stable ID, UTC occurrence time, event type, optional
user, source IP, authentication method, key fingerprint and process, and a
masked line. Server responses link each event to its host and the snapshot
and baseline revision in effect at that time. The supported event types are
login, sudo, su, user/group/password change, sshd reload, fail2ban ban/unban
and configured auditd keys.
Fail2ban and auditd events are reported when they appear in the selected
journal or authentication log. Dedicated log files for those daemons are
outside this source.

Failed authentications produce only counters, across invalid user, failed
key and failed password categories. The counters also record accepted logins
and a distinct failed-source IP **count**, capped at 4,096 per minute.
Buckets use UTC minute boundaries,
and repeat deliveries use an idempotent batch ID. The agent keeps the input
position and unacknowledged batch so a retry neither skips nor duplicates
data. Raw events follow the Logs store retention. Snapshot and diff history
defaults to 90 days.

Never transmit key material, password material or file contents. Key comments,
SSH command options and sudo rules are treated as potentially sensitive and
sanitized before sending. Logs masking is mandatory. A degraded collector
must not silently report an empty complete inventory.
Forced-command arguments are omitted from SSH key metadata. A change confined
to those arguments is outside key-option drift detection.

## Operator API

All paths below are under `/api/security` and use the standard success/data
envelope. Read routes require the `security:read` API scope. Mutation
routes require `security:manage`. Sessions use the corresponding Fleet
view and management permissions.

| Method and path | Result |
| --- | --- |
| GET `/hosts` | Host posture, latest snapshot ID, baseline state, reviewable drift count, coverage gap count and last receipt time |
| GET `/hosts/:hostId/snapshots` | Snapshot IDs, hashes, and timestamps, newest first |
| GET `/hosts/:hostId/snapshots/:snapshotId` | Snapshot by stable ID |
| GET `/hosts/:hostId/snapshot` | Current snapshot, host name, last heartbeat and staleness |
| GET `/hosts/:hostId/snapshot?at=...` | Latest snapshot at or before a UTC time |
| GET `/hosts/:hostId/diff` | Current snapshot versus approved baseline, with the last approval for administrators, or an event's diff with `snapshotId` and `baselineRevision` |
| POST `/hosts/:hostId/approve` | Approve all or selected item IDs, with optional reason |
| GET `/hosts/:hostId/events` | Events filtered by type, user, source IP and time |
| GET `/hosts/:hostId/counters` | Minute counters filtered by time |
| GET `/known-addresses` | Labeled IP/CIDR entries and optional expiry |
| POST `/known-addresses` | Add a known address |
| PATCH `/known-addresses/:id` | Update a known address |
| DELETE `/known-addresses/:id` | Remove a known address |

Collection responses support `limit` and an opaque `cursor` that binds to
the listed sort order. Reuse it with the same filters. Times use ISO 8601 in UTC. Time filters use
inclusive `from` and exclusive `until`. Expired known addresses do not
classify subsequent logins. Host arrival, inventory approval and telemetry
staleness are distinct states.

## Deploy a collector

Enable the source on each enrolled Linux agent by setting
`ROBIN_AGENT_HOST_SECURITY=1`. Leave the service running as its existing
account. Fleet → Security shows sections the account cannot read.

| Setting | Default |
| --- | --- |
| `ROBIN_AGENT_HOST_SECURITY_INTERVAL` | 300 seconds, with jitter |
| `ROBIN_AGENT_HOST_SECURITY_PATHS` | Optional comma-separated absolute paths to add to the standard integrity paths |
| `ROBIN_AGENT_HOST_SECURITY_FILE_CAP` | 10,000 integrity files |
| `ROBIN_AGENT_HOST_SECURITY_BYTE_CAP` | 32 MiB read for integrity in one collection |
| `ROBIN_AGENT_HOST_SECURITY_AUDIT_KEYS` | Optional comma-separated auditd keys |
| `HOST_SECURITY_RETENTION_DAYS` | Snapshot and approval history on the server, at least 90 days |
| `HOST_SECURITY_PATCH_ALERT_DAYS` | Alert after seven days of pending security upgrades or reboot |

The agent checks the local package cache with an APT simulation that disables
locking. Package update counts are unavailable on hosts without APT.
Snapshot freshness becomes stale after three configured intervals.
For alert delivery, enable the host security subscriptions on each relevant
destination. Recent login alerts recover when the login leaves the 24-hour
window. Drift alerts recover after approval or when the observed value matches
the approved baseline again.
