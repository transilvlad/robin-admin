import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const seconds = Number(process.env.LOAD_SECONDS ?? 300);
const agents = Number(process.env.LOAD_AGENTS ?? 3);
assert.ok(Number.isInteger(seconds) && seconds >= 60 && seconds <= 7200);
assert.ok(Number.isInteger(agents) && agents >= 2 && agents <= 8);
const receipt = value => console.log(JSON.stringify(value));
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `Docker ${args[0]} failed; arguments and backend output withheld`);
  return result.stdout;
};

if (process.argv[2] !== 'container') {
  const id = randomUUID();
  const network = `robin-test-load-${id}`;
  const pg = `${network}-pg`, vm = `${network}-vm`, app = `${network}-app`;
  const owned = [];
  let networkCreated = false, child;
  const port = Number(process.env.LOAD_PORT ?? 3568);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65000);
  Object.assign(process.env, { POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
    DB_HOST: pg, DB_PORT: '5432', DB_USER: 'test', DB_NAME: `robin_test_load_${id.replaceAll('-', '')}`,
    SESSION_SECRET: randomBytes(48).toString('base64url'), ROBIN_ADMIN_ENCRYPTION_KEY: randomBytes(32).toString('base64url') });
  process.env.DB_PASSWORD = process.env.POSTGRES_PASSWORD;
  let cookie = '', csrf = '';
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify(body) });
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const result = await response.json();
    assert.ok(response.ok, `Setup HTTP ${response.status}; response withheld`);
    return result.data;
  };
  try {
    docker('network', 'create', '--label', `robin.test.load=${id}`, network); networkCreated = true;
    docker('run', '-d', '--name', pg, '--label', `robin.test.load=${id}`, '--network', network,
      '-e', 'POSTGRES_USER=test', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=postgres',
      '--tmpfs', '/var/lib/postgresql:rw,size=2g', 'postgres:18-alpine'); owned.push(pg);
    docker('run', '-d', '--name', vm, '--label', `robin.test.load=${id}`, '--network', network,
      '--network-alias', 'robin-admin-victoriametrics', '--memory', '256m', '--cpus', '0.5', '--read-only',
      '--tmpfs', '/storage:rw,size=128m', 'victoriametrics/victoria-metrics:v1.153.0', '-storageDataPath=/storage',
      '-retentionPeriod=1d', '-memory.allowedBytes=128MB'); owned.push(vm);
    for (let n = 0; n < 60; n++) {
      if (spawnSync('docker', ['exec', pg, 'pg_isready', '-U', 'test'], { stdio: 'ignore' }).status === 0) break;
      assert.ok(n < 59, 'Fixture PostgreSQL did not become ready'); await delay(500);
    }
    docker('exec', pg, 'createdb', '-U', 'test', process.env.DB_NAME);
    const args = ['run', '--name', app, '--label', `robin.test.load=${id}`, '--network', network,
      '-p', `127.0.0.1:${port}:3001`, '--memory', '1g', '--cpus', '1.5', '--read-only',
      '--tmpfs', '/tmp:rw,mode=1777,size=32m', '--tmpfs', '/app/logs:rw,uid=1000,gid=1000,mode=0700,size=8m',
      '--mount', `type=bind,source=${fileURLToPath(import.meta.url)},target=/app/combined-load.mjs,readonly`];
    for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'SESSION_SECRET', 'ROBIN_ADMIN_ENCRYPTION_KEY']) args.push('-e', key);
    args.push('-e', `LOAD_SECONDS=${seconds}`, '-e', `LOAD_AGENTS=${agents}`, process.env.LOAD_ADMIN_IMAGE ?? 'robin-admin-server', 'node', '/app/combined-load.mjs', 'container');
    child = spawn('docker', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); owned.push(app);
    let setupReady = false, outputBuffer = '';
    child.stdout.on('data', value => {
      process.stdout.write(value);
      outputBuffer += value.toString();
      const lines = outputBuffer.split('\n'); outputBuffer = lines.pop();
      for (const line of lines) {
        try { if (JSON.parse(line).event === 'combined-load-setup-ready') setupReady = true; } catch { /* Non-receipt output is not readiness. */ }
      }
    });
    child.stderr.on('data', () => {});
    let exitCode;
    const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => { exitCode = code; resolve(code); }); });
    for (let n = 0; n < 180; n++) {
      assert.equal(exitCode, undefined, 'Load fixture exited before setup');
      try { if (setupReady && (await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      assert.ok(n < 179, 'Load fixture startup timed out'); await delay(500);
    }
    const login = await request('/api/auth/login', { email: 'load@example.test', password: 'Disposable-load-fixture-only-20261003!' }); csrf = login.csrfToken;
    for (let n = 0; n < agents; n++) {
      const created = await request('/api/fleet/agents', { name: `Load agent ${n}` });
      await request('/api/fleet/services', { serviceId: `load-postfix-${n}`, serviceType: 'postfix', name: `Load Postfix ${n}`, apiUrl: 'http://127.0.0.1:39999' });
      await request(`/api/fleet/agents/${created.agent.agentId}/services`, { serviceId: `load-postfix-${n}` });
      const name = `${network}-agent-${n}`;
      const env = { ...process.env, ROBIN_AGENT_ID: created.agent.agentId, ROBIN_ENROLLMENT_TOKEN: created.enrollment.token };
      const result = spawnSync('docker', ['run', '-d', '--name', name, '--label', `robin.test.load=${id}`, '--network', network,
        '--mount', `type=bind,source=${fileURLToPath(new URL('./fixtures/reliability-postqueue.sh', import.meta.url))},target=/usr/local/bin/postqueue,readonly`,
        '-e', `ROBIN_ADMIN_URL=http://${app}:3001`, '-e', 'ROBIN_AGENT_ID', '-e', 'ROBIN_ENROLLMENT_TOKEN', process.env.RELIABILITY_AGENT_IMAGE ?? 'robin-agent:reliability'], { env, encoding: 'utf8', timeout: 60000 });
      assert.equal(result.status, 0, 'Load agent start failed; credentials withheld'); owned.push(name);
    }
    const timer = setTimeout(() => { docker('stop', '-t', '10', app); }, (seconds + 180) * 1000);
    try { assert.equal(await exited, 0, 'Combined load failed'); } finally { clearTimeout(timer); }
    for (const name of owned) {
      const state = JSON.parse(docker('inspect', name))[0];
      assert.equal(state.State.OOMKilled, false, 'A load container was OOM-killed');
      assert.equal(state.RestartCount, 0, 'A load container restarted');
    }
    receipt({ event: 'isolated-load-verified', agents, seconds, restarts: 0, oomKilled: false });
  } finally {
    for (const name of owned.reverse()) {
      const inspect = spawnSync('docker', ['inspect', name], { encoding: 'utf8' });
      if (inspect.status === 0 && JSON.parse(inspect.stdout)[0].Config.Labels['robin.test.load'] === id) docker('rm', '-f', name);
    }
    if (child && child.exitCode === null) await new Promise(resolve => child.once('close', resolve));
    if (networkCreated) docker('network', 'rm', network);
  }
} else {
  assert.match(process.env.DB_NAME, /^robin_test_load_[a-f0-9]{32}$/);
  assert.match(process.env.DB_HOST, /^robin-test-load-[a-f0-9-]+-pg$/);
  Object.assign(process.env, { NODE_ENV: 'development', PORT: '3001', HOST: '0.0.0.0', COOKIE_SECURE: 'false',
    ROBIN_API_ENABLED: 'false', SHERIFF_BASE_URL: 'http://unavailable.invalid', SETUP_ID_FILE: '/tmp/load-setup-id',
    STATIC_TEST_USERS: 'false', LOG_LEVEL: 'error', RATE_LIMIT_MAX_REQUESTS: '100000' });
  const { initializeSchema } = await import('file:///app/dist/db/schema.js');
  const { query, closePool } = await import('file:///app/dist/db/connection.js');
  const { updateConfig, cleanupOldReportingReports } = await import('file:///app/dist/db/queries/config.js');
  const { createApiKey } = await import('file:///app/dist/db/queries/security.js');
  const { getStoreConnection, saveStoreConnection } = await import('file:///app/dist/services/telemetry/connection.js');
  const { insertReport } = await import('file:///app/dist/db/queries/dmarc.js');
  let server, stop = false;
  const latency = new Map(), resources = [];
  let key, cookie = '';
  const request = async (kind, path, body, contentType = 'application/json', method) => {
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:3001${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), signal: AbortSignal.timeout(45000),
      headers: { ...(kind === 'fleet-queue' ? {} : { authorization: `Bearer ${key}` }), cookie, 'content-type': contentType }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const data = response.status === 204 ? null : await response.json();
    assert.ok(response.ok, `${kind} HTTP ${response.status}; response withheld`);
    const times = latency.get(kind) ?? []; times.push(performance.now() - start); latency.set(kind, times);
    return data;
  };
  try {
    await initializeSchema();
    await updateConfig({ telemetryEnabled: true, reportingIntegrationEnabled: true, fleetEnabled: true, allowPrivateServiceUrls: true,
      reportingMtaStsChecksEnabled: false, reportingTlsrptChecksEnabled: false, reportingDaneChecksEnabled: false, reportingBimiChecksEnabled: false });
    await saveStoreConnection({ ...await getStoreConnection(), mode: 'managed' });
    await query(`INSERT INTO dmarc_rollup_source_daily(day,domain,source_ip,total_volume,compliant_volume,fully_aligned_volume,dkim_pass_volume,spf_pass_volume)
      SELECT CURRENT_DATE-day.n,'load-'||(ip.n%200)||'.example.test',host('10.0.0.0'::inet+ip.n),10,10,10,10,10
      FROM generate_series(1,100000) ip(n),generate_series(0,2) day(n)`);
    await query(`INSERT INTO dmarc_rollup_daily(day,domain,org_name,total_volume,compliant_volume,fully_aligned_volume)
      SELECT day,domain,'fixture',sum(total_volume),sum(compliant_volume),sum(fully_aligned_volume) FROM dmarc_rollup_source_daily GROUP BY day,domain`);
    await query(`INSERT INTO source_identity(ip,provider,provider_via)
      SELECT host('10.0.0.0'::inet+n),'Dense fixture '||n,'cidr' FROM generate_series(1,10000) n`);
    await query('ANALYZE dmarc_rollup_source_daily');
    key = (await createApiKey({ name: 'Disposable combined load', role: 'admin', scopes: ['reporting:read', 'reports:ingest', 'telemetry:read', 'telemetry:write', 'telemetry:manage'],
      allowedCidrs: ['127.0.0.1/32'], createdBy: null, expiresAt: new Date(Date.now() + (seconds + 300) * 1000) })).plainText;
    server = spawn(process.execPath, ['dist/index.js'], { cwd: '/app', env: process.env, stdio: ['ignore', 'ignore', 'ignore'] });
    const wait = async (fn, timeout = 60000) => { const end = Date.now() + timeout; while (!await fn()) { assert.ok(Date.now() < end && server.exitCode === null, 'Load fixture condition timed out'); await delay(500); } };
    await wait(async () => { try { return (await fetch('http://127.0.0.1:3001/health/ready')).ok; } catch { return false; } });
    await request('setup', '/api/setup', { email: 'load@example.test', password: 'Disposable-load-fixture-only-20261003!', name: 'Load fixture', setupId: (await readFile('/tmp/load-setup-id', 'utf8')).trim() });
    await request('login', '/api/auth/login', { email: 'load@example.test', password: 'Disposable-load-fixture-only-20261003!' });
    receipt({ event: 'combined-load-setup-ready' });
    await wait(async () => Number((await query("SELECT count(*) FROM fleet_agents WHERE enrolled_at IS NOT NULL AND services_json::text LIKE '%postfix.queue.list%'")).rows[0].count) === agents);
    const started = Date.now(), end = started + seconds * 1000;
    let ingests = 0, writes = 0, batches = 0, queues = 0, retentions = 0;
    const until = async (fn, pause) => { while (!stop && Date.now() < end) { await fn(); await delay(pause); } };
    receipt({ event: 'combined-load-start', seconds, agents, addresses: 100000, denseIdentities: 10000, reportingReaders: 8, telemetryHosts: 80, telemetrySeries: 800 });
    const tasks = [
      until(async () => {
        await Promise.all(Array.from({ length: 8 }, async (_, n) => {
          const data = await request('sources', `/api/reporting/sources?days=${7 + (batches % 8) + n}&limit=50`);
          assert.ok(data.pagination.total >= 10000);
          assert.equal(data.data.length, 50);
          assert.equal(data.meta.buckets.all, Object.entries(data.meta.buckets).filter(([bucket]) => bucket !== 'all').reduce((sum, [, count]) => sum + count, 0));
        })); batches++;
      }, 1000),
      until(async () => { await Promise.all(Array.from({ length: agents }, async (_, n) => {
        const data = await request('fleet-queue', `/api/postfix/queue?serviceId=load-postfix-${n}`);
        assert.ok(data.success); queues++;
      })); }, 1000),
      until(async () => {
        const epoch = Math.floor(Date.now() / 1000) - 7200;
        await request('report-ingest', '/api/dmarc/reports', { reportId: `load-${ingests}`, orgName: 'fixture', email: 'load@example.test', domain: 'load.example.test',
          dateBegin: epoch, dateEnd: epoch + 3600, policy: 'reject', subdomainPolicy: 'reject', dkimAlignment: 'r', spfAlignment: 'r', pct: '100', totalCount: 3, errorCount: 0,
          records: [{ sourceIp: '198.18.0.1', count: 3, disposition: 'none', dkim: 'pass', spf: 'pass', headerFrom: 'load.example.test' }] }); ingests++;
      }, 5000),
      until(async () => {
        const lines = [], timestamp = Date.now();
        for (let host = 0; host < 80; host++) for (let metric = 0; metric < 10; metric++) lines.push(`load_metric_${metric}{host="load-${host}",role="fixture"} ${host + writes} ${timestamp}`);
        await request('telemetry-write', '/api/telemetry/import', lines.join('\n') + '\n', 'text/plain'); writes++;
      }, 1000),
      until(async () => {
        const now = Math.floor(Date.now() / 1000), params = new URLSearchParams({ start: String(now - 300), end: String(now), step: '5', query: 'load_metric_0' });
        const range = await request('telemetry-range', `/api/telemetry/query_range?${params}`);
        if (range.data.series.length) assert.equal(range.data.series.length, 80);
        await request('telemetry-sources', '/api/telemetry/sources');
      }, 1000),
      until(async () => {
        const reportId = `expired-${retentions}`;
        await insertReport({ reportId, orgName: 'fixture', email: 'load@example.test', domain: 'expired.example.test', dateBegin: 1609459200, dateEnd: 1609462800,
          policy: 'reject', subdomainPolicy: 'reject', dkimAlignment: 'r', spfAlignment: 'r', pct: '100', totalCount: 7, errorCount: 0,
          records: [{ sourceIp: '198.18.0.1', count: 7, disposition: 'none', dkim: 'pass', spf: 'pass' }] });
        await cleanupOldReportingReports();
        assert.equal(Number((await query('SELECT count(*) FROM dmarc_reports WHERE report_id=$1', [reportId])).rows[0].count), 0); retentions++;
      }, 30000),
      until(async () => {
        assert.equal(server.exitCode, null, 'Admin exited during no-restart load');
        const status = await readFile(`/proc/${server.pid}/status`, 'utf8');
        const rssMiB = Number(status.match(/^VmRSS:\s+(\d+)/m)[1]) / 1024;
        const activity = (await query("SELECT count(*) FILTER(WHERE state='active')::int active,count(*) FILTER(WHERE wait_event_type='Lock')::int locks FROM pg_stat_activity WHERE datname=current_database()")).rows[0];
        resources.push({ seconds: (Date.now() - started) / 1000, rssMiB, ...activity });
        if (resources.length % 6 === 0) receipt({ event: 'combined-load-progress', ...resources.at(-1), ingests, writes, queues, batches });
      }, 5000),
    ];
    try { await Promise.all(tasks); } catch (error) { stop = true; await Promise.allSettled(tasks); throw error; }
    const totals = (await query('SELECT (SELECT sum(total_volume) FROM dmarc_rollup_daily)::text daily,(SELECT sum(total_volume) FROM dmarc_rollup_source_daily)::text source')).rows[0];
    assert.equal(totals.daily, String(3000000 + ingests * 3 + retentions * 7)); assert.equal(totals.daily, totals.source);
    const summary = Object.fromEntries([...latency].map(([kind, times]) => { times.sort((a, b) => a - b); return [kind, { requests: times.length, p95Ms: times[Math.ceil(times.length * .95) - 1], maxMs: times.at(-1) }]; }));
    receipt({ event: 'combined-load-complete', seconds: (Date.now() - started) / 1000, ingests, writes, queues, batches, retentions, totalsExact: true,
      peakAdminRssMiB: Math.max(...resources.map(value => value.rssMiB)), firstMinuteRssMiB: resources.filter(value => value.seconds < 60).at(-1)?.rssMiB,
      lastMinuteRssMiB: resources.at(-1)?.rssMiB, maxDbLockWaiters: Math.max(...resources.map(value => value.locks)), summary });
  } catch (error) { receipt({ event: 'combined-load-failed', error: error.message }); throw new Error('Combined load failed; credentials withheld'); }
  finally {
    if (server?.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 10000); await exited; clearTimeout(timer); }
    await closePool();
  }
}
