import { createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_INGEST_LINES, MAX_LINE_BYTES, MAX_SOURCE_NAME_LENGTH, type LogEntry } from './logs-store.js';
import { normalizeLogText, truncateLogText } from './log-text.js';

export const MAX_INGEST_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ATTRIBUTE_COUNT = 32;
const MAX_ATTRIBUTE_VALUE_LENGTH = 512;
const MAX_ATTRIBUTES_JSON_BYTES = 8 * 1024;
const MAX_SERVICE_TYPE_BYTES = 120;
const SENTRY_RESOURCES = new Set([
  'installation',
  'event_alert',
  'issue',
  'metric_alert',
  'error',
  'comment',
  'seer',
  'preprod_artifact',
]);

type JsonRecord = Record<string, unknown>;

export class LogsIngestPayloadError extends Error {
  readonly status = 400;
}

export class LogsIngestBodyTooLargeError extends Error {
  readonly status = 413;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function attributeValue(value: unknown): string | undefined {
  if (!isRecord(value)) return asString(value);
  for (const key of ['stringValue', 'boolValue', 'intValue', 'doubleValue']) {
    const scalar = asString(value[key]);
    if (scalar !== undefined) return scalar;
  }
  if (value.arrayValue && isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
    return JSON.stringify(value.arrayValue.values.map(attributeValue));
  }
  if (value.kvlistValue && isRecord(value.kvlistValue)) {
    return JSON.stringify(value.kvlistValue);
  }
  return undefined;
}

function attributeMap(value: unknown): JsonRecord {
  if (isRecord(value)) return value;
  if (!Array.isArray(value)) return {};
  const result: JsonRecord = {};
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.key !== 'string') continue;
    const parsed = attributeValue(entry.value);
    if (parsed !== undefined) result[entry.key] = parsed;
  }
  return result;
}

function jsonAttributes(resource: JsonRecord, record: JsonRecord): string | undefined {
  const combined = { ...attributeMap(resource.attributes), ...attributeMap(record.attributes) };
  const bounded: JsonRecord = {};
  for (const [key, value] of Object.entries(combined).slice(0, MAX_ATTRIBUTE_COUNT)) {
    const normalized = key.trim().slice(0, 100);
    const parsed = attributeValue(value);
    if (normalized && parsed !== undefined) {
      bounded[normalized] = truncateLogText(parsed, MAX_ATTRIBUTE_VALUE_LENGTH);
      if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > MAX_ATTRIBUTES_JSON_BYTES) {
        delete bounded[normalized];
        break;
      }
    }
  }
  if (Object.keys(bounded).length === 0) return undefined;
  return JSON.stringify(bounded);
}

function resolveString(record: JsonRecord, keys: string[], attributes: JsonRecord = {}): string | undefined {
  for (const key of keys) {
    const direct = asString(record[key]);
    if (direct !== undefined) return direct;
    const fromAttributes = asString(attributes[key]);
    if (fromAttributes !== undefined) return fromAttributes;
  }
  return undefined;
}

function resolveMessage(record: JsonRecord): string {
  for (const key of ['message', '_msg', 'msg', 'log', 'body']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (isRecord(value)) {
      const scalar = attributeValue(value);
      if (scalar?.trim()) return scalar;
    }
  }
  return JSON.stringify(record);
}

