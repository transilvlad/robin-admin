# Robin module protocol 1.0

Robin Admin accepts only catalogs matching `contracts/catalog-v1.schema.json`.
Production catalogs must be signed by a key certified by the catalogue authority's offline
root. Configure the pinned PEM using the settings in [Configuration](configuration.md#modules) (literal `\n`
separators are accepted in environment files). Unsigned catalogs, uncertified
online keys, and unknown schema versions fail closed.

The catalogue contains only published and deprecated modules. Drafts
are absent from both public catalogue endpoints. Local bootstrap configuration
records installed runtimes, including private operator modules; it never creates
catalogue entries. A stored license alone does not make a module appear in the
module list. Installed runtimes remain visible when removed from the catalogue,
and paid runtimes still require a valid lease.

Public catalogue sync refreshes installation presentation snapshots, including
images. For entitled paid installations, the signed activation/renewal response
contains `data.release` with the same canonical fields as a catalogue module;
only this authenticated response can include `status: draft`. Admin verifies the
response signature and instance-bound lease before accepting that release. It
updates the existing installation's release cache, never the public catalogue,
installed version, runtime endpoints or ownership. An older public snapshot or a
failed/malformed refresh cannot replace this cache. Bootstrap refresh preserves
it and cannot take ownership of an installer-managed runtime.

Manual catalogue sync also renews installed paid entitlements to discover private
updates. Automatic discovery follows license renewal; it is not a live GitHub tag
lookup. Failed release refresh retains the last known release, so a successful
renewal alone is not proof that the cached release is current. A valid license
remains valid if its separately validated release metadata is malformed.

Publishers are explicitly approved as `first-party` or `third-party`. Approval
identifies ownership and support responsibility; it does not grant a publisher
permission to supply Docker commands, mounts, networks, container names, host
paths, environment values, or secrets.

Catalog delivery metadata contains only repository aliases, immutable digests,
platforms, and whether delivery is available. The host installer resolves these
identifiers through its separately maintained approved-module policy.

Free public modules use `public-ghcr`. Licensed modules use authenticated proxy delivery;
the delivery authority maps the public alias to a publisher-owned private repository without
revealing the upstream repository or credential.

The configured base URL selects the catalogue/licensing server,
with a pinned public key for its signing root. Admin never switches
authorities when that server is unavailable. Cached license records retain
their authority URL; changing it requires explicit reactivation.

Paid leases bind to the deployment's current instance fingerprint and key,
last at most 24 hours, and include up to 72 hours of signed offline grace,
capped at license expiry. Access decisions use signed times, not mutable cache
dates. Explicit refresh rejection disables runtime and delivery access
immediately; only transient failures allow offline grace. Automatic renewal
starts halfway through the lease, with a one-minute failure retry backoff.
`POST /api/modules/:slug/refresh-license` performs immediate admin-only renewal.
`lastValidatedAt` records successful validation, not failed attempts.

A license key is returned once when issued. Each license has an explicit seat count; active instance fingerprints
consume those seats. "Used here" compares an activation with the caller's
stable fingerprint, not runtime presence. Revoking an activation frees its seat.
An installed draft module remains usable with a valid lease even though it is
absent from the signed public catalogue.

Installer actions are advertised only when the authenticated host capability
endpoint is reachable, in Docker mode, and approves the module. Capability reads
are shared and cached for five seconds, with a 1.5-second request deadline.
Compose/bootstrap runtimes are managed by their owning deployment, not these
controls. Install/upgrade additionally require an approved release version;
start/stop/uninstall require installer ownership and matching Docker labels.
Lifecycle management of older installed versions uses approved canonical container
names, not permission to pull an old image. If those names change, retain the old
version's policy until its containers are explicitly migrated. Uninstall keeps
data volumes but removes the installed runtime entry. A hidden draft must be
provisioned explicitly again (or published) to reinstall it after uninstall.

Private image pulls recheck live license status, expiry, activation and seat
entitlement on token exchange and every proxied request. Grants are pull-only,
repository-scoped and live for at most five minutes, never beyond the lease or
license expiry at issue time. After a seat reduction, the earliest activations
(creation time, then ID) retain entitlement. Already redirected CDN downloads
cannot be recalled; revocation prevents subsequent proxy requests.

Module frontends execute in Robin Admin's browser origin. Only reviewed modules
should be approved until a separately isolated third-party frontend model exists.

## Administrator identity

Each administrator has a database-generated, immutable UUID `uid`. Integer `id`
values remain the primary keys for existing APIs and foreign keys, but must not
identify people in new module grants. Existing accounts receive UUIDs once on
schema initialization. Login, `/api/auth/me`, profile and admin responses include
`uid`; hosted module frontends receive it in the `currentAdmin` prop.

