import { createInstallerServer } from './installer.js';

const port = Number.parseInt(process.env.MODULE_INSTALLER_PORT || '3041', 10);
const host = process.env.MODULE_INSTALLER_HOST || '127.0.0.1';
const secret = process.env.MODULE_INSTALLER_SIGNING_SECRET || '';

if (!secret || secret.length < 32) {
  console.error('MODULE_INSTALLER_SIGNING_SECRET must be set to at least 32 characters.');
  process.exit(1);
}

const server = await createInstallerServer({
  secret,
  mode: process.env.MODULE_INSTALLER_MODE || 'docker',
  policyPath: process.env.MODULE_INSTALLER_POLICY_FILE || '/etc/robin-admin/installer-policy.json',
  stateDir: process.env.MODULE_INSTALLER_STATE_DIR || '/var/lib/robin-admin-installer',
});

server.listen(port, host, () => {
  console.log(`Robin Admin host installer listening on http://${host}:${port}`);
});
