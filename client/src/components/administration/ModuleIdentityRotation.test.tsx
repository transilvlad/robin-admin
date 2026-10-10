import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { moduleIdentityApi, type ModuleIdentityRotationStatus } from '../../api/client';
import { ModuleIdentityRotation } from './ModuleIdentityRotation';

vi.mock('../../api/client', () => ({
  moduleIdentityApi: {
    get: vi.fn(),
    prepare: vi.fn(),
    acknowledge: vi.fn(),
    activate: vi.fn(),
    cancel: vi.fn(),
    prepareRetirement: vi.fn(),
    retire: vi.fn(),
    rollback: vi.fn(),
  },
}));

const oldKey = { kid: 'old-key', kty: 'OKP', crv: 'Ed25519', x: 'old-public', alg: 'EdDSA', use: 'sig' };
const newKey = { kid: 'new-key', kty: 'OKP', crv: 'Ed25519', x: 'new-public', alg: 'EdDSA', use: 'sig' };
const stable: ModuleIdentityRotationStatus = {
  issuer: 'urn:robin-admin:fixture',
  trust: { issuer: 'urn:robin-admin:fixture', keys: [oldKey] },
  trustFingerprint: 'a'.repeat(64),
  stage: 'stable',
  active: { kid: 'old-key', createdAt: '2026-10-05T00:00:00.000Z' },
  pending: null,
  retiring: null,
  retentionMs: 360_000,
  trustExportConfigured: true,
  configuredModules: ['robin-tools'],
  affectedModules: [],
  activationReadiness: [],
  retirementReadiness: [],
};
const pending: ModuleIdentityRotationStatus = {
  ...stable,
  trust: { ...stable.trust, keys: [oldKey, newKey] },
  trustFingerprint: 'b'.repeat(64),
  stage: 'pending',
  pending: { kid: 'new-key', createdAt: '2026-10-05T00:01:00.000Z' },
  affectedModules: ['robin-tools'],
  activationReadiness: [{ moduleSlug: 'robin-tools', ready: false, acknowledgedAt: null, evidence: null }],
};
const acknowledged: ModuleIdentityRotationStatus = {
  ...pending,
  activationReadiness: [{ moduleSlug: 'robin-tools', ready: true, acknowledgedAt: '2026-10-05T00:02:00.000Z', evidence: 'Restarted backend.' }],
};
const retiring: ModuleIdentityRotationStatus = {
  ...stable,
  trust: { ...stable.trust, keys: [oldKey, newKey] },
  trustFingerprint: 'c'.repeat(64),
  stage: 'retiring',
  active: { kid: 'new-key', createdAt: '2026-10-05T00:01:00.000Z' },
  retiring: { kid: 'old-key', createdAt: '2026-10-05T00:00:00.000Z', retireAfter: new Date(Date.now() - 1000).toISOString(), trustRemovalPreparedAt: null },
};
const retirementPrepared: ModuleIdentityRotationStatus = {
  ...retiring,
  trust: { ...stable.trust, keys: [newKey] },
  trustFingerprint: 'd'.repeat(64),
  stage: 'retirement-ready',
  retiring: { ...retiring.retiring!, trustRemovalPreparedAt: '2026-10-05T00:10:00.000Z' },
  affectedModules: ['robin-tools'],
  retirementReadiness: [{ moduleSlug: 'robin-tools', ready: false, acknowledgedAt: null, evidence: null }],
};
const retirementAcknowledged: ModuleIdentityRotationStatus = {
  ...retirementPrepared,
  retirementReadiness: [{ moduleSlug: 'robin-tools', ready: true, acknowledgedAt: '2026-10-05T00:11:00.000Z', evidence: 'Restarted backend.' }],
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(moduleIdentityApi.get).mockResolvedValue({ success: true, data: stable });
});

it('requires backend trust evidence before activation and never displays private key material', async () => {
  vi.mocked(moduleIdentityApi.prepare).mockResolvedValue({ success: true, data: pending });
  vi.mocked(moduleIdentityApi.acknowledge).mockResolvedValue({ success: true, data: acknowledged });
  vi.mocked(moduleIdentityApi.activate).mockResolvedValue({ success: true, data: retiring });
  render(<MemoryRouter><ModuleIdentityRotation disabled={false} /></MemoryRouter>);
  expect(await screen.findByText('stable')).toBeInTheDocument();
  expect(screen.queryByText('PRIVATE KEY')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare rotation' }));
  expect(await screen.findByText('Pending key new-key')).toBeInTheDocument();
  const activate = screen.getByRole('button', { name: 'Activate pending key' });
  expect(activate).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/Evidence that this backend process/), { target: { value: 'Restarted robin-tools with the new public trust.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge readiness' }));
  await waitFor(() => expect(activate).toBeEnabled());
  fireEvent.click(activate);
  await waitFor(() => expect(moduleIdentityApi.activate).toHaveBeenCalledOnce());
  expect(moduleIdentityApi.acknowledge).toHaveBeenCalledWith('activation', 'robin-tools', 'Restarted robin-tools with the new public trust.');
});

it('publishes active-only trust, requires retirement readiness, then retires the old key', async () => {
  vi.mocked(moduleIdentityApi.get).mockResolvedValue({ success: true, data: retiring });
  vi.mocked(moduleIdentityApi.prepareRetirement).mockResolvedValue({ success: true, data: retirementPrepared });
  vi.mocked(moduleIdentityApi.acknowledge).mockResolvedValue({ success: true, data: retirementAcknowledged });
  vi.mocked(moduleIdentityApi.retire).mockResolvedValue({ success: true, data: stable });
  render(<MemoryRouter><ModuleIdentityRotation disabled={false} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Publish trust without old key' }));
  expect(await screen.findByText(/export now omits the retained key/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/Evidence that this backend process/), { target: { value: 'Restarted robin-tools with active-only trust.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge readiness' }));
  const retire = await screen.findByRole('button', { name: 'Retire old key' });
  await waitFor(() => expect(retire).toBeEnabled());
  fireEvent.click(retire);
  await waitFor(() => expect(moduleIdentityApi.retire).toHaveBeenCalledOnce());
  expect(moduleIdentityApi.acknowledge).toHaveBeenCalledWith('retirement', 'robin-tools', 'Restarted robin-tools with active-only trust.');
});