function parseTimestamp(record: JsonRecord): string | undefined {
  const candidate = record.timestamp ?? record.time ?? record.eventTime ?? record.timeUnixNano ?? record.time_unix_nano;
  if (candidate === undefined || candidate === null || candidate === '') return undefined;
  if (typeof candidate === 'string' && /^\d{16,}$/.test(candidate)) {
    try {
      const millis = Number(BigInt(candidate) / 1_000_000n);
      const date = new Date(millis);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    } catch {
      return undefined;
    }
  }
  if (typeof candidate === 'string' && /^\d{10,13}$/.test(candidate)) {
    const numeric = Number(candidate);
    const date = new Date(numeric > 1e12 ? numeric : numeric * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof candidate === 'number' && candidate > 1e15) {
    const date = new Date(candidate / 1_000_000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof candidate === 'number' && candidate > 1e12) {
    const date = new Date(candidate);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const date = typeof candidate === 'number' ? new Date(candidate * 1000) : new Date(String(candidate));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeRecord(record: JsonRecord, sourceName: string, sourceType = 'http', resource: JsonRecord = {}): LogEntry {
  const resourceAttributes = attributeMap(resource.attributes);
  const lineAttributes = attributeMap(record.attributes);
  const attributes = { ...resourceAttributes, ...lineAttributes };
  const serviceName = resolveString(record, ['service_id', 'serviceId', 'service.name', 'serviceName', 'service'], attributes)
    ?? resolveString(resource, ['service.name', 'serviceName'], resourceAttributes);
  const now = new Date().toISOString();
  const message = truncateLogText(resolveMessage(record), MAX_LINE_BYTES);
  return {
    time: parseTimestamp(record) ?? now,
    receivedAt: now,
    message,
    serviceType: truncateLogText(normalizeLogText(resolveString(record, ['service_type', 'serviceType'], attributes) ?? 'external'), MAX_SERVICE_TYPE_BYTES),
    ...(serviceName ? { serviceId: truncateLogText(serviceName, 256) } : {}),
    source: truncateLogText(resolveString(record, ['source', 'origin', 'file']) ?? sourceName, 256),
    sourceType,
    sourceName: truncateLogText(sourceName, MAX_SOURCE_NAME_LENGTH),
    ...(resolveString(record, ['severity', 'severityText', 'level'], attributes)
      ? { severity: truncateLogText(resolveString(record, ['severity', 'severityText', 'level'], attributes)!, 32) }
      : {}),
    ...(resolveString(record, ['host', 'hostname', 'host.name'], attributes)
      ? { host: truncateLogText(resolveString(record, ['host', 'hostname', 'host.name'], attributes)!, 256) }
      : {}),
    ...(resolveString(record, ['environment', 'deployment.environment.name'], attributes)
      ? { environment: truncateLogText(resolveString(record, ['environment', 'deployment.environment.name'], attributes)!, 128) }
      : {}),
    ...(resolveString(record, ['event_id', 'eventId', 'id']) ? { eventId: truncateLogText(resolveString(record, ['event_id', 'eventId', 'id'])!, 256) } : {}),
    ...(jsonAttributes(resource, record) ? { attributesJson: jsonAttributes(resource, record) } : {}),
  };
}

function otlpRecords(root: JsonRecord): Array<{ record: JsonRecord; resource: JsonRecord }> | null {
  if ('resourceLogs' in root && !Array.isArray(root.resourceLogs)) {
    throw new LogsIngestPayloadError('resourceLogs must be an array');
  }
  if (!Array.isArray(root.resourceLogs)) return null;
  const result: Array<{ record: JsonRecord; resource: JsonRecord }> = [];
  for (const resourceLog of root.resourceLogs) {
    if (!isRecord(resourceLog) || !Array.isArray(resourceLog.scopeLogs)) {
      throw new LogsIngestPayloadError('Each OTLP resource must contain a scopeLogs array');
    }
    for (const scopeLog of resourceLog.scopeLogs) {
      if (!isRecord(scopeLog) || !Array.isArray(scopeLog.logRecords)) {
        throw new LogsIngestPayloadError('Each OTLP scope must contain a logRecords array');
      }
      for (const logRecord of scopeLog.logRecords) {
        if (!isRecord(logRecord)) throw new LogsIngestPayloadError('Each OTLP log record must be an object');
        result.push({ record: logRecord, resource: isRecord(resourceLog.resource) ? resourceLog.resource : {} });
      }
    }
  }
  return result;
}

function jsonRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new LogsIngestPayloadError('Each log record must be a JSON object');
  return value;
}

function parseJsonRecords(body: Buffer): Array<{ record: JsonRecord; resource: JsonRecord }> {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new LogsIngestPayloadError('Request body must contain valid JSON');
  }
  if (Array.isArray(value)) {
    return value.map((record) => ({ record: jsonRecord(record), resource: {} }));
  }
  if (!isRecord(value)) throw new LogsIngestPayloadError('Request body must be a JSON object or array');
  const otlp = otlpRecords(value);
  if (otlp) return otlp;
  if (Array.isArray(value.records)) {
    return value.records.map((record) => ({ record: jsonRecord(record), resource: {} }));
  }
  if ('records' in value) throw new LogsIngestPayloadError('records must be an array');
  return [{ record: value, resource: {} }];
}

export function normalizeHttpLogs(body: Buffer, contentType: string | undefined, sourceName: string, bodyLimit = MAX_INGEST_BODY_BYTES): LogEntry[] {
  if (body.length > bodyLimit) throw new LogsIngestBodyTooLargeError();
  if (body.length === 0) throw new LogsIngestPayloadError('Request body is empty');
  const mediaType = (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  let records: Array<{ record: JsonRecord; resource: JsonRecord }>;
  if (mediaType === 'application/x-ndjson' || mediaType === 'application/ndjson') {
    records = body.toString('utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return { record: jsonRecord(parsed), resource: {} };
      } catch {
        throw new LogsIngestPayloadError('Each NDJSON line must be a JSON object');
      }
    });
  } else if (mediaType === 'text/plain') {
    records = body.toString('utf8').split(/\r?\n/).filter((line) => line.trim())
      .map((line) => ({ record: { message: line }, resource: {} }));
  } else if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    records = parseJsonRecords(body);
  } else {
    throw new LogsIngestPayloadError('Content-Type must be application/json, application/x-ndjson, or text/plain');
  }
  if (records.length === 0) throw new LogsIngestPayloadError('Request body must contain at least one log record');
  if (records.length > MAX_INGEST_LINES) throw new LogsIngestPayloadError(`Ingest at most ${MAX_INGEST_LINES} log lines per request`);
  return records.map(({ record, resource }) => normalizeRecord(record, sourceName, 'http', resource));
}

