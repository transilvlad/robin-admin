import { copyFile, chmod } from 'node:fs/promises';

// Docker Desktop bind mounts do not preserve POSIX modes. Load the fixed,
// read-only policy into a private tmpfs file before the shared validator runs.
await copyFile('/policy/installer-policy.json', '/tmp/installer-policy.json');
await chmod('/tmp/installer-policy.json', 0o600);
process.env.MODULE_INSTALLER_POLICY_FILE = '/tmp/installer-policy.json';
await import('./index.js');
