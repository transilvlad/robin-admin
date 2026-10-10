import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RedisConfigPage } from './RedisConfig';

const { getConfig, getStatus, getRenderedConfig, updateConfig, reload } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getStatus: vi.fn(),
  getRenderedConfig: vi.fn(),
  updateConfig: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  redisApi: { getConfig, getStatus, getRenderedConfig, updateConfig, reload },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedRedisService: { serviceId: 'redis1', name: 'Redis 1', serviceType: 'redis' },
    redisServices: [{ serviceId: 'redis1', name: 'Redis 1', serviceType: 'redis' }],
  }),
}));

vi.mock('../components/fleet/PageServiceSelector', () => ({
  PageServiceSelector: () => <div data-testid="selector" />,
}));

vi.mock('../constants/appIcons', () => ({ appIcons: new Proxy({}, { get: () => () => null }) }));

const MANAGED = {
  maxmemory: '256mb',
  maxmemoryPolicy: 'noeviction' as const,
  save: '3600 1 300 100 60 10000',
  appendonly: false,
  appendfsync: 'everysec' as const,
  timeout: 0,
  tcpKeepalive: 300,
  maxclients: 10000,
  slowlogLogSlowerThan: 10000,
  slowlogMaxLen: 128,
  loglevel: 'notice' as const,
  notifyKeyspaceEvents: '',
  lazyfreeLazyEviction: false,
  lazyfreeLazyExpire: false,
  lazyfreeLazyServerDel: false,
  lazyfreeLazyUserDel: false,
  lazyfreeLazyUserFlush: false,
  hz: 10,
};

describe('RedisConfigPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ data: { serviceId: 'redis1', serviceName: 'Redis 1', managed: MANAGED } });
    getStatus.mockResolvedValue({ data: { serviceId: 'redis1', serviceName: 'Redis 1', reachable: true, managed: MANAGED, metrics: null } });
    getRenderedConfig.mockResolvedValue({ data: { managed: 'maxmemory 256mb' } });
  });

  it('renders the managed config form loaded from the API', async () => {
    render(<MemoryRouter><RedisConfigPage /></MemoryRouter>);

    expect(await screen.findByText('Redis config')).toBeInTheDocument();
    await waitFor(() => expect(getConfig).toHaveBeenCalledWith('redis1'));
    expect(await screen.findByDisplayValue('256mb')).toBeInTheDocument();
    await waitFor(() => expect(getRenderedConfig).toHaveBeenCalledWith('redis1'));
  });
});
