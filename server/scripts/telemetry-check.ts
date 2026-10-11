/**
 * Runs every Telemetry dashboard panel through the Robin Admin API and reports
 * panels that fail or return no data. Use it after changing dashboards, after
 * seeding, and against production at cutover to find metrics that are missing.
 *
 *   npm run telemetry:check -- [--hours 6] [--dashboard <uid>] [--each host] [--var job=metrics]
 *
 * --each <variable> runs the dashboard once per option of that variable (for
 * example every host); otherwise single-value variables use their first option
 * and multi-value variables mean all. --var pins a variable.
 *
 * Needs a telemetry:read API key in TELEMETRY_CHECK_API_KEY or
 * TELEMETRY_DEV_READ_API_KEY (environment or the repository .env).
 * TELEMETRY_CHECK_URL defaults to https://localhost:3443; the bundled Caddy's
 * internal CA is accepted for loopback hosts only.
 *
 * Exits 1 when a panel errors or a panel not marked optional is empty.
 */
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { TelemetryDashboard } from '../src/services/telemetry/dashboards/types.js';

interface Options {
  hours: number;
  dashboard?: string;
  each?: string;
  pinned: Record<string, string[]>;
}

const baseUrl = (process.env.TELEMETRY_CHECK_URL ?? 'https://localhost:3443').replace(/\/+$/, '');
const target = new URL(baseUrl);
if (target.protocol === 'https:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
  // The bundled Caddy serves a certificate from its internal CA.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

function readApiKey(): string {
  const fromEnv = process.env.TELEMETRY_CHECK_API_KEY ?? process.env.TELEMETRY_DEV_READ_API_KEY;
  if (fromEnv) return fromEnv.trim();
  try {
    const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    const match = env.match(/^TELEMETRY_(?:CHECK|DEV_READ)_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // Fall through to the error below.
  }
  throw new Error('Set TELEMETRY_CHECK_API_KEY (or TELEMETRY_DEV_READ_API_KEY) to a telemetry:read API key');
}

function parseArgs(argv: string[]): Options {
  const options: Options = { hours: 6, pinned: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    if (arg === '--hours') options.hours = Number(value);
    else if (arg === '--dashboard') options.dashboard = value;
    else if (arg === '--each') options.each = value;
    else if (arg === '--var') {
      const [name, ...rest] = value.split('=');
      (options.pinned[name] ??= []).push(rest.join('='));
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.hours) || options.hours <= 0) throw new Error('--hours must be positive');
  return options;
}

const apiKey = readApiKey();

async function get<T>(path: string, params: URLSearchParams): Promise<T> {
  let response = await fetch(`${baseUrl}/api/telemetry${path}?${params}`, { headers: { authorization: `Bearer ${apiKey}` } });
  // API keys share the per-IP rate limit; wait it out rather than failing.
  for (let attempt = 0; response.status === 429 && attempt < 10; attempt++) {
    await response.body?.cancel();
    const wait = Number(response.headers.get('retry-after')) || 5;
    await delay(wait * 1000);
    response = await fetch(`${baseUrl}/api/telemetry${path}?${params}`, { headers: { authorization: `Bearer ${apiKey}` } });
  }
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: string };
  if (!response.ok || !body.success) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body.data as T;
}

function withVariables(base: Record<string, string>, values: Record<string, string[]>): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const [name, list] of Object.entries(values)) for (const value of list) params.append(`var-${name}`, value);
  return params;
}

interface PanelData {
  series: Array<{ values: Array<number | null> }>;
}

async function checkDashboard(dashboard: TelemetryDashboard, preset: Record<string, string[]>, window: Record<string, string>): Promise<number> {
  const values: Record<string, string[]> = {};
  for (const variable of dashboard.variables) {
    if (preset[variable.name]) {
      values[variable.name] = preset[variable.name];
      continue;
    }
    const options = await get<string[]>(`/dashboards/${dashboard.uid}/variables/${variable.name}`, withVariables(window, values));
    values[variable.name] = variable.multi ? [] : options.slice(0, 1);
  }
  const label = Object.entries(values).map(([name, list]) => `${name}=${list.length ? list.join('|') : 'all'}`).join(' ');
  console.log(`\n${dashboard.title} (${dashboard.uid})${label ? ` ${label}` : ''}`);

  let failures = 0;
  for (const row of dashboard.rows) {
    for (const panel of row.panels) {
      try {
        const data = await get<PanelData>(`/dashboards/${dashboard.uid}/panels/${panel.id}`, withVariables(window, values));
        const points = data.series.reduce((sum, series) => sum + series.values.filter((value) => value !== null).length, 0);
        const empty = points === 0;
        if (empty && !panel.optional) failures++;
        const status = empty ? (panel.optional ? 'empty (optional)' : 'EMPTY') : 'ok';
        console.log(`  ${status.padEnd(16)} ${row.title} / ${panel.title}: ${data.series.length} series, ${points} points`);
      } catch (error) {
        failures++;
        console.log(`  ${'ERROR'.padEnd(16)} ${row.title} / ${panel.title}: ${(error as Error).message}`);
      }
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const end = Math.floor(Date.now() / 1000);
  const window = { start: String(end - Math.round(options.hours * 3600)), end: String(end) };
  const summaries = (await get<Array<{ uid: string }>>('/dashboards', new URLSearchParams()))
    .filter((dashboard) => !options.dashboard || dashboard.uid === options.dashboard);
  const dashboards = await Promise.all(summaries.map((summary) => get<TelemetryDashboard>(`/dashboards/${summary.uid}`, new URLSearchParams())));
  if (dashboards.length === 0) throw new Error(`No dashboard matches ${options.dashboard}`);

  let failures = 0;
  for (const dashboard of dashboards) {
    const eachVariable = options.each ? dashboard.variables.find((variable) => variable.name === options.each) : undefined;
    if (!eachVariable) {
      failures += await checkDashboard(dashboard, options.pinned, window);
      continue;
    }
    const prior: Record<string, string[]> = {};
    for (const variable of dashboard.variables.slice(0, dashboard.variables.indexOf(eachVariable))) {
      prior[variable.name] = options.pinned[variable.name] ?? [];
    }
    const choices = await get<string[]>(`/dashboards/${dashboard.uid}/variables/${eachVariable.name}`, withVariables(window, prior));
    for (const choice of choices) {
      failures += await checkDashboard(dashboard, { ...options.pinned, ...prior, [eachVariable.name]: [choice] }, window);
    }
  }
  console.log(failures === 0 ? '\nAll panels returned data.' : `\n${failures} panel(s) failed or were empty.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
