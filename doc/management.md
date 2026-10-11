# Administration

Administrative functions for Robin Admin.

## Access

Manage administrator accounts (requires Admin role).

### Admin fields

| Field | Description |
|-------|-------------|
| **Email** | Login email address |
| **Role** | Permission level |
| **Created** | Account creation date |
| **Last Login** | Most recent login |
| **Locked** | Account lockout status |

### Roles

| Role | Permissions |
|------|-------------|
| **viewer** | View all data, no modifications |
| **editor** | View and modify users, aliases, queue |
| **admin** | Full access including admin management |

### Creating admins

1. Click "Add Admin"
2. Enter email address
3. Enter password (min 8 characters)
4. Select role
5. Click Save

### Editing admins

- Change role: Select from dropdown and save
- Reset password: Enter new password in edit modal
- Unlock account: Click unlock button if locked

> **Gotcha**: You cannot delete your own admin account or change your own role to prevent lockout.

### Account lockout

Accounts are locked after too many failed login attempts:

- Failed attempts are persisted in PostgreSQL
- Locks can be triggered by account or by IP address
- Admins can clear locks from **Administration -> Security**
- Lockout duration and thresholds are configured in **Administration -> Security**

---

## Audit log

View a chronological log of administrative actions.

### Logged actions

| Action | Description |
|--------|-------------|
| `admin.login` | Admin logged in |
| `admin.logout` | Admin logged out |
| `admin.login_failed` | Login failed |
| `admin.login_locked` | Login was locked out |
| `admin.create` | Admin account created |
| `admin.update` | Admin account modified |
| `admin.delete` | Admin account deleted |
| `api_key.create` | API key created |
| `api_key.revoke` | API key revoked |
| `api_key.delete` | API key deleted |
| `rspamd.settings_update` | Rspamd connectivity or mount settings changed |
| `rspamd.config_update` | Managed Rspamd DKIM/Bayes config changed |
| `rspamd.rules_update` | Structured Rspamd rules changed |
| `rspamd.dkim_domain_create` | DKIM signing domain created |
| `rspamd.dkim_domain_update` | DKIM signing domain updated |
| `rspamd.dkim_key_create` | Initial DKIM selector created |
| `rspamd.dkim_key_rotate` | DKIM selector rotated |
| `rspamd.dkim_key_revoke` | Retired selector revoked |
| `rspamd.training_import` | Training import created |
| `rspamd.training_learn` | Stored sample relearned |
| `rspamd.training_relabel` | Stored sample relabeled and relearned |
| `rspamd.training_delete` | Stored sample deleted |
| `rspamd.scan_run` | Manual or uploaded scan stored in history |
| `rspamd.scan_replay` | Historical scan replayed |
| `rspamd.scan_learn` | Historical scan learned as spam/ham |
| `rspamd.scan_fuzzy` | Historical scan added to or removed from fuzzy storage |
| `rspamd.classifiers_update` | Scan-lab classifier defaults or fuzzy presets changed |
| `user.create` | User account created |
| `user.update` | User account modified |
| `user.delete` | User account deleted |
| `alias.create` | Alias created |
| `alias.update` | Alias modified |
| `alias.delete` | Alias deleted |
| `queue.retry` | Queue item retried |
| `queue.delete` | Queue item deleted |
| `config.update` | Security/integration/reporting settings changed |

### Audit entry fields

| Field | Description |
|-------|-------------|
| **Timestamp** | When the action occurred |
| **Admin** | Who performed the action, or the creator of an API key when available |
| **Action** | What action was taken |
| **Target** | What was affected |
| **Details** | Additional information (JSON) |
| **IP Address** | Client IP address |

### Filtering

Filter audit entries by:
- **Date range**: Start and end dates
- **Admin**: Specific admin email
- **Action**: Specific action type

### Retention

Audit log entries can optionally be pruned. Set **Audit log retention
(days)** in **Administration -> Security** to a positive number (up to 3650)
to permanently delete entries older than that window; the default of `0`
keeps entries indefinitely, preserving the original behavior. Cleanup runs on
demand via the **Cleanup old audit log entries** button, mirroring raw report
retention.

> **Gotcha**: Audit entries include IP addresses. Configure trusted proxy CIDRs in **Administration -> Security** if Robin Admin should trust `X-Forwarded-For` from a reverse proxy.

---

## Settings pages

Configure Robin Admin behavior (requires Admin role).

### Available settings

