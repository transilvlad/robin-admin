#!/usr/bin/env node
// Static guard for the Compose layouts: every service follows the Robin suite
// conventions. Container name equals service name and starts with `suite-`,
// every service has a healthcheck, and network aliases are role aliases only.
import { execFileSync } from 'node:child_process';

const LAYOUTS = [
  ['base', ['docker-compose.yaml']],
  ['suite', ['docker-compose.yaml', 'docker-compose.suite.yaml']],
  ['host', ['docker-compose.yaml', 'docker-compose.host.yaml']],
  ['dev', ['docker-compose.yaml', 'docker-compose.dev.yaml']],
  ['suite+dev', ['docker-compose.yaml', 'docker-compose.suite.yaml', 'docker-compose.dev.yaml']],
];
const ROLE_ALIAS = /^[a-z0-9]+(-[a-z0-9]+)*-(backend|frontend|gateway)$/;
// Placeholders for required variables; the check reads structure, not values.
const ENV = {
  ...process.env,
  SESSION_SECRET: 'x', ROBIN_ADMIN_ENCRYPTION_KEY: 'x', DB_PASSWORD: 'x',
  MODULE_INSTALLER_SIGNING_SECRET: 'x', MODULE_PROXY_SECRETS_JSON: '{}',
  SUITE_AGENT_CREDENTIAL: 'x', TELEMETRY_DEV_API_KEY: 'x',
};

const problems = [];
for (const [layout, files] of LAYOUTS) {
  const args = ['compose', ...files.flatMap(file => ['-f', file]), '--profile', '*', 'config', '--format', 'json'];
  const config = JSON.parse(execFileSync('docker', args, { env: ENV, encoding: 'utf8' }));
  for (const [name, service] of Object.entries(config.services)) {
    const where = `${layout}: ${name}`;
    if (!name.startsWith('suite-')) problems.push(`${where}: service name must start with "suite-"`);
    if (service.container_name !== name) problems.push(`${where}: container_name must equal the service name (is ${service.container_name ?? 'unset'})`);
    if (!service.healthcheck || service.healthcheck.disable) problems.push(`${where}: missing healthcheck`);
    for (const [network, settings] of Object.entries(service.networks ?? {})) {
      for (const alias of settings?.aliases ?? []) {
        if (!ROLE_ALIAS.test(alias)) problems.push(`${where}: alias "${alias}" on ${network} is not a role alias (<role>-backend|frontend|gateway)`);
      }
    }
  }
}

if (problems.length) {
  console.error(`Compose convention check failed:\n${[...new Set(problems)].map(problem => `- ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log(`Compose convention check passed for ${LAYOUTS.map(([layout]) => layout).join(', ')}.`);
