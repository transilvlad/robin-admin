# Reliability validation

Run `node scripts/reliability-soak.mjs` from `server` after building the backend
and `docker build -t robin-agent:reliability agent` from the repository root.
Linux, Node 22.23.4+, 24.22.1+ or 26.12.1+, PostgreSQL, Docker and OpenSSL are required. Database
credentials use `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`; the host must be
loopback. The harness creates and drops only its new `robin_test_reliability_*`
database, uses isolated listeners and removes its own agent container. It does
not use installation credentials or execute commands against real MTA services.

`SOAK_MINUTES` is 1..120 (default 5). `SOAK_WORKLOAD=faults` is the default smoke
drill: scheduler/HTTPS/SMTP failures, lost leased command payloads (gateway 503), transient result
delivery failures, agent/Admin restarts and database disconnects.
The fault workload first verifies that stalled execution, inherited output pipes
and output over 4 MiB produce explicit recorded failures before command expiry,
with one execution each. Those preflight checks run before the measured soak.
Run the manual Reliability workflow with `steady` and 60 or 120 minutes for the separate no-restart
Fleet/reporting test. `SOAK_WORKLOAD=steady SOAK_SOURCES=10000` seeds seven days
of rollups with dense resolved identities and one independently displayed group
per address (1000..100000 addresses). Each cycle combines four real queue reads
and four reporting reads with real monitoring transitions and email delivery.
It injects result-delivery retries but no lost command payloads, database disconnects or
Admin/agent restarts. Setup restarts and a successful command-channel warm-up occur before measurement. TLS probe faults
and harmless queue-command failures remain expected observations.

Linux receipts sample server RSS, file descriptors and database connections
every five seconds, verify process/container start continuity, and fail above
the fixture's 1 GiB server RSS safety threshold. That check is not a container
limit or a universal capacity guarantee. Inspect the resource trend and read
latencies, not just the final pass. No-restart tests are bounded observations,
not proof of leak freedom. The fixture does not include telemetry ingest,
external webhooks, real mail queues, arbitrary identity distributions or a
production-sized multi-agent Fleet. Its SQL seeds rollups directly; use the
separate scale/parity tests for raw-report ingestion and aggregation correctness.

JSON receipts go to stdout. On failures, correlated command IDs and lifecycle
metadata are included, without command arguments, output, credentials or URLs.
Raw server logs remain in the private temporary fixture and are removed during
cleanup; do not upload unrestricted logs as CI artifacts. Capture the JSON
receipt stream when retaining evidence. The temporary TLS and runtime secrets
are unique per run and never written to the repository.

Deployment import failures receive one guarded automatic reload per route within
five minutes, preserving its path, query and hash. The guard survives a new
document in tab-local session storage and caps total failing routes at 32 per
cooldown. Repeated failures or unavailable storage retain the manual recovery
screen. Recovery does not bypass certificate errors or fix network/server faults.
