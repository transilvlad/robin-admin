import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { TelemetryDashboard, TelemetryRangeData, TelemetryStatus } from '../types/telemetry';
import { TelemetryPage } from './Telemetry';

const api = vi.hoisted(() => ({
  status: vi.fn(),
  dashboards: vi.fn(),
  dashboard: vi.fn(),
  panel: vi.fn(),
  previewPanel: vi.fn(),
  variableOptions: vi.fn(),
  previewVariable: vi.fn(),
  saveDashboard: vi.fn(),
  createDashboard: vi.fn(),
  deleteDashboard: vi.fn(),
  restoreDefault: vi.fn(),
  keepDashboard: vi.fn(),
  templates: vi.fn(),
  versions: vi.fn(),
  annotations: vi.fn(),
  panelQueries: vi.fn(),
}));
const auth = vi.hoisted(() => ({ canEdit: true, isAdmin: true }));
const confirmMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, public status = 400) {
      super(message);
    }
  },
  telemetryApi: api,
}));
vi.mock('../hooks/useAuth', () => ({ useCanEdit: () => auth.canEdit, useIsAdmin: () => auth.isAdmin }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => confirmMock }));
vi.mock('../components/telemetry/TimeSeriesChart', () => ({
  TimeSeriesChart: ({ data }: { data: TelemetryRangeData }) => (
    <div data-testid="chart">{data.series.map((series) => series.name).join(',')}</div>
  ),
}));
vi.mock('react-grid-layout', () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="grid">{children}</div>,
  useContainerWidth: () => ({ width: 1200, containerRef: { current: null }, mounted: true }),
}));

const HOST: TelemetryDashboard = {
  uid: 'host',
  title: 'Linux host',
  description: 'Host metrics.',
  templateKey: 'host',
  templateUpdated: false,
  version: 3,
  updatedAt: '2026-10-01T00:00:00Z',
  updatedBy: null,
  variables: [
    { name: 'role', label: 'Role', source: 'role', multi: true },
    { name: 'host', label: 'Host', source: 'host', match: 'host_uptime{role=~"$role"}' },
  ],
  rows: [{
    id: 'overview',
    title: 'Overview',
    panels: [
      { id: 'cpu', title: 'CPU busy', type: 'stat', unit: 'percent', queries: [{ expr: 'x' }], thresholds: { warning: 70, critical: 90 }, layout: { x: 0, y: 0, w: 3, h: 4 } },
      { id: 'load', title: 'Load', type: 'timeseries', unit: 'none', queries: [{ expr: 'y' }], layout: { x: 3, y: 0, w: 6, h: 8 } },
    ],
  }],
};

const APPLICATION: TelemetryDashboard = {
  ...HOST,
  uid: 'application',
  title: 'Application',
  templateKey: null,
  variables: [{ name: 'host', label: 'Host', source: 'host' }],
  rows: [{ id: 'queue', title: 'Queue', panels: [{ id: 'queue', title: 'Queue', type: 'table', unit: 'count', queries: [{ expr: 'z' }], layout: { x: 0, y: 0, w: 6, h: 8 } }] }],
};

const READY: TelemetryStatus = { enabled: true, configured: true, reachable: true, totalSeries: 10, sources: ['worker-a'], silentAfterSeconds: 900 };

function range(series: Array<{ name: string; values: Array<number | null> }>): TelemetryRangeData {
  return { start: 0, end: 60, step: 60, timestamps: [0, 60], truncated: false, series: series.map((item) => ({ ...item, labels: {} })) };
}

function panelData(panelId: string) {
  return {
    success: true,
    data: panelId === 'cpu'
      ? range([{ name: 'CPU busy', values: [40, 95] }])
      : panelId === 'queue'
        ? range([{ name: 'service-a', values: [3, 7] }])
        : range([{ name: '1m', values: [1, 2] }, { name: '5m', values: [1, 1] }]),
  };
}

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderPage(url = '/telemetry') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <TelemetryPage />
      <Location />
    </MemoryRouter>,
  );
}

