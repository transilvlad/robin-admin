import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

interface MockClient {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

const clientInstances: MockClient[] = [];

function makeClient(locked: boolean): MockClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return Promise.resolve({ rows: [{ locked }] });
      }
      return Promise.resolve({ rows: [] });
    }),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}

// The module under test constructs `new pg.Client(...)` for each acquisition
// attempt; queue mock instances so each attempt gets the next one.
let nextClients: MockClient[] = [];
function defaultClientCtor() {
  const instance = nextClients.shift() ?? makeClient(false);
  clientInstances.push(instance);
  return instance;
}
vi.mock('pg', () => ({
  default: {
    Client: vi.fn().mockImplementation(defaultClientCtor),
  },
}));

vi.mock('../config.js', () => ({
  config: {
    postgres: { host: 'localhost', port: 5432, database: 'robin', user: 'robin', password: 'robin' },
  },
}));

import pg from 'pg';
import { runAsLeader, isBackgroundJobsLeader, releaseLeaderLock } from './leader-lock.js';

describe('leader-lock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clientInstances.length = 0;
    nextClients = [];
    vi.mocked(pg.Client).mockImplementation(defaultClientCtor);
  });

  afterEach(async () => {
    await releaseLeaderLock();
    vi.useRealTimers();
  });

  it('acquires leadership immediately when the lock is free', async () => {
    nextClients = [makeClient(true)];
    const onLeader = vi.fn();

    runAsLeader(onLeader);
    await vi.runOnlyPendingTimersAsync();

    expect(onLeader).toHaveBeenCalledTimes(1);
    expect(isBackgroundJobsLeader()).toBe(true);
  });

  it('retries until leadership is granted when the lock is held elsewhere', async () => {
    let attempts = 0;
    vi.mocked(pg.Client).mockImplementation(function mockClientCtor() {
      attempts += 1;
      const instance = makeClient(attempts >= 4);
      clientInstances.push(instance);
      return instance;
    });
    const onLeader = vi.fn();

    runAsLeader(onLeader);
    await vi.runOnlyPendingTimersAsync();
    expect(onLeader).not.toHaveBeenCalled();
    expect(isBackgroundJobsLeader()).toBe(false);
    expect(attempts).toBeGreaterThanOrEqual(1);

    // Keep advancing until leadership is granted (bounded so a regression
    // that never grants it fails the test instead of hanging).
    for (let i = 0; i < 10 && !isBackgroundJobsLeader(); i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    expect(onLeader).toHaveBeenCalledTimes(1);
    expect(isBackgroundJobsLeader()).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(4);
  });

  it('closes losing connections without leaving them open', async () => {
    const losing = makeClient(false);
    nextClients = [losing];
    runAsLeader(vi.fn());
    await vi.runOnlyPendingTimersAsync();

    expect(losing.end).toHaveBeenCalledTimes(1);
  });

  it('releaseLeaderLock unlocks and closes the held connection', async () => {
    const winner = makeClient(true);
    nextClients = [winner];
    runAsLeader(vi.fn());
    await vi.runOnlyPendingTimersAsync();
    expect(isBackgroundJobsLeader()).toBe(true);

    await releaseLeaderLock();

    expect(winner.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [847_362_910_142]);
    expect(winner.end).toHaveBeenCalledTimes(1);
    expect(isBackgroundJobsLeader()).toBe(false);
  });

  it('stops the jobs and leads again after the lock connection drops', async () => {
    const first = makeClient(true);
    const second = makeClient(true);
    nextClients = [first, second];
    const onLeader = vi.fn();
    const onLost = vi.fn();

    runAsLeader(onLeader, onLost);
    await vi.runOnlyPendingTimersAsync();
    expect(onLeader).toHaveBeenCalledTimes(1);

    const endHandler = first.on.mock.calls.find(([event]) => event === 'end')?.[1] as () => void;
    endHandler();
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(isBackgroundJobsLeader()).toBe(false);

    await vi.runOnlyPendingTimersAsync();
    expect(onLeader).toHaveBeenCalledTimes(2);
    expect(isBackgroundJobsLeader()).toBe(true);
  });

  it('does not treat a deliberate release as a lost lock', async () => {
    const client = makeClient(true);
    nextClients = [client];
    const onLost = vi.fn();
    runAsLeader(vi.fn(), onLost);
    await vi.runOnlyPendingTimersAsync();
    await releaseLeaderLock();
    const endHandler = client.on.mock.calls.find(([event]) => event === 'end')?.[1] as () => void;
    endHandler();
    expect(onLost).not.toHaveBeenCalled();
  });
});

