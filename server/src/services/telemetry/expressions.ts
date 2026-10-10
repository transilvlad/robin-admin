/**
 * PromQL placeholder substitution and legend formatting for dashboard panels.
 */

import { TelemetryQueryError } from './store-client.js';

export const MAX_VARIABLE_VALUES = 100;
const MAX_VARIABLE_VALUE_LENGTH = 256;
const MIN_RATE_INTERVAL_SECONDS = 240;
const PLACEHOLDER_RE = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
const LEGEND_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Selected values per variable name; an empty list means all. */
export type VariableValues = Record<string, string[]>;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape for a double-quoted PromQL string. */
function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** A variable's selection as the body of a regex matcher. */
export function variableRegex(values: string[] | undefined): string {
  if (!values || values.length === 0) return '.+';
  const alternatives = values.map((value) => escapeString(escapeRegex(value)));
  return alternatives.length === 1 ? alternatives[0] : `(${alternatives.join('|')})`;
}

export function rateInterval(step: number): string {
  return `${Math.max(4 * step, MIN_RATE_INTERVAL_SECONDS)}s`;
}

/**
 * Substitute `$variable`, `$__interval` and `$__rate_interval`. Only the
 * names in `allowed` may appear; anything else is a definition error.
 */
export function renderExpr(expr: string, values: VariableValues, step: number, allowed: Set<string>): string {
  return expr.replace(PLACEHOLDER_RE, (_match, name: string) => {
    if (name === '__interval') return `${step}s`;
    if (name === '__rate_interval') return rateInterval(step);
    if (!allowed.has(name)) {
      throw new TelemetryQueryError(`Unknown variable $${name}`);
    }
    return variableRegex(values[name]);
  });
}

/** Brackets and double quotes balance outside string literals. */
export function balancedExpr(expr: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < expr.length; i++) {
    const char = expr[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if ('([{'.includes(char)) stack.push(char);
    else if (char in pairs && stack.pop() !== pairs[char]) return false;
  }
  return !inString && stack.length === 0;
}

export function formatSeriesName(legend: string | undefined, labels: Record<string, string>, fallback: string): string {
  if (legend) {
    const name = legend.replace(LEGEND_RE, (_match, label: string) => labels[label] ?? '').trim();
    if (name) return name;
  }
  const pairs = Object.entries(labels).filter(([key]) => key !== '__name__');
  if (pairs.length === 0) return fallback;
  return pairs.map(([key, value]) => `${key}="${value}"`).join(', ');
}

/** Read `var-<name>` query parameters (repeated for several values). */
export function parseVariableValues(query: Record<string, unknown>): VariableValues {
  const values: VariableValues = {};
  for (const [key, raw] of Object.entries(query)) {
    if (!key.startsWith('var-')) continue;
    values[key.slice('var-'.length)] = checkVariableValues(raw);
  }
  return values;
}

/** Validate one variable's selected values from a query string or JSON body. */
export function checkVariableValues(raw: unknown): string[] {
  const list = (Array.isArray(raw) ? raw : [raw]).filter((value): value is string => typeof value === 'string' && value !== '');
  if (list.length > MAX_VARIABLE_VALUES) {
    throw new TelemetryQueryError(`A variable may have at most ${MAX_VARIABLE_VALUES} values`);
  }
  if (list.some((value) => value.length > MAX_VARIABLE_VALUE_LENGTH)) {
    throw new TelemetryQueryError(`Variable values must be at most ${MAX_VARIABLE_VALUE_LENGTH} characters`);
  }
  return list;
}
