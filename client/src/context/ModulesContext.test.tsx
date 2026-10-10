import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModulesProvider, useModules } from './ModulesContext';

const { modulesList, state } = vi.hoisted(() => ({
  modulesList: vi.fn(),
  state: {
    isAuthenticated: true,
    authLoading: false,
    modulesEnabled: false,
  },
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  modulesApi: {
    list: modulesList,
  },
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: state.isAuthenticated,
    isLoading: state.authLoading,
  }),
}));

vi.mock('./FeaturesContext', () => ({
  useFeatures: () => ({
    features: {
      modulesEnabled: state.modulesEnabled,
    },
  }),
}));

function Probe() {
  const { modules, isLoading } = useModules();
  return (
    <div>
      <span>modules:{modules.length}</span>
      <span>loading:{String(isLoading)}</span>
    </div>
  );
}

describe('ModulesProvider', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    state.isAuthenticated = true;
    state.authLoading = false;
    state.modulesEnabled = false;
    localStorage.clear();
  });

  it('does not call the modules API while the Modules capability is disabled', async () => {
    render(
      <ModulesProvider>
        <Probe />
      </ModulesProvider>
    );

    await waitFor(() => expect(screen.getByText('loading:false')).toBeInTheDocument());
    expect(screen.getByText('modules:0')).toBeInTheDocument();
    expect(modulesList).not.toHaveBeenCalled();
  });

  it('loads modules after the Modules capability is enabled', async () => {
    state.modulesEnabled = true;
    modulesList.mockResolvedValue({ data: [] });

    render(
      <ModulesProvider>
        <Probe />
      </ModulesProvider>
    );

    await waitFor(() => expect(modulesList).toHaveBeenCalledOnce());
  });
});
