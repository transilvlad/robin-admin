/**
 * PostgreSQL database connection pool.
 */

import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  database: config.postgres.database,
  user: config.postgres.user,
  password: config.postgres.password,
  max: config.postgres.poolMax,
  min: config.postgres.poolMin,
  idleTimeoutMillis: config.postgres.idleTimeoutMillis,
  connectionTimeoutMillis: config.postgres.connectionTimeoutMillis,
  // Backstop so a stuck statement or an abandoned open transaction can never
  // hold a pool slot forever — Postgres will error it out, which forces the
  // client back through pg's normal release path.
  statement_timeout: config.postgres.statementTimeoutMillis,
  idle_in_transaction_session_timeout: config.postgres.idleInTransactionSessionTimeoutMillis,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  application_name: 'robin-admin',
});

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', { error: err.message });
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

/**
 * Execute a query with automatic connection management.
 */
export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    logger.debug('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
    return result;
  } catch (error) {
    logger.error('Database query failed', {
      error: (error as Error).message,
      duration: Date.now() - start,
      text: text.replace(/\s+/g, ' ').trim().substring(0, 160),
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    });
    throw error;
  }
}

/**
 * Get a client from the pool for transactions.
 */
export async function getClient(): Promise<pg.PoolClient> {
  const start = Date.now();
  try {
    return await pool.connect();
  } catch (error) {
    logger.error('Database client checkout failed', {
      error: (error as Error).message,
      duration: Date.now() - start,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    });
    throw error;
  }
}

/**
 * Test database connection.
 */
export async function testConnection(): Promise<boolean> {
  try {
    await query('SELECT 1');
    logger.info('Database connection successful');
    return true;
  } catch (error) {
    logger.error('Database connection failed', { error: (error as Error).message });
    return false;
  }
}

/**
 * Close the pool (for graceful shutdown).
 */
export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('Database pool closed');
}
