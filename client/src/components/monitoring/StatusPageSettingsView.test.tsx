import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StatusPageSettingsView } from './StatusPageSettingsView';
const api = vi.hoisted(() => ({ adminSummary: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../../api/client', () => ({ ApiError: class ApiError extends Error {}, statusPageApi: api }));
const settings = { companyName: 'Test status', companyUrl: null, logoUrl: null, customDomain: null, timezone: 'UTC', historyDays: 90, theme: 'system', announcement: null, published: false, subscribable: false, incidentHistoryEnabled: true, maintenancePageEnabled: true, feedsEnabled: true, incidentGroupingMinutes: 15, homeIncidentDays: 7 };
beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  api.adminSummary.mockResolvedValue({ success: true, data: { settings } });
  api.updateSettings.mockImplementation(async data => ({ success: true, data }));
});
it('loads and saves existing status configuration without implicit publication', async () => {
  render(<StatusPageSettingsView />);
  const name = await screen.findByLabelText('Company name');
  expect(name).toHaveValue('Test status');
  fireEvent.change(name, { target: { value: 'Updated test status' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Status page settings saved');
  expect(api.updateSettings).toHaveBeenCalledWith({ ...settings, companyName: 'Updated test status' });
  expect(screen.getByLabelText('Published')).not.toBeChecked();
});
it('keeps failed edits for correction', async () => {
  api.updateSettings.mockRejectedValue(new Error('offline'));
  render(<StatusPageSettingsView />);
  const name = await screen.findByLabelText('Company name');
  fireEvent.change(name, { target: { value: 'Unsaved' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  expect(name).toHaveValue('Unsaved');
});
it('saves the page feature switches and incident grouping', async () => {
  render(<StatusPageSettingsView />);
  fireEvent.click(await screen.findByLabelText('RSS and JSON feeds of incidents'));
  fireEvent.change(screen.getByLabelText('Group failures into one incident within (minutes)'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Status page settings saved');
  expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ feedsEnabled: false, incidentGroupingMinutes: 0, incidentHistoryEnabled: true }));
});
