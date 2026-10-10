import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFile, readdir, appendFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const db = `robin_test_reliability_${Date.now()}`;
const fixtureDirectory = await mkdtemp(join(tmpdir(), 'robin-reliability-'));
await chmod(fixtureDirectory, 0o700);
const fixtureFile = name => join(fixtureDirectory, name);
const postgres = { host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USER ?? 'test', password: process.env.DB_PASSWORD ?? 'test' };
assert.ok(postgres.host === '127.0.0.1' || postgres.host === 'localhost', 'Disposable local database required');
const port = Number(process.env.RELIABILITY_PORT ?? 3566);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65000);
const agentPort = port + 1;
const databasePort = port + 13;
const agent = `robin-test-reliability-agent-${Date.now()}`;
const root = new URL('../', import.meta.url);
const pool = new pg.Pool({ ...postgres, database: db });
const logFile = fixtureFile('results.jsonl');
const started = Date.now();
const sessionSecret = randomBytes(48).toString('base64url');
const encryptionKey = randomBytes(32).toString('base64url');
const minutes = Number(process.env.SOAK_MINUTES ?? 5);
assert.ok(Number.isInteger(minutes) && minutes >= 1 && minutes <= 120, 'Duration must be 1..120 minutes');
const workload = process.env.SOAK_WORKLOAD ?? 'faults';
assert.ok(['faults', 'steady'].includes(workload));
const sourceCount = Number(process.env.SOAK_SOURCES ?? 10000);
assert.ok(Number.isInteger(sourceCount) && sourceCount >= 1000 && sourceCount <= 100000);
let resourceTimer;
let resourceSampling = false;
let resourceTransition = false;
let resourceFailure;
let peakRssMiB = 0;
let baselinePid;
let baselineAgentStartedAt;
let adminRestarts = 0;
let agentRestarts = 0;
let mode = 'up';
let smtpMode = 'up';
let acceptedMail = 0;
let server;
let agentCreated = false;
let cookie = '';
let csrf = '';
let dropPoll = false;
let dropResult = false;
let droppedPolls = 0;
let droppedResults = 0;
let databaseOffline = false;
const databaseSockets = new Set();
const credentials = { email: 'reliability-admin@example.test', password: 'Disposable-reliability-only-20261001!' };
const sockets = new Set();
const receipt = async value => { const line = JSON.stringify(value); console.log(line); await appendFile(logFile, line + '\n'); };
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(result.status, 0, `Docker ${args[0]} failed (exit ${result.status ?? 'timeout'}); arguments withheld`);
  return result.stdout;
};
async function request(path, body, auth = true) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(35_000),
    headers: { 'content-type': 'application/json', ...(auth ? { cookie, 'x-csrf-token': csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  return { status: response.status, body: await response.json() };
}
async function waitUntil(fn, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(500); }
  throw new Error('Fixture condition timed out');
}
async function startServer() {
  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), DB_HOST: '127.0.0.1', DB_PORT: String(databasePort), DB_NAME: db,
      DB_USER: postgres.user, DB_PASSWORD: postgres.password,
      SESSION_SECRET: sessionSecret, ROBIN_ADMIN_ENCRYPTION_KEY: encryptionKey,
      SETUP_ID_FILE: fixtureFile('setup-id'),
      ROBIN_ADMIN_PUBLIC_URL: `http://127.0.0.1:${port}`, COOKIE_SECURE: 'false', COOKIE_DOMAIN: '',
      ROBIN_API_ENABLED: 'false', SHERIFF_BASE_URL: 'http://unavailable.invalid',
      LOGIN_RATE_LIMIT_MAX: '50', RATE_LIMIT_MAX_REQUESTS: '1000', STATIC_TEST_USERS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', value => void appendFile(fixtureFile('server.log'), value));
  server.stderr.on('data', value => void appendFile(fixtureFile('server.log'), value));
  await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health/ready`)).ok; } catch { return false; } });
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill();
  await exited;
}
async function login() {
  const result = await request('/api/auth/login', credentials, false);
  assert.equal(result.status, 200);
  csrf = result.body.data.csrfToken;
}
const databaseProxy = net.createServer(socket => {
  if (databaseOffline) { socket.destroy(); return; }
  const upstream = net.connect(postgres.port, postgres.host);
  databaseSockets.add(socket); databaseSockets.add(upstream);
  socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  socket.once('close', () => { databaseSockets.delete(socket); upstream.destroy(); });
  upstream.once('close', () => { databaseSockets.delete(upstream); socket.destroy(); });
  socket.pipe(upstream); upstream.pipe(socket);
});
databaseProxy.listen(databasePort, '127.0.0.1');
await once(databaseProxy, 'listening');
const agentProxy = http.createServer((req, res) => {
  const commandPoll = req.url.startsWith('/api/fleet/agent/commands?');
  if (workload === 'faults' && commandPoll) {
    void receipt({ event: 'gateway-poll', phase: 'received', droppedPolls });
    res.once('finish', () => void receipt({ event: 'gateway-poll', phase: 'finished', status: res.statusCode, droppedPolls }));
  }
  if (dropResult && /\/commands\/[^/]+\/result$/.test(req.url)) {
    dropResult = false; droppedResults++;
    req.resume(); res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Injected result delivery failure' })); return;
  }
  const upstream = http.request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, incoming => {
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks);
      if (dropPoll && commandPoll) {
        try {
          if (JSON.parse(body).data?.length) {
            dropPoll = false; droppedPolls++;
            // Discard the already-leased payload at the gateway. A clean error
            // avoids platform forwarding layers swallowing an abrupt reset.
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Injected leased payload loss' }));
            return;
          }
        } catch { /* Non-JSON failure is forwarded. */ }
      }
      res.writeHead(incoming.statusCode, incoming.headers); res.end(body);
    });
  });
  upstream.on('error', () => { res.writeHead(503); res.end(); });
  req.pipe(upstream);
});
agentProxy.listen(agentPort, '0.0.0.0');
await once(agentProxy, 'listening');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', fixtureFile('key.pem'), '-out', fixtureFile('cert.pem')], { stdio: 'ignore', timeout: 30_000 });
const fixture = https.createServer({
  key: await readFile(fixtureFile('key.pem')),
  cert: await readFile(fixtureFile('cert.pem')),
}, (_req, res) => { if (mode !== 'stall') { res.writeHead(mode === 'down' ? 503 : 200); res.end('fixture'); } });
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const smtp = net.createServer(socket => {
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  socket.setEncoding('utf8'); socket.write('220 disposable SMTP\r\n');
  let buffer = ''; let data = false;
  socket.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\r\n')) {
      const index = buffer.indexOf('\r\n'); const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      if (data) { if (line === '.') { data = false; acceptedMail++; socket.write('250 queued\r\n'); } continue; }
      if (/^EHLO/.test(line)) socket.write('250 disposable\r\n');
      else if (/^MAIL FROM/.test(line)) socket.write(smtpMode === 'fail' ? '451 temporary failure\r\n' : '250 sender\r\n');
      else if (/^RCPT TO/.test(line)) socket.write('250 recipient\r\n');
      else if (line === 'DATA') { data = true; socket.write('354 send data\r\n'); }
      else if (line === 'QUIT') socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    }
  });
});
smtp.listen(0, '127.0.0.1');
await once(smtp, 'listening');
let iterations = 0;
async function sampleResources() {
  if (resourceSampling || resourceTransition) return;
  resourceSampling = true;
  try {
    assert.equal(server.exitCode, null, 'Admin process exited during soak');
    const status = await readFile(`/proc/${server.pid}/status`, 'utf8');
    const rssMiB = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]) / 1024;
    assert.ok(Number.isFinite(rssMiB) && rssMiB < 1024, 'Admin RSS exceeds the fixture safety bound');
    peakRssMiB = Math.max(peakRssMiB, rssMiB);
    const descriptors = (await readdir(`/proc/${server.pid}/fd`)).length;
    const connections = (await pool.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1', [db])).rows[0].n;
    if (workload === 'steady') {
      assert.equal(server.pid, baselinePid, 'Admin restarted in no-restart mode');
      assert.equal(docker('inspect', '--format', '{{.State.StartedAt}}', agent).trim(), baselineAgentStartedAt, 'Agent restarted in no-restart mode');
    }
    await receipt({ event: 'resources', rssMiB, peakRssMiB, descriptors, connections, adminRestarts, agentRestarts });
  } catch (error) { resourceFailure = error; }
  finally { resourceSampling = false; }
}

async function seedDenseSources() {
  await pool.query(`INSERT INTO dmarc_rollup_source_daily
    (day,domain,source_ip,total_volume,compliant_volume,fully_aligned_volume,dkim_pass_volume,spf_pass_volume)
    SELECT CURRENT_DATE-day.n, 'dense-'||(ip.n%20)||'.example.test',
      '10.'||(ip.n/65536)||'.'||((ip.n/256)%256)||'.'||(ip.n%256), 10,10,10,10,10
    FROM generate_series(1,$1::int) ip(n),generate_series(0,6) day(n)`, [sourceCount]);
  await pool.query(`INSERT INTO source_identity(ip,provider,provider_category,provider_via,resolved_at)
    SELECT DISTINCT source_ip,'Fixture '||source_ip,'email_service','cidr',CURRENT_TIMESTAMP
    FROM dmarc_rollup_source_daily`);
  await pool.query(`INSERT INTO dmarc_rollup_daily(day,domain,org_name,total_volume,compliant_volume,fully_aligned_volume)
    SELECT day,domain,'fixture',sum(total_volume),sum(compliant_volume),sum(fully_aligned_volume)
    FROM dmarc_rollup_source_daily GROUP BY day,domain`);
}
try {
  const adminPool = new pg.Pool({ ...postgres, database: 'postgres' });
  try { await adminPool.query(`CREATE DATABASE ${db}`); } finally { await adminPool.end(); }
  await startServer();
  const setup = await request('/api/setup/status', undefined, false);
  assert.equal(setup.body.data.setupRequired, true);
  const setupId = (await readFile(fixtureFile('setup-id'), 'utf8')).trim();
  assert.equal((await request('/api/setup', { ...credentials, name: 'Isolated reliability', setupId }, false)).status, 201);
  await login();
  await pool.query("INSERT INTO admin_config(key,value) VALUES ('monitoringEnabled','true'),('fleetEnabled','true'),('allowPrivateServiceUrls','true') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  await stopServer(); await startServer(); await login();
  const createdAgent = await request('/api/fleet/agents', { name: 'Isolated reliability agent' });
  assert.equal(createdAgent.status, 201);
  const agentId = createdAgent.body.data.agent.agentId;
  const serviceResult = await request('/api/fleet/services', { serviceId: 'reliability-postfix', serviceType: 'postfix', name: 'Harmless queue fixture', apiUrl: 'http://127.0.0.1:39999' });
  assert.equal(serviceResult.status, 201, JSON.stringify(serviceResult.body));
  assert.equal((await request(`/api/fleet/agents/${agentId}/services`, { serviceId: 'reliability-postfix' })).status, 200);
  docker('run', '-d', '--name', agent, '--label', 'robin.test.reliability=true',
    ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    '--mount', `type=bind,source=${fileURLToPath(new URL('./fixtures/reliability-postqueue.sh', import.meta.url))},target=/usr/local/bin/postqueue,readonly`,
    '-e', `ROBIN_ADMIN_URL=http://host.docker.internal:${agentPort}`, '-e', `ROBIN_AGENT_ID=${agentId}`,
    '-e', `ROBIN_ENROLLMENT_TOKEN=${createdAgent.body.data.enrollment.token}`, process.env.RELIABILITY_AGENT_IMAGE ?? 'robin-agent:reliability');
  agentCreated = true;
  await waitUntil(async () => (await pool.query('SELECT enrolled_at, services_json FROM fleet_agents WHERE agent_id=$1', [agentId])).rows[0]?.services_json?.['reliability-postfix']?.actions?.includes('postfix.queue.list'));
  const target = (await request('/api/monitoring/targets', { name: 'Isolated reliability probe', targetType: 'endpoint', environment: 'test' })).body.data;
  const checkResponse = await request('/api/monitoring/checks', { targetId: target.id, name: 'HTTPS fault cycle', checkType: 'http',
    endpoint: `https://127.0.0.1:${fixture.address().port}`, tlsMode: 'allow_self_signed', timeoutSeconds: 1, intervalSeconds: 10,
    confirmationSeconds: 0, recoverySeconds: 0, certExpiryDays: 1, allowPrivate: true });
  assert.equal(checkResponse.status, 201, JSON.stringify(checkResponse.body));
  const checkId = checkResponse.body.data.id;
  await pool.query("INSERT INTO email_relays(name,relay_type,enabled,priority,smtp_host,smtp_port,smtp_security,tls_mode) VALUES ('Disposable sink','smtp',true,1,'127.0.0.1',$1,'none','strict')", [smtp.address().port]);
  await pool.query("UPDATE email_sender_profiles SET enabled=true, from_email='fixture@example.test',relay_ids=ARRAY[(SELECT id FROM email_relays LIMIT 1)]");
  await stopServer(); await startServer(); await login();
  const warmup = await request('/api/postfix/queue?serviceId=reliability-postfix');
  assert.equal(warmup.status, 200, 'Agent command channel must recover from setup restarts before measurement');
  if (workload === 'faults') {
    for (const [queueMode, expectedError, boundMs] of [
      ['stall', /context deadline exceeded/, 19_000],
      ['inherited', /WaitDelay expired/, 5_000],
      ['overflow', /output exceeds 4194304 bytes/, 5_000],
    ]) {
      docker('exec', agent, 'sh', '-c', `printf '${queueMode}' > /tmp/queue-mode`);
      const commandStarted = Date.now();
      const response = await request('/api/postfix/queue?serviceId=reliability-postfix');
      const elapsedMs = Date.now() - commandStarted;
      assert.equal(response.status, 400, `Bounded execution fixture: ${response.body.error ?? response.status}`);
      assert.match(response.body.error, expectedError);
      assert.ok(elapsedMs < boundMs, `${queueMode} exceeded its response bound`);
      const command = (await pool.query(`SELECT id,status,created_at,sent_at,acknowledged_at,completed_at,expires_at
        FROM fleet_agent_commands ORDER BY created_at DESC LIMIT 1`)).rows[0];
      assert.equal(command.status, 'failed', 'Execution error must be recorded, not expire silently');
      assert.ok(command.completed_at < command.expires_at);
      const logs = spawnSync('docker', ['logs', agent], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(logs.status, 0, 'Command execution diagnostics must be available');
      const events = `${logs.stdout}${logs.stderr}`.split('\n').flatMap(line => {
        const value = line.match(/robin-agent: command lifecycle (\{.*\})/);
        if (!value) return [];
        const event = JSON.parse(value[1]);
        return event.commandId === command.id ? [event.event] : [];
      });
      // The metrics collector independently invokes postqueue too; correlate by ID.
      assert.equal(events.filter(event => event === 'execution_started').length, 1, 'Failed command must not replay');
      assert.equal(events.filter(event => event === 'execution_completed').length, 1);
      await receipt({ event: 'bounded-command', queueMode, elapsedMs, command });
    }
    docker('exec', agent, 'sh', '-c', "printf 'up' > /tmp/queue-mode");
  }
  if (workload === 'steady') await seedDenseSources();
  const soakStarted = Date.now();
  baselinePid = server.pid;
  baselineAgentStartedAt = docker('inspect', '--format', '{{.State.StartedAt}}', agent).trim();
  if (process.platform === 'linux') resourceTimer = setInterval(() => void sampleResources(), 5000);
  await receipt({ event: 'start', minutes, workload, sourceCount: workload === 'steady' ? sourceCount : 0,
    denseIdentities: workload === 'steady', distinctSourceGroups: workload === 'steady' ? sourceCount : 0,
    components: ['real Admin API', 'real agent binary', 'real monitoring scheduler', 'real email worker', 'HTTPS probe', 'SMTP sink'], webhookWorker: 'not exercised with local sink: private destinations intentionally prohibited' });
  while (Date.now() - soakStarted < minutes * 60_000) {
    if (resourceFailure) throw resourceFailure;
    mode = ['up', 'down', 'stall', 'up'][iterations % 4];
    const queueMode = ['up', 'delay', 'fail', 'up'][iterations % 4];
    if (iterations % 12 === 0) { dropPoll = workload === 'faults'; dropResult = true; }
    docker('exec', agent, 'sh', '-c', `printf '${queueMode}' > /tmp/queue-mode`);
    const queueWork = Promise.all(Array.from({ length: workload === 'steady' ? 4 : 1 }, () => request('/api/postfix/queue?serviceId=reliability-postfix')));
    const reportStarted = Date.now();
    const reporting = workload === 'steady' ? Promise.all(Array.from({ length: 4 }, async (_, reader) => {
      const reports = await request(`/api/reporting/sources?days=${7 + (iterations % 6) + reader}&limit=50`);
      assert.equal(reports.status, 200, `Reporting fixture: ${reports.body.error ?? reports.status}`);
      assert.equal(reports.body.pagination?.total, sourceCount);
      assert.equal(reports.body.data.length, 50);
      assert.ok(reports.body.data.every(source => source.breakdown.totalVolume === 70 && source.domainCount === 1));
    })).then(() => receipt({ event: 'reporting', readers: 4, groups: sourceCount, elapsedMs: Date.now() - reportStarted })) : Promise.resolve();
    const [queues] = await Promise.all([queueWork, reporting]);
    const queue = queues[0];
    for (const result of queues) assert.equal(result.status, queueMode === 'fail' ? 400 : 200, `Fleet fixture: ${result.body.error ?? result.status}`);
    assert.equal(queue.status, queueMode === 'fail' ? 400 : 200);
    if (queueMode === 'fail') assert.match(queue.body.error, /fixture command failure/);
    let observed;
    const expectedStatus = mode === 'up' ? 'up' : 'down';
    const recoveryStarted = Date.now();
    await waitUntil(async () => {
      observed = await request(`/api/monitoring/checks/${checkId}/run`, {});
      assert.equal(observed.status, 200);
      if (observed.body.data.status === expectedStatus) return true;
      await receipt({ event: 'transitional-observation', iteration: iterations + 1, mode,
        observation: observed.body.data, elapsedMs: Date.now() - recoveryStarted });
      return false;
    }, 5_000);
    assert.ok(observed.body.data.responseTimeMs < 3000);
    const open = (await pool.query("SELECT count(*)::int n FROM monitoring_issues WHERE check_id=$1 AND status='open'", [checkId])).rows[0].n;
    assert.equal(open, mode === 'up' ? 0 : 1);
    smtpMode = iterations % 5 === 1 ? 'fail' : 'up';
    await pool.query("INSERT INTO email_deliveries(purpose,sender_profile_key,recipient_email,recipient_kind,subject,text_body) VALUES ('test','system','sink@example.test','external','Disposable reliability','fixture-only')");
    if (workload === 'faults' && iterations % 10 === 5) { docker('restart', agent); agentRestarts++; await delay(3000); }
    if (workload === 'faults' && iterations % 10 === 8) {
      // Drain sampling before the intentional stop; an exiting /proc entry can
      // lose VmRSS and must not be mistaken for an unbounded-memory failure.
      resourceTransition = true;
      try {
        await waitUntil(() => !resourceSampling, 10000);
        await stopServer(); await startServer(); adminRestarts++; await login();
      } finally { resourceTransition = false; }
    }
    if (workload === 'faults' && iterations % 12 === 7) {
      databaseOffline = true;
      for (const socket of databaseSockets) socket.destroy();
      try {
        const failed = await request(`/api/monitoring/checks/${checkId}/run`, {});
        assert.ok(failed.status >= 400, 'DB failure must not return a successful observation');
      } finally { databaseOffline = false; }
      await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/health/ready`)).ok);
    }
    const duplicates = (await pool.query("SELECT check_id FROM monitoring_issues WHERE status='open' GROUP BY check_id HAVING count(*)>1")).rowCount;
    assert.equal(duplicates, 0);
    const stats = (await pool.query("SELECT status, count(*)::int n FROM email_deliveries GROUP BY status")).rows;
    await receipt({ event: 'iteration', iteration: ++iterations, mode, queueMode, openIssues: open, acceptedMail, emailStates: stats,
      elapsedSeconds: Math.round((Date.now() - soakStarted) / 1000), droppedPolls, droppedResults,
      agentRestarts, adminRestarts });
    await delay(Math.min(15_000, Math.max(0, minutes * 60_000 - (Date.now() - soakStarted))));
  }
  smtpMode = 'up';
  await waitUntil(async () => {
    const outstanding = await pool.query("SELECT count(*)::int n FROM email_deliveries WHERE status <> 'accepted'");
    return outstanding.rows[0].n === 0;
  });
  const deliveryStates = (await pool.query("SELECT status,count(*)::int n FROM email_deliveries GROUP BY status")).rows;
  assert.deepEqual(deliveryStates, [{ status: 'accepted', n: iterations }]);
  assert.equal(acceptedMail, iterations);
  if (resourceFailure) throw resourceFailure;
  if (workload === 'steady') {
    assert.equal(adminRestarts, 0); assert.equal(agentRestarts, 0);
    if (process.platform === 'linux') await sampleResources();
    if (resourceFailure) throw resourceFailure;
  }
  await receipt({ event: 'complete', iterations, acceptedMail, elapsedSeconds: (Date.now() - soakStarted) / 1000,
    totalSeconds: (Date.now() - started) / 1000, adminRestarts, agentRestarts, peakRssMiB });
} catch (error) {
  const serverLog = await readFile(fixtureFile('server.log'), 'utf8').catch(() => '');
  const serverEvents = serverLog.split('\n').flatMap(line => {
    const value = line.match(/Agent command lifecycle (\{.*\})/);
    if (!value) return [];
    try { return [JSON.parse(value[1])]; } catch { return []; }
  });
  await receipt({ event: 'server-command-diagnostics', events: serverEvents.slice(-100) });
  if (agentCreated) {
    const logs = spawnSync('docker', ['logs', '--tail', '100', agent], { encoding: 'utf8', timeout: 10_000 });
    const events = `${logs.stdout ?? ''}${logs.stderr ?? ''}`.split('\n').flatMap(line => {
      const value = line.match(/robin-agent: command lifecycle (\{.*\})/);
      if (!value) return [];
      try {
        const parsed = JSON.parse(value[1]);
        return [Object.fromEntries(['event','commandId','serviceId','action','elapsedMs','attempt','httpStatus','outcome'].filter(key => key in parsed).map(key => [key,parsed[key]]))];
      } catch { return []; }
    });
    await receipt({ event: 'agent-diagnostics', events });
  }
  await receipt({ event: 'failed', message: error.message, iterations }); process.exitCode = 1;
} finally {
  clearInterval(resourceTimer);
  await waitUntil(() => !resourceSampling, 10000);
  await stopServer();
  if (agentCreated) docker('rm', '-f', agent);
  fixture.closeAllConnections(); fixture.close();
  for (const socket of sockets) socket.destroy();
  smtp.close();
  agentProxy.closeAllConnections(); agentProxy.close();
  for (const socket of databaseSockets) socket.destroy();
  databaseProxy.close();
  await pool.end();
  const cleanupPool = new pg.Pool({ ...postgres, database: 'postgres' });
  try { await cleanupPool.query(`DROP DATABASE ${db} WITH (FORCE)`); } finally { await cleanupPool.end(); }
  await rm(fixtureDirectory, { recursive: true, force: true });
}
