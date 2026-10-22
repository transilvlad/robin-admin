import { describe, it, expect } from 'vitest';
import {
  FLEET_SERVICE_TYPES,
  SERVICE_TYPE_LIST,
  SERVICE_TYPE_REGISTRY,
  getServiceTypeMeta,
} from './serviceTypes';

// Minimal fake `overview.byType[type]` entries, one per type, carrying just the
// fields each type's projections read. This mirrors the server contract.
const FAKE_ENTRY: Record<string, { totalServices: number; healthyServices: number; totals: Record<string, unknown> }> = {
  robin: {
    totalServices: 1, healthyServices: 1,
    totals: { received24h: 5, delivered24h: 4, rejected24h: 1, totalReceived: 100, avgCpuPct: 3, rejectionBreakdown24h: { rbl: 1, virus: 0, spam: 2, dos: 0 } },
  },
  rspamd: {
    totalServices: 1, healthyServices: 1,
    totals: { scanned24h: 9, totalActions24h: 2, spam24h: 3, learnedSpam24h: 1, avgMemoryResidentMB: 50, actionBreakdown24h: { addHeader: 1, reject: 1, softReject: 0, greylist: 0, noAction: 0, rewriteSubject: 0, discard: 0, quarantine: 0 } },
  },
  clamav: {
    totalServices: 1, healthyServices: 1,
    totals: { queueItems: 0, peakQueue24h: 2, staleDatabaseServices: 0, unhealthySamples24h: 0 },
  },
  cyrus: {
    totalServices: 1, healthyServices: 1,
    totals: { sessions: 3, users: 2, logins24h: 4, authFailure24h: 0, imapCommands24h: 7, mailDeliveries24h: 1 },
  },
  dovecot: {
    totalServices: 1, healthyServices: 1,
    totals: { sessions: 3, users: 2, logins24h: 4, authFailure24h: 0, imapCommands24h: 7, mailDeliveries24h: 1 },
  },
  postfix: {
    totalServices: 1, healthyServices: 1,
    totals: { queueTotal: 5, queueActive: 1, queueDeferred: 2, peakQueue24h: 6, peakDeferred24h: 3, maxDeferredAgeSecs: 3600 },
  },
  redis: {
    totalServices: 1, healthyServices: 1,
    totals: { connectedClients: 5, hitRatio: 95, opsProcessed24h: 1000, evictedKeys24h: 2, peakMemoryUsedBytes24h: 1048576, peakConnectedClients24h: 8 },
  },
  postgres: {
    totalServices: 1, healthyServices: 1,
    totals: { connectionsTotal: 10, cacheHitRatio: 0.98, xactCommit24h: 500, xactRollback24h: 5, deadlocks24h: 0, peakConnectionSaturationPct24h: 40 },
  },
  mariadb: {
    totalServices: 1, healthyServices: 1,
    totals: { threadsConnected: 35, bufferPoolHitRatio: 0.99, questions24h: 10000, slowQueries24h: 3, deadlocks24h: 0, trxLockWaits: 1, maxOldestTrxAgeSecs: 900 },
  },
};

describe('service-type registry', () => {
  it('provides Cyrus IMAP monitoring without managed configuration', () => {
    expect(SERVICE_TYPE_REGISTRY.cyrus).toMatchObject({ label: 'Cyrus IMAP', routeBase: '/cyrus', hasMetricsPage: true, hasConfigPage: false });
  });
  it('has a complete entry for every registered type', () => {
    for (const type of FLEET_SERVICE_TYPES) {
      const meta = getServiceTypeMeta(type);
      expect(meta.type).toBe(type);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.icon).toBeTruthy();
      expect(meta.badgeClass.length).toBeGreaterThan(0);
      expect(meta.routeBase.startsWith('/')).toBe(true);
      expect(typeof meta.headlineCard).toBe('function');
      expect(typeof meta.throughputCards).toBe('function');
      expect(typeof meta.capacityPeaks).toBe('function');
    }
  });

  it('reports the Postgres cache hit ratio as a percentage', () => {
    expect(SERVICE_TYPE_REGISTRY.postgres.headlineCard(FAKE_ENTRY.postgres).secondaryValue).toBe('98%');
    expect(SERVICE_TYPE_REGISTRY.postgres.throughputCards(FAKE_ENTRY.postgres)[1]).toMatchObject({ value: '98%', tone: 'green' });
  });

  it('reports the MariaDB buffer pool ratio as a percentage', () => {
    expect(SERVICE_TYPE_REGISTRY.mariadb.headlineCard(FAKE_ENTRY.mariadb).secondaryValue).toBe('99%');
  });

  it('SERVICE_TYPE_LIST matches FLEET_SERVICE_TYPES order', () => {
    expect(SERVICE_TYPE_LIST.map((m) => m.type)).toEqual([...FLEET_SERVICE_TYPES]);
  });

  it('headline + throughput projections return renderable data for every type', () => {
    for (const type of FLEET_SERVICE_TYPES) {
      const entry = FAKE_ENTRY[type];
      const card = SERVICE_TYPE_REGISTRY[type].headlineCard(entry);
      expect(card.title.length).toBeGreaterThan(0);
      expect(card.status).toContain('/');
      expect(card.primaryValue).toBeTruthy();
      expect(card.secondaryValue).toBeTruthy();

      const throughput = SERVICE_TYPE_REGISTRY[type].throughputCards(entry);
      expect(throughput.length).toBeGreaterThan(0);
      for (const t of throughput) {
        expect(t.title.length).toBeGreaterThan(0);
        expect(t.value).toBeTruthy();
      }
    }
  });

  it('only robin/rspamd expose a pressure projection', () => {
    expect(typeof SERVICE_TYPE_REGISTRY.robin.pressure).toBe('function');
    expect(typeof SERVICE_TYPE_REGISTRY.rspamd.pressure).toBe('function');
    expect(SERVICE_TYPE_REGISTRY.clamav.pressure).toBeUndefined();
    expect(SERVICE_TYPE_REGISTRY.dovecot.pressure).toBeUndefined();
    expect(SERVICE_TYPE_REGISTRY.postfix.pressure).toBeUndefined();
    expect(SERVICE_TYPE_REGISTRY.redis.pressure).toBeUndefined();
    expect(SERVICE_TYPE_REGISTRY.postgres.pressure).toBeUndefined();
    expect(SERVICE_TYPE_REGISTRY.mariadb.pressure).toBeUndefined();
  });

  it('pressure renders both when there is activity and when the fleet is clean (all zero)', () => {
    const active = SERVICE_TYPE_REGISTRY.robin.pressure!(FAKE_ENTRY.robin);
    expect(active).not.toBeNull();
    expect(active!.values.some((v) => v > 0)).toBe(true);

    // Zero rejections is a legitimate, worth-seeing state (a clean fleet), not
    // an absence of data — the card should still render rather than disappear.
    const zero = SERVICE_TYPE_REGISTRY.robin.pressure!({
      totalServices: 1, healthyServices: 1,
      totals: { rejectionBreakdown24h: { rbl: 0, virus: 0, spam: 0, dos: 0 } } as Record<string, unknown>,
    });
    expect(zero).not.toBeNull();
    expect(zero!.values.every((v) => v === 0)).toBe(true);
  });
});