function hostOptions(dashboardUid: string, name: string) {
  return name === 'role' ? ['worker', 'service'] : dashboardUid === 'application' ? ['service-a', 'service-b'] : ['worker-a', 'worker-b'];
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.canEdit = true;
  auth.isAdmin = true;
  confirmMock.mockResolvedValue(true);
  api.status.mockResolvedValue({ success: true, data: READY });
  api.dashboards.mockResolvedValue({
    success: true,
    data: [HOST, APPLICATION].map(({ uid, title, description, templateKey, templateUpdated, version, updatedAt }) => ({ uid, title, description, templateKey, templateUpdated, version, updatedAt })),
  });
  api.dashboard.mockImplementation(async (uid: string) => ({ success: true, data: uid === 'application' ? APPLICATION : HOST }));
  api.variableOptions.mockImplementation(async (uid: string, name: string) => ({ success: true, data: hostOptions(uid, name) }));
  api.previewVariable.mockImplementation(async ({ name }: { name: string }) => ({ success: true, data: hostOptions('host', name) }));
  api.panel.mockImplementation(async (_uid: string, panelId: string) => panelData(panelId));
  api.previewPanel.mockImplementation(async ({ panel }: { panel: { id: string } }) => panelData(panel.id));
  api.saveDashboard.mockImplementation(async (uid: string, content: object, version: number) => ({ success: true, data: { ...HOST, ...content, uid, version: version + 1 } }));
});

describe('TelemetryPage viewing', () => {
  it('does not replace an explicitly requested missing dashboard with the first dashboard', async () => {
    renderPage('/telemetry?dashboard=deleted&var-host=unrelated');
    await screen.findByText('Dashboard not found. It may have been deleted.');
    expect(api.dashboard).not.toHaveBeenCalled();
    expect(api.panel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'View dashboards' }));
    await screen.findByText('95%');
    expect(screen.getByTestId('location')).not.toHaveTextContent('deleted');
    expect(screen.getByTestId('location')).not.toHaveTextContent('unrelated');
  });
  it('explains a missing store instead of loading dashboards', async () => {
    api.status.mockResolvedValue({ success: true, data: { ...READY, configured: false, reachable: false } });
    renderPage();
    expect(await screen.findByText('No Telemetry store configured')).toBeInTheDocument();
    expect(api.dashboards).not.toHaveBeenCalled();
  });

  it('opens the first dashboard, resolves variables in order and loads saved panels', async () => {
    renderPage();
    expect(await screen.findByText('95%')).toBeInTheDocument();
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(await screen.findByTestId('chart')).toHaveTextContent('1m,5m');

    expect(api.variableOptions).toHaveBeenNthCalledWith(1, 'host', 'role', expect.any(Object), {});
    expect(api.variableOptions).toHaveBeenNthCalledWith(2, 'host', 'host', expect.any(Object), { role: [] });
    expect(api.panel).toHaveBeenCalledWith('host', 'cpu', expect.objectContaining({ start: expect.any(Number) }), { role: [], host: ['worker-a'] });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('var-host=worker-a'));
    expect(api.previewPanel).not.toHaveBeenCalled();
  });

  it('switches dashboards and replaces a host the new dashboard does not have', async () => {
    renderPage('/telemetry?dashboard=host&var-host=worker-b');
    await waitFor(() => expect(api.panel).toHaveBeenCalledWith('host', 'cpu', expect.any(Object), { role: [], host: ['worker-b'] }));
    fireEvent.change(screen.getByLabelText('Dashboard'), { target: { value: 'application' } });
    expect(await screen.findByText('service-a', { selector: 'td' })).toBeInTheDocument();
    expect(api.panel).toHaveBeenCalledWith('application', 'queue', expect.any(Object), { host: ['service-a'] });
  });

  it('reloads panels for a new time range', async () => {
    renderPage();
    await screen.findByText('95%');
    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    // The router applies the URL change as a transition, so a reload already
    // under way can still request the old window first; wait for the new one.
    await waitFor(() => {
      const [, , window] = api.panel.mock.calls[api.panel.mock.calls.length - 1];
      expect(window.end - window.start).toBe(24 * 3600);
    });
  });
  it('reloads variable options for the selected historical window', async () => {
    api.variableOptions.mockImplementation(async (_uid: string, name: string, window: { start: number; end: number }) => ({
      data: name === 'role' ? ['worker'] : window.end - window.start >= 86400 ? ['historical-device'] : ['current-device'],
    }));
    renderPage();
    await waitFor(() => expect(api.panel).toHaveBeenCalledWith('host', 'cpu', expect.any(Object), { role: [], host: ['current-device'] }));
    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    await waitFor(() => expect(api.panel).toHaveBeenCalledWith('host', 'cpu', expect.any(Object), { role: [], host: ['historical-device'] }));
  });

  it('hides editing from viewers', async () => {
    auth.canEdit = false;
    renderPage();
    await screen.findByText('95%');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['Export JSON', 'Version history']);
  });

  it('offers the dashboard menu to editors and deletes after confirming', async () => {
    renderPage();
    await screen.findByText('95%');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Manage dashboards', 'Duplicate', 'Export JSON', 'Version history', 'Restore template', 'Delete dashboard',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete dashboard' }));
    await waitFor(() => expect(api.deleteDashboard).toHaveBeenCalledWith('host'));
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('Delete the dashboard "Linux host"'));
  });
});