| Setting | Description |
|---------|-------------|
| **Idle timeout** | How long an inactive browser session remains valid |
| **Absolute lifetime** | Maximum browser session age |
| **Persistent brute-force protection** | Enables PostgreSQL-backed failed-login tracking |
| **Attempts per account / IP** | Lockout thresholds |
| **Lockout duration** | How long login attempts are blocked |
| **CSRF protection** | Requires CSRF tokens for browser write requests |
| **Global IP allowlist** | CIDRs allowed to access the API |
| **Administrator CIDR restrictions** | Optional per-admin CIDRs that add further limits on top of the global allowlist |
| **Trusted proxy CIDRs** | Proxies whose forwarded client IP headers can be trusted |
| **Allowed CORS origins** | Browser origins accepted in production |
| **Report ingestion authentication** | Requires a shared secret or `reports:ingest` API key outside trusted CIDRs |
| **Trusted ingestion source CIDRs** | CIDRs allowed to submit report evidence directly |
| **Shared ingestion secret** | Secret accepted via `X-Robin-Admin-Ingest-Secret` |
| **IP jail** | Blocks IP/CIDR ranges from all API traffic (timed or infinite) |
| **API key max lifetime** | Maximum expiration window for newly created keys |
| **Private fleet service URLs** | Allows or blocks private/loopback service URLs |
| **Robin config-store table** | Compatible table used for Robin shared and per-instance configuration |
| **Fleet operations** | Metrics polling, metrics retention, and service log line limits |
| **Agent deployment artifacts** | Agent image, installer, release asset, and deployment guide URLs used by Fleet enrollment snippets |
| **Module runtime** | Read-only module installer, catalog authority, signing, and proxy-secret status |
| **Reporting posture checks** | Optional MTA-STS, TLS-RPT, DANE, and BIMI advisories |
| **Reporting intelligence** | Default reporting windows, stale thresholds, debounce, how many analyses run at once (4 by default, so a burst of reports cannot take every database connection), and detection policy thresholds |
| **DNS enrichment** | Resolver, timeout, concurrency, and TTL settings for sender and source enrichment |
| **Raw report retention** | Raw DMARC, TLS-RPT, and forensic report cleanup window with usage counts |
| **Audit log retention** | Audit trail cleanup window; `0` (default) keeps entries indefinitely |
| **Avatar defaults** | Gravatar and fallback avatar behavior |

Runtime and secret-bearing settings are split deliberately. Values that can be
changed safely at runtime are persisted in `admin_config`; environment-owned
settings, passwords, signing state, and secret names are shown as read-only
status without exposing secret values.

### API keys (Access)

API keys are intended for automations and scripts.

- Created keys are shown once and then stored only as hashes
- Each key has a role ceiling: viewer, editor, or admin
- Each key has explicit scopes
- Keys can expire
- Keys can be restricted to CIDRs
- Last-used timestamp and IP are recorded

Use API keys with:

```text
Authorization: Bearer <api-key>
```

### Report ingestion

These controls live in **Administration -> Reporting -> Report ingestion**.

Trusted ingestion CIDRs can submit reports directly, but the list is empty by
default — no source is trusted until an operator adds one. A common opt-in for
co-located deployments is localhost and common local/container networks:

```text
127.0.0.0/8
::1/128
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
fc00::/7
```

Report bots not on that list can authenticate in either of these ways:

```text
Authorization: Bearer <api-key-with-reports:ingest>
```

or:

```text
X-Robin-Admin-Ingest-Secret: <shared-secret>
```

Ingestion can also be limited to specific CIDRs.

### IP jail (Security)

IP jail entries are enforced before authentication and apply to all `/api` routes.

- Supports single IP or CIDR entries
- Supports timed expiry or infinite jail (`expires_at = null`)
- Lifting a jail entry restores access immediately
- Jailed entries override other allowlists, including trusted ingestion CIDRs

---

## Rspamd administration

Rspamd is managed under **Fleet -> Rspamd** when:

- the configured controller is reachable
- the configured `local.d` mount is readable
- the configured store mount is readable

The cross-cutting control-plane settings live in **Administration -> Integrations**:

- show or hide Mailboxes, Fleet, Monitoring, Telemetry, and Modules from the **Capabilities** tab without deleting data; disabling Mailboxes also blocks its APIs
- configure shared avatar defaults
- select the Robin config-store table (persisted setting, then `ROBIN_CONFIG_TABLE`, then `robin_config_store`)

