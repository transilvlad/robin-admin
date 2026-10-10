import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  buildDockerPlan,
  buildJobPlan,
  createInstallerServer,
  loadPolicy,
  parsePolicy,
  signRequest,
  verifyRequestSignature,
} from '../src/installer.js';

const secret = 'installer-test-secret-with-at-least-32-chars';
const digest = `sha256:${'a'.repeat(64)}`;
const testRoots = new Set();

function policyValue(image = `ghcr.io/robinmta/robin-tools@${digest}`) {
  return {
    modules: {
      'robin-tools': {
        upgradeStrategy: 'stage-first',
        versions: {
          '1.2.3': {
            runtime: { backendUrl: null, assetBaseUrl: 'http://host.docker.internal:3080', probeUrl: 'http://host.docker.internal:3080/health' },
            services: [{
              name: 'web',
              image,
              containerName: 'robin-tools-web',
              network: 'suite',
              ports: [{
                hostIp: '127.0.0.1',
                hostPort: 3080,
                containerPort: 8080,
                protocol: 'tcp',
              }],
              volumes: [{ name: 'robin-tools-data', target: '/data' }],
              allowedEnvKeys: ['NODE_ENV'],
              environment: { NODE_ENV: 'production' },
              healthTimeoutSeconds: 30,
            }],
          },
        },
      },
    },
  };
}

function sheriffPolicyValue() {
  const value = policyValue(`sheriff.robinmta.com/paid/tools-frontend@${digest}`);
  value.modules['robin-tools'].versions['1.2.3'].services[0].name = 'frontend';
  value.modules['robin-tools'].versions['1.2.3'].services.push({
    name: 'backend',
    image: `sheriff.robinmta.com/paid/tools-backend@sha256:${'b'.repeat(64)}`,
    containerName: 'robin-tools-backend',
    network: 'suite',
    ports: [],
    volumes: [],
    allowedEnvKeys: [],
    environment: {},
    healthTimeoutSeconds: 30,
  });
  return value;
}

function stateDir() {
  const path = join(tmpdir(), 'robin-admin-installer-test', randomUUID());
  testRoots.add(path);
  return path;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function signedFetch(baseUrl, method, path, value, signatureSecret = secret) {
  const body = value === undefined ? '' : JSON.stringify(value);
  const timestamp = Date.now().toString();
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      'x-robin-installer-timestamp': timestamp,
      'x-robin-installer-signature': signRequest(signatureSecret, timestamp, method, path, body),
    },
    body: body || undefined,
  });
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

afterEach(async () => {
  await Promise.all([...testRoots].map((path) => rm(path, { recursive: true, force: true })));
  testRoots.clear();
});

describe('installer request authentication', () => {
  it('accepts current valid HMAC signatures and rejects mismatches or stale requests', () => {
    const timestamp = Date.now().toString();
    const body = JSON.stringify({ action: 'install' });
    const signature = signRequest(secret, timestamp, 'POST', '/api/jobs', body);

    assert.equal(verifyRequestSignature(secret, timestamp, 'POST', '/api/jobs', body, signature), true);
    assert.equal(verifyRequestSignature(secret, timestamp, 'POST', '/api/jobs', `${body} `, signature), false);
    assert.equal(
      verifyRequestSignature(secret, String(Date.now() - 60_000), 'POST', '/api/jobs', body, signature),
      false,
    );
  });

  it('requires authentication for job and module APIs', async () => {
    const server = await createInstallerServer({
      secret,
      mode: 'dry-run',
      policy: parsePolicy(policyValue()),
      stateDir: stateDir(),
    });
    const baseUrl = await listen(server);
    for (const path of ['/api/jobs/missing', '/api/capabilities']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 401);
    }
    assert.equal((await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await signedFetch(baseUrl, 'GET', '/api/capabilities', undefined, 'incorrect-secret')).status, 401);
    await close(server);
  });
});