describe('TelemetryPage editing', () => {
  async function startEditing() {
    renderPage();
    await screen.findByText('95%');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(api.previewPanel).toHaveBeenCalled());
  }

  async function removeLoad() {
    fireEvent.click(screen.getByRole('button', { name: 'Remove Load' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Load' })).not.toBeInTheDocument());
  }

  it('renders the draft through the preview endpoint and only saves when something changed', async () => {
    await startEditing();
    expect(api.previewVariable).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('removes a panel and saves with the edited version', async () => {
    await startEditing();
    await removeLoad();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveDashboard).toHaveBeenCalled());
    const [uid, content, version] = api.saveDashboard.mock.calls[0];
    expect(uid).toBe('host');
    expect(version).toBe(3);
    expect(content.rows[0].panels.map((panel: { id: string }) => panel.id)).toEqual(['cpu']);
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('adds a panel from the editor and adds rows', async () => {
    await startEditing();
    fireEvent.click(screen.getByRole('button', { name: 'Add panel' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Queue size' } });
    fireEvent.change(within(dialog).getByLabelText('Query 1'), { target: { value: 'sum(postfix_queue_messages{host=~"$host"})' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add panel' }));
    expect(await screen.findByRole('region', { name: 'Queue size' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveDashboard).toHaveBeenCalled());
    const content = api.saveDashboard.mock.calls[0][1];
    expect(content.rows).toHaveLength(2);
    expect(content.rows[0].panels[2]).toMatchObject({
      title: 'Queue size',
      queries: [{ expr: 'sum(postfix_queue_messages{host=~"$host"})' }],
      layout: { x: 0, y: 8, w: 6, h: 8 },
    });
  });

  it('offers to reload or overwrite when someone else saved first', async () => {
    const { ApiError } = await import('../api/client');
    await startEditing();
    await removeLoad();
    api.saveDashboard.mockRejectedValueOnce(new (ApiError as unknown as new (message: string, status: number) => Error)('changed', 409));
    api.dashboard.mockResolvedValueOnce({ success: true, data: { ...HOST, version: 5 } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Someone else saved this dashboard', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/now version 5/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save over it' }));
    await waitFor(() => expect(api.saveDashboard).toHaveBeenLastCalledWith('host', expect.any(Object), 5), { timeout: 5000 });
  }, 15000);

  it('confirms before leaving unsaved changes for another dashboard', async () => {
    await startEditing();
    await removeLoad();
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.change(screen.getByLabelText('Dashboard'), { target: { value: 'application' } });
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith('Discard your unsaved changes to this dashboard?'), { timeout: 5000 });
    expect(screen.getByTestId('location')).not.toHaveTextContent('dashboard=application');
  }, 15000);
});

describe('TelemetryPage features', () => {
  function withDashboard(dashboard: TelemetryDashboard) {
    api.dashboard.mockResolvedValue({ success: true, data: dashboard });
  }

  it('repeats a row for every value of its variable', async () => {
    withDashboard({ ...HOST, rows: [{ ...HOST.rows[0], repeat: 'role' }] });
    renderPage('/telemetry?dashboard=host');
    expect(await screen.findByRole('region', { name: 'Overview: worker' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Overview: service' })).toBeInTheDocument();
    await waitFor(() => expect(api.panel).toHaveBeenCalledWith('host', 'cpu', expect.any(Object), expect.objectContaining({ role: ['service'] })));
    expect(api.panel).toHaveBeenCalledWith('host', 'cpu', expect.any(Object), expect.objectContaining({ role: ['worker'] }));
  });

  it('offers a newer default to editors', async () => {
    withDashboard({ ...HOST, templateUpdated: true });
    api.restoreDefault.mockResolvedValue({ success: true, data: { ...HOST, version: 4 } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Use updated template' }));
    await waitFor(() => expect(api.restoreDefault).toHaveBeenCalledWith('host'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use updated template' })).not.toBeInTheDocument());
  });

  it('keeps the current dashboard instead of a newer default', async () => {
    withDashboard({ ...HOST, templateUpdated: true });
    api.keepDashboard.mockResolvedValue({ success: true, data: { ...HOST, templateUpdated: false } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(api.keepDashboard).toHaveBeenCalledWith('host'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use updated template' })).not.toBeInTheDocument());
    expect(api.restoreDefault).not.toHaveBeenCalled();
  });

  it('does not offer a newer default to viewers', async () => {
    auth.canEdit = false;
    withDashboard({ ...HOST, templateUpdated: true });
    renderPage();
    await screen.findByText('95%');
    expect(screen.queryByRole('button', { name: 'Use updated template' })).not.toBeInTheDocument();
  });

  it('loads Monitoring incidents when switched on', async () => {
    api.annotations.mockResolvedValue({ success: true, data: [{ id: 1, checkName: 'SMTP', severity: 'critical', summary: 'down', openedAt: '2026-10-01T00:00:00Z', closedAt: null }] });
    renderPage();
    await screen.findByText('95%');
    expect(api.annotations).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Incidents/ }));
    await waitFor(() => expect(api.annotations).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Incidents (1)' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('location')).toHaveTextContent('incidents=1');
  });

  it('keeps Monitoring incidents from non-admins', async () => {
    auth.isAdmin = false;
    renderPage('/telemetry?incidents=1');
    await screen.findByText('95%');
    expect(screen.queryByRole('button', { name: /Incidents/ })).not.toBeInTheDocument();
    expect(api.annotations).not.toHaveBeenCalled();
  });

  it('opens the linked dashboard for a clicked series', async () => {
    withDashboard({
      ...APPLICATION,
      rows: [{ ...APPLICATION.rows[0], panels: [{ ...APPLICATION.rows[0].panels[0], link: { dashboardUid: 'host', variable: 'host', label: 'host' } }] }],
    });
    api.panel.mockResolvedValue({ success: true, data: { ...range([]), series: [{ name: 'worker-b', labels: { host: 'worker-b' }, values: [1, 2] }] } });
    renderPage('/telemetry?dashboard=application&range=24h');
    fireEvent.click(await screen.findByRole('button', { name: 'worker-b' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('dashboard=host'));
    expect(screen.getByTestId('location')).toHaveTextContent('var-host=worker-b');
    expect(screen.getByTestId('location')).toHaveTextContent('range=24h');
  });

  it('views a panel full screen', async () => {
    renderPage();
    await screen.findByText('95%');
    fireEvent.click(screen.getByRole('button', { name: 'View Load' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('chart')).toHaveTextContent('1m,5m');
  });

  it('opens a panel in Explore with its rendered queries', async () => {
    api.panelQueries.mockResolvedValue({ success: true, data: { step: 60, unit: 'percent', queries: [{ expr: 'a{host="worker-a"}' }, { expr: 'b' }] } });
    renderPage();
    await screen.findByText('95%');
    fireEvent.click(screen.getByRole('button', { name: 'Open Load in Explore' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/telemetry/explore'));
    const search = new URLSearchParams(screen.getByTestId('location').textContent!.split('?')[1]);
    expect(search.getAll('q')).toEqual(['a{host="worker-a"}', 'b']);
    expect(search.get('unit')).toBe('percent');
  });

  it('opens with the dashboard default range unless the URL has one', async () => {
    withDashboard({ ...HOST, defaults: { range: '24h' } });
    renderPage();
    await waitFor(() => expect(api.panel).toHaveBeenCalled());
    const [, , window] = api.panel.mock.calls[0];
    expect(window.end - window.start).toBe(24 * 3600);
    expect(screen.getByTestId('location')).not.toHaveTextContent('range=');
  });

  it('shows stopped series as having no data instead of their old value', async () => {
    withDashboard({ ...HOST, rows: [{ id: 'r', title: 'R', panels: [
      { ...HOST.rows[0].panels[0], id: 'cpu' },
      { ...APPLICATION.rows[0].panels[0], id: 'queue' },
    ] }] });
    const stopped = {
      start: 0, end: 7200, step: 600, truncated: false,
      timestamps: [0, 600, 1200, 1800, 2400, 3000, 3600, 4200, 4800, 5400, 6000, 6600, 7200],
      series: [
        { name: 'worker-a', labels: { host: 'worker-a' }, values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 95] },
        { name: 'worker-b', labels: { host: 'worker-b' }, values: [99, 99, 99, null, null, null, null, null, null, null, null, null, null] },
      ],
    };
    api.panel.mockResolvedValue({ success: true, data: stopped });
    renderPage();
    const cpu = await screen.findByRole('region', { name: 'CPU busy' });
    expect(await within(cpu).findByText('95%')).toBeInTheDocument();
    expect(within(cpu).queryByText('99%')).not.toBeInTheDocument();
    expect(within(cpu).getByText('No data for 1h')).toBeInTheDocument();
    const queue = screen.getByRole('region', { name: 'Queue' });
    const rows = within(queue).getAllByRole('row');
    expect(rows[0]).toHaveTextContent('worker-a');
    expect(rows[1]).toHaveTextContent('No data for 1h');
    expect(within(rows[1]).queryByText('Critical')).not.toBeInTheDocument();
  });

  it('lists every series of a stat panel and joins table columns by label', async () => {
    withDashboard({
      ...HOST,
      rows: [{
        id: 'r', title: 'R', panels: [
          { ...HOST.rows[0].panels[0], id: 'cpu' },
          { id: 'joined', title: 'Joined', type: 'table', unit: 'count', tableBy: 'host', queries: [{ expr: 'a', legend: 'Queued' }, { expr: 'b', legend: 'Held', unit: 'percent' }], layout: { x: 3, y: 0, w: 6, h: 8 } },
        ],
      }],
    });
    api.panel.mockImplementation(async (_uid: string, panelId: string) => ({
      success: true,
      data: panelId === 'cpu'
        ? range([{ name: 'worker-a', values: [10, 20] }, { name: 'worker-b', values: [30, 95] }])
        : {
          ...range([]),
          series: [
            { name: 'x', query: 0, labels: { host: 'service-a' }, values: [1, 5] },
            { name: 'y', query: 1, labels: { host: 'service-a' }, values: [1, 40] },
            { name: 'z', query: 0, labels: { host: 'service-b' }, values: [1, 2] },
          ],
        },
    }));
    renderPage();
    const cpu = await screen.findByRole('region', { name: 'CPU busy' });
    expect(await within(cpu).findByText('worker-a')).toBeInTheDocument();
    expect(within(cpu).getByText('95%')).toBeInTheDocument();
    const joined = screen.getByRole('region', { name: 'Joined' });
    const rows = await within(joined).findAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('Queued'), expect.stringContaining('service-a'), expect.stringContaining('service-b')]);
    expect(rows[0]).toHaveTextContent('Held');
    expect(rows[1]).toHaveTextContent('40%');
  });
});
