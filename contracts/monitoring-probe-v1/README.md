# Monitoring probe protocol v1

These language-neutral JSON contracts are shared by robin-admin and
robin-agent. Additive protocol changes require a new compatible contract;
breaking payload or execution semantics require a new protocol version.

- `check.schema.json`: normalized check definition and optional in-memory
  credentials. Secret headers are present only in an authenticated manifest
  response and must never be persisted or logged by an agent.
- `manifest.schema.json`: location-scoped check assignments, revision,
  concurrency limit and per-check deterministic jitter seed.
- `observation.schema.json`: one bounded result sent for an assigned check.
  The receiver supplies its own receipt timestamp and location identity.
- `error-codes.json`: stable identifiers shared across probe engines.
- `cases.json`: executable fixture descriptions and expected result codes.

`manifestRevision` increases whenever the assigned set or any effective check
definition changes. An observation for a removed check, unknown location, or
revision outside the server's acceptance window is rejected.

The v1 conformance suite uses deterministic HTTP, TCP-banner and SMTP-greeting
fixtures. Extend the same case list with DNS, TLS and IMAP fixtures; both
implementations must consume those cases before the protocol version can be
enabled for remote execution.
