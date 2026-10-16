import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StatusPagePublic } from './StatusPagePublic';

const statusPageApi = vi.hoisted(() => ({ publicPage: vi.fn() }));
vi.mock('../api/client', () => ({ ApiError: class ApiError extends Error {}, statusPageApi, emailApi: {}, statusPageFeedUrl: () => '' }));
vi.mock('../components/status-page/StatusPageViews', async importOriginal => ({
  ...await importOriginal<typeof import('../components/status-page/StatusPageViews')>(),
  StatusOverview: () => null,
}));

const settings = {
  companyName: 'Example Org', companyUrl: null, logoUrl: 'https://cdn.example.com/logo.png', historyDays: 30, timezone: 'UTC',
  theme: 'light', announcement: null, subscribable: false, incidentHistoryEnabled: false, maintenancePageEnabled: false, feedsEnabled: false,
};

beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  document.title = 'Robin Admin';
  document.head.querySelectorAll('link[rel~="icon"]').forEach(link => link.remove());
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('names the browser tab after the company and uses its logo as the icon', async () => {
  statusPageApi.publicPage.mockResolvedValue({ data: { settings, aggregateStatus: 'operational', sections: [], activeReports: [], recentReports: [], maintenances: [], generatedAt: '2026-10-16T00:00:00Z' } });
  render(<MemoryRouter><StatusPagePublic basePath="" /></MemoryRouter>);
  await waitFor(() => expect(document.title).toBe('Example Org status'));
  expect(document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href).toBe('https://cdn.example.com/logo.png');
});

it('keeps the default tab title while the page cannot load', async () => {
  statusPageApi.publicPage.mockRejectedValue(new Error('offline'));
  render(<MemoryRouter><StatusPagePublic basePath="" /></MemoryRouter>);
  await waitFor(() => expect(statusPageApi.publicPage).toHaveBeenCalled());
  expect(document.title).toBe('Robin Admin');
});
