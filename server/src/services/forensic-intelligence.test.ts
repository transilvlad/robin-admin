import { describe, expect, it, vi } from 'vitest';

// The module pulls in the DB layer at import time; none of it is exercised
// by the pure clustering function under test.
vi.mock('../db/connection.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

import { clusterForensicRecords, type ForensicRecord } from './forensic-intelligence.js';

let nextId = 1;

function record(overrides: Partial<ForensicRecord> = {}): ForensicRecord {
  return {
    id: nextId++,
    domain: 'example.com',
    sourceIp: '203.0.113.10',
    primaryFailure: 'dmarc',
    severity: 'urgent',
    verdict: 'Unauthorized sender',
    recommendation: 'Investigate',
    subject: 'Invoice',
    sender: 'billing@example.com',
    receivedAt: new Date('2026-05-02T00:00:00Z'),
    ...overrides,
  };
}

describe('clusterForensicRecords', () => {
  it('keys clusters on domain + source IP + failure type', () => {
    const clusters = clusterForensicRecords([
      record({ sourceIp: '203.0.113.10', primaryFailure: 'dmarc' }),
      record({ sourceIp: '203.0.113.10', primaryFailure: 'dmarc' }),
      record({ sourceIp: '203.0.113.10', primaryFailure: 'spf' }),
      record({ sourceIp: '203.0.113.10', primaryFailure: 'spf' }),
      record({ sourceIp: '198.51.100.7', primaryFailure: 'dmarc' }),
      record({ sourceIp: '198.51.100.7', primaryFailure: 'dmarc' }),
    ]);

    expect(clusters).toHaveLength(3);
    const keys = clusters.map((c) => `${c.domain}|${c.sourceIp}|${c.authFailure}`).sort();
    expect(keys).toEqual([
      'example.com|198.51.100.7|dmarc',
      'example.com|203.0.113.10|dmarc',
      'example.com|203.0.113.10|spf',
    ]);
  });

  it('drops singletons below the minimum occurrence threshold', () => {
    const clusters = clusterForensicRecords([record({ sourceIp: '203.0.113.99' })]);
    expect(clusters).toHaveLength(0);
  });

  it('skips records with no source IP rather than clustering them together', () => {
    const clusters = clusterForensicRecords([
      record({ sourceIp: null }),
      record({ sourceIp: null }),
    ]);
    expect(clusters).toHaveLength(0);
  });

  it('carries report ids so issue evidence can link back to raw reports', () => {
    const clusters = clusterForensicRecords([
      record({ id: 101 }),
      record({ id: 102 }),
      record({ id: 103 }),
    ]);

    expect(clusters[0].reportIds).toEqual([101, 102, 103]);
  });

  it('counts only non-info records as actionable', () => {
    const clusters = clusterForensicRecords([
      record({ severity: 'urgent' }),
      record({ severity: 'warn' }),
      record({ severity: 'info' }),
    ]);

    expect(clusters[0].count).toBe(3);
    expect(clusters[0].actionableCount).toBe(2);
  });

  it('tracks the true first and last seen regardless of input order', () => {
    const clusters = clusterForensicRecords([
      record({ receivedAt: new Date('2026-05-05T00:00:00Z') }),
      record({ receivedAt: new Date('2026-05-01T00:00:00Z') }),
      record({ receivedAt: new Date('2026-05-03T00:00:00Z') }),
    ]);

    expect(clusters[0].firstSeen.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(clusters[0].lastSeen.toISOString()).toBe('2026-05-05T00:00:00.000Z');
  });

  it('deduplicates subjects and senders', () => {
    const clusters = clusterForensicRecords([
      record({ subject: 'Invoice', sender: 'a@example.com' }),
      record({ subject: 'Invoice', sender: 'a@example.com' }),
      record({ subject: 'Payment', sender: 'b@example.com' }),
    ]);

    expect(clusters[0].subjects).toEqual(['Invoice', 'Payment']);
    expect(clusters[0].senders).toEqual(['a@example.com', 'b@example.com']);
  });

  it('orders clusters by actionable volume so triage sees the worst first', () => {
    const clusters = clusterForensicRecords([
      record({ sourceIp: '203.0.113.1', severity: 'info' }),
      record({ sourceIp: '203.0.113.1', severity: 'info' }),
      record({ sourceIp: '203.0.113.1', severity: 'info' }),
      record({ sourceIp: '203.0.113.2', severity: 'urgent' }),
      record({ sourceIp: '203.0.113.2', severity: 'urgent' }),
    ]);

    expect(clusters[0].sourceIp).toBe('203.0.113.2');
  });
});
