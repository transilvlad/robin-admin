/** Replace characters that PostgreSQL text and JSONB cannot represent. */
export function normalizeLogText(value: string): string {
  return value.replace(/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

export function truncateLogText(value: string, maxBytes: number): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 3) throw new RangeError('Log text limit must be at least 3 bytes');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const bytes = Buffer.from(value, 'utf8');
  let end = maxBytes - 3;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}…`;
}