The Robin config-store table name is a single unqualified PostgreSQL identifier
with at most 63 characters. It must already expose `server_id`, `file_name`,
`payload_json`, `updated_epoch`, and `sha256`, with a unique key on
`(server_id, file_name)`. Saving a compatible table name takes effect
immediately for Robin config CRUD, dashboard readiness checks, and Fleet agent
sync; it does not create or migrate data and does not control Fleet navigation.
Robin itself must already be configured to use the same table.

Endpoints, credentials, managed files, and health for Robin, Rspamd, ClamAV,
Dovecot, Postfix, Redis, and PostgreSQL live in **Fleet -> Services** and the
corresponding service workspaces.

### Config

The **Fleet -> Rspamd -> Config** page manages:

- native `dkim_signing.conf`
- native `classifier-bayes.conf`
- per-file ownership for DKIM and Bayes config separately
- DKIM signing policy
- Bayes/autolearn policy

Unmanaged files appear as disabled policy sections until management is enabled for that file. Read-only mounts keep the Rspamd pages visible but block mutating actions.

Every fleet-service **Config** page (Rspamd, Dovecot, Postfix, ClamAV, Redis,
Postgres) uses the same per-instance override model:

- a **Scope** selector — `Default (base)` plus each instance of that type;
- **Save** writes the current scope (the base stores full values; an instance
  stores only the fields that differ from the base);
- **Save As** creates an override for a new instance id;
- **Diff** (on a non-`default` scope) shows the instance's overrides vs the base;
- **Reset to base** drops the current file's override so the instance re-inherits
  the base.

See [fleet.md](fleet.md#per-instance-config-overrides) for the full model.

### Rules

The **Fleet -> Rspamd -> Rules** page manages:

- `actions.conf`
- `groups.conf`
- `settings.conf`
- `composites.conf`
- `multimap.conf`
- managed local multimap backing files under `maps/*.map`

The editor is structured rather than raw-UCL based:

- common documented fields use first-class inputs
- the broader documented surface is exposed through typed advanced property rows
- preview runs server-side validation and renderer output before save

Management can be enabled or disabled per rule family. Disabling a family stops Robin Admin from owning that generated file.

### DKIM keys

The **Fleet -> Rspamd -> DKIM Keys** page manages:

- signing domains
- active and retired selectors
- date-based selector generation (`20260504`, `20260504a`, ...)
- manual rotate-now actions
- optional automatic rotation
- DNS TXT publication values
- retention and purge state for retired private keys

Private keys stay on disk in the mounted Rspamd store. PostgreSQL stores selector metadata and public key material.

### Training

The **Fleet -> Rspamd -> Scan** page is the experimentation surface for outbound abuse control. It supports:

- raw RFC822 paste or `.eml` upload
- `checkv2` and `checkv3`
- outbound metadata such as envelope sender, recipients, source IP, HELO, authenticated user, and `settings_id`
- persisted scan history with raw message retention under the managed Rspamd store path
- replay, learn spam/ham, and fuzzy add/remove actions directly from stored runs

The **Fleet -> Rspamd -> Training** page stores a managed corpus and learns
through the controller API. It also exposes an optional classifier override so
stored samples can be relearned against a specific classifier when needed.

Supported uploads:

- `.eml`
- `.mbox`
- `.zip`
- `.tar`
- `.tar.gz`
- `.tgz`

Each extracted message is:

1. stored in the managed training directory
2. indexed in PostgreSQL
3. learned as spam or ham through the controller

Stored samples can be relearned, relabeled, and deleted later.

The corpus list supports:

- search by filename or hash
- label filter
- learn-status filter
- server-side pagination

---

## Delivery test

Submit test messages through Robin MTA from **Fleet -> Robin -> Delivery Test**.

### Fields

| Field | Description |
|-------|-------------|
| **From** | Sender email address |
| **To** | Recipient email address |
| **Subject** | Email subject line |
| **Body** | Email body (plain text) |

### Default values

Form fields are pre-populated from Robin's client configuration:
- From address from `client.json5` mail settings
- To address from test recipient settings

### Submitting a test

1. Fill in or modify the form fields
2. Click "Send Email"
3. Email is submitted to Robin's queue API
4. Success/error message is displayed

### Use cases

- Test outbound email delivery
- Verify DKIM signing is working
- Test recipient addresses
- Debug delivery issues

> **Gotcha**: Emails are queued through Robin's API, not sent immediately. Check the Queue page to monitor delivery.

---

## Profile

Personal settings for the logged-in admin.

### Available actions

- **View account info**: Email and role
- **Change password**: Update login password

### Password change

1. Enter current password
2. Enter new password (min 8 characters)
3. Confirm new password
4. Click "Change Password"

Password changes are logged in the audit log.
