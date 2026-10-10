import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createInstallerServer, parsePolicy, signRequest } from '../src/installer.js';

const secret = 'transaction-test-secret-at-least-32-characters';
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
const names = ['frontend', 'backend'];
function policy(upgradeStrategy = 'stage-first') {
  return parsePolicy({ modules: { qa: { upgradeStrategy, versions: { '1.0.0': {
    runtime: { backendUrl: 'http://qa-backend:3002/module', assetBaseUrl: 'http://qa-frontend', probeUrl: 'http://qa-backend:3002/ready' },
    services: names.map((name) => ({
    name, image: `ghcr.io/test/${name}@sha256:${'a'.repeat(64)}`, containerName: `qa-${name}`,
    network: 'internal', ports: [], volumes: [], allowedEnvKeys: [], environment: {}, healthTimeoutSeconds: 1,
  })) } } } } });
}

test('executed installs publish durable runtime addresses even without port mappings', async () => {
  const runtime = runner();
  const api = await start(runtime.docker);
  try {
    const job = await upgrade(api);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.data.mode, 'docker');
    assert.deepEqual(job.data.runtime, {
      backendUrl: 'http://qa-backend:3002/module', assetBaseUrl: 'http://qa-frontend', probeUrl: 'http://qa-backend:3002/ready',
    });
    const persisted = JSON.parse(await readFile(join(api.root, 'jobs', 'transaction-job.json'), 'utf8'));
    assert.deepEqual(persisted.data.runtime, job.data.runtime);
  } finally { await api.close(); }
});
function runner(failure, previousRunning = true) {
  const labels = { 'robin.admin.managed': 'true', 'robin.admin.module': 'qa' };
  const containers = new Map(names.map((name) => [`qa-${name}`, { Id: `old-id-${name}`, Image: `old-${name}`, Config: { Labels: labels }, State: { Status: previousRunning ? 'running' : 'exited' } }]));
  const calls = [];
  let failed = false;
  const docker = async (args) => {
    calls.push(args);
    const name = args.at(-1);
    if (!failed && failure?.(args)) { failed = true; throw Error('injected failure'); }
    if (args[0] === 'container') {
      if (!containers.has(name)) throw Error('not found');
      return { stdout: JSON.stringify(containers.get(name)) };
    }
    if (args[0] === 'inspect') {
      if (!containers.has(name)) throw Error('not found');
      return { stdout: JSON.stringify(containers.get(name).State) + (args.includes('{{json .State}}|{{.Config.Image}}') ? `|${containers.get(name).Image}` : '') };
    }
    if (args[0] === 'create') containers.set(args[args.indexOf('--name') + 1], {
      Id: randomUUID(), Image: name,
      Config: { Labels: Object.fromEntries(args.flatMap((value, i) => value === '--label' ? [args[i + 1].split('=')] : [])) },
      State: { Status: 'created', Health: { Status: 'healthy' } },
    });
    if (args[0] === 'start') { if (!containers.has(name)) throw Error('not found'); containers.get(name).State.Status = 'running'; }
    if (args[0] === 'stop') { if (!containers.has(name)) throw Error('not found'); containers.get(name).State.Status = 'exited'; }
    if (args[0] === 'rename') { const value = containers.get(args[1]); if (!value) throw Error('not found'); containers.delete(args[1]); containers.set(args[2], value); }
    if (args[0] === 'rm') containers.delete(name);
    return { stdout: '', stderr: '' };
  };
  return { docker, containers, calls };
}
async function start(docker, root, jobTimeoutMs, strategy = 'stage-first') {
  root ??= join(tmpdir(), 'robin-admin-installer-test', randomUUID());
  if (!roots.includes(root)) roots.push(root);
  const server = await createInstallerServer({ secret, mode: 'docker', policy: policy(strategy), stateDir: root, docker, jobTimeoutMs });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, value) => {
    const body = value === undefined ? '' : JSON.stringify(value);
    const timestamp = String(Date.now());
    const response = await fetch(base + path, { method, body: body || undefined, headers: {
      'content-type': 'application/json', 'x-robin-installer-timestamp': timestamp,
      'x-robin-installer-signature': signRequest(secret, timestamp, method, path, body),
    } });
    assert.ok(response.ok);
    return (await response.json()).data;
  };
  return { root, request, close: async () => { const closed = once(server, 'close'); server.close(); await closed; } };
}
async function upgrade(api, action = 'upgrade', version = '1.0.0') {
  await api.request('POST', '/api/jobs', { jobId: 'transaction-job', moduleSlug: 'qa', version, action, maintenanceAcknowledged: true });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const job = await api.request('GET', '/api/jobs/transaction-job');
    if (['succeeded', 'failed'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Job did not finish');
}

test('lifecycle actions accept an older installed version but require all ownership labels before changing anything', async () => {
  const runtime = runner();
  const api = await start(runtime.docker);
  try {
    const capabilities = await api.request('GET', '/api/capabilities');
    assert.deepEqual(capabilities.modules, { qa: ['1.0.0'] });
    assert.equal((await upgrade(api, 'stop', '0.9.0')).status, 'succeeded');
    originals(runtime, false);
  } finally { await api.close(); }
  const unmanaged = runner();
  unmanaged.containers.get('qa-backend').Config = { Labels: {} };
  const blocked = await start(unmanaged.docker);
  try {
    const result = await upgrade(blocked, 'stop', '0.9.0');
    assert.equal(result.status, 'failed');
    assert.match(result.message, /not installer-managed/);
    originals(unmanaged);
    assert.equal(unmanaged.calls.filter(a => a[0] === 'stop').length, 0);
  } finally { await blocked.close(); }
});

test('uninstall preserves data volumes but reports Docker deletion failures', async () => {
  const runtime = runner(a => a[0] === 'rm' && a.at(-1) === 'qa-backend');
  const api = await start(runtime.docker);
  try {
    assert.equal((await upgrade(api, 'uninstall', '0.9.0')).status, 'failed');
    assert.ok(runtime.containers.has('qa-backend'));
    assert.equal(runtime.calls.filter(a => a[0] === 'volume').length, 0);
  } finally { await api.close(); }
});
function originals(runtime, running = true) {
  for (const name of names) {
    assert.equal(runtime.containers.get(`qa-${name}`)?.Image, `old-${name}`);
    assert.equal(runtime.containers.get(`qa-${name}`)?.State.Status, running ? 'running' : 'exited');
  }
  assert.equal(runtime.containers.size, 2);
}

for (const [label, failure] of [
  ['second pull', a => a[0] === 'pull' && a[1].includes('/backend@')],
  ['second staging create', a => a[0] === 'create' && a.includes('qa-backend-staged-nsaction-job')],
  ['second staging health', a => a[0] === 'inspect' && a.at(-1).includes('backend-staged')],
  ['second stop', a => a[0] === 'stop' && a.at(-1) === 'qa-backend'],
  ['second rename', a => a[0] === 'rename' && a[1] === 'qa-backend'],
  ['second final create', a => a[0] === 'create' && a[a.indexOf('--name') + 1] === 'qa-backend'],
  ['second final start', a => a[0] === 'start' && a.at(-1) === 'qa-backend'],
  ['second final health', a => a[0] === 'inspect' && a.at(-1) === 'qa-backend'],
]) {
  test(`module transaction restores all original services after ${label} failure`, async () => {
    const runtime = runner(failure);
    const api = await start(runtime.docker);
    try { assert.equal((await upgrade(api)).status, 'failed'); originals(runtime); }
    finally { await api.close(); }
  });
}
test('all services are staged before switching, and successful jobs leave no pending journal', async () => {
  const runtime = runner(); const api = await start(runtime.docker);
  try {
    assert.equal((await upgrade(api)).status, 'succeeded');
    const firstStop = runtime.calls.findIndex(a => a[0] === 'stop');
    const stagedHealth = runtime.calls.findIndex(a => a[0] === 'inspect' && a.at(-1).includes('backend-staged'));
    assert.ok(firstStop > stagedHealth);
    assert.deepEqual(await readdir(join(api.root, 'transactions')), []);
  } finally { await api.close(); }
});
test('maintenance pulls all images then stops all originals before creating any replacement', async () => {
  const runtime = runner();
  const api = await start(runtime.docker, undefined, undefined, 'maintenance');
  try {
    const result = await upgrade(api);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.data.upgradeStrategy, 'maintenance');
    const pulls = runtime.calls.flatMap((a, i) => a[0] === 'pull' ? [i] : []);
    const stops = runtime.calls.flatMap((a, i) => a[0] === 'stop' ? [i] : []);
    const creates = runtime.calls.flatMap((a, i) => a[0] === 'create' ? [i] : []);
    assert.equal(pulls.length, 2);
    assert.equal(creates.length, 2);
    assert.ok(Math.max(...pulls) < Math.min(...stops));
    assert.ok(Math.max(...stops) < Math.min(...creates));
    assert.equal(runtime.calls.some(a => a.some(v => v.includes('-staged-')) && a[0] === 'create'), false);
  } finally { await api.close(); }
});
for (const running of [true, false]) {
  for (const boundary of ['stop', 'rename', 'create', 'start', 'inspect']) {
    test(`maintenance restores ${running ? 'running' : 'stopped'} originals after second ${boundary} failure`, async () => {
      const runtime = runner(a => a[0] === boundary && (boundary === 'create'
        ? a[a.indexOf('--name') + 1] === 'qa-backend'
        : boundary === 'rename' ? a[1] === 'qa-backend' : a.at(-1) === 'qa-backend'), running);
      const api = await start(runtime.docker, undefined, undefined, 'maintenance');
      try {
        const result = await upgrade(api);
        assert.equal(result.status, running || boundary !== 'stop' ? 'failed' : 'succeeded');
        if (result.status === 'failed') originals(runtime, running);
      } finally { await api.close(); }
    });
  }
}
test('install and maintenance upgrade refuse every unmanaged original before any mutation', async () => {
  for (const action of ['install', 'upgrade']) {
    const runtime = runner();
    runtime.containers.get('qa-backend').Config.Labels = {};
    const api = await start(runtime.docker, undefined, undefined, 'maintenance');
    try {
      assert.match((await upgrade(api, action)).message, /not installer-managed/);
      assert.equal(runtime.calls.some(a => ['pull', 'stop', 'rename', 'create', 'rm'].includes(a[0])), false);
    } finally { await api.close(); }
  }
});
test('rollback refuses a foreign replacement and retains the recovery journal', async () => {
  const runtime = runner();
  const docker = async a => {
    if (a[0] === 'start' && a.at(-1) === 'qa-backend') {
      runtime.containers.get('qa-frontend').Config.Labels = {};
      throw Error('foreign container replaced canonical name');
    }
    return runtime.docker(a);
  };
  const api = await start(docker, undefined, undefined, 'maintenance');
  try {
    const result = await upgrade(api);
    assert.match(result.message, /Rollback incomplete.*not installer-managed/);
    assert.ok(runtime.containers.has('qa-frontend'));
    assert.ok((await readdir(join(api.root, 'transactions'))).includes('transaction-job.json'));
  } finally { await api.close(); }
});
for (const strategy of ['stage-first', 'maintenance']) {
  test(`${strategy} restart recovers every create, start, stop and rename boundary`, async () => {
    const runtime = runner();
    const snapshots = [];
    let api;
    const docker = async args => {
      const result = await runtime.docker(args);
      if (['create', 'start', 'stop', 'rename', 'rm'].includes(args[0])) {
        snapshots.push({
          journal: JSON.parse(await readFile(join(api.root, 'transactions', 'transaction-job.json'), 'utf8')),
          containers: structuredClone([...runtime.containers]),
          boundary: args.join(' '),
        });
      }
      return result;
    };
    api = await start(docker, undefined, undefined, strategy);
    try { assert.equal((await upgrade(api)).status, 'succeeded'); }
    finally { await api.close(); }
    assert.ok(snapshots.length >= 8);
    for (const snapshot of snapshots) {
      const recoveredRuntime = runner();
      recoveredRuntime.containers.clear();
      for (const [name, container] of snapshot.containers) recoveredRuntime.containers.set(name, container);
      const root = join(tmpdir(), 'robin-admin-installer-test', randomUUID());
      roots.push(root);
      await mkdir(join(root, 'transactions'), { recursive: true });
      await mkdir(join(root, 'jobs'));
      await writeFile(join(root, 'transactions', 'transaction-job.json'), JSON.stringify(snapshot.journal));
      await writeFile(join(root, 'jobs', 'transaction-job.json'), JSON.stringify({ jobId: 'transaction-job', status: 'running' }));
      const recovered = await start(recoveredRuntime.docker, root, undefined, strategy);
      try {
        originals(recoveredRuntime);
        assert.deepEqual(await readdir(join(root, 'transactions')), [], snapshot.boundary);
        assert.equal((await recovered.request('GET', '/api/jobs/transaction-job')).status, 'failed');
      } finally { await recovered.close(); }
    }
  });
}
test('a running replacement without a Docker health check is rejected and rolled back', async () => {
  const runtime = runner();
  const docker = async args => {
    const result = await runtime.docker(args);
    if (args[0] === 'inspect' && args.at(-1) === 'qa-backend') {
      result.stdout = JSON.stringify({ Status: 'running' });
    }
    return result;
  };
  const api = await start(docker, undefined, undefined, 'maintenance');
  try {
    assert.match((await upgrade(api)).message, /no image health check/);
    originals(runtime);
  } finally { await api.close(); }
});
test('rollback preserves stopped originals', async () => {
  const runtime = runner(a => a[0] === 'start' && a.at(-1) === 'qa-backend', false);
  const api = await start(runtime.docker);
  try { assert.equal((await upgrade(api)).status, 'failed'); originals(runtime, false); }
  finally { await api.close(); }
});
test('job timeout leaves originals unchanged and cleans staged containers', async () => {
  const runtime = runner();
  const docker = async a => { if (a[0] === 'pull') await new Promise(r => setTimeout(r, 20)); return runtime.docker(a); };
  const api = await start(docker, undefined, 1);
  try { assert.equal((await upgrade(api)).status, 'failed'); originals(runtime); }
  finally { await api.close(); }
});
for (const phase of ['before-stop', 'after-stop', 'after-rename', 'after-create']) {
  test(`restart rolls back an interrupted transaction ${phase}`, async () => {
    const runtime = runner(); const root = join(tmpdir(), 'robin-admin-installer-test', randomUUID()); roots.push(root);
    const canonicalName = 'qa-frontend'; const rollbackName = 'qa-frontend-rollback-restart';
    if (phase !== 'before-stop') runtime.containers.get(canonicalName).State.Status = 'exited';
    if (['after-rename', 'after-create'].includes(phase)) {
      runtime.containers.set(rollbackName, runtime.containers.get(canonicalName)); runtime.containers.delete(canonicalName);
    }
    if (phase === 'after-create') runtime.containers.set(canonicalName, {
      Image: 'new-frontend', State: { Status: 'running' },
      Config: { Labels: { 'robin.admin.managed': 'true', 'robin.admin.module': 'qa', 'robin.admin.job': 'restart' } },
    });
    await mkdir(join(root, 'transactions'), { recursive: true }); await mkdir(join(root, 'jobs'));
    await writeFile(join(root, 'jobs', 'restart.json'), JSON.stringify({ jobId: 'restart', status: 'running' }));
    await writeFile(join(root, 'transactions', 'restart.json'), JSON.stringify({ jobId: 'restart', moduleSlug: 'qa', phase: 'switching', operations: [{
      canonicalName, rollbackName, stagedName: 'qa-frontend-staged-restart', previousImage: 'old-frontend', previousRunning: true, switchStarted: true,
    }] }));
    const api = await start(runtime.docker, root);
    try { originals(runtime); assert.equal((await api.request('GET', '/api/jobs/restart')).status, 'failed'); }
    finally { await api.close(); }
  });
}
test('rollback failure is surfaced and its journal is retained for restart recovery', async () => {
  const runtime = runner(); let switchingFailed = false;
  const docker = async a => {
    if (a[0] === 'start' && a.at(-1) === 'qa-backend') { switchingFailed = true; throw Error('switch failed'); }
    if (switchingFailed && a[0] === 'rename' && a[1].includes('frontend-rollback')) throw Error('restore failed');
    return runtime.docker(a);
  };
  const api = await start(docker);
  try {
    const job = await upgrade(api); assert.equal(job.status, 'failed'); assert.match(job.message, /Rollback incomplete.*restore failed/);
    assert.ok(JSON.parse(await readFile(join(api.root, 'transactions', 'transaction-job.json'))).operations.length);
  } finally { await api.close(); }
  const recovered = await start(runtime.docker, api.root);
  try { originals(runtime); } finally { await recovered.close(); }
});
test('restart preserves a completed switch whose job result was not yet persisted', async () => {
  const runtime = runner(); const root = join(tmpdir(), 'robin-admin-installer-test', randomUUID()); roots.push(root);
  await mkdir(join(root, 'transactions'), { recursive: true }); await mkdir(join(root, 'jobs'));
  const result = { mode: 'docker', runtime: {
    backendUrl: 'http://qa-backend:3002/module', assetBaseUrl: 'http://qa-frontend', probeUrl: 'http://qa-backend:3002/ready',
  }, services: ['qa-frontend', 'qa-backend'], rollback: [] };
  await writeFile(join(root, 'jobs', 'complete.json'), JSON.stringify({ jobId: 'complete', status: 'running' }));
  await writeFile(join(root, 'transactions', 'complete.json'), JSON.stringify({ jobId: 'complete', moduleSlug: 'qa', phase: 'complete', operations: [], result }));
  const api = await start(runtime.docker, root);
  try {
    const job = await api.request('GET', '/api/jobs/complete');
    assert.equal(job.status, 'succeeded'); assert.deepEqual(job.data, result);
    assert.equal(runtime.calls.length, 0);
  } finally { await api.close(); }
});
test('quarantines corrupted durable job records and continues startup', async () => {
  for (const contents of ['{broken', JSON.stringify({ jobId: 'other', status: 'succeeded' }), JSON.stringify({ jobId: 'corrupt', status: 'invalid' })]) {
    const root = join(tmpdir(), 'robin-admin-installer-test', randomUUID());
    roots.push(root);
    await mkdir(join(root, 'jobs'), { recursive: true });
    await writeFile(join(root, 'jobs', 'corrupt.json'), contents);
    await writeFile(join(root, 'jobs', 'healthy.json'), JSON.stringify({ jobId: 'healthy', status: 'succeeded' }));
    const runtime = runner();
    const api = await start(runtime.docker, root);
    try {
      assert.equal((await api.request('GET', '/health')).mode, 'docker');
      assert.equal((await api.request('GET', '/api/jobs/healthy')).status, 'succeeded');
      assert.equal((await readdir(join(root, 'jobs', 'quarantine'))).length, 1);
    } finally { await api.close(); }
    assert.equal(runtime.calls.length, 0);
  }
});
