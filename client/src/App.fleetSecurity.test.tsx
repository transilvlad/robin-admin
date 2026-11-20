import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { prefixAppPath } from './utils/basePath';

vi.unmock('./context/FeaturesContext');

const hostId = 'fixture-host';
const receivedAt = '2026-11-19T10:00:00.000Z';
const emptyPage = { items: [], nextCursor: null };
const emptySection = { status: 'ok', complete: true, items: [] };
const responses: Record<string, unknown> = {
  '/auth/me': { id: 1, uid: 'fixture-user', name: 'Fleet operator', email: 'operator@example.test', role: 'viewer' },
  '/dashboard/features': { fleet: true, fleetEnabled: true },
  '/fleet/capabilities': { byType: {}, services: [] },
  '/fleet/services/enabled': [],
  '/security/hosts': {
    ...emptyPage,
    items: [{ hostId, name: 'Fixture host', lastReceivedAt: receivedAt }],
  },
  [`/security/hosts/${hostId}/snapshot`]: {
    observedAt: receivedAt,
    sections: {
      sshKeys: emptySection, sshd: emptySection, accounts: emptySection,
      privilegedGroups: emptySection, sudoers: emptySection, cron: emptySection,
      systemd: emptySection, listeners: emptySection, firewall: emptySection,
      patching: emptySection, integrity: emptySection,
    },
  },
  [`/security/hosts/${hostId}/diff`]: { baselinePending: false, items: [] },
  [`/security/hosts/${hostId}/events`]: emptyPage,
  [`/security/hosts/${hostId}/counters`]: emptyPage,
  '/security/known-addresses': emptyPage,
};

describe('Fleet Security routes in the app shell', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const pathname = new URL(url, window.location.origin).pathname;
      const apiBase = prefixAppPath('/api', import.meta.env.BASE_URL);
      const endpoint = pathname.startsWith(`${apiBase}/`) ? pathname.slice(apiBase.length) : pathname;
      if (!Object.prototype.hasOwnProperty.call(responses, endpoint)) {
        return Response.json({ success: false, error: `Unexpected API request: ${pathname}` }, { status: 404 });
      }
      return Response.json({ success: true, data: responses[endpoint] });
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
    [`/fleet/security/${hostId}`, 'Host security details', 'No differences from the baseline.'],
    ['/fleet/security/known-addresses', 'Known addresses', 'No known addresses are configured.'],
  ])('loads %s', async (path, heading, loadedText) => {
    window.history.replaceState(null, '', prefixAppPath(path, import.meta.env.BASE_URL));
    render(<ErrorBoundary><App /></ErrorBoundary>);

    const pageHeading = await screen.findByRole('heading', {
      name: new RegExp(`^(${heading}|Something went wrong)$`),
    });
    expect(pageHeading).toHaveTextContent(heading);
    expect(await screen.findByText(loadedText)).toBeInTheDocument();
  });
});
