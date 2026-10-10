import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const settings = vi.hoisted(() => ({ url: 'http://installer.test', signingSecret: 'test-installer-secret' }));
vi.mock('../config.js', () => ({ config: { moduleInstaller: settings } }));
const module = { slug: 'robin-qa', installed: true, installedSource: 'installer', latestVersion: '0.1.6' };
beforeEach(() => { vi.resetModules(); settings.signingSecret = 'test-installer-secret'; });
afterEach(() => vi.unstubAllGlobals());

it('never probes the installer for externally managed runtimes or missing credentials', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { getAvailableInstallerActions } = await import('./module-installer.js');
  expect(await getAvailableInstallerActions({ ...module, installedSource: 'bootstrap' })).toEqual([]);
  settings.signingSecret = '';
  expect(await getAvailableInstallerActions(module)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it('authenticates and shares bounded capability requests and separates lifecycle from release approval', async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    expect(headers['x-robin-installer-signature']).toBe(createHmac('sha256', settings.signingSecret)
      .update(`${headers['x-robin-installer-timestamp']}\nGET\n/api/capabilities\n`).digest('hex'));
    return new Response(JSON.stringify({ success: true, data: { mode: 'docker', modules: { 'robin-qa': ['0.1.6'] }, upgradeStrategies: { 'robin-qa': 'maintenance' } } }));
  });
  vi.stubGlobal('fetch', fetch);
  const { getAvailableInstallerActions } = await import('./module-installer.js');
  const results = await Promise.all(Array.from({ length: 10 }, () => getAvailableInstallerActions(module)));
  expect(results[0]).toEqual(['upgrade', 'start', 'stop', 'uninstall']);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await getAvailableInstallerActions({ ...module, latestVersion: '0.1.7' })).toEqual(['start', 'stop', 'uninstall']);
  expect(await getAvailableInstallerActions({ ...module, installed: false, installedSource: null })).toEqual(['install']);
  expect(await getAvailableInstallerActions({ ...module, installed: false, installedSource: null, latestVersion: '0.1.7' })).toEqual([]);
});

it.each(['offline', 'dry-run', 'bad-schema'])('hides installer actions for %s', async variant => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (variant === 'offline') throw new Error('offline');
    return new Response(JSON.stringify({ data: variant === 'dry-run' ? { mode: 'dry-run', modules: { 'robin-qa': ['0.1.6'] } } : { mode: 'docker', modules: { 'robin-qa': false } } }));
  }));
  const { getAvailableInstallerActions } = await import('./module-installer.js');
  expect(await getAvailableInstallerActions(module)).toEqual([]);
});

it('accepts explicit runtime addresses without inspecting ports or container names', async () => {
  const { extractInstallerRuntime } = await import('./module-installer.js');
  expect(extractInstallerRuntime({ mode: 'docker', runtime: {
    backendUrl: 'https://[::1]:4000/module/', assetBaseUrl: 'http://web:80/', probeUrl: 'https://[::1]:4000/ready',
  } })).toEqual({ backendUrl: 'https://[::1]:4000/module', assetBaseUrl: 'http://web', probeUrl: 'https://[::1]:4000/ready' });
  expect(extractInstallerRuntime({ mode: 'docker', runtime: {
    backendUrl: null, assetBaseUrl: 'http://web', probeUrl: 'http://web/ready',
  } }).backendUrl).toBeNull();
});

it('fails closed for dry runs, missing contracts and invalid runtime URLs', async () => {
  const { extractInstallerRuntime } = await import('./module-installer.js');
  const runtime = { backendUrl: 'http://db', assetBaseUrl: 'http://web', probeUrl: 'http://db/ready' };
  for (const data of [undefined, { mode: 'dry-run', runtime }, { plan: { services: [] } },
    { mode: 'docker', runtime: { ...runtime, backendUrl: 'http://u:secret@db' } },
    { mode: 'docker', runtime: { ...runtime, assetBaseUrl: 'http://web/assets' } },
    { mode: 'docker', runtime: { ...runtime, probeUrl: 'http://db/ready?secret=x' } },
    { mode: 'docker', runtime: { ...runtime, backendUrl: 'http://0.0.0.0:3000' } },
    { mode: 'docker', runtime: { ...runtime, backendUrl: 'file:///app' } },
    { mode: 'docker', runtime: { ...runtime, extra: true } },
    { mode: 'docker', runtime: { assetBaseUrl: 'http://web', probeUrl: 'http://web/ready' } }]) {
    expect(() => extractInstallerRuntime(data)).toThrow(/Installer/);
  }
});
