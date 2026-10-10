import { beforeEach, describe, expect, it, vi } from 'vitest';

const federationMock = vi.hoisted(() => {
  const runtime = {
    registerRemotes: vi.fn(),
    loadRemote: vi.fn(),
  };

  return {
    runtime,
    createInstance: vi.fn(() => runtime),
    getInstance: vi.fn(() => null),
  };
});

vi.mock('@module-federation/runtime', () => ({
  createInstance: federationMock.createInstance,
  getInstance: federationMock.getInstance,
}));

describe('module federation loader', () => {
  beforeEach(() => {
    vi.resetModules();
    federationMock.runtime.registerRemotes.mockReset();
    federationMock.runtime.loadRemote.mockReset();
    federationMock.createInstance.mockClear();
    federationMock.getInstance.mockClear();
    federationMock.getInstance.mockReturnValue(null);
  });

  it('registers a remote once when definition and component loads share the same remote', async () => {
    const RemoteComponent = () => null;
    federationMock.runtime.loadRemote.mockResolvedValue({
      default: RemoteComponent,
      moduleDefinition: {
        title: 'Robin Tools',
        defaultPath: 'dns/spf',
        navigation: [],
      },
    });

    const { loadRemoteModuleComponent, loadRemoteModuleDefinition } = await import('./moduleFederation');

    const [definition, component] = await Promise.all([
      loadRemoteModuleDefinition('/modules/robin-tools/remoteEntry.js', 'robinTools', './RobinToolsApp'),
      loadRemoteModuleComponent('/modules/robin-tools/remoteEntry.js', 'robinTools', './RobinToolsApp'),
    ]);

    expect(definition?.title).toBe('Robin Tools');
    expect(component).toBe(RemoteComponent);
    expect(federationMock.runtime.registerRemotes).toHaveBeenCalledTimes(1);
    expect(federationMock.runtime.registerRemotes).toHaveBeenCalledWith([
      {
        name: 'robinTools',
        entry: '/modules/robin-tools/remoteEntry.js',
        type: 'module',
      },
    ]);
  });

  it('forces registration only when the same remote scope changes entry URL', async () => {
    federationMock.runtime.loadRemote.mockResolvedValue({
      moduleDefinition: {
        title: 'Robin Tools',
        navigation: [],
      },
    });

    const { loadRemoteModuleDefinition } = await import('./moduleFederation');

    await loadRemoteModuleDefinition('/modules/robin-tools/remoteEntry.js', 'robinTools', './RobinToolsApp');
    await loadRemoteModuleDefinition('/modules/robin-tools/remoteEntry.v2.js', 'robinTools', './RobinToolsApp');

    expect(federationMock.runtime.registerRemotes).toHaveBeenCalledTimes(2);
    expect(federationMock.runtime.registerRemotes).toHaveBeenNthCalledWith(2, [
      {
        name: 'robinTools',
        entry: '/modules/robin-tools/remoteEntry.v2.js',
        type: 'module',
      },
    ], { force: true });
  });
});
