import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDockerRunner, createInstallerServer, parsePolicy, signRequest } from '../src/installer.js';

test('real Linux fixed-port collision, maintenance switch, and failed-upgrade recovery', {
  skip: process.env.ROBIN_INSTALLER_DOCKER_PROOF !== '1',
  timeout: 240_000,
}, async () => {
  const docker = createDockerRunner();
  const suffix = randomUUID().slice(0, 8);
  const slug = `fixture-${suffix}`;
  const registry = `${slug}-registry`;
  const volume = `${slug}-data`;
  const root = await mkdtemp(join(tmpdir(), 'robin-installer-fixed-port-'));
  const secret = randomUUID() + randomUUID();
  const ownedNames = new Set([registry, slug]);
  let server;
  let localImage;
  const close = async () => {
    if (!server) return;
    const closed = once(server, 'close');
    server.close();
    await closed;
    server = null;
  };
  try {
    const availablePort = async () => {
      const result = await docker(['run', '--rm', '--network', 'host', 'python:3.13-alpine', 'python', '-c',
        'import socket; s=socket.socket(); s.bind(("0.0.0.0",0)); print(s.getsockname()[1]); s.close()']);
      const value = Number(result.stdout);
      assert.ok(Number.isInteger(value) && value > 0);
      return value;
    };
    const registryPort = await availablePort();
    await docker(['run', '-d', '--name', registry, '--network', 'host',
      '--label', `robin.test.owner=${slug}`, '-e', `REGISTRY_HTTP_ADDR=127.0.0.1:${registryPort}`, 'registry:3']);
    const address = `localhost:${registryPort}`;
    localImage = `${address}/fixed-port:fixture`;
    await docker(['build', '--quiet', '-t', localImage, fileURLToPath(new URL('./fixtures/fixed-port', import.meta.url))]);
    await docker(['push', localImage]);
    const image = JSON.parse((await docker(['image', 'inspect', localImage])).stdout)[0].RepoDigests
      .find(value => value.startsWith(`${address}/fixed-port@`));
    assert.ok(image);
    await docker(['volume', 'create', '--label', `robin.test.owner=${slug}`, volume]);
    // Find an unused port in the Linux Docker-host namespace without touching existing services.
    const port = await availablePort();
    await docker(['run', '-d', '--name', slug, '--network', 'host',
      '--label', 'robin.admin.managed=true', '--label', `robin.admin.module=${slug}`,
      '-e', `FIXTURE_PORT=${port}`, '--mount', `type=volume,src=${volume},dst=/data`, image]);
    for (let attempt = 0; attempt < 30; attempt++) {
      const info = JSON.parse((await docker(['inspect', slug])).stdout)[0];
      if (info.State.Health.Status === 'healthy') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await docker(['exec', slug, 'sh', '-c', 'printf preserved-fixture > /data/proof']);
    const original = JSON.parse((await docker(['inspect', slug])).stdout)[0];
    assert.equal(original.State.Health.Status, 'healthy');
    const policy = (strategy, failHealth) => parsePolicy({ modules: { [slug]: {
      upgradeStrategy: strategy, versions: { '1.0.0': {
        runtime: { backendUrl: null, assetBaseUrl: `http://host.docker.internal:${port}`, probeUrl: `http://host.docker.internal:${port}/health` },
        services: [{ name: 'web', image, containerName: slug, network: 'host', ports: [],
          volumes: [{ name: volume, target: '/data' }], allowedEnvKeys: ['FIXTURE_PORT', 'FAIL_HEALTH'],
          environment: { FIXTURE_PORT: String(port), FAIL_HEALTH: String(failHealth) }, healthTimeoutSeconds: 10 }],
      } },
    } } });
    const run = async (strategy, failHealth, jobId) => {
      await close();
      server = await createInstallerServer({ secret, mode: 'docker', stateDir: root, policy: policy(strategy, failHealth), docker });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const base = `http://127.0.0.1:${server.address().port}`;
      const request = async (method, path, input) => {
        const body = input ? JSON.stringify(input) : '';
        const timestamp = String(Date.now());
        const response = await fetch(base + path, { method, body: body || undefined, headers: {
          'content-type': 'application/json', 'x-robin-installer-timestamp': timestamp,
          'x-robin-installer-signature': signRequest(secret, timestamp, method, path, body),
        } });
        assert.equal(response.ok, true, await response.clone().text());
        return (await response.json()).data;
      };
      const id = `${slug}-${jobId}`;
      ownedNames.add(`${slug}-staged-${id.slice(-12)}`);
      ownedNames.add(`${slug}-rollback-${id.slice(-12)}`);
      await request('POST', '/api/jobs', { jobId: id, moduleSlug: slug, version: '1.0.0', action: 'upgrade', maintenanceAcknowledged: true });
      for (let attempt = 0; attempt < 300; attempt++) {
        const job = await request('GET', `/api/jobs/${id}`);
        if (['succeeded', 'failed'].includes(job.status)) return job;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('Fixture job deadline exceeded.');
    };
    const collision = await run('stage-first', false, 'collision');
    assert.equal(collision.status, 'failed');
    assert.match(collision.message, /health|bind|running/i);
    assert.equal(JSON.parse((await docker(['inspect', slug])).stdout)[0].Id, original.Id);
    assert.equal((await run('maintenance', false, 'success')).status, 'succeeded');
    const switched = JSON.parse((await docker(['inspect', slug])).stdout)[0];
    assert.notEqual(switched.Id, original.Id);
    assert.equal(switched.State.Health.Status, 'healthy');
    const failed = await run('maintenance', true, 'unhealthy');
    assert.equal(failed.status, 'failed');
    const restored = JSON.parse((await docker(['inspect', slug])).stdout)[0];
    assert.equal(restored.Id, switched.Id);
    assert.equal(restored.State.Status, 'running');
    assert.equal((await docker(['exec', slug, 'cat', '/data/proof'])).stdout, 'preserved-fixture');
    assert.deepEqual(await readdir(join(root, 'transactions')), []);
    console.log('Disposable Linux Docker host-network proof: collision rejected, maintenance healthy, unhealthy upgrade restored exact original and data.');
  } finally {
    await close();
    for (const name of ownedNames) {
      try { await docker(['rm', '-f', name]); }
      catch (error) { if (!/no such (container|object)/i.test(error.message)) throw error; }
    }
    await docker(['volume', 'rm', volume]).catch(error => {
      if (!/no such volume/i.test(error.message)) throw error;
    });
    if (localImage) await docker(['image', 'rm', localImage]);
    await rm(root, { recursive: true, force: true });
  }
});
