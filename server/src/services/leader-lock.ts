/**
 * Leadership election for singleton background jobs.
 *
 * Robin Admin's metrics poller, alert scheduler/delivery worker, and Rspamd
 * DKIM maintenance sweep are all designed to run from exactly one process:
 * running them from more than one replica at once would double-write metrics
 * history, double-fire/double-send alerts, or race on DKIM key rotation and
 * file deletion. Robin Admin is normally deployed as a single instance, where
 * this is moot. If it is ever run with more than one replica (for example to
 * support zero-downtime rolling deploys), this module uses a Postgres
 * session-scoped advisory lock so only one replica ("the leader") starts
 * those jobs; the rest still serve HTTP/API traffic normally.
 *
 * The lock is held by a dedicated, long-lived client connection (not the
 * shared pool, where the lock would attach to whichever pooled connection
 * happened to run the query and could be silently reused by unrelated work).
 * If that connection drops — process crash, network blip, restart — Postgres
 * releases the advisory lock automatically, and any replica still retrying
 * `runAsLeader` picks up leadership on its next attempt.
 */

import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Arbitrary fixed key shared by every replica of the same Robin Admin
// deployment; the value has no other meaning. Advisory locks are scoped to
// the connected database, so separate Robin Admin deployments (separate
// databases) never contend with each other over this key.
const LOCK_KEY = 847_362_910_142;

const RETRY_INTERVAL_MS = 15_000;

let client: pg.Client | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let isLeader = false;
let leaderLost: (() => void) | null = null;
let startRetrying: (() => void) | null = null;

/**
 * The lock connection dropped (Postgres restart, network blip): the lock is
 * gone, so another replica may take it. Stop the singleton jobs here and try
 * to lead again, instead of running unguarded and never retrying.
 */
function handleLostLock(candidate: pg.Client): void {
  // A lock released on purpose (shutdown) already cleared the client.
  if (client !== candidate) return;
  client = null;
  isLeader = false;
  logger.error('Background-jobs leader lock lost; stopping singleton jobs and retrying');
  try {
    leaderLost?.();
  } catch (error) {
    logger.error('Stopping singleton jobs after losing leadership failed', { error: (error as Error).message });
  }
  startRetrying?.();
}

async function tryAcquire(): Promise<boolean> {
  const candidate = new pg.Client({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    application_name: 'robin-admin-leader-lock',
  });
  try {
    await candidate.connect();
    const result = await candidate.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [LOCK_KEY]
    );
    if (!result.rows[0]?.locked) {
      await candidate.end();
      return false;
    }
    candidate.on('error', (err) => {
      logger.error('Leader lock connection error; leadership released', { error: err.message });
      handleLostLock(candidate);
    });
    candidate.on('end', () => handleLostLock(candidate));
    client = candidate;
    return true;
  } catch (error) {
    logger.error('Leader lock acquisition attempt failed', { error: (error as Error).message });
    try {
      await candidate.end();
    } catch {
      // Connection may never have opened; nothing to clean up.
    }
    return false;
  }
}

/**
 * Attempt to become the leader for singleton background jobs, retrying
 * quietly in the background until leadership is granted. Calls `onLeader`
 * the moment leadership is acquired — immediately if available now (the
 * common single-instance case), or later once a currently-leading replica
 * releases it. If the lock is lost, `onLost` stops the jobs and retrying
 * starts again; `onLeader` runs again on the next acquisition, so it must be
 * safe to call more than once. Safe to call once at startup.
 */
export function runAsLeader(onLeader: () => void, onLost?: () => void): void {
  leaderLost = onLost ?? null;
  const attempt = async () => {
    if (isLeader) return;
    const acquired = await tryAcquire();
    if (acquired) {
      isLeader = true;
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      logger.info('Acquired background-jobs leader lock; starting singleton jobs');
      onLeader();
    }
  };

  startRetrying = () => {
    if (retryTimer) return;
    void attempt();
    retryTimer = setInterval(() => void attempt(), RETRY_INTERVAL_MS);
    retryTimer.unref();
  };
  startRetrying();
}

export function isBackgroundJobsLeader(): boolean {
  return isLeader;
}

/** Release the lock and stop retrying, for graceful shutdown. */
export async function releaseLeaderLock(): Promise<void> {
  startRetrying = null;
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  const current = client;
  client = null;
  isLeader = false;
  if (current) {
    try {
      await current.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } catch {
      // The connection close below releases the session-scoped lock anyway.
    }
    try {
      await current.end();
    } catch {
      // Already closing; nothing more to do.
    }
  }
}
