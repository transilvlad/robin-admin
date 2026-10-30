# Mailboxes

The Mailboxes section manages email accounts and routing. These tables follow Postfix/Dovecot conventions.

## Enablement and backend

Enable **Mailboxes** in **Administration -> Integrations -> Capabilities**. It is
off on a fresh installation. Enabling it exposes Users, Aliases and Auto Aliases
even when Fleet has no mail services. Disabling it hides the workspace, redirects
its browser routes and blocks mailbox APIs with HTTP 403; existing data is retained.
The switch is persisted and changes are recorded as `config.update` audit events.

Mailboxes uses Robin Admin's configured PostgreSQL database, not a selected Fleet
service or a separate connection. Each tab independently requires its table in
the `public` schema:

| Tab | Table | Required Columns |
|-----|-------|------------------|
| Users | `users` | `id`, `email`, `password` |
| Aliases | `aliases` | `id`, `source`, `destination` |
| Auto Aliases | `auto_aliases` | `id`, `source`, `destination` |
| Domains & send-as | `mail_domains`, `mail_sender_grants` | Suite mail-control migration, plus `users` and `aliases` |

Missing or incompatible tables show a backend-not-configured state rather than
an empty results table. Their APIs return HTTP 503 without running CRUD queries.
Users schema metadata is cached for up to five seconds; use **Check again** after
configuring the backend. Admin does not create or migrate mailbox tables, verify
mail delivery, or support selecting a different mailbox database in this release.
Operators must provide compatible column types, IDs/defaults and constraints.

UID/GID inputs are offered only when those columns exist. Unsupported UID/GID or
extra fields are rejected with HTTP 400 rather than silently ignored. Additional
schema columns are available through the users API's `extra` map, not arbitrary
UI form controls. Extra columns that are required need defaults or explicit API
values. Existing viewer/editor/admin permissions still apply.

## Users

Manage Dovecot mailbox users (virtual email accounts).

### User fields

| Field | Description |
|-------|-------------|
| **Email** | Full email address (e.g., `user@example.com`) |
| **Password** | Hashed password (SHA512-CRYPT format) |
| **UID** | Unix user ID for mailbox ownership (default: 5000) |
| **GID** | Unix group ID for mailbox ownership (default: 5000) |
| **Home** | Home directory path |
| **Maildir** | Maildir path for email storage |

### Creating users

1. Click "Add User"
2. Enter email address
3. Enter password (will be hashed automatically)
4. Customize UID/GID if these fields are supported (defaults: 5000; accepted range: 0-2147483647)
5. Home and Maildir are auto-generated from email when those columns exist

> **Gotcha**: The password is hashed using SHA512-CRYPT format compatible with Dovecot. The hash includes `{SHA512-CRYPT}` prefix.

### Password format

Passwords are stored in Dovecot-compatible format:
```
{SHA512-CRYPT}$6$salt$hash...
```

The salt is randomly generated for each password.

### Maildir structure

Default paths follow this pattern:
- **Home**: `/var/mail/vhosts/example.com/user`
- **Maildir**: `maildir:/var/mail/vhosts/example.com/user`

---

## Aliases

Email aliases redirect mail from one address to another.

### Alias fields

| Field | Description |
|-------|-------------|
| **Source** | The alias address (receives mail) |
| **Destination** | The target address (delivers mail) |

### Use cases

1. **Personal aliases**: `john.smith@example.com` → `jsmith@example.com`
2. **Role aliases**: `support@example.com` → `helpdesk@example.com`
3. **Catchall**: `@example.com` → `admin@example.com`
4. **External forwarding**: `old@example.com` → `new@gmail.com`

### Creating aliases

1. Click "Add Alias"
2. Enter source address (the alias)
3. Enter destination address (where mail goes)
4. Click Save

> **Gotcha**: Aliases are processed before user lookup. If an alias exists for an address, mail goes to the alias destination even if a user with that address exists.

### Catchall aliases

To create a catchall alias (receives all mail for a domain):
- **Source**: `@example.com`
- **Destination**: `admin@example.com`

Legacy catch-all syntax above is backend-specific, not an instruction to enable
it in the managed suite. The suite domain policy below defaults catch-all off.

## Domains and sender identities

