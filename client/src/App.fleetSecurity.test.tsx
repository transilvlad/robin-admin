import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { prefixAppPath } from './utils/basePath';

vi.unmock('./context/FeaturesContext');

const hostId = 'fixture-host';
const hostRoute = `/fleet/security/${hostId}`;
const hostEndpoint = `/security/hosts/${hostId}`;
const receivedAt = '2026-11-19T10:00:00.000Z';
const emptyPage = { items: [], nextCursor: null };
const emptySection = { status: 'ok', complete: true, items: [] };
const passwordChange = {
  id: 'sshd:passwordauthentication', section: 'sshd', itemId: 'passwordauthentication', change: 'changed',
  before: { name: 'passwordauthentication', value: 'yes' }, after: { name: 'passwordauthentication', value: 'no' },
};
const responses: Record<string, unknown> = {
  '/auth/me': { id: 1, uid: 'fixture-user', name: 'Fleet operator', email: 'operator@example.test', role: 'viewer', csrfToken: 'fixture-csrf' },
  '/dashboard/features': { fleet: true, fleetEnabled: true },
  '/fleet/capabilities': { byType: {}, services: [] },
  '/fleet/services/enabled': [],
  '/security/hosts': {
    ...emptyPage,
    items: [{ hostId, name: 'Fixture host', lastReceivedAt: receivedAt }],
  },
  [`${hostEndpoint}/snapshot`]: {
    id: '42', name: 'Fixture host', lastReceivedAt: receivedAt, stale: false,
    observedAt: receivedAt,
    sections: {
      sshKeys: emptySection, sshd: emptySection, accounts: emptySection,
      privilegedGroups: emptySection, sudoers: emptySection, cron: emptySection,
      systemd: emptySection, listeners: emptySection, firewall: emptySection,
      patching: emptySection, integrity: emptySection,
    },
  },
  [`${hostEndpoint}/diff`]: { snapshotId: '42', baselineRevision: 2, baselinePending: false, items: [] },
  [`${hostEndpoint}/events`]: emptyPage,
  [`${hostEndpoint}/counters`]: emptyPage,
  '/security/known-addresses': emptyPage,
};

function renderApp(path: string) {
  window.history.replaceState(null, '', prefixAppPath(path, import.meta.env.BASE_URL));
  render(<ErrorBoundary><App /></ErrorBoundary>);
}