describe('local policy and job plans', () => {
  it('requires an explicit strategy and deliberate maintenance upgrade acknowledgement', () => {
    const value = policyValue();
    delete value.modules['robin-tools'].upgradeStrategy;
    assert.throws(() => parsePolicy(value), /upgradeStrategy/);
    value.modules['robin-tools'].upgradeStrategy = 'maintenance';
    const policy = parsePolicy(value);
    const job = { action: 'upgrade', moduleSlug: 'robin-tools', version: '1.2.3' };
    assert.throws(() => buildJobPlan(job, policy), /acknowledgement/);
    assert.throws(() => buildJobPlan({ ...job, maintenanceAcknowledged: 'true' }, policy), /boolean/);
    assert.equal(buildJobPlan({ ...job, maintenanceAcknowledged: true }, policy).upgradeStrategy, 'maintenance');
    assert.equal(buildJobPlan({ ...job, action: 'install' }, policy).upgradeStrategy, 'maintenance');
  });
  it('requires explicit runtime addresses and rejects unsafe or ambiguous targets', () => {
    for (const runtime of [undefined, {}, { backendUrl: null, assetBaseUrl: 'file:///app', probeUrl: 'http://db/health' },
      { backendUrl: 'http://u:secret@db', assetBaseUrl: 'http://web', probeUrl: 'http://db/health' },
      { backendUrl: 'http://0.0.0.0:3000', assetBaseUrl: 'http://web', probeUrl: 'http://db/health' },
      { backendUrl: 'http://db', assetBaseUrl: 'http://web/assets', probeUrl: 'http://db/health' },
      { backendUrl: 'http://db', assetBaseUrl: 'http://web', probeUrl: 'http://db/health?token=secret' },
      { backendUrl: 'http://db', assetBaseUrl: 'http://web', probeUrl: 'http://db/health', extra: true }]) {
      const value = policyValue();
      value.modules['robin-tools'].versions['1.2.3'].runtime = runtime;
      assert.throws(() => parsePolicy(value), /runtime/);
    }
    const value = policyValue();
    value.modules['robin-tools'].versions['1.2.3'].services[0].network = 'host';
    value.modules['robin-tools'].versions['1.2.3'].services[0].ports = [];
    const plan = buildJobPlan({ action: 'install', moduleSlug: 'robin-tools', version: '1.2.3' }, parsePolicy(value));
    assert.deepEqual(plan.runtime, value.modules['robin-tools'].versions['1.2.3'].runtime);
  });
  it('requires private policy file permissions on POSIX', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = stateDir();
    const policyPath = join(root, 'policy.json');
    await mkdir(root, { recursive: true });
    await writeFile(policyPath, JSON.stringify(policyValue()));

    await chmod(policyPath, 0o666);
    await assert.rejects(() => loadPolicy(policyPath), /permissions 666 are unsafe/);

    await chmod(policyPath, 0o644);
    await assert.rejects(() => loadPolicy(policyPath), /permissions 644 are unsafe/);

    await chmod(policyPath, 0o600);
    const policy = await loadPolicy(policyPath);
    assert.equal(policy.has('robin-tools'), true);

    await chmod(policyPath, 0o440);
    const policyFromCredential = await loadPolicy(policyPath);
    assert.equal(policyFromCredential.has('robin-tools'), true);
  });

  it('builds Docker argv only from fixed local policy values', () => {
    const plan = buildJobPlan({
      jobId: 'job-1',
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '1.2.3',
    }, parsePolicy(policyValue()));
    const dockerPlan = buildDockerPlan(plan)[0];

    assert.deepEqual(dockerPlan.pull, ['pull', `ghcr.io/robinmta/robin-tools@${digest}`]);
    assert.ok(dockerPlan.createFinal.includes('127.0.0.1:3080:8080/tcp'));
    assert.ok(dockerPlan.createFinal.includes('type=volume,src=robin-tools-data,dst=/data'));
    assert.ok(dockerPlan.createFinal.includes('NODE_ENV=production'));
    assert.ok(dockerPlan.createFinal.includes('--restart'));
    assert.ok(dockerPlan.createFinal.includes('unless-stopped'));
    assert.equal(dockerPlan.createStaged.includes('--restart'), false);
    assert.equal(dockerPlan.createFinal.at(-1), `ghcr.io/robinmta/robin-tools@${digest}`);
  });

  it('rejects catalog install specs and every arbitrary job field', () => {
    const policy = parsePolicy(policyValue());
    assert.throws(() => buildJobPlan({
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '1.2.3',
      installSpec: { services: [{ image: `attacker.invalid/root@${digest}` }] },
    }, policy), /unsupported field "installSpec"/);
    assert.throws(() => buildJobPlan({
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '1.2.3',
      command: ['sh', '-c', 'id'],
    }, policy), /unsupported field "command"/);
  });

  it('rejects mutable image tags in local policy', () => {
    assert.throws(
      () => parsePolicy(policyValue('ghcr.io/robinmta/robin-tools:latest')),
      /immutable image@sha256 digest/,
    );
  });

  it('rejects unreplaced environment secret placeholders', () => {
    const value = policyValue();
    value.modules['robin-tools'].versions['1.2.3'].services[0].allowedEnvKeys.push('MODULE_PROXY_SECRET');
    value.modules['robin-tools'].versions['1.2.3'].services[0].environment.MODULE_PROXY_SECRET =
      'REPLACE_WITH_HIGH_ENTROPY_SECRET';
    assert.throws(() => parsePolicy(value), /unreplaced operator placeholder/);
  });

  it('accepts only narrow, short-lived credentials matching approved registries', () => {
    const policy = parsePolicy(sheriffPolicyValue());
    const credentials = [{
      repository: 'paid/tools-frontend',
      registry: 'sheriff.robinmta.com',
      username: 'grant-user',
      password: 'frontend-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, {
      repository: 'paid/tools-backend',
      registry: 'sheriff.robinmta.com',
      username: 'grant-user',
      password: 'backend-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }];
    const plan = buildJobPlan({
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '1.2.3',
      registryCredentials: credentials,
    }, policy);
    assert.deepEqual(
      plan.registryCredentials.map(({ repository, serviceName }) => ({ repository, serviceName })),
      [
        { repository: 'paid/tools-frontend', serviceName: 'frontend' },
        { repository: 'paid/tools-backend', serviceName: 'backend' },
      ],
    );
    assert.throws(() => buildJobPlan({
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '1.2.3',
      registryCredentials: [{ ...credentials[0], extra: 'not-allowed' }, credentials[1]],
    }, policy), /unsupported field "extra"/);
    assert.throws(() => buildJobPlan({
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '1.2.3',
      registryCredentials: [credentials[0]],
    }, policy), /cover each approved Sheriff service/);
    assert.throws(() => buildJobPlan({
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '1.2.3',
      registryCredentials: [...credentials, credentials[0]],
    }, policy), /at most two/);
  });
});

describe('job API and persistence', () => {
  it('persists jobs atomically without credentials and restores them after restart', async () => {
    const root = stateDir();
    const policy = parsePolicy(sheriffPolicyValue());
    const credentials = [{
      repository: 'paid/tools-frontend',
      registry: 'sheriff.robinmta.com',
      username: 'grant-user',
      password: 'secret-frontend-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, {
      repository: 'paid/tools-backend',
      registry: 'sheriff.robinmta.com',
      username: 'grant-user',
      password: 'secret-backend-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }];
    let server = await createInstallerServer({ secret, mode: 'dry-run', policy, stateDir: root });
    let baseUrl = await listen(server);
    const response = await signedFetch(baseUrl, 'POST', '/api/jobs', {
      jobId: 'persistent-job',
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '1.2.3',
      registryCredentials: credentials,
    });
    assert.equal(response.status, 202);

    let job;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const poll = await signedFetch(baseUrl, 'GET', '/api/jobs/persistent-job');
      job = (await poll.json()).data;
      if (job.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.status, 'succeeded');
    assert.equal(job.data.mode, 'dry-run');
    assert.deepEqual(job.data.plan.runtime, sheriffPolicyValue().modules['robin-tools'].versions['1.2.3'].runtime);
    const persisted = await readFile(join(root, 'jobs', 'persistent-job.json'), 'utf8');
    assert.equal(persisted.includes('secret-frontend-token'), false);
    assert.equal(persisted.includes('secret-backend-token'), false);
    assert.equal(persisted.includes('.new-'), false);
    await close(server);

    server = await createInstallerServer({ secret, mode: 'dry-run', policy, stateDir: root });
    baseUrl = await listen(server);
    const restored = await signedFetch(baseUrl, 'GET', '/api/jobs/persistent-job');
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).data.status, 'succeeded');
    await close(server);
  });

  it('uses a separate scoped Docker login for each paid service pull', async () => {
    const calls = [];
    const docker = async (args, options = {}) => {
      calls.push({ args, options });
      if (args[0] === 'container' && args[1] === 'inspect') throw new Error('not found');
      if (args[0] === 'inspect') {
        return { stdout: '{"Status":"running","Health":{"Status":"healthy"}}', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const server = await createInstallerServer({
      secret,
      mode: 'docker',
      policy: parsePolicy(sheriffPolicyValue()),
      stateDir: stateDir(),
      docker,
    });
    const baseUrl = await listen(server);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const response = await signedFetch(baseUrl, 'POST', '/api/jobs', {
      jobId: 'two-service-job',
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '1.2.3',
      registryCredentials: [{
        repository: 'paid/tools-frontend',
        registry: 'sheriff.robinmta.com',
        username: 'activation-1',
        password: 'frontend-token',
        expiresAt,
      }, {
        repository: 'paid/tools-backend',
        registry: 'sheriff.robinmta.com',
        username: 'activation-1',
        password: 'backend-token',
        expiresAt,
      }],
    });
    assert.equal(response.status, 202);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const poll = await signedFetch(baseUrl, 'GET', '/api/jobs/two-service-job');
      if ((await poll.json()).data.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const logins = calls.filter((call) => call.args[0] === 'login');
    const pulls = calls.filter((call) => call.args[0] === 'pull');
    assert.equal(logins.length, 2);
    assert.deepEqual(logins.map((call) => call.options.stdin), ['frontend-token', 'backend-token']);
    assert.notEqual(logins[0].options.env.DOCKER_CONFIG, logins[1].options.env.DOCKER_CONFIG);
    assert.deepEqual(pulls.map((call) => call.args[1]), [
      `sheriff.robinmta.com/paid/tools-frontend@${digest}`,
      `sheriff.robinmta.com/paid/tools-backend@sha256:${'b'.repeat(64)}`,
    ]);
    assert.deepEqual(
      pulls.map((call) => call.options.env.DOCKER_CONFIG),
      logins.map((call) => call.options.env.DOCKER_CONFIG),
    );
    await close(server);
  });

  it('is idempotent by job id and allows only one active job per module', async () => {
    let releaseJob = () => {};
    let pullStarted;
    const pulling = new Promise((resolve) => { pullStarted = resolve; });
    const docker = async (args) => {
      if (args[0] === 'container' && args[1] === 'inspect') throw new Error('not found');
      if (args[0] === 'pull') {
        await new Promise((resolve) => {
          releaseJob = resolve;
          pullStarted();
        });
      }
      return { stdout: args[0] === 'inspect' ? '{"Status":"running","Health":{"Status":"healthy"}}' : '', stderr: '' };
    };
    const server = await createInstallerServer({
      secret,
      mode: 'docker',
      policy: parsePolicy(policyValue()),
      stateDir: stateDir(),
      docker,
    });
    const baseUrl = await listen(server);
    // Released and closed even when an assertion fails, so a parked job
    // cannot keep the test process alive.
    try {
      const firstJob = {
        jobId: 'job-one',
        action: 'install',
        moduleSlug: 'robin-tools',
        version: '1.2.3',
      };
      assert.equal((await signedFetch(baseUrl, 'POST', '/api/jobs', firstJob)).status, 202);
      assert.equal((await signedFetch(baseUrl, 'POST', '/api/jobs', firstJob)).status, 200);
      assert.equal((await signedFetch(baseUrl, 'POST', '/api/jobs', {
        ...firstJob,
        jobId: 'job-two',
      })).status, 409);
      // Wait for the job to reach its pull, however slow the runner is.
      await Promise.race([
        pulling,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('job never reached docker pull')), 10_000).unref()),
      ]);
      releaseJob();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const poll = await signedFetch(baseUrl, 'GET', '/api/jobs/job-one');
        const status = (await poll.json()).data.status;
        if (status === 'succeeded' || status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      releaseJob();
      await close(server);
    }
  });
});
