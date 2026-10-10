import type { IncomingHttpHeaders } from 'node:http';
import type { MonitoringHttpAssertion } from '../../types/monitoring.js';

export function evaluateAssertions(assertions: MonitoringHttpAssertion[], body: string, headers: IncomingHttpHeaders): Array<{ index: number; kind: string; passed: boolean }> {
  let json: unknown;
  let parsed = false;
  if (assertions.some(assertion => assertion.kind === 'json')) {
    try { json = JSON.parse(body); parsed = true; } catch { /* Invalid JSON fails JSON assertions. */ }
  }
  return assertions.map((assertion, index) => {
    let actual: unknown;
    let present = true;
    if (assertion.kind === 'body') actual = body;
    else if (assertion.kind === 'header') {
      actual = headers[assertion.name.toLowerCase()];
      present = Object.hasOwn(headers, assertion.name.toLowerCase()) && actual !== undefined;
      if (Array.isArray(actual)) actual = actual.join(', ');
    } else {
      actual = json;
      present = parsed;
      for (const raw of assertion.pointer === '' ? [] : assertion.pointer.slice(1).split('/')) {
        const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!present || actual === null || typeof actual !== 'object' || !Object.hasOwn(actual, key)) { present = false; break; }
        actual = (actual as Record<string, unknown>)[key];
      }
    }
    let passed = false;
    if (present) {
      const expected = assertion.value;
      switch (assertion.operator) {
        case 'exists': passed = true; break;
        case 'equals': passed = actual === expected; break;
        case 'not_equals': passed = actual !== expected; break;
        case 'contains': passed = typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected); break;
        case 'not_contains': passed = typeof actual === 'string' && typeof expected === 'string' && !actual.includes(expected); break;
        case 'gt': passed = typeof actual === 'number' && typeof expected === 'number' && actual > expected; break;
        case 'gte': passed = typeof actual === 'number' && typeof expected === 'number' && actual >= expected; break;
        case 'lt': passed = typeof actual === 'number' && typeof expected === 'number' && actual < expected; break;
        case 'lte': passed = typeof actual === 'number' && typeof expected === 'number' && actual <= expected; break;
      }
    }
    return { index: index + 1, kind: assertion.kind, passed };
  });
}
