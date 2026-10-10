export const DISCOVERY_DEFAULTS = {
  telemetrySourceLabel: 'instance',
  telemetryGroupLabel: 'job',
  telemetrySourceSelector: '{__name__=~".+"}',
};

export type DiscoverySettings = typeof DISCOVERY_DEFAULTS;
export const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const MATCHER = /\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*("(?:[^"\\\r\n]|\\["\\nrt])*")\s*/y;

/** Accept only a bounded metric selector, never a query/expression fragment. */
export function selectorMatchers(raw: string): string[] {
  if (!raw || raw.length > 1024) throw new Error('Series selector must contain 1 to 1024 characters');
  const opening = raw.indexOf('{');
  if (opening < 0) {
    if (!METRIC_NAME.test(raw)) throw new Error('Series selector must be a metric name or label selector');
    return [`__name__=${JSON.stringify(raw)}`];
  }
  if (!raw.endsWith('}')) throw new Error('Series selector must end with }');
  const metric = raw.slice(0, opening).trim();
  if (metric && !METRIC_NAME.test(metric)) throw new Error('Invalid metric name in series selector');
  const body = raw.slice(opening + 1, -1).trim();
  const matchers = metric ? [`__name__=${JSON.stringify(metric)}`] : [];
  let offset = 0;
  while (offset < body.length) {
    MATCHER.lastIndex = offset;
    const match = MATCHER.exec(body);
    if (!match) throw new Error('Invalid label matcher in series selector');
    // JSON parsing validates the bounded quoted literal, including escapes.
    const value = JSON.parse(match[3]) as string;
    matchers.push(`${match[1]}${match[2]}${JSON.stringify(value)}`);
    if (matchers.length > 20) throw new Error('Series selector has too many matchers');
    offset = MATCHER.lastIndex;
    if (offset === body.length) break;
    if (body[offset] !== ',') throw new Error('Series selector matchers must be separated by commas');
    offset++;
    if (offset === body.length) throw new Error('Series selector cannot end with a comma');
  }
  if (matchers.length === 0) throw new Error('Series selector must include a metric or label matcher');
  return matchers;
}

export function validateDiscoverySettings(updates: Record<string, unknown>, current: DiscoverySettings): string | null {
  const settings = { ...DISCOVERY_DEFAULTS, ...current, ...updates };
  if (typeof settings.telemetrySourceLabel !== 'string' || settings.telemetrySourceLabel.length > 128 || !LABEL_NAME.test(settings.telemetrySourceLabel) || settings.telemetrySourceLabel === '__name__') {
    return 'Source identity label must be a valid Prometheus label other than __name__';
  }
  if (typeof settings.telemetryGroupLabel !== 'string' || settings.telemetryGroupLabel.length > 128 || (settings.telemetryGroupLabel !== '' && (!LABEL_NAME.test(settings.telemetryGroupLabel) || settings.telemetryGroupLabel === '__name__' || settings.telemetryGroupLabel === settings.telemetrySourceLabel))) {
    return 'Grouping label must be empty or a valid, distinct Prometheus label';
  }
  if (typeof settings.telemetrySourceSelector !== 'string') return 'Series selector must be a string';
  try { selectorMatchers(settings.telemetrySourceSelector); }
  catch (error) { return (error as Error).message; }
  return null;
}

export function discoverySelector(settings: DiscoverySettings, additional: string[] = []): string {
  return `{${[...selectorMatchers(settings.telemetrySourceSelector), `${settings.telemetrySourceLabel}!=""`, ...additional].join(',')}}`;
}
