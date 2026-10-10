import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RobinConfigPage } from './RobinConfigPage';

const {
  getFiles,
  getServerIds,
  getFile,
  getClamavLink,
  setClamavLink,
  getClamavConfig,
  useServicesMock,
} = vi.hoisted(() => ({
  getFiles: vi.fn(),
  getServerIds: vi.fn(),
  getFile: vi.fn(),
  getClamavLink: vi.fn(),
  setClamavLink: vi.fn(),
  getClamavConfig: vi.fn(),
  useServicesMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  robinConfigApi: {
    getFiles,
    getServerIds,
    getFile,
    getClamavLink,
    setClamavLink,
  },
  clamavApi: {
    getConfig: getClamavConfig,
  },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => useServicesMock(),
}));

describe('RobinConfigPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();

    getFiles.mockResolvedValue({
      data: [
        { fileName: 'users.json5', serverIds: ['default'], updatedAt: '2024-01-01T00:00:00Z' },
        { fileName: 'proxy.json5', serverIds: ['default'], updatedAt: '2024-01-01T00:00:00Z' },
        { fileName: 'server.json5', serverIds: ['default'], updatedAt: '2024-01-01T00:00:00Z' },
        { fileName: 'stalwart.json5', serverIds: ['default'], updatedAt: '2024-01-01T00:00:00Z' },
        { fileName: 'vault.json5', serverIds: ['default'], updatedAt: '2024-01-01T00:00:00Z' },
      ],
    });
    getServerIds.mockResolvedValue({ data: ['default'] });
    getFile.mockImplementation(async (fileName: string) => ({
      data: {
        fileName,
        base: { config: {}, updatedAt: '2024-01-01T00:00:00Z', sha256: 'base' },
        override: null,
      },
    }));
    getClamavLink.mockResolvedValue({ data: { serverId: 'default', serviceId: null, sourceServerId: null, inherited: false } });
    setClamavLink.mockResolvedValue({ data: { serverId: 'default', serviceId: null, sourceServerId: null, inherited: false } });
    getClamavConfig.mockResolvedValue({ data: null });
    useServicesMock.mockReturnValue({
      clamavServices: [],
    });
  });

  it('prefers server.json5 on first load and uses typed forms for users, proxy, stalwart, and vault', async () => {
    render(
      <MemoryRouter>
        <RobinConfigPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('General settings')).toBeInTheDocument();
    expect(getFile).toHaveBeenCalledWith('server.json5', 'default');

    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    expect(await screen.findByText('Static test users')).toBeInTheDocument();
    expect(screen.queryByText('Edit the raw JSON configuration below. Changes are validated in real-time.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Proxy' }));
    expect(await screen.findByText('Proxy mode')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stalwart' }));
    expect(await screen.findByText('Stalwart backend')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Vault' }));
    expect(await screen.findByText('Vault integration')).toBeInTheDocument();
    expect(screen.queryByText('Edit the raw JSON configuration below. Changes are validated in real-time.')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(getFile).toHaveBeenCalledWith('users.json5', 'default');
      expect(getFile).toHaveBeenCalledWith('proxy.json5', 'default');
      expect(getFile).toHaveBeenCalledWith('stalwart.json5', 'default');
      expect(getFile).toHaveBeenCalledWith('vault.json5', 'default');
    });
  });
});