The **Domains & send-as** tab requires the explicit suite migration
`.suite/migration/001-mail-domains-and-sender-grants.sql` from the Robin
repository. Rehearse that migration on a restored database and back up first.
It preserves existing domain policy on rerun, rejects mixed-case mailbox
identities rather than silently rewriting them, and backfills explicit primary
grants. Admin never creates these tables simply because a tab was opened.

`mail_domains(domain, enabled, plus_addressing, catch_all)` records canonical
domain policy. Plus addressing and catch-all are off by default. A catch-all
must point directly to an existing local mailbox, not an alias or external
forward. Disabling a domain prevents new grants and denies senders under the
suite sender query; recipient enforcement also requires the suite domain-aware
recipient resolver.

`mail_sender_grants(account, address, grant_type)` records exact normalized
authenticated principals and allowed sender addresses:

| Type | Requirement |
|------|-------------|
| `primary` | Existing account and identical sender address |
| `alias` | Existing account and explicit routing alias source |
| `delegated` | Existing account and existing local sender mailbox |

Routing, group membership and send permission are separate. One row in
`aliases` represents one target; multiple rows for a source form a list.
Neither an alias nor access to a shared network grants permission to send.
Delegated send-as does **not** create an IMAP ACL or permit reading another
mailbox. Shared mailbox access must be provisioned and read back through the
actual mailbox backend.

These are saved database policies, not proof of enforcement. The consuming
Robin instance must enable `senderAuthorization` with the suite query and check
both the envelope and message From. In enforced mode a primary grant is required
too. Creating or renaming an account requires explicitly reviewing its grants;
the migration revokes grants for deleted or renamed mailbox identities, and
revokes an alias grant when its last target is removed. Do not remove these
cleanup triggers or the account/catch-all foreign keys.

Viewers can inspect policies. Changes require the **admin** role (not editor)
and, for API keys, `admin:*`; reads use `users:read`. Browser writes retain the
normal CSRF protection. Changes are audited as `mail_policy.domain_save`,
`mail_policy.sender_grant` and `mail_policy.sender_revoke`.

API endpoints under `/api/mail-policy`: `GET /status`, paginated `GET /domains`
and `GET /grants`, `PUT /domains`, `PUT /grants`, `DELETE /grants`.
Writes accept the table-shaped JSON fields above. Revocation accepts
`{ "account": "owner@example.test", "address": "shared@example.test" }`.
An absent migration returns `available: false` from status and HTTP 503 for
CRUD, never an empty success.

An isolated Docker acceptance test applies the **actual suite migration** and
uses only synthetic mail identities, a uniquely named PostgreSQL container,
ephemeral storage and a random loopback port:

```powershell
.\server\scripts\test-mail-policy-docker.ps1 -MigrationPath ..\robin\.suite\migration\001-mail-domains-and-sender-grants.sql
```

It does not start, stop, rebuild or mount any running suite or Webmail service.
Use a local source build for these endpoints; an older published Admin image
does not acquire them by changing its environment or applying the SQL migration.

---

## Auto aliases

Automatic alias rules that generate aliases dynamically.

### Auto alias fields

| Field | Description |
|-------|-------------|
| **Source** | Pattern to match (e.g., `%@old.com`) |
| **Destination** | Replacement pattern (e.g., `%@new.com`) |

### Pattern syntax

- `%` represents the local part (before @)
- Use for domain-wide redirects or transformations

### Examples

| Source | Destination | Effect |
|--------|-------------|--------|
| `%@old.com` | `%@new.com` | Redirect entire domain |
| `%@sales.example.com` | `%@example.com` | Subdomain to main domain |

### Priority

When resolving an email address, Robin checks in order:
1. Exact alias match
2. User account match
3. Auto alias match

> **Gotcha**: Auto aliases use SQL LIKE patterns. The `%` is a SQL wildcard, not a literal character.

---

## Postfix compatibility

These tables are designed to be compatible with Postfix virtual mailbox maps:

- `users` → `virtual_mailbox_maps`
- `aliases` → `virtual_alias_maps`
- `auto_aliases` → Additional alias processing

The SQL queries in Robin's Dovecot configuration (`dovecot.json5`) query these tables directly.
