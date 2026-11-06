#!/usr/bin/env node
// Static guard for the Compose layouts: every service follows the Robin suite
// conventions. Container name equals service name and starts with `suite-`,
// healthchecks are defined when the image supports them, and network aliases
// are role aliases only.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LAYOUTS = [
  ['base', ['docker-compose.yaml']],
  ['suite', ['docker-compose.yaml', 'docker-compose.suite.yaml']],
  ['host', ['docker-compose.yaml', 'docker-compose.host.yaml']],
  ['dev', ['docker-compose.yaml', 'docker-compose.dev.yaml']],
  ['suite+dev', ['docker-compose.yaml', 'docker-compose.suite.yaml', 'docker-compose.dev.yaml']],
];
const ROLE_ALIAS = /^[a-z0-9]+(-[a-z0-9]+)*-(backend|frontend|gateway)$/;
// VictoriaLogs is distroless; Robin Admin and CI probe its HTTP health endpoint.
const HEALTHCHECK_EXEMPT = new Set(['suite-victorialogs']);
// Placeholders for required variables; the check reads structure, not values.
const ENV = {
  ...process.env,
  SESSION_SECRET: 'x', ROBIN_ADMIN_ENCRYPTION_KEY: 'x', DB_PASSWORD: 'x',
  MODULE_INSTALLER_SIGNING_SECRET: 'x', MODULE_PROXY_SECRETS_JSON: '{}',
  SUITE_AGENT_CREDENTIAL: 'x', TELEMETRY_DEV_API_KEY: 'x',
  SUITE_LOG_MOUNT: process.env.SUITE_LOG_MOUNT || process.cwd(),
};

const problems = [];
for (const [layout, files] of LAYOUTS) {
  const args = ['compose', ...files.flatMap(file => ['-f', file]), '--profile', '*', 'config', '--format', 'json'];
  const config = JSON.parse(execFileSync('docker', args, { env: ENV, encoding: 'utf8' }));
  for (const [name, service] of Object.entries(config.services)) {
    const where = `${layout}: ${name}`;
    if (!name.startsWith('suite-')) problems.push(`${where}: service name must start with "suite-"`);
    if (service.container_name !== name) problems.push(`${where}: container_name must equal the service name (is ${service.container_name ?? 'unset'})`);
    if ((!service.healthcheck || service.healthcheck.disable) && !HEALTHCHECK_EXEMPT.has(name)) {
      problems.push(`${where}: missing healthcheck`);
    }
    for (const [network, settings] of Object.entries(service.networks ?? {})) {
      for (const alias of settings?.aliases ?? []) {
        if (!ROLE_ALIAS.test(alias)) problems.push(`${where}: alias "${alias}" on ${network} is not a role alias (<role>-backend|frontend|gateway)`);
      }
    }
  }
  if (layout === 'suite' || layout === 'suite+dev') {
    for (const [name, target] of [['suite-admin-agent', '/logs'], ['suite-admin', '/mnt/logs/robin']]) {
      const mount = config.services[name]?.volumes?.find((volume) => volume.target === target);
      if (!mount?.read_only || mount.bind?.create_host_path !== false) {
        problems.push(`${layout}: ${name} ${target} must be a read-only bind without automatic host directory creation`);
      }
    }
  }
}

// A Git include resolves relative binds in its downloaded project, not the
// parent suite. Exercise that layout without downloading or starting anything.
const fixture = mkdtempSync(join(tmpdir(), 'robin-admin-compose-'));
try {
  const downloaded = join(fixture, 'downloaded');
  const logs = join(fixture, 'suite-logs');
  mkdirSync(downloaded);
  mkdirSync(join(logs, 'robin'), { recursive: true });
  for (const file of ['docker-compose.yaml', 'docker-compose.suite.yaml']) {
    copyFileSync(resolve(file), join(downloaded, file));
  }
  const parent = join(fixture, 'compose.yaml');
  const envFile = join(fixture, 'empty.env');
  writeFileSync(envFile, '');
  writeFileSync(parent, `include:\n  - path:\n      - ${JSON.stringify(join(downloaded, 'docker-compose.yaml'))}\n      - ${JSON.stringify(join(downloaded, 'docker-compose.suite.yaml'))}\n`);
  const args = ['compose', '--env-file', envFile, '-f', parent, 'config', '--format', 'json'];
  const env = { ...ENV, SUITE_LOG_MOUNT: logs };
  delete env.ROBIN_LOG_MOUNT;
  const config = JSON.parse(execFileSync('docker', args, { env, encoding: 'utf8' }));
  for (const [name, target, expected] of [
    ['suite-admin-agent', '/logs', logs],
    ['suite-admin', '/mnt/logs/robin', join(logs, 'robin')],
  ]) {
    const mount = config.services[name]?.volumes?.find((volume) => volume.target === target);
    if (!mount || resolve(mount.source) !== resolve(expected)) {
      problems.push(`included suite: ${name} ${target} must resolve to the configured host path`);
    }
  }
  delete env.SUITE_LOG_MOUNT;
  const missing = spawnSync('docker', args, { env, encoding: 'utf8' });
  if (missing.status === 0 || !missing.stderr.includes('SUITE_LOG_MOUNT')) {
    problems.push('included suite: an unset SUITE_LOG_MOUNT must fail with an actionable error');
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`Compose convention check failed:\n${[...new Set(problems)].map(problem => `- ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log(`Compose convention check passed for ${LAYOUTS.map(([layout]) => layout).join(', ')}.`);