function sentryMessage(payload: JsonRecord, data: JsonRecord, event: JsonRecord): string {
  return asString(event.message)
    ?? asString(event.title)
    ?? asString(data.title)
    ?? asString(payload.triggered_rule)
    ?? `${asString(payload.action) ?? 'updated'} Sentry ${asString(payload.resource) ?? 'event'}`;
}

export function verifySentrySignature(body: Buffer, signature: string | undefined, clientSecret: string): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature) || !clientSecret) return false;
  const expected = createHmac('sha256', clientSecret).update(body).digest('hex');
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(signature.toLowerCase(), 'utf8');
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export function normalizeSentryWebhook(body: Buffer, requestId: string | undefined, resourceHeader: string | undefined): LogEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new LogsIngestPayloadError('Sentry webhook body must be valid JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.data)) throw new LogsIngestPayloadError('Sentry webhook payload is incomplete');
  if (!resourceHeader || !SENTRY_RESOURCES.has(resourceHeader)) throw new LogsIngestPayloadError('Unsupported Sentry webhook resource');
  const data = parsed.data;
  const event = isRecord(data.event) ? data.event : isRecord(data.issue) ? data.issue : {};
  const installation = isRecord(parsed.installation) ? parsed.installation : {};
  const eventTime = parseTimestamp(event) ?? new Date().toISOString();
  const issueId = resolveString(event, ['issue_id', 'issueId', 'id']) ?? resolveString(data, ['issue_id', 'issueId']);
  const eventId = requestId ?? resolveString(event, ['event_id', 'eventId', 'id']) ?? issueId;
  const project = isRecord(event.project) ? event.project : isRecord(data.project) ? data.project : {};
  const normalized = normalizeRecord({
    message: sentryMessage(parsed, data, event),
    timestamp: eventTime,
    service_type: 'sentry',
    service_id: asString(project.slug) ?? asString(project.name) ?? asString(event.project) ?? 'sentry',
    source: resolveString(event, ['web_url', 'url']) ?? resolveString(data, ['web_url', 'url']) ?? 'sentry',
    severity: resolveString(event, ['level', 'severity']),
    environment: resolveString(event, ['environment']),
    event_id: eventId,
    attributes: {
      resource: resourceHeader,
      issue_id: issueId ?? '',
      action: asString(parsed.action) ?? '',
      project: asString(project.slug) ?? asString(project.name) ?? '',
      issue_url: resolveString(data, ['issue_url']) ?? '',
      event_url: resolveString(event, ['web_url', 'url']) ?? resolveString(data, ['web_url']) ?? '',
      triggered_rule: asString(parsed.triggered_rule) ?? '',
      installation: asString(installation.uuid) ?? '',
    },
  }, 'sentry', 'sentry');
  return { ...normalized, time: eventTime };
}
