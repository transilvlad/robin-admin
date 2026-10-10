/** Synthetic metrics for an explicitly disposable loopback development instance. */
const target = new URL(process.env.TELEMETRY_SEED_URL ?? '');
if (process.env.TELEMETRY_SEED_DISPOSABLE !== '1' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.protocol !== 'http:' || target.username || target.password) {
  throw new Error('Set TELEMETRY_SEED_DISPOSABLE=1 and TELEMETRY_SEED_URL to a disposable loopback HTTP instance');
}
const apiKey = process.env.TELEMETRY_SEED_API_KEY;
if (!apiKey) throw new Error('Set TELEMETRY_SEED_API_KEY to a disposable telemetry:write key');
const end = Date.now();
const lines: string[] = [];
for (let at = end - 3600000; at <= end; at += 30000) {
  for (const instance of ['node-a.example.test', 'node-b.example.test']) {
    const labels = `instance=${JSON.stringify(instance)},job="demo"`;
    lines.push(`demo_requests_total{${labels}} ${Math.floor(at / 30000)} ${at}`);
    lines.push(`demo_latency_seconds{${labels}} ${(1 + Math.sin(at / 300000)) / 10} ${at}`);
  }
}
const response = await fetch(new URL('api/telemetry/import', `${target.href.replace(/\/+$/, '')}/`), {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(30000),
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'text/plain' },
  body: `${lines.join('\n')}\n`,
});
await response.body?.cancel();
if (response.status !== 204) throw new Error(`Demo import failed: HTTP ${response.status}`);
console.log(`Wrote ${lines.length} synthetic samples`);
