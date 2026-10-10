import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { monitoringApi } from '../../api/client';
import { MonitoringConfigTransfer } from './MonitoringConfigTransfer';

vi.mock('../../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, monitoringApi: { exportConfiguration: vi.fn(), importConfiguration: vi.fn() } };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Monitoring configuration transfer controls', () => {
  it('previews changes before applying them and refreshes Monitoring afterward', async () => {
    const config = { format: 'robin-admin-monitoring', version: 1, targets: [], checks: [], sections: [], components: [] };
    vi.mocked(monitoringApi.importConfiguration)
      .mockResolvedValueOnce({ success: true, data: { changes: [{ resource: 'target', action: 'create', identity: 'Mail (production)' }], conflicts: [], errors: [] } })
      .mockResolvedValueOnce({ success: true, data: { changes: [{ resource: 'target', action: 'create', identity: 'Mail (production)' }], conflicts: [], errors: [] } });
    const onImported = vi.fn();
    render(<MonitoringConfigTransfer onImported={onImported} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const file = new File([JSON.stringify(config)], 'monitoring.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('Configuration file'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview import' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));

    await screen.findByRole('region', { name: 'Import preview' });
    expect(screen.getByText(/1 creates · 0 updates · 0 conflicts · 0 invalid rows/)).toBeTruthy();
    expect(monitoringApi.importConfiguration).toHaveBeenCalledWith(config, true);

    fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(monitoringApi.importConfiguration).toHaveBeenCalledWith(config, false);
  });
});