describe('Fleet Security routes in the app shell', () => {
  let fixtures: Record<string, unknown>;
  const mutations = vi.fn<(method: string, endpoint: string, body: unknown) => Response>();

  beforeEach(() => {
    fixtures = { ...responses };
    mutations.mockReset();
    vi.stubGlobal('matchMedia', () => ({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      const { pathname } = new URL(url, window.location.origin);
      const apiBase = prefixAppPath('/api', import.meta.env.BASE_URL);
      const endpoint = pathname.startsWith(`${apiBase}/`) ? pathname.slice(apiBase.length) : pathname;
      if (options?.method && options.method !== 'GET') {
        return mutations(options.method, endpoint, options.body ? JSON.parse(String(options.body)) : undefined);
      }
      if (!Object.prototype.hasOwnProperty.call(fixtures, endpoint)) {
        return Response.json({ success: false, error: `Unexpected API request: ${pathname}` }, { status: 404 });
      }
      const result = fixtures[endpoint];
      return result instanceof Response ? result.clone() : Response.json({ success: true, data: result });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    window.history.replaceState(null, '', import.meta.env.BASE_URL);
  });

  it.each([
    ['/fleet/security', 'Host security', 'Fixture host'],
    [hostRoute, 'Fixture host', 'No differences from the baseline.'],
    ['/fleet/security/known-addresses', 'Known addresses', 'No known addresses are configured.'],
  ])('loads %s', async (path, heading, loadedText) => {
    renderApp(path);

    const pageHeading = await screen.findByRole('heading', {
      name: new RegExp(`^(${heading}|Something went wrong)$`),
    });
    expect(pageHeading).toHaveTextContent(heading);
    expect(await screen.findByText(loadedText)).toBeInTheDocument();
  });

  it('keeps baseline changes usable while a sign-in feed fails independently', async () => {
    fixtures[`${hostEndpoint}/counters`] = Response.json({ success: false, error: 'Authentication counts unavailable' }, { status: 403 });
    fixtures[`${hostEndpoint}/events`] = { ...emptyPage, items: [{
      id: 'fixture-login', type: 'login', observedAt: receivedAt, sourceIp: '192.0.2.30', user: 'operator',
      authMethod: 'publickey', keyFingerprint: 'SHA256:Fixture', line: 'Fixture accepted publickey', knownAddressId: null,
    }] };
    renderApp(hostRoute);
    expect(await screen.findByText('No differences from the baseline.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign-ins' }));
    expect(await screen.findByText('Unknown address')).toBeInTheDocument();
    fireEvent.click(screen.getByText('View evidence'));
    expect(screen.getByText('SHA256:Fixture')).toBeVisible();
    expect(await screen.findByText('Could not load authentication counts')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    expect(await screen.findByText('No differences from the baseline.')).toBeInTheDocument();
    expect(screen.queryByText('Could not load authentication counts')).not.toBeInTheDocument();
  });

  it('reviews a readable change before sending the snapshot, revision and selected change for approval', async () => {
    fixtures['/auth/me'] = { ...(responses['/auth/me'] as object), role: 'admin' };
    fixtures[`${hostEndpoint}/diff`] = {
      snapshotId: '42', baselineRevision: 2, baselinePending: false,
      items: [passwordChange],
    };
    mutations.mockImplementation(() => {
      fixtures[`${hostEndpoint}/diff`] = { snapshotId: '42', baselineRevision: 3, baselinePending: false, items: [] };
      return Response.json({ success: true, data: { baselineRevision: 3 } });
    });
    renderApp(hostRoute);

    fireEvent.click(await screen.findByRole('button', { name: 'Review change: Password authentication' }));
    const review = within(screen.getByRole('dialog', { name: 'Approve change' }));
    expect(review.getByRole('columnheader', { name: 'Before' })).toBeInTheDocument();
    expect(review.getByRole('cell', { name: 'yes' })).toBeInTheDocument();
    expect(review.getByRole('cell', { name: 'no' })).toBeInTheDocument();
    expect(mutations).not.toHaveBeenCalled();
    fireEvent.change(review.getByLabelText('Approval reason (optional)'), { target: { value: 'Verified change' } });
    fireEvent.click(review.getByRole('button', { name: 'Approve change' }));

    expect(await screen.findByText('Changes approved.')).toBeInTheDocument();
    expect(mutations).toHaveBeenCalledWith('POST', `${hostEndpoint}/approve`, {
      snapshotId: '42', baselineRevision: 2, itemIds: ['sshd:passwordauthentication'], reason: 'Verified change',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('qualifies an empty diff when inventory coverage is incomplete', async () => {
    const snapshot = responses[`${hostEndpoint}/snapshot`] as { sections: Record<string, unknown> };
    fixtures[`${hostEndpoint}/snapshot`] = {
      ...snapshot, sections: { ...snapshot.sections, sshd: { ...emptySection, complete: false } },
    };
    renderApp(hostRoute);

    expect(await screen.findByText('10 of 11')).toBeInTheDocument();
    expect(screen.getByText('No differences were found in the reported inventory.')).toBeInTheDocument();
    expect(screen.queryByText('No differences from the baseline.')).not.toBeInTheDocument();
  });

  it('requires a fresh review after the server rejects an outdated approval', async () => {
    fixtures['/auth/me'] = { ...(responses['/auth/me'] as object), role: 'admin' };
    fixtures[`${hostEndpoint}/diff`] = { snapshotId: '42', baselineRevision: 2, baselinePending: false, items: [passwordChange] };
    mutations.mockImplementation(() => {
      fixtures[`${hostEndpoint}/snapshot`] = { ...(responses[`${hostEndpoint}/snapshot`] as object), id: '43' };
      fixtures[`${hostEndpoint}/diff`] = { snapshotId: '43', baselineRevision: 2, baselinePending: false, items: [passwordChange] };
      return Response.json({ success: false, error: 'Host snapshot or baseline changed. Reload before approving.' }, { status: 409 });
    });
    renderApp(hostRoute);

    fireEvent.click(await screen.findByRole('button', { name: 'Review change: Password authentication' }));
    const review = within(screen.getByRole('dialog', { name: 'Approve change' }));
    fireEvent.click(review.getByRole('button', { name: 'Approve change' }));
    expect(await review.findByText('Host snapshot or baseline changed. Reload before approving.')).toBeInTheDocument();
    const outdatedSubmit = review.getByRole('button', { name: 'Approve change' });
    expect(outdatedSubmit).toBeDisabled();
    fireEvent.click(outdatedSubmit);
    expect(mutations).toHaveBeenCalledTimes(1);
  });

  it('edits a known address in a dialog and confirms removal', async () => {
    fixtures['/auth/me'] = { ...(responses['/auth/me'] as object), role: 'admin' };
    const address = { id: '1', network: '192.0.2.0/24', label: 'Office', expiresAt: null };
    fixtures['/security/known-addresses'] = { ...emptyPage, items: [address] };
    mutations.mockImplementation((method, _endpoint, body) => {
      fixtures['/security/known-addresses'] = method === 'DELETE' ? emptyPage : { ...emptyPage, items: [{ id: address.id, ...(body as object) }] };
      return Response.json({ success: true, data: null });
    });
    renderApp('/fleet/security/known-addresses');

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Office' }));
    const editor = within(screen.getByRole('dialog', { name: 'Edit known address' }));
    fireEvent.change(editor.getByLabelText('Label'), { target: { value: 'Admin network' } });
    fireEvent.click(editor.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mutations).toHaveBeenCalledWith('PATCH', '/security/known-addresses/1', { label: 'Admin network', network: address.network, expiresAt: null });

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Admin network' }));
    expect(mutations).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Confirm' })).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('No known addresses are configured.')).toBeInTheDocument();
    expect(mutations).toHaveBeenLastCalledWith('DELETE', '/security/known-addresses/1', undefined);
  });
});
