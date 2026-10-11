import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChunkRecovery, isChunkLoadError, recoverChunkLoad } from './chunkRecovery';

const error = new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/page.js');
const environment = () => ({ sessionStorage, location: { pathname: '/modules/robin-qa/cases', search: '?page=2', hash: '#case', reload: vi.fn() } });
beforeEach(() => sessionStorage.clear());

describe('chunk recovery', () => {
  it('recognizes browser and bundler import errors, not arbitrary exceptions', () => {
    expect(isChunkLoadError(error)).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Network request failed'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });
  it('reloads the same deep route once, with a guard surviving a new document', () => {
    const first = environment();
    expect(recoverChunkLoad(error, first, 1000)).toBe(true);
    expect(first.location.reload).toHaveBeenCalledOnce();
    const next = environment();
    expect(recoverChunkLoad(error, next, 2000)).toBe(false);
    expect(next.location.reload).not.toHaveBeenCalled();
    expect(recoverChunkLoad(error, next, 301_001)).toBe(true);
    expect(next.location.search).toBe('?page=2');
    expect(next.location.hash).toBe('#case');
  });
  it('does not reload ordinary failures or when storage cannot retain the guard', () => {
    const blocked = { ...environment(), sessionStorage: { getItem: () => null, setItem: () => { throw new Error('blocked'); } } };
    expect(recoverChunkLoad(error, blocked)).toBe(false);
    expect(blocked.location.reload).not.toHaveBeenCalled();
    expect(recoverChunkLoad(new Error('render failure'), environment())).toBe(false);
  });
  it('permits recovery on a different route but guards clock rollback', () => {
    const first = environment(); recoverChunkLoad(error, first, 1000);
    expect(recoverChunkLoad(error, environment(), 500)).toBe(false);
    const next = environment(); next.location.pathname = '/telemetry';
    expect(recoverChunkLoad(error, next, 1500)).toBe(true);
    expect(recoverChunkLoad(error, environment(), 1600)).toBe(false);
  });
  it('installs and removes the Vite preload listener', () => {
    const event = new Event('vite:preloadError', { cancelable: true });
    Object.assign(event, { payload: new Error('ordinary failure') });
    const dispose = installChunkRecovery();
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    dispose();
  });
  it('suppresses the Vite error only when recovery starts and disposes its handler', () => {
    const recover = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const dispose = installChunkRecovery(recover);
    const dispatch = () => {
      const event = new Event('vite:preloadError', { cancelable: true });
      Object.assign(event, { payload: error });
      window.dispatchEvent(event);
      return event;
    };
    expect(dispatch().defaultPrevented).toBe(true);
    expect(dispatch().defaultPrevented).toBe(false);
    expect(recover).toHaveBeenCalledWith(error);
    dispose();
    dispatch();
    expect(recover).toHaveBeenCalledTimes(2);
  });
  it('fails safely for corrupt storage and excessive failing routes', () => {
    sessionStorage.setItem('robin-admin.chunk-recovery', '{');
    expect(recoverChunkLoad(error, environment(), 1000)).toBe(false);
    sessionStorage.clear();
    for (let i = 0; i < 32; i++) {
      const current = environment(); current.location.pathname = `/page/${i}`;
      expect(recoverChunkLoad(error, current, 1000)).toBe(true);
    }
    expect(recoverChunkLoad(error, environment(), 1001)).toBe(false);
  });
});