Authenticated session calls to module backends include `x-robin-admin-uid` beside
the existing `x-robin-admin-id`, role, email and name headers. These values are
constructed by Admin, never forwarded from client-supplied identity headers.
Identity headers are attribution only. Backends must verify both their module
proxy credential and the request-bound signed assertion below; the frontend prop
and unsigned headers are not authorization credentials.

API-key calls omit `x-robin-admin-uid`, including when the key has a creator. Keys
have independent roles/scopes; creator attribution is not delegated access to that
person's grants. Existing integer attribution headers remain unchanged. A module
requiring per-user grants must reject missing UUIDs rather than falling back to
the integer ID or email. User-delegated/service-principal grants are not provided
by this change.

Sessions bind both ID and UUID; missing or mismatched UUIDs require login again.
Deployment therefore expires existing UUID-less browser sessions once. Profile
and account edits cannot change UUIDs. Backups/restores preserve them; deleting
and recreating an account generates a new identity, even if its ID/email is reused.
Cloning a database intentionally clones identities and is not identity isolation.
Restoring a pre-UUID backup cannot recover UUID-based grants without an explicit
mapping. Modules must deliberately verify any existing integer-grant migration;
Admin never automatically converts grants. Future SSO requires a separate mapping
from the provider's issuer/subject to this local UUID, not automatic email matching.

## Signed module identity

Every authenticated backend request carries `x-robin-module-identity`, a compact
Ed25519 JWS/JWT. Its protected header is `alg: EdDSA`,
`typ: robin-module-identity+jwt`, and a pinned `kid`. The assertion is minted
server-side for each request, expires after 30 seconds, and contains no tenant
data. Modules must reject missing/invalid assertions; there is no unsigned fallback.

Claims:
- `iss`: persistent identity-signing authority of this Admin deployment.
- `aud`: exactly one module slug, not a multi-audience array.
- `principal`: `admin` or `api-key`. For admins, `sub` is their immutable UUID.
  For API keys, `sub` is `api-key:<key id>`; it is not an administrator UUID.
- `adminId`, `name`, `email`, `role`: signed attribution/current host role.
  API-key creator IDs remain attribution only. Never infer a user's grants from
  an API-key assertion. Host roles do not imply customer/tenant membership.
- `iat`, `exp`, `issuedAtMs`: issuance/expiry and millisecond issuance time.
- `jti`: random UUID, consumed atomically once by the target backend.
- `method`, `target`: uppercase method and actual backend path including query,
  after Admin's URL construction/normalization, before Express router rewriting.
- `digest`: base64url SHA-256 of the exact forwarded body bytes; empty for GET/HEAD.
- `headersDigest`: base64url SHA-256 of UTF-8 compact JSON of ordered
  `[header-name, value]` pairs for `content-type`, `if-match`,
  `if-modified-since`, `if-none-match`, `if-unmodified-since`, `range`,
  `x-robin-instance-fingerprint`. Missing values are empty strings.

The reference verifier is `server/src/services/module-identity-protocol.ts`.
Module backends must implement the same protocol and pass its conformance
tests. Use a JOSE library; never implement signature algorithms yourself. Capture
raw body bytes with Express parser `verify` before parsing, and pass
`req.originalUrl`, method and bound headers to the verifier. Authorization must
use the verified result, not `x-robin-admin-*` headers. Do not log assertions.

Pin public trust through an operator-controlled read-only file
(`ROBIN_ADMIN_IDENTITY_TRUST_FILE`) or explicit `ROBIN_ADMIN_IDENTITY_TRUST_JSON`.
Never load keys from token-supplied URLs. Admin stores its dedicated identity key
encrypted in `admin_config`; it does not reuse catalogue or license-signing keys.
`MODULE_IDENTITY_TRUST_EXPORT_FILE` publishes only the issuer/public JWK set.
Bundled deployments mount this public directory writable only by Admin and
read-only in module backends. Fresh-install projects have separate public volumes.
Administration -> Integrations -> Modules can download the public trust document.

Back up the Admin database and `ROBIN_ADMIN_ENCRYPTION_KEY` together. Public trust
can be regenerated from that recovered encrypted state; never silently regenerate
a corrupt or undecryptable stored key. The encrypted `admin_config` value
`moduleIdentitySigningKey` uses the existing AES-256-GCM stored-secret envelope.
Its decrypted v2 JSON contains the stable `issuer`, `active`, optional `pending`
and `retiring` signing-key records, a frozen `affectedModules` list, and
per-module readiness acknowledgements bound to a key ID and SHA-256 fingerprint
of the exact public trust set. Legacy `{issuer,kid,privateKey}` records are
migrated in place without changing their issuer or key. Private keys remain
encrypted in the database and are never returned by the rotation API or included
in public trust.

Administration -> Security -> Module identity provides the staged rotation
workflow. Preparing publishes the active and pending public keys together.
Configured module backends must load that exact trust set and be explicitly
acknowledged with operator evidence before activation. Activation changes only
the signing key; the issuer stays stable and both verification pins remain
published. The signer and activation transition use shared/exclusive PostgreSQL
advisory locks so in-flight old-key signatures finish before the retention timer
starts. A retiring key remains published for at least six minutes: the verifier
accepts assertion lifetimes up to 60 seconds, plus a documented five-minute
safety margin.

