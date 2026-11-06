import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LogsIngestPayloadError,
  MAX_INGEST_BODY_BYTES,
  normalizeHttpLogs,
  normalizeSentryWebhook,
  verifySentrySignature,
} from './logs-ingestion.js';

describe('normalizeHttpLogs', () => {
  it('normalizes JSON records with bounded source metadata', () => {
    const body = Buffer.from(JSON.stringify([{
      timestamp: '2026-11-03T10:00:00Z',
      message: 'connection refused',
      level: 'error',
      service: 'api',
      host: 'node-1',
      environment: 'production',
    }]));

    expect(normalizeHttpLogs(body, 'application/json', 'Falcon/production')[0]).toMatchObject({
      time: '2026-11-03T10:00:00.000Z',
      message: 'connection refused',
      serviceType: 'external',
      serviceId: 'api',
      sourceType: 'http',
      sourceName: 'Falcon/production',
      severity: 'error',
      host: 'node-1',
      environment: 'production',
    });
  });

  it('normalizes OTLP JSON resource and record attributes', () => {
    const body = Buffer.from(JSON.stringify({
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] },
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: '1793700000000000000',
            severityText: 'WARN',
            body: { stringValue: 'slow response' },
            attributes: [{ key: 'host.name', value: { stringValue: 'node-2' } }],
          }],
        }],
      }],
    }));

    expect(normalizeHttpLogs(body, 'application/json', 'otel-gateway')[0]).toMatchObject({
      time: '2026-11-03T10:00:00.000Z',
      message: 'slow response',
      serviceId: 'checkout',
      severity: 'WARN',
      host: 'node-2',
      sourceName: 'otel-gateway',
    });
  });

  it('accepts NDJSON and numeric millisecond timestamps', () => {
    const body = Buffer.from('{"timestamp":1793700000000,"message":"ok"}\n');
    expect(normalizeHttpLogs(body, 'application/x-ndjson', 'collector')[0].time)
      .toBe('2026-11-03T10:00:00.000Z');
  });

  it('rejects unsupported content types and malformed NDJSON', () => {
    expect(() => normalizeHttpLogs(Buffer.from('{}'), 'application/octet-stream', 'test'))
      .toThrow(LogsIngestPayloadError);
    expect(() => normalizeHttpLogs(Buffer.from('not-json'), 'application/x-ndjson', 'test'))
      .toThrow(/Each NDJSON line/);
  });

  it.each(['[null]', '[1]', '{"records":[false]}', '{"records":{}}', '{"resourceLogs":{}}', '[]'])('rejects malformed or empty JSON records: %s', (body) => {
    expect(() => normalizeHttpLogs(Buffer.from(body), 'application/json', 'collector')).toThrow(LogsIngestPayloadError);
  });

  it('rejects scalar NDJSON and blank text batches', () => {
    expect(() => normalizeHttpLogs(Buffer.from('null\n'), 'application/x-ndjson', 'collector')).toThrow(LogsIngestPayloadError);
    expect(() => normalizeHttpLogs(Buffer.from(' \n'), 'text/plain', 'collector')).toThrow(LogsIngestPayloadError);
  });

  it('honors larger configured request limits and bounds UTF-8 messages', () => {
    const body = Buffer.from(JSON.stringify({ message: '界'.repeat(MAX_INGEST_BODY_BYTES / 3) }));
    const [entry] = normalizeHttpLogs(body, 'application/json', 'collector', 16 * 1024 * 1024);
    expect(Buffer.byteLength(entry.message)).toBeLessThanOrEqual(8192);
    expect(entry.message).not.toContain('\uFFFD');
    expect(() => normalizeHttpLogs(body, 'application/json', 'collector')).toThrow();
  });

  it('bounds external service types without cutting a UTF-8 character', () => {
    const body = Buffer.from(JSON.stringify({ message: 'ok', service_type: '界'.repeat(100) }));
    const [entry] = normalizeHttpLogs(body, 'application/json', 'collector');
    expect(Buffer.byteLength(entry.serviceType!, 'utf8')).toBeLessThanOrEqual(120);
    expect(entry.serviceType).toContain('…');
    expect(entry.serviceType).not.toContain('\uFFFD');

    const invalid = Buffer.from(JSON.stringify({ message: 'ok', service_type: '\u0000'.repeat(120) }));
    const [normalized] = normalizeHttpLogs(invalid, 'application/json', 'collector');
    expect(Buffer.byteLength(normalized.serviceType!, 'utf8')).toBeLessThanOrEqual(120);
    expect(normalized.serviceType).not.toContain('\u0000');
  });

  it('preserves a complete replacement character at the message boundary', () => {
    const body = Buffer.from(JSON.stringify({ message: `${'x'.repeat(8192 - 6)}\uFFFDmore` }));
    const [entry] = normalizeHttpLogs(body, 'application/json', 'collector');
    expect(entry.message.endsWith('\uFFFD…')).toBe(true);
    expect(Buffer.byteLength(entry.message)).toBe(8192);
  });

  it('keeps bounded attributes as valid JSON', () => {
    const attributes = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`key-${i}`, 'x'.repeat(512)]));
    const [entry] = normalizeHttpLogs(Buffer.from(JSON.stringify({ message: 'ok', attributes })), 'application/json', 'collector');
    expect(Buffer.byteLength(entry.attributesJson!)).toBeLessThanOrEqual(8192);
    expect(() => JSON.parse(entry.attributesJson!)).not.toThrow();
  });
});

describe('Sentry webhook normalization', () => {
  const secret = 'sentry-webhook-secret';
  const body = Buffer.from(JSON.stringify({
    action: 'triggered',
    data: {
      event: {
        event_id: 'event-1',
        issue_id: 'issue-2',
        timestamp: '2026-11-03T10:00:00Z',
        message: 'Unhandled exception',
        level: 'error',
        environment: 'production',
        project: { slug: 'checkout' },
        web_url: 'https://sentry.example/issues/issue-2',
      },
    },
    installation: { uuid: 'install-1' },
  }));
  const signature = createHmac('sha256', secret).update(body).digest('hex');

  it('verifies the exact raw body signature and normalizes event metadata', () => {
    expect(verifySentrySignature(body, signature, secret)).toBe(true);
    expect(verifySentrySignature(body, signature.toUpperCase(), secret)).toBe(true);
    expect(verifySentrySignature(Buffer.from(`${body} `), signature, secret)).toBe(false);
    expect(verifySentrySignature(body, 'invalid', secret)).toBe(false);

    expect(normalizeSentryWebhook(body, 'request-1', 'event_alert')).toMatchObject({
      time: '2026-11-03T10:00:00.000Z',
      message: 'Unhandled exception',
      serviceType: 'sentry',
      serviceId: 'checkout',
      sourceType: 'sentry',
      sourceName: 'sentry',
      severity: 'error',
      environment: 'production',
      eventId: 'request-1',
    });
  });

  it('rejects unsupported webhook resources', () => {
    expect(() => normalizeSentryWebhook(body, undefined, 'unknown')).toThrow(/Unsupported Sentry webhook resource/);
  });
});
