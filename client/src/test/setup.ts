import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import { capabilityAllowed, resetCapabilities } from './capabilities';

beforeEach(() => {
  resetCapabilities();
});

// Some pages load in several steps (status, dashboard, variables, panels);
// on a loaded CI runner that takes longer than the 1 s default wait.
configure({ asyncUtilTimeout: 5000 });

// Pages gate features on the selected service's capabilities. Tests that mock
// FeaturesContext themselves replace this.
vi.mock('../context/FeaturesContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context/FeaturesContext')>();
  return {
    ...actual,
    useFeatures: () => ({
      features: {},
      isLoading: false,
      capabilitiesSettled: true,
      refresh: async () => undefined,
    }),
    useServiceCapabilities: (serviceId: string | null | undefined) => ({
      loaded: Boolean(serviceId),
      features: undefined,
      can: (id: string) => Boolean(serviceId) && capabilityAllowed(id),
      reason: () => undefined,
    }),
  };
});
