const metricNumberFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatMetricNumber(value: number | null | undefined): string {
  const number = value ?? 0;
  return metricNumberFormatter.format(Number.isFinite(number) ? number : 0);
}

/** A 0..1 ratio (cache hit, commit ratio) as a percentage, e.g. 0.998 → "99.8%". */
export function formatMetricRatio(value: number | null | undefined): string {
  return formatMetricPercent((value ?? 0) * 100);
}

export function formatMetricPercent(value: number | null | undefined): string {
  return `${formatMetricNumber(value)}%`;
}

/** Human-readable byte size, e.g. 1536 → "2 KB", 1610612736 → "1.5 GB". */
export function formatBytes(bytes: number | null | undefined): string {
  const value = bytes ?? 0;
  if (value >= 1073741824) return `${formatMetricNumber(value / 1073741824)} GB`;
  if (value >= 1048576) return `${formatMetricNumber(value / 1048576)} MB`;
  if (value >= 1024) return `${formatMetricNumber(value / 1024)} KB`;
  return `${formatMetricNumber(value)} B`;
}
