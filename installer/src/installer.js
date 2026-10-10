import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ACTIONS = new Set(['install', 'upgrade', 'start', 'stop', 'uninstall']);
const JOB_KEYS = new Set(['jobId', 'action', 'moduleSlug', 'version', 'registryCredentials', 'maintenanceAcknowledged']);
const CREDENTIAL_KEYS = new Set(['repository', 'registry', 'username', 'password', 'expiresAt']);
const SERVICE_KEYS = new Set([
  'name',
  'image',
  'containerName',
  'network',
  'ports',
  'volumes',
  'environment',
  'allowedEnvKeys',
  'healthTimeoutSeconds',
]);
const PORT_KEYS = new Set(['hostIp', 'hostPort', 'containerPort', 'protocol']);
const VOLUME_KEYS = new Set(['name', 'target', 'readOnly']);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const REGISTRY_PATTERN = /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?$/;
const REPOSITORY_PATTERN = /^[a-z0-9][a-z0-9._/-]{1,200}$/;
const SHERIFF_REGISTRY = 'sheriff.robinmta.com';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_CREDENTIAL_LIFETIME_MS = 15 * 60_000;
const DEFAULT_DOCKER_TIMEOUT_MS = 120_000;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unsupported field "${key}".`);
    }
  }
}

function imageRegistry(image) {
  const first = image.split('/')[0];
  return first.includes('.') || first.includes(':') || first === 'localhost' ? first : 'docker.io';
}

function imageRepository(image) {
  const imageName = image.slice(0, image.indexOf('@'));
  const registry = imageRegistry(image);
  return registry === 'docker.io' ? imageName : imageName.slice(registry.length + 1);
}

export function signRequest(secret, timestamp, method, path, body = '') {
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`)
    .digest('hex');
}

