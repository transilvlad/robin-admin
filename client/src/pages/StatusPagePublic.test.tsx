import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StatusPagePublic } from './StatusPagePublic';
import { statusFaviconUrl } from '../components/status-page/statusFavicon';

const statusPageApi = vi.hoisted(() => ({ publicPage: vi.fn() }));
vi.mock('../api/client', () => ({ ApiError: class ApiError extends Error {}, statusPageApi, emailApi: {}, statusPageFeedUrl: () => '' }));
vi.mock('../components/status-page/StatusPageViews', async importOriginal => ({
  ...await importOriginal<typeof import('../components/status-page/StatusPageViews')>(),
  StatusOverview: () => null,
}));

const settings = {
  companyName: 'Example Org', companyUrl: null, logoUrl: null, historyDays: 30, timezone: 'UTC',
  theme: 'light', announcement: null, subscribable: false, incidentHistoryEnabled: false, maintenancePageEnabled: false, feedsEnabled: false,
};
const page = (aggregateStatus: string) => ({ data: { settings, aggregateStatus, sections: [], activeReports: [], recentReports: [], maintenances: [], generatedAt: '2026-10-16T00:00:00Z' } });
const icon = () => document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.getAttribute('href');

beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  document.title = 'Robin Admin';
  document.head.querySelectorAll('link[rel~="icon"]').forEach(link => link.remove());
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('names the browser tab after the company and shows the page status as its icon', async () => {
  statusPageApi.publicPage.mockResolvedValue(page('operational'));
  render(<MemoryRouter><StatusPagePublic basePath="" /></MemoryRouter>);
  await waitFor(() => expect(document.title).toBe('Example Org status'));
  expect(icon()).toBe(statusFaviconUrl('operational'));
});

it('changes the icon when a refresh finds a different status', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  statusPageApi.publicPage.mockResolvedValueOnce(page('operational')).mockResolvedValue(page('outage'));
  render(<MemoryRouter><StatusPagePublic basePath="" /></MemoryRouter>);
  await waitFor(() => expect(icon()).toBe(statusFaviconUrl('operational')));
  await vi.advanceTimersByTimeAsync(30_000);
  await waitFor(() => expect(icon()).toBe(statusFaviconUrl('outage')));
});

it('keeps the default tab title while the page cannot load', async () => {
  statusPageApi.publicPage.mockRejectedValue(new Error('offline'));
  render(<MemoryRouter><StatusPagePublic basePath="" /></MemoryRouter>);
  await waitFor(() => expect(statusPageApi.publicPage).toHaveBeenCalled());
  expect(document.title).toBe('Robin Admin');
  expect(icon()).toBeUndefined();
});

it('gives every status a distinct icon', () => {
  const urls = (['operational', 'degraded', 'outage', 'maintenance', 'unknown'] as const).map(statusFaviconUrl);
  expect(new Set(urls).size).toBe(5);
  expect(urls.every(url => url.startsWith('data:image/svg+xml,'))).toBe(true);
});
