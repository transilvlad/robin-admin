#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const problems = [];
const dockerfile = read('client/Dockerfile');
const stages = dockerfile.split(/\r?\n/).filter((line) => /^FROM\s/i.test(line));
const builder = stages.find((line) => /\sAS\s+builder\s*$/i.test(line));
const runtime = stages.find((line) => /\sAS\s+runtime\s*$/i.test(line));

// The UI is static output. Executing its Node/Rolldown toolchain for each target
// architecture put the ARM64 release build under QEMU and stalled graph parsing.
if (!builder || !/^FROM\s+--platform=\$BUILDPLATFORM\s+\S+\s+AS\s+builder\s*$/i.test(builder)) {
  problems.push('Client compilation must run on $BUILDPLATFORM, not the target architecture.');
}
if (!runtime || /--platform=/.test(runtime)) {
  problems.push('The client runtime must retain Buildx target-platform selection.');
}
if (!/^COPY\s+--from=builder\b.*\s\/app\/dist\s+/m.test(dockerfile)
  || /^COPY\s+--from=builder\b.*node_modules/m.test(dockerfile)) {
  problems.push('Only architecture-independent client dist output may cross into the runtime.');
}

const workflow = read('.github/workflows/release.yml');
const jobs = new Map([...workflow.matchAll(/^  ([\w-]+):\r?\n([\s\S]*?)(?=^  [\w-]+:\r?\n|(?![\s\S]))/gm)]
  .map((match) => [match[1], match[2]]));
const imageJobs = ['build-and-push-client', 'build-and-push-server', 'build-and-push-installer'];
const needsValue = jobs.get('release')?.match(/^    needs:\s*(\[[^\]]+\]|[\w-]+)\s*$/m)?.[1] ?? '';
const needs = needsValue.replace(/^\[|\]$/g, '').split(',').map((name) => name.trim());
for (const name of ['build', ...imageJobs]) {
  if (!needs.includes(name)) problems.push(`Creating a release must wait for ${name} to succeed.`);
}
for (const name of imageJobs) {
  const job = jobs.get(name) ?? '';
  if (!/^          platforms: linux\/amd64,linux\/arm64\s*$/m.test(job)) {
    problems.push(`${name} must still publish both advertised architectures.`);
  }
  if (!/provenance: true/.test(job) || !/sbom: true/.test(job)
    || !/exit-code: '1'/.test(job) || !/cosign sign --yes/.test(job)) {
    problems.push(`${name} must retain the blocking scan, provenance, SBOM and signature.`);
  }
}

if (problems.length) {
  console.error(`Release build contract failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Release build contract passed: native client compilation, target runtimes and image-gated releases.');
}
