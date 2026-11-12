import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MonitoringSilences } from './MonitoringSilences';
import type { MonitoringCheck, MonitoringSilence, MonitoringTarget } from '../../types/monitoring';

const mocks = vi.hoisted(() => ({
  silences: vi.fn(),
  createSilence: vi.fn(),
  endSilence: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  ApiError: class ApiError extends Error {},
  monitoringApi: {
    silences: mocks.silences,
    createSilence: mocks.createSilence,
    endSilence: mocks.endSilence,
  },
}));

const target: MonitoringTarget = {
  id: 1, name: 'Mail host', targetType: 'host', environment: 'production',
  description: null, enabled: true, createdAt: '', updatedAt: '',
};
const check = {
  id: 2, name: 'Backup job', targetId: 1, targetName: 'Mail host',
} as MonitoringCheck;

function silence(overrides: Partial<MonitoringSilence> = {}): MonitoringSilence {
  const startsAt = new Date(Date.now() - 60_000).toISOString();
  const endsAt = new Date(Date.now() + 60 * 60_000).toISOString();
  return {
    id: 8, name: 'Upgrade', scopeType: 'target', targetId: 1, targetName: 'Mail host',
    checkId: null, checkName: null, reason: 'Database upgrade', startsAt, endsAt,
    processedAt: null, createdAt: startsAt, updatedAt: startsAt, ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.silences.mockResolvedValue({ data: [] });
  mocks.createSilence.mockResolvedValue({ data: silence() });
  mocks.endSilence.mockResolvedValue({ data: silence({ processedAt: new Date().toISOString() }) });
});

describe('monitoring maintenance silences', () => {
  it('creates a check-scoped window and explains issue behavior', async () => {
    const onChanged = vi.fn();
    render(<MonitoringSilences targets={[target]} checks={[check]} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Backup maintenance' } });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'check' } });
    fireEvent.change(screen.getByLabelText('Check'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule silence' }));

    await waitFor(() => expect(mocks.createSilence).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Backup maintenance', scopeType: 'check', checkId: 2,
    })));
    expect(screen.getByText(/Monitoring continues to record health and issues/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('ends an active window', async () => {
    mocks.silences.mockResolvedValueOnce({ data: [silence()] });
    render(<MonitoringSilences targets={[target]} checks={[check]} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'End now' }));
    await waitFor(() => expect(mocks.endSilence).toHaveBeenCalledWith(8));
  });
});
