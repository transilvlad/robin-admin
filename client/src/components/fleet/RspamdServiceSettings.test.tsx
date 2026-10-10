import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RspamdServiceSettings } from './RspamdServiceSettings';

const { getSettings, updateSettings } = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));

vi.mock('../../api/client', () => ({
  ApiError: class ApiError extends Error {},
  rspamdApi: { getSettings, updateSettings },
}));

describe('RspamdServiceSettings', () => {
  it('loads the storage directories and saves them for the service', async () => {
    getSettings.mockResolvedValue({ data: { settings: { hasControllerPassword: true, rspamdTrainingDir: '', rspamdStoreDir: '/mnt/rspamd/store' } } });
    updateSettings.mockResolvedValue({ data: {} });
    const onSaved = vi.fn();
    render(<RspamdServiceSettings serviceId="rspamd-1" onSaved={onSaved} />);

    expect(await screen.findByDisplayValue('/mnt/rspamd/store')).toBeInTheDocument();
    expect(screen.getByText('Password set')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('/mnt/rspamd/store/training'), { target: { value: ' /data/training ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save storage' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ rspamdTrainingDir: '/data/training', rspamdStoreDir: '/mnt/rspamd/store' }, 'rspamd-1'));
    expect(await screen.findByRole('status')).toHaveTextContent('Storage settings saved');
    expect(onSaved).toHaveBeenCalled();
  });
});
