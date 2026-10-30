import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigStorePayload } from '../db/queries/config-store.js';
import { getRspamdManagedConfig } from '../db/queries/rspamd.js';
import { renderDkimSigningConf } from './rspamd.js';
import { renderDkimDomainBlock } from './rspamd-dkim-delivery.js';

vi.mock('../db/queries/config-store.js', async (original) => ({
  ...await original<typeof import('../db/queries/config-store.js')>(), getConfigStorePayload: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getConfigStorePayload).mockResolvedValue({});
});

describe('Rspamd production signing policy', () => {
  it('defaults to authenticated-only signing and the existing delivered key layout', async () => {
    const config = await getRspamdManagedConfig();
    const rendered = renderDkimSigningConf(config);
    expect(config.rspamdDkimSignLocal).toBe(false);
    expect(config.rspamdDkimAllowUsernameMismatch).toBe(false);
    expect(rendered).toContain('sign_authenticated = true;');
    expect(rendered).toContain('sign_local = false;');
    expect(rendered).toContain('allow_username_mismatch = false;');
    expect(rendered).toContain('path = "$LOCAL_CONFDIR/local.d/dkim/$domain.$selector.key";');
  });

  it('preserves explicit operator values rather than silently migrating persisted policy', async () => {
    vi.mocked(getConfigStorePayload).mockResolvedValue({
      rspamdDkimSignLocal: true,
      rspamdDkimSignAuthenticated: false,
      rspamdDkimPathTemplate: '/operator-managed/$domain.$selector.key',
      rspamdDkimAllowUsernameMismatch: true,
    });
    const rendered = renderDkimSigningConf(await getRspamdManagedConfig('rspamd'));
    expect(rendered).toContain('sign_local = true;');
    expect(rendered).toContain('sign_authenticated = false;');
    expect(rendered).toContain('path = "/operator-managed/$domain.$selector.key";');
    expect(rendered).toContain('allow_username_mismatch = true;');
  });

  it('keeps authenticated delegation policy when rotation appends per-domain selectors', async () => {
    const config = { ...await getRspamdManagedConfig(), rspamdDkimAllowUsernameMismatch: true };
    const rendered = renderDkimSigningConf(config) + renderDkimDomainBlock([{ domain: 'example.test', selector: 's2' }]);
    expect(rendered).toContain('allow_username_mismatch = true;');
    expect(rendered).toContain('sign_local = false;');
    expect(rendered).toContain('path = "$LOCAL_CONFDIR/local.d/dkim/example.test.s2.key";');
    expect(rendered).toContain('selector = "s2";');
    expect(rendered.match(/sign_local\s*=/g)).toHaveLength(1);
  });
});
