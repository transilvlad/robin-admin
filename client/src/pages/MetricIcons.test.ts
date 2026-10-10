import { describe, expect, it } from 'vitest';
import clamavMetricsSource from './ClamavMetrics.tsx?raw';
import dovecotMetricsSource from './DovecotMetrics.tsx?raw';
import fleetMetricsSource from './FleetMetrics.tsx?raw';
import metricsSource from './Metrics.tsx?raw';
import postfixMetricsSource from './PostfixMetrics.tsx?raw';
import mariadbMetricsSource from './MariadbMetrics.tsx?raw';
import postgresMetricsSource from './PostgresMetrics.tsx?raw';
import redisMetricsSource from './RedisMetrics.tsx?raw';
import rspamdMetricsSource from './RspamdMetrics.tsx?raw';

const METRIC_SURFACES = {
  'Metrics.tsx': metricsSource,
  'ClamavMetrics.tsx': clamavMetricsSource,
  'DovecotMetrics.tsx': dovecotMetricsSource,
  'FleetMetrics.tsx': fleetMetricsSource,
  'PostfixMetrics.tsx': postfixMetricsSource,
  'PostgresMetrics.tsx': postgresMetricsSource,
  'MariadbMetrics.tsx': mariadbMetricsSource,
  'RedisMetrics.tsx': redisMetricsSource,
  'RspamdMetrics.tsx': rspamdMetricsSource,
};

describe('metric icon policy', () => {
  it.each(Object.entries(METRIC_SURFACES))('uses components instead of emoji in %s', (_fileName, source) => {
    expect(source).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it.each([
    ['ClamavMetrics.tsx', clamavMetricsSource],
    ['DovecotMetrics.tsx', dovecotMetricsSource],
    ['PostfixMetrics.tsx', postfixMetricsSource],
    ['PostgresMetrics.tsx', postgresMetricsSource],
    ['MariadbMetrics.tsx', mariadbMetricsSource],
    ['RedisMetrics.tsx', redisMetricsSource],
    ['RspamdMetrics.tsx', rspamdMetricsSource],
  ])('uses the shared metric card in %s', (_fileName, source) => {
    expect(source).toContain("import { MetricCard } from '../components/ui/MetricCard'");
    expect(source).not.toContain('function MetricCard(');
  });

  it.each([
    ['Metrics.tsx', metricsSource],
    ['FleetMetrics.tsx', fleetMetricsSource],
  ])('uses shared resilient metric typography in %s', (_fileName, source) => {
    expect(source).toContain("import { MetricValue } from '../components/ui/MetricCard'");
  });

  it.each([
    ['Metrics.tsx', metricsSource],
    ['ClamavMetrics.tsx', clamavMetricsSource],
    ['FleetMetrics.tsx', fleetMetricsSource],
    ['PostgresMetrics.tsx', postgresMetricsSource],
    ['MariadbMetrics.tsx', mariadbMetricsSource],
    ['RedisMetrics.tsx', redisMetricsSource],
    ['RspamdMetrics.tsx', rspamdMetricsSource],
  ])('uses shared floating-point formatting in %s', (_fileName, source) => {
    expect(source).toMatch(/formatMetric(?:Number|Percent)|formatBytes/);
    expect(source).not.toContain('.toFixed(');
  });

  it('contains Fleet service tables within focusable horizontal scrollers', () => {
    expect(fleetMetricsSource).toContain(
      'className="min-w-0 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700"',
    );
    expect(fleetMetricsSource).toContain('className="mt-4 min-w-0">{table}</div>');
    expect(fleetMetricsSource).toContain('scrollLabel="PostgreSQL services table"');
  });
});