export function verifyRequestSignature(secret, timestamp, method, path, body, signature, now = Date.now()) {
  if (
    !secret
    || typeof timestamp !== 'string'
    || !/^[0-9]{10,16}$/.test(timestamp)
    || Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_MS
    || typeof signature !== 'string'
    || !/^[a-f0-9]{64}$/i.test(signature)
  ) {
    return false;
  }

  const expected = Buffer.from(signRequest(secret, timestamp, method, path, body), 'hex');
  const received = Buffer.from(signature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function normalizePort(port, label) {
  if (!port || typeof port !== 'object' || Array.isArray(port)) {
    throw new Error(`${label} must be an object.`);
  }
  assertExactKeys(port, PORT_KEYS, label);
  const hostIp = port.hostIp ?? '127.0.0.1';
  const protocol = port.protocol ?? 'tcp';
  if (hostIp !== '127.0.0.1' && hostIp !== '0.0.0.0') {
    throw new Error(`${label}.hostIp must be fixed to 127.0.0.1 or 0.0.0.0.`);
  }
  if (!Number.isInteger(port.hostPort) || port.hostPort < 1 || port.hostPort > 65535) {
    throw new Error(`${label}.hostPort is invalid.`);
  }
  if (!Number.isInteger(port.containerPort) || port.containerPort < 1 || port.containerPort > 65535) {
    throw new Error(`${label}.containerPort is invalid.`);
  }
  if (protocol !== 'tcp' && protocol !== 'udp') {
    throw new Error(`${label}.protocol is invalid.`);
  }
  return { hostIp, hostPort: port.hostPort, containerPort: port.containerPort, protocol };
}

function normalizeVolume(volume, label) {
  if (!volume || typeof volume !== 'object' || Array.isArray(volume)) {
    throw new Error(`${label} must be an object.`);
  }
  assertExactKeys(volume, VOLUME_KEYS, label);
  if (!NAME_PATTERN.test(volume.name || '')) {
    throw new Error(`${label}.name must be a fixed named volume.`);
  }
  if (typeof volume.target !== 'string' || !volume.target.startsWith('/') || /[\r\n]/.test(volume.target)) {
    throw new Error(`${label}.target is invalid.`);
  }
  return { name: volume.name, target: volume.target, readOnly: volume.readOnly === true };
}

function normalizeService(service, moduleSlug, version, index) {
  const label = `${moduleSlug}@${version}.services[${index}]`;
  if (!service || typeof service !== 'object' || Array.isArray(service)) {
    throw new Error(`${label} must be an object.`);
  }
  assertExactKeys(service, SERVICE_KEYS, label);
  if (!NAME_PATTERN.test(service.name || '')) {
    throw new Error(`${label}.name is invalid.`);
  }
  if (!IMAGE_PATTERN.test(service.image || '')) {
    throw new Error(`${label}.image must use an immutable image@sha256 digest.`);
  }
  if (!NAME_PATTERN.test(service.containerName || '')) {
    throw new Error(`${label}.containerName is invalid.`);
  }
  if (!NAME_PATTERN.test(service.network || '')) {
    throw new Error(`${label}.network is invalid.`);
  }

  const allowedEnvKeys = service.allowedEnvKeys ?? [];
  if (!Array.isArray(allowedEnvKeys) || allowedEnvKeys.some((key) => typeof key !== 'string' || !ENV_KEY_PATTERN.test(key))) {
    throw new Error(`${label}.allowedEnvKeys is invalid.`);
  }
  const allowedEnvSet = new Set(allowedEnvKeys);
  const environment = service.environment ?? {};
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error(`${label}.environment is invalid.`);
  }
  for (const [key, value] of Object.entries(environment)) {
    if (!allowedEnvSet.has(key) || typeof value !== 'string' || value.length > 4096 || /[\u0000\r\n]/.test(value)) {
      throw new Error(`${label}.environment contains a non-allowlisted or invalid value.`);
    }
    if (/^(?:REPLACE_|<REPLACE)/.test(value)) {
      throw new Error(`${label}.environment contains an unreplaced operator placeholder.`);
    }
  }

  const healthTimeoutSeconds = service.healthTimeoutSeconds ?? 60;
  if (!Number.isInteger(healthTimeoutSeconds) || healthTimeoutSeconds < 1 || healthTimeoutSeconds > 300) {
    throw new Error(`${label}.healthTimeoutSeconds is invalid.`);
  }

  return {
    name: service.name,
    image: service.image,
    containerName: service.containerName,
    network: service.network,
    ports: (service.ports ?? []).map((port, portIndex) => normalizePort(port, `${label}.ports[${portIndex}]`)),
    volumes: (service.volumes ?? []).map((volume, volumeIndex) => normalizeVolume(volume, `${label}.volumes[${volumeIndex}]`)),
    environment,
    allowedEnvKeys,
    healthTimeoutSeconds,
  };
}

function normalizeRuntime(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must define runtime addresses reachable from Admin.`);
  }
  assertExactKeys(value, new Set(['backendUrl', 'assetBaseUrl', 'probeUrl']), label);
  const runtime = {};
  for (const key of ['backendUrl', 'assetBaseUrl', 'probeUrl']) {
    if (key === 'backendUrl' && value[key] === null) {
      runtime[key] = null;
      continue;
    }
    const raw = value[key];
    let url;
    try { url = new URL(raw); } catch { throw new Error(`${label}.${key} must be an absolute HTTP(S) URL.`); }
    if (typeof raw !== 'string' || raw.length > 2048 || /[\s?#]/.test(raw)
      || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || ['0.0.0.0', '[::]'].includes(url.hostname)
      || (key === 'assetBaseUrl' && url.pathname !== '/')) {
      throw new Error(`${label}.${key} is invalid; use a reachable HTTP(S) address without credentials, query or fragment (assets require an origin).`);
    }
    runtime[key] = key === 'probeUrl' ? url.href : url.href.replace(/\/$/, '');
  }
  return runtime;
}

export function parsePolicy(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Installer policy must be a JSON object.');
  }
  assertExactKeys(parsed, new Set(['modules']), 'Installer policy');
  if (!parsed.modules || typeof parsed.modules !== 'object' || Array.isArray(parsed.modules)) {
    throw new Error('Installer policy.modules must be an object.');
  }

  const modules = new Map();
  for (const [slug, modulePolicy] of Object.entries(parsed.modules)) {
    if (!SLUG_PATTERN.test(slug) || !modulePolicy || typeof modulePolicy !== 'object' || Array.isArray(modulePolicy)) {
      throw new Error(`Invalid module policy for "${slug}".`);
    }
    assertExactKeys(modulePolicy, new Set(['versions', 'upgradeStrategy']), `Policy module ${slug}`);
    if (!['stage-first', 'maintenance'].includes(modulePolicy.upgradeStrategy)) {
      throw new Error(`Policy module ${slug} must explicitly select upgradeStrategy stage-first or maintenance.`);
    }
    if (!modulePolicy.versions || typeof modulePolicy.versions !== 'object' || Array.isArray(modulePolicy.versions)) {
      throw new Error(`Policy module ${slug} must define versions.`);
    }
    const versions = new Map();
    if (Object.keys(modulePolicy.versions).length === 0) throw new Error(`Policy module ${slug} must approve at least one version.`);
    for (const [version, versionPolicy] of Object.entries(modulePolicy.versions)) {
      if (!VERSION_PATTERN.test(version) || !versionPolicy || typeof versionPolicy !== 'object' || Array.isArray(versionPolicy)) {
        throw new Error(`Invalid policy version ${slug}@${version}.`);
      }
      assertExactKeys(versionPolicy, new Set(['services', 'runtime']), `Policy version ${slug}@${version}`);
      if (!Array.isArray(versionPolicy.services) || versionPolicy.services.length === 0) {
        throw new Error(`Policy version ${slug}@${version} must define services.`);
      }
      versions.set(version, {
        runtime: normalizeRuntime(versionPolicy.runtime, `${slug}@${version}.runtime`),
        services: versionPolicy.services.map((service, index) => normalizeService(service, slug, version, index)),
      });
      if (new Set(versionPolicy.services.map(service => service.name)).size !== versionPolicy.services.length
        || new Set(versionPolicy.services.map(service => service.containerName)).size !== versionPolicy.services.length) {
        throw new Error(`Policy version ${slug}@${version} contains duplicate services or container names.`);
      }
    }
    modules.set(slug, { versions, upgradeStrategy: modulePolicy.upgradeStrategy });
  }
  return modules;
}

export async function validatePolicyFile(policyPath) {
  if (!policyPath) {
    throw new Error('MODULE_INSTALLER_POLICY_FILE is required.');
  }
  const file = await lstat(policyPath);
  if (!file.isFile()) {
    throw new Error('Installer policy must be a regular file.');
  }
  if (process.platform !== 'win32') {
    const permissions = file.mode & 0o777;
    // 0440 is included because systemd (254+) LoadCredential mounts are
    // group-readable by design, with real access enforced via ACL to only
    // the unit's own user; that is not a wider group-readable exposure.
    if (permissions !== 0o600 && permissions !== 0o400 && permissions !== 0o440) {
      throw new Error(
        `Installer policy permissions ${permissions.toString(8).padStart(3, '0')} are unsafe; use 0600, 0400, or the systemd LoadCredential default of 0440.`,
      );
    }
  }
}

export async function loadPolicy(policyPath) {
  await validatePolicyFile(policyPath);
  return parsePolicy(await readFile(policyPath, 'utf8'));
}

function validateRegistryCredential(value, service, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('registryCredential must be an object.');
  }
  assertExactKeys(value, CREDENTIAL_KEYS, 'registryCredential');
  if (
    typeof value.registry !== 'string'
    || !REGISTRY_PATTERN.test(value.registry)
    || value.registry !== SHERIFF_REGISTRY
    || typeof value.repository !== 'string'
    || !REPOSITORY_PATTERN.test(value.repository)
    || typeof value.username !== 'string'
    || value.username.length < 1
    || value.username.length > 256
    || typeof value.password !== 'string'
    || value.password.length < 1
    || value.password.length > 8192
    || typeof value.expiresAt !== 'string'
  ) {
    throw new Error('registryCredential is invalid.');
  }
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > MAX_CREDENTIAL_LIFETIME_MS) {
    throw new Error('registryCredential must be valid for no more than 15 minutes.');
  }
  if (
    imageRegistry(service.image) !== value.registry
    || imageRepository(service.image) !== value.repository
  ) {
    throw new Error('registryCredentials repository does not match an approved service image.');
  }
  return {
    repository: value.repository,
    registry: value.registry,
    username: value.username,
    password: value.password,
    expiresAt: value.expiresAt,
    serviceName: service.name,
  };
}

function validateRegistryCredentials(value, services, action, now) {
  if (value === undefined) {
    value = [];
  }
  if (!Array.isArray(value) || value.length > 2) {
    throw new Error('registryCredentials must be an array with at most two entries.');
  }
  if (value.length > 0 && action !== 'install' && action !== 'upgrade') {
    throw new Error('registryCredentials are only accepted for install or upgrade.');
  }
  if (action !== 'install' && action !== 'upgrade') {
    return [];
  }

  const privateServices = services.filter((service) => imageRegistry(service.image) === SHERIFF_REGISTRY);
  const privateRepositories = privateServices.map((service) => imageRepository(service.image));
  if (new Set(privateRepositories).size !== privateRepositories.length) {
    throw new Error('Approved Sheriff services must use distinct repositories.');
  }
  if (value.length !== privateServices.length) {
    throw new Error('registryCredentials must cover each approved Sheriff service exactly once.');
  }
  const unmatched = [...privateServices];
  return value.map((credential) => {
    const repository = credential && typeof credential === 'object' ? credential.repository : null;
    const matchIndex = unmatched.findIndex((service) => imageRepository(service.image) === repository);
    if (matchIndex < 0) {
      throw new Error('registryCredentials repository does not match an approved service image.');
    }
    const [service] = unmatched.splice(matchIndex, 1);
    return validateRegistryCredential(credential, service, now);
  });
}

export function buildJobPlan(job, policy, now = Date.now()) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new Error('Job body must be a JSON object.');
  }
  assertExactKeys(job, JOB_KEYS, 'Job');
  if (!ACTIONS.has(job.action)) {
    throw new Error('Unsupported installer action.');
  }
  if (typeof job.moduleSlug !== 'string' || !SLUG_PATTERN.test(job.moduleSlug)) {
    throw new Error('Invalid module slug.');
  }
  if (typeof job.version !== 'string' || !VERSION_PATTERN.test(job.version)) {
    throw new Error('A valid module version is required.');
  }
  if (job.jobId !== undefined && (typeof job.jobId !== 'string' || !NAME_PATTERN.test(job.jobId))) {
    throw new Error('Invalid job id.');
  }

  const modulePolicy = policy.get(job.moduleSlug);
  const lifecycle = ['start', 'stop', 'uninstall'].includes(job.action);
  const versionPolicy = modulePolicy?.versions.get(job.version)
    ?? (lifecycle ? modulePolicy?.versions.values().next().value : undefined);
  if (!versionPolicy) {
    throw new Error(`Module version ${job.moduleSlug}@${job.version} is not approved by local policy.`);
  }
  if (job.maintenanceAcknowledged !== undefined && typeof job.maintenanceAcknowledged !== 'boolean') {
    throw new Error('maintenanceAcknowledged must be a boolean.');
  }
  if (job.action === 'upgrade' && modulePolicy.upgradeStrategy === 'maintenance' && job.maintenanceAcknowledged !== true) {
    throw new Error('Maintenance upgrades require explicit downtime acknowledgement.');
  }
  const registryCredentials = validateRegistryCredentials(
    job.registryCredentials,
    versionPolicy.services,
    job.action,
    now,
  );

  return {
    jobId: job.jobId || randomUUID(),
    action: job.action,
    moduleSlug: job.moduleSlug,
    version: job.version,
    services: versionPolicy.services,
    runtime: versionPolicy.runtime,
    upgradeStrategy: modulePolicy.upgradeStrategy,
    maintenanceAcknowledged: job.maintenanceAcknowledged === true,
    registryCredentials,
  };
}

function createArgs(service, name, includePorts) {
  const args = [
    'create',
    '--name', name,
    '--network', service.network,
    '--label', 'robin.admin.managed=true',
    '--label', `robin.admin.module=${service.moduleSlug}`,
    '--label', `robin.admin.version=${service.version}`,
    '--label', `robin.admin.job=${service.jobId}`,
  ];
  if (includePorts) {
    args.push('--restart', 'unless-stopped');
    for (const port of service.ports) {
      args.push('--publish', `${port.hostIp}:${port.hostPort}:${port.containerPort}/${port.protocol}`);
    }
  }
  for (const volume of service.volumes) {
    args.push('--mount', `type=volume,src=${volume.name},dst=${volume.target}${volume.readOnly ? ',readonly' : ''}`);
  }
  for (const key of service.allowedEnvKeys) {
    if (Object.hasOwn(service.environment, key)) {
      args.push('--env', `${key}=${service.environment[key]}`);
    }
  }
  args.push(service.image);
  return args;
}

export function buildDockerPlan(plan) {
  const suffix = plan.jobId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(-12) || 'job';
  return plan.services.map((service) => {
    const approved = { ...service, moduleSlug: plan.moduleSlug, version: plan.version, jobId: plan.jobId };
    return {
      service: service.name,
      image: service.image,
      canonicalName: service.containerName,
      stagedName: `${service.containerName}-staged-${suffix}`,
      rollbackName: `${service.containerName}-rollback-${suffix}`,
      pull: ['pull', service.image],
      createStaged: createArgs(approved, `${service.containerName}-staged-${suffix}`, false),
      createFinal: createArgs(approved, service.containerName, true),
    };
  });
}

export function createDockerRunner(options = {}) {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;
  return (args, commandOptions = {}) => new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: [commandOptions.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: commandOptions.env ? { ...process.env, ...commandOptions.env } : process.env,
    });
    if (commandOptions.stdin !== undefined) {
      child.stdin.end(commandOptions.stdin);
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, Math.min(commandTimeoutMs, commandOptions.timeoutMs ?? commandTimeoutMs));
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 1024 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error(
          signal === 'SIGKILL'
            ? `docker command exceeded ${commandTimeoutMs}ms`
            : stderr.trim() || stdout.trim() || `docker exited with ${code}`,
        ));
      }
    });
  });
}

async function waitHealthy(docker, name, timeoutSeconds, dockerEnv, deadline) {
  const timeoutAt = Math.min(Date.now() + timeoutSeconds * 1000, deadline);
  while (Date.now() < timeoutAt) {
    const result = await docker(['inspect', '--format', '{{json .State}}', name], { env: dockerEnv });
    const state = JSON.parse(result.stdout);
    if (state.Status === 'running' && !state.Health) throw new Error(`Container ${name} has no image health check.`);
    if (state.Status === 'running' && state.Health?.Status === 'healthy') return;
    if (state.Status === 'exited' || state.Health?.Status === 'unhealthy') {
      throw new Error(`Container ${name} failed its health check.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Container ${name} did not become healthy in time.`);
}

async function pullServiceImage(plan, service, docker, stateDir) {
  const credential = plan.registryCredentials.find((candidate) => candidate.serviceName === service.name);
  if (!credential) {
    return docker(['pull', service.image]);
  }
  const configDir = join(stateDir, 'credentials', plan.jobId, service.name);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  const dockerEnv = { DOCKER_CONFIG: configDir };
  try {
    await docker(
      ['login', credential.registry, '--username', credential.username, '--password-stdin'],
      { env: dockerEnv, stdin: credential.password },
    );
    return await docker(['pull', service.image], { env: dockerEnv });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

async function inspectModule(docker, plan) {
  const services = [];
  for (const service of plan.services) {
    try {
      const result = await docker([
        'inspect',
        '--format',
        '{{json .State}}|{{.Config.Image}}',
        service.containerName,
      ]);
      const separator = result.stdout.lastIndexOf('|');
      services.push({
        service: service.name,
        containerName: service.containerName,
        state: JSON.parse(result.stdout.slice(0, separator)),
        image: result.stdout.slice(separator + 1),
      });
    } catch (error) {
      services.push({ service: service.name, containerName: service.containerName, state: null, image: null });
    }
  }
  return { services };
}

async function executeInstall(plan, docker, stateDir, deadline) {
  const recoveryDocker = docker;
  docker = (args, options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Installer job exceeded its time limit.');
    return recoveryDocker(args, { ...options, timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS, remaining) });
  };
  const operations = buildDockerPlan(plan);
  const path = join(stateDir, 'transactions', `${plan.jobId}.json`);
  const transaction = { jobId: plan.jobId, moduleSlug: plan.moduleSlug, phase: 'staging', operations: [] };
  for (const operation of operations) {
    const previous = await inspectContainer(docker, operation.canonicalName);
    if (previous) assertOwnership(previous, operation.canonicalName, plan.moduleSlug);
    if (await inspectContainer(docker, operation.rollbackName) || await inspectContainer(docker, operation.stagedName)) {
      throw new Error(`Transaction container already exists for ${operation.canonicalName}.`);
    }
    transaction.operations.push({
      canonicalName: operation.canonicalName, stagedName: operation.stagedName,
      rollbackName: operation.rollbackName, previousImage: previous?.Image ?? null,
      previousId: previous?.Id ?? null,
      previousRunning: previous?.State.Status === 'running', switchStarted: false,
    });
  }
  await atomicWriteJson(path, transaction);
  try {
    // All approved pulls finish before staging or downtime begins.
    for (const operation of operations) {
      if (Date.now() >= deadline) throw new Error('Installer job exceeded its time limit.');
      const service = plan.services.find((candidate) => candidate.name === operation.service);
      await pullServiceImage(plan, service, docker, stateDir);
    }
    if (plan.upgradeStrategy === 'stage-first') {
      for (const operation of operations) {
        if (Date.now() >= deadline) throw new Error('Installer job exceeded its time limit.');
        const service = plan.services.find((candidate) => candidate.name === operation.service);
        await docker(operation.createStaged);
        await docker(['start', operation.stagedName]);
        await waitHealthy(docker, operation.stagedName, service.healthTimeoutSeconds, undefined, deadline);
        await removeTransactionContainer(docker, operation.stagedName, transaction);
      }
    }
    transaction.phase = 'switching';
    // Recheck every original after the pulls before stopping any of them.
    for (const entry of transaction.operations) {
      const current = await inspectContainer(docker, entry.canonicalName);
      if (current) assertOwnership(current, entry.canonicalName, plan.moduleSlug);
      if ((current?.Id ?? null) !== entry.previousId || (current?.Image ?? null) !== entry.previousImage) {
        throw new Error(`Original container ${entry.canonicalName} changed during preparation.`);
      }
    }
    for (const [index, operation] of operations.entries()) {
      if (Date.now() >= deadline) throw new Error('Installer job exceeded its time limit.');
      const service = plan.services.find((candidate) => candidate.name === operation.service);
      const entry = transaction.operations[index];
      // Journal intent first so restart recovery handles every crash boundary.
      entry.switchStarted = true;
      await atomicWriteJson(path, transaction);
      if (entry.previousImage) {
        if (entry.previousRunning) await docker(['stop', operation.canonicalName]);
        await docker(['rename', operation.canonicalName, operation.rollbackName]);
      }
      if (plan.upgradeStrategy === 'maintenance') continue;
      await docker(operation.createFinal);
      await docker(['start', operation.canonicalName]);
      await waitHealthy(docker, operation.canonicalName, service.healthTimeoutSeconds, undefined, deadline);
    }
    if (plan.upgradeStrategy === 'maintenance') {
      for (const operation of operations) {
        if (Date.now() >= deadline) throw new Error('Installer job exceeded its time limit.');
        const service = plan.services.find((candidate) => candidate.name === operation.service);
        await docker(operation.createFinal);
        await docker(['start', operation.canonicalName]);
        await waitHealthy(docker, operation.canonicalName, service.healthTimeoutSeconds, undefined, deadline);
      }
    }
    transaction.phase = 'complete';
    transaction.result = {
      mode: 'docker',
      runtime: plan.runtime,
      upgradeStrategy: plan.upgradeStrategy,
      services: operations.map((operation) => operation.canonicalName),
      rollback: operations.map((operation, index) => ({
        service: operation.service, previousContainer: transaction.operations[index].previousImage ? operation.rollbackName : null,
        installedContainer: operation.canonicalName,
      })),
    };
    await atomicWriteJson(path, transaction);
    return transaction.result;
  } catch (error) {
    try {
      await rollbackTransaction(transaction, recoveryDocker);
      await removeJournal(path);
    } catch (recoveryError) {
      const failure = new Error(`${error.message} Rollback incomplete: ${recoveryError.message}`);
      failure.recoveryRequired = true;
      throw failure;
    }
    throw error;
  }
}

async function inspectContainer(docker, name) {
  let result;
  try {
    result = await docker(['container', 'inspect', '--format', '{{json .}}', name]);
  } catch (error) {
    if (/no such (object|container)|not found/i.test(error.message)) return null;
    throw error;
  }
  const container = JSON.parse(result.stdout);
  if (!container?.State || typeof container.Image !== 'string') throw new Error(`Invalid inspection of ${name}.`);
  return container;
}

async function removeContainer(docker, name) {
  try {
    await docker(['rm', '-f', name]);
  } catch (error) {
    if (!/no such (object|container)|not found/i.test(error.message)) throw error;
  }
}

function assertOwnership(container, name, moduleSlug) {
  if (container.Config?.Labels?.['robin.admin.managed'] !== 'true'
    || container.Config?.Labels?.['robin.admin.module'] !== moduleSlug) {
    throw new Error(`Container ${name} is not installer-managed for ${moduleSlug}.`);
  }
}

async function removeTransactionContainer(docker, name, transaction) {
  const container = await inspectContainer(docker, name);
  if (!container) return;
  assertOwnership(container, name, transaction.moduleSlug);
  if (container.Config.Labels['robin.admin.job'] !== transaction.jobId) {
    throw new Error(`Container ${name} does not belong to this transaction.`);
  }
  await removeContainer(docker, name);
}

async function rollbackTransaction(transaction, docker) {
  const failures = [];
  // Remove every replacement before restarting any fixed-port original.
  for (const operation of [...transaction.operations].reverse()) {
    try {
      await removeTransactionContainer(docker, operation.stagedName, transaction);
      if (!operation.switchStarted) continue;
      const canonical = await inspectContainer(docker, operation.canonicalName);
      if (!canonical) continue;
      if (operation.previousImage && canonical.Image === operation.previousImage
        && (!operation.previousId || canonical.Id === operation.previousId)) {
        assertOwnership(canonical, operation.canonicalName, transaction.moduleSlug);
        continue;
      }
      await removeTransactionContainer(docker, operation.canonicalName, transaction);
    } catch (error) {
      failures.push(`${operation.canonicalName}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
  for (const operation of [...transaction.operations].reverse()) {
    try {
      if (!operation.switchStarted) continue;
      if (!operation.previousImage) continue;
      const backup = await inspectContainer(docker, operation.rollbackName);
      if (backup) {
        assertOwnership(backup, operation.rollbackName, transaction.moduleSlug);
        if (backup.Image !== operation.previousImage || (operation.previousId && backup.Id !== operation.previousId)) {
          throw new Error('Rollback container does not match original.');
        }
        if (await inspectContainer(docker, operation.canonicalName)) throw new Error('Canonical container already exists.');
        await docker(['rename', operation.rollbackName, operation.canonicalName]);
      }
      const restored = await inspectContainer(docker, operation.canonicalName);
      if (restored?.Image !== operation.previousImage) throw new Error('Original container is unavailable.');
      assertOwnership(restored, operation.canonicalName, transaction.moduleSlug);
      if (operation.previousId && restored.Id !== operation.previousId) throw new Error('Original container identity changed.');
      if (operation.previousRunning && restored.State.Status !== 'running') await docker(['start', operation.canonicalName]);
      if (!operation.previousRunning && restored.State.Status === 'running') await docker(['stop', operation.canonicalName]);
    } catch (error) {
      failures.push(`${operation.canonicalName}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}

async function recoverTransactions(stateDir, docker) {
  const directory = join(stateDir, 'transactions');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    const transaction = JSON.parse(await readFile(path, 'utf8'));
    if (!NAME_PATTERN.test(transaction.jobId) || name !== `${transaction.jobId}.json`
      || !SLUG_PATTERN.test(transaction.moduleSlug) || !Array.isArray(transaction.operations)
      || !['staging', 'switching', 'complete'].includes(transaction.phase)) throw new Error('Invalid installer transaction.');
    for (const operation of transaction.operations) {
      if (!['canonicalName', 'stagedName', 'rollbackName'].every((key) => typeof operation[key] === 'string' && NAME_PATTERN.test(operation[key]))
        || typeof operation.switchStarted !== 'boolean' || typeof operation.previousRunning !== 'boolean'
        || (operation.previousImage !== null && typeof operation.previousImage !== 'string')) throw new Error('Invalid installer transaction operation.');
    }
    if (transaction.phase === 'complete') {
      const jobPath = join(stateDir, 'jobs', `${transaction.jobId}.json`);
      const job = JSON.parse(await readFile(jobPath, 'utf8'));
      job.status = 'succeeded';
      job.message = 'Module action completed before installer restart.';
      job.data = transaction.result;
      job.finishedAt = new Date().toISOString();
      await atomicWriteJson(jobPath, job);
    } else {
      await rollbackTransaction(transaction, docker);
    }
    await removeJournal(path);
  }
}

async function executePlan(plan, docker, stateDir, deadline) {
  if (plan.action === 'install' || plan.action === 'upgrade') {
    return executeInstall(plan, docker, stateDir, deadline);
  }
  if (plan.action === 'start' || plan.action === 'stop') {
    for (const service of plan.services) await assertManagedContainer(docker, service.containerName, plan.moduleSlug);
    for (const service of plan.services) {
      await docker([plan.action, service.containerName]);
    }
    return inspectModule(docker, plan);
  }
  for (const service of plan.services) await assertManagedContainer(docker, service.containerName, plan.moduleSlug, true);
  for (const service of plan.services) {
    await removeContainer(docker, service.containerName);
  }
  return {
    removedContainers: plan.services.map((service) => service.containerName),
    preservedVolumes: [...new Set(plan.services.flatMap((service) => service.volumes.map((volume) => volume.name)))],
  };
}

async function assertManagedContainer(docker, name, moduleSlug, allowMissing = false) {
  const container = await inspectContainer(docker, name);
  if (!container && allowMissing) return;
  if (!container) throw new Error(`Container ${name} is not installer-managed for ${moduleSlug}.`);
  assertOwnership(container, name, moduleSlug);
}

function publicPlan(plan) {
  return {
    action: plan.action,
    moduleSlug: plan.moduleSlug,
    version: plan.version,
    runtime: plan.runtime,
    upgradeStrategy: plan.upgradeStrategy,
    services: plan.services.map((service) => ({
      name: service.name,
      image: service.image,
      containerName: service.containerName,
      network: service.network,
      ports: service.ports,
      volumes: service.volumes,
      environmentKeys: Object.keys(service.environment),
    })),
  };
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.new-${process.pid}-${randomUUID()}`;
  const file = await open(temporaryPath, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, path);
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

async function removeJournal(path) {
  await rm(path, { force: true });
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

async function loadJobs(stateDir) {
  const jobsDir = join(stateDir, 'jobs');
  await mkdir(jobsDir, { recursive: true, mode: 0o700 });
  const jobs = new Map();
  for (const name of await readdir(jobsDir)) {
    if (!name.endsWith('.json')) continue;
    let job;
    try {
      job = JSON.parse(await readFile(join(jobsDir, name), 'utf8'));
      if (!job || !NAME_PATTERN.test(job.jobId || '') || name !== `${job.jobId}.json`
        || !['accepted', 'running', 'succeeded', 'failed'].includes(job.status)) {
        throw new Error('Invalid installer job record.');
      }
    } catch {
      const quarantineDir = join(jobsDir, 'quarantine');
      try {
        await mkdir(quarantineDir, { recursive: true, mode: 0o700 });
        await rename(join(jobsDir, name), join(quarantineDir, `${randomUUID()}.invalid`));
        console.warn('Quarantined invalid installer job file', { file: name });
      } catch (quarantineError) {
        console.error('Could not quarantine invalid installer job file', { file: name, error: quarantineError.message.slice(0, 300) });
      }
      continue;
    }
    if (job.status === 'accepted' || job.status === 'running') {
      job.status = 'failed';
      job.message = 'Installer restarted before this job completed.';
      job.finishedAt = new Date().toISOString();
      await atomicWriteJson(join(jobsDir, name), job);
    }
    jobs.set(job.jobId, job);
  }
  return jobs;
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      reject(new Error('Request body timed out.'));
      req.destroy();
    }, timeoutMs);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timer);
        reject(new Error('Request body is too large.'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function createInstallerServer(options) {
  const policy = options.policy ?? await loadPolicy(options.policyPath);
  const stateDir = options.stateDir;
  if (!stateDir) throw new Error('Installer stateDir is required.');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const activeModules = new Set();
  const recoveryRequired = new Set();
  const docker = options.docker ?? createDockerRunner({ commandTimeoutMs: options.dockerTimeoutMs });
  const mode = options.mode === 'dry-run' ? 'dry-run' : 'docker';
  if (mode === 'docker') await recoverTransactions(stateDir, docker);
  const jobs = await loadJobs(stateDir);
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  async function persist(job) {
    await atomicWriteJson(join(stateDir, 'jobs', `${job.jobId}.json`), job);
  }

  async function runJob(record, plan) {
    activeModules.add(plan.moduleSlug);
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    await persist(record);
    const completed = { ...record };
    try {
      completed.data = mode === 'dry-run'
        ? { mode, plan: publicPlan(plan) }
        : { ...await executePlan(plan, docker, stateDir, Date.now() + jobTimeoutMs), mode, runtime: plan.runtime };
      completed.status = 'succeeded';
      completed.message = mode === 'dry-run' ? 'Dry-run plan completed.' : 'Module action completed.';
    } catch (error) {
      completed.status = 'failed';
      completed.message = error.message;
      if (error.recoveryRequired) recoveryRequired.add(plan.moduleSlug);
    } finally {
      completed.finishedAt = new Date().toISOString();
      await persist(completed);
      // Dry runs write no transaction journal.
      if (mode === 'docker' && completed.status === 'succeeded' && (plan.action === 'install' || plan.action === 'upgrade')) {
        await removeJournal(join(stateDir, 'transactions', `${plan.jobId}.json`));
      }
      jobs.set(record.jobId, completed);
      activeModules.delete(plan.moduleSlug);
    }
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || '/', 'http://installer.local');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') {
      return jsonResponse(res, 200, {
        success: true,
        data: { mode, approvedModules: policy.size, activeJobs: activeModules.size },
      });
    }

    let body = '';
    if (req.method === 'POST') {
      try {
        body = await readBody(req, requestTimeoutMs);
      } catch (error) {
        return jsonResponse(res, error.message.includes('large') ? 413 : 408, { success: false, error: error.message });
      }
    }
    if (!verifyRequestSignature(
      options.secret,
      req.headers['x-robin-installer-timestamp'],
      req.method || 'GET',
      path,
      body,
      req.headers['x-robin-installer-signature'],
    )) {
      return jsonResponse(res, 401, { success: false, error: 'Invalid or expired installer request signature.' });
    }

    if (req.method === 'GET' && path.startsWith('/api/jobs/')) {
      const jobId = decodeURIComponent(path.slice('/api/jobs/'.length));
      const job = jobs.get(jobId);
      return jsonResponse(res, job ? 200 : 404, job
        ? { success: true, data: job }
        : { success: false, error: 'Job not found.' });
    }

    if (req.method === 'GET' && path === '/api/capabilities') {
      return jsonResponse(res, 200, { success: true, data: {
        mode, modules: Object.fromEntries([...policy].map(([slug, entry]) => [slug, [...entry.versions.keys()]])),
        upgradeStrategies: Object.fromEntries([...policy].map(([slug, entry]) => [slug, entry.upgradeStrategy])),
      } });
    }

    const statusMatch = req.method === 'GET' && path.match(/^\/api\/modules\/([a-z0-9-]+)\/status$/);
    if (statusMatch) {
      const moduleSlug = statusMatch[1];
      const modulePolicy = policy.get(moduleSlug);
      if (!modulePolicy) return jsonResponse(res, 404, { success: false, error: 'Module is not approved.' });
      const latestJob = [...jobs.values()]
        .filter((job) => job.moduleSlug === moduleSlug)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
      const version = latestJob?.version ?? [...modulePolicy.versions.keys()][0];
      const plan = buildJobPlan({ action: 'start', moduleSlug, version }, policy);
      const runtime = mode === 'dry-run' ? null : await inspectModule(docker, plan);
      return jsonResponse(res, 200, { success: true, data: { moduleSlug, latestJob, runtime } });
    }

    if (req.method !== 'POST' || path !== '/api/jobs') {
      return jsonResponse(res, 404, { success: false, error: 'Not found.' });
    }

    let plan;
    try {
      plan = buildJobPlan(JSON.parse(body), policy);
    } catch (error) {
      return jsonResponse(res, 400, { success: false, error: error.message });
    }
    const existing = jobs.get(plan.jobId);
    if (existing) {
      const sameRequest = existing.action === plan.action
        && existing.moduleSlug === plan.moduleSlug
        && existing.version === plan.version;
      return jsonResponse(res, sameRequest ? 200 : 409, sameRequest
        ? { success: true, data: existing }
        : { success: false, error: 'Job id was already used for a different request.' });
    }
    if (recoveryRequired.has(plan.moduleSlug)) {
      return jsonResponse(res, 409, { success: false, error: 'Module rollback needs recovery. Repair the reported Docker failure and restart the installer.' });
    }
    if (activeModules.has(plan.moduleSlug)) {
      return jsonResponse(res, 409, { success: false, error: 'A job is already running for this module.' });
    }

    const record = {
      jobId: plan.jobId,
      action: plan.action,
      moduleSlug: plan.moduleSlug,
      version: plan.version,
      status: 'accepted',
      message: null,
      data: { mode, plan: publicPlan(plan) },
      createdAt: new Date().toISOString(),
    };
    jobs.set(record.jobId, record);
    activeModules.add(plan.moduleSlug);
    try {
      await persist(record);
    } catch (error) {
      jobs.delete(record.jobId);
      activeModules.delete(plan.moduleSlug);
      throw error;
    }
    setImmediate(() => {
      activeModules.delete(plan.moduleSlug);
      void runJob(record, plan).catch((error) => {
        recoveryRequired.add(plan.moduleSlug);
        jobs.set(record.jobId, { ...record, status: 'failed', message: `Job persistence failed: ${error.message}` });
      });
    });
    return jsonResponse(res, 202, { success: true, data: record });
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      if (!res.headersSent && !res.destroyed) jsonResponse(res, 503, { success: false, error: `Installer request failed: ${error.message}` });
      else res.destroy();
    });
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = requestTimeoutMs;
  server.keepAliveTimeout = 5_000;
  return server;
}
