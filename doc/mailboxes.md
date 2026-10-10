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