After retention expires, an administrator prepares retirement, which republishes
the trust set without the old key. Each affected backend must load that exact
active-only set and be explicitly acknowledged before the old encrypted key is
finally removed. If the configured backend set changes during preparation, the
transition is blocked until readiness is repeated against the new set. Cancel is
available only before activation. Rollback is available while the old key remains
published and starts a fresh retention interval for the key being rolled back;
it is blocked once retirement trust has been published. No installer lifecycle
operation is treated as proof of trust readiness: the workflow requires explicit
operator evidence for each configured backend.

The trust export (`MODULE_IDENTITY_TRUST_EXPORT_FILE`; bundled compose defaults
to `/app/module-identity/trust.json`) is atomically written at startup and after
each rotation transition. Backends using the reference verifier cache the pinned JWK set when
their verifier is first initialized in each process. A trust-file update alone
does not refresh these caches: restart each affected backend after both the
overlapping and active-only trust document changes. The process restart also
resets its bounded replay cache; assertions minted before startup remain rejected.

The reference replay cache supports one backend process per module/deployment,
up to 50,000 unexpired assertions. It rejects tokens issued before process startup,
so restart does not reopen the replay window. Clocks must be synchronized; no
expiry leeway is granted. Multi-replica backends must use shared atomic replay
storage instead of independent caches. Retries need a fresh assertion; signatures
do not provide business-operation idempotency.

Signing prevents a leaked proxy secret from forging user identities. It does not
protect against a compromised Admin signer, malicious same-origin module frontend,
or a compromised target backend. Network isolation/TLS remain necessary. An
already minted assertion is not instantly revoked when an account is disabled:
new host requests fail, but an outstanding assertion can survive until expiry.

## Module account directory and lifecycle

Module backends may call these read-only host endpoints using their own
`x-robin-module-secret`, never a forwarded browser cookie or broad host API key:

- `GET /api/module-host/:slug/admins?limit=100&after=<uid>&search=<text>`
- `GET /api/module-host/:slug/admins/:uid`
- `GET /api/module-host/:slug/events?after=<revision>&limit=100`

The module must be installed/entitled and Modules enabled. Directory and lifecycle
capabilities default off, are approved independently in Administration ->
Integrations -> Modules, and are audited. Responses use `Cache-Control: no-store`.
The directory returns only `uid, name, email, role, disabled`; a missing UUID
lookup returns 404. Limits are 1-200; directory search is bounded to 200 characters.
The existing `/api/admins` remains host-admin-only for frontend account management.
Directory-read approval does not grant membership-management privileges.

Events have `revision` (decimal string), `uid`, `kind` (`created`, `updated`,
`deleted`), `disabled`, and `createdAt`. Revisions are committed in order by a
transactional database trigger, including profile edits. Password/login/CIDR-only
changes do not emit directory events. Events contain no email or credentials.
Modules persist `nextCursor` only after applying each batch, tolerate redelivery,
and fetch current records when needed. Retain the decimal cursor as a string,
not a JavaScript number. The feed is retained indefinitely and is backup-covered.

For initial synchronization, consume events from zero, enumerate the current
directory, then catch up the feed from the saved cursor. Paginated listings are
not point-in-time snapshots; periodically reconcile known UUIDs by lookup.
Disable suspends access, not memberships; deletion marks grants orphaned rather
than silently transferring them or destroying audit history. Grant cleanup is a
module responsibility. Events are not an authorization/revocation guarantee.
Database rollback/old backup restoration also requires reconciliation and cursor
reset if the restored feed precedes the saved cursor.

## Module upload policy

Each configured module has saved maximum-body and backend-timeout policies under
Administration -> Integrations -> Modules: default 5 MiB / 30 seconds, adjustable
within 1-64 MiB / 5-120 seconds. Changes apply to subsequent requests. General
`BODY_LIMIT` and frontend proxy defaults do not override these module bounds.

Admin authenticates module requests before the bounded body parser. JSON,
`application/*+json`, text (including CSV/zone files), octet-stream, DNS,
CSV and multipart bodies preserve their exact bytes/content type through the
proxy. Unsupported media types and compressed uploads return 415; oversized
requests return 413, including chunked requests. Redirects are not followed.
Bodyless control requests remain supported.

Forwarding multipart bytes does not parse/store files: the module must implement
its own bounded parser, filename/type validation, row/record limits and import
authorization. Backend limits and infrastructure request deadlines may be lower
than the host policy. Bodies are bounded but buffered for signing, not unlimited
streaming uploads. Large imports should create asynchronous jobs with progress,
idempotency and a separate execution deadline; assertion expiry limits acceptance,
not the duration of an already authorized job.
