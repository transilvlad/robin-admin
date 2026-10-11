/**
 * DKIM signing keys reach rspamd the way the rest of its config does: through
 * the fleet agent. When a service's manifest is built, dkim_signing.conf gets
 * a `domain { }` block naming each enabled domain's active selector, and the
 * sealed private keys ride along as `dkim/<domain>.<selector>.key` files,
 * which the agent writes under local.d.
 */

export const DKIM_SIGNING_FILE = 'dkim_signing.conf';

const KEY_FILE_DIR = 'dkim/';
const KEY_CONFIG_PATH = '$LOCAL_CONFDIR/local.d/dkim/';

export interface DeliveredDkimKey {
  domain: string;
  selector: string;
}

export function dkimKeyFileName(key: DeliveredDkimKey): string {
  return `${KEY_FILE_DIR}${key.domain}.${key.selector}.key`;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The per-domain selector map appended to dkim_signing.conf; empty with no keys. */
export function renderDkimDomainBlock(keys: DeliveredDkimKey[]): string {
  if (keys.length === 0) return '';
  const lines = ['# Signing keys for domains managed in Robin Admin.', 'domain {'];
  for (const key of keys) {
    lines.push(`  ${quote(key.domain)} {`);
    lines.push(`    path = ${quote(`${KEY_CONFIG_PATH}${key.domain}.${key.selector}.key`)};`);
    lines.push(`    selector = ${quote(key.selector)};`);
    lines.push('  }');
  }
  lines.push('}', '');
  return lines.join('\n');
}
