import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { ApiError, monitoringApi } from '../../api/client';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import type { MonitoringCheck, MonitoringCheckOptions, MonitoringCheckType, MonitoringHttpAssertion, MonitoringHttpOptions, MonitoringProbeLocation, MonitoringTarget, MonitoringTlsMode, MonitoringCertificateErrorMode } from '../../types/monitoring';

interface HeaderRow { name: string; value: string; secret: boolean; }
interface AssertionRow { kind: 'body' | 'header' | 'json'; operator: MonitoringHttpAssertion['operator']; name: string; pointer: string; value: string; valueType: 'string' | 'number' | 'boolean' | 'null'; }
export interface CheckForm {
  id: number | null; targetId: number; name: string; checkType: MonitoringCheckType; endpoint: string; port: string;
  intervalSeconds: number; timeoutSeconds: number; confirmationSeconds: number; recoverySeconds: number;
  placementMode: 'all' | 'selected'; locationIds: number[]; quorum: number;
  certExpiryDays: string; tlsMode: MonitoringTlsMode; certificateErrorMode: MonitoringCertificateErrorMode; enabled: boolean; allowPrivate: boolean;
  startTls: boolean;
  http: MonitoringHttpOptions; statuses: string; headers: HeaderRow[]; storedHeaders: string[]; assertions: AssertionRow[];
  tcp: NonNullable<MonitoringCheckOptions['tcp']>; dns: NonNullable<MonitoringCheckOptions['dns']>; expectedRecords: string;
}
function httpDefaults(): MonitoringHttpOptions { return { method: 'GET', headers: {}, body: '', expectedStatuses: Array.from({ length: 100 }, (_, i) => 200 + i), followRedirects: true, maxRedirects: 3, maxResponseTimeMs: null, assertions: [] }; }
function startTlsDefault(type: MonitoringCheckType, port: string): boolean { return (type === 'smtp' && port === '587') || (type === 'imap' && port === '143'); }
export function emptyCheckForm(targetId = 0): CheckForm {
  return { id: null, targetId, name: '', checkType: 'http', endpoint: '', port: '', intervalSeconds: 60, timeoutSeconds: 10, confirmationSeconds: 180, recoverySeconds: 180, placementMode: 'all', locationIds: [], quorum: 0, certExpiryDays: '', tlsMode: 'strict', certificateErrorMode: 'down', enabled: true, allowPrivate: false, startTls: false,
    http: httpDefaults(), statuses: '200-299', headers: [], storedHeaders: [], assertions: [], tcp: { tls: false, bannerContains: '' }, dns: { recordType: 'A', resolver: null, expectedValues: [] }, expectedRecords: '' };
}
export function editCheckForm(check: MonitoringCheck): CheckForm {
  const http = check.options.http ?? httpDefaults();
  return { ...emptyCheckForm(check.targetId), ...check, port: check.port === null ? '' : String(check.port), certExpiryDays: check.certExpiryDays === null ? '' : String(check.certExpiryDays),
    http, statuses: formatStatuses(http.expectedStatuses), storedHeaders: check.secretHeaderNames,
    headers: [...Object.entries(http.headers).map(([name, value]) => ({ name, value, secret: false })), ...check.secretHeaderNames.map(name => ({ name, value: '', secret: true }))],
    assertions: http.assertions.map(assertion => ({ kind: assertion.kind, operator: assertion.operator, name: 'name' in assertion ? assertion.name : '', pointer: 'pointer' in assertion ? assertion.pointer : '', value: assertion.value === undefined || assertion.value === null ? '' : String(assertion.value), valueType: assertion.value === null ? 'null' : typeof assertion.value === 'number' ? 'number' : typeof assertion.value === 'boolean' ? 'boolean' : 'string' })),
    startTls: check.checkType === 'smtp' ? check.options.smtp?.startTls ?? check.port === 587 : check.checkType === 'imap' ? check.options.imap?.startTls ?? check.port === 143 : false,
    tcp: check.options.tcp ?? { tls: false, bannerContains: '' }, dns: check.options.dns ?? { recordType: 'A', resolver: null, expectedValues: [] }, expectedRecords: check.options.dns?.expectedValues.join('\n') ?? '' };
}
function formatStatuses(codes: number[]): string {
  const sorted = [...new Set(codes)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const first = sorted[i]!;
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i]! + 1) i++;
    ranges.push(first === sorted[i] ? String(first) : `${first}-${sorted[i]}`);
  }
  return ranges.join(', ');
}
export function checkPayload(form: CheckForm) {
  const options: MonitoringCheckOptions = {};
  const secretHeaders: Record<string, string | null> = Object.create(null);
  for (const name of form.storedHeaders) secretHeaders[name] = null;
  if (form.checkType === 'http') {
    const headers: Record<string, string> = Object.create(null);
    const names = new Set<string>();
    for (const row of form.headers) {
      const name = row.name.trim().toLowerCase();
      if (!name || names.has(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Header names must be non-empty and unique');
      names.add(name);
      if (row.secret) {
        if (row.value) secretHeaders[name] = row.value;
        else if (form.storedHeaders.includes(name)) delete secretHeaders[name];
        else throw new Error('New credential headers require a value');
      } else headers[name] = row.value;
    }
    const expectedStatuses = form.statuses.split(',').flatMap(raw => {
      const match = /^(\d{3})(?:-(\d{3}))?$/.exec(raw.trim());
      if (!match) throw new Error('Expected statuses must be codes or ranges, separated by commas');
      const start = Number(match[1]); const end = Number(match[2] ?? match[1]);
      if (start < 100 || end > 599 || start > end) throw new Error('Expected statuses must be between 100 and 599');
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    });
    const assertions = form.assertions.map(row => {
      const assertion: Record<string, unknown> = { kind: row.kind, operator: row.operator };
      if (row.kind === 'header') assertion.name = row.name;
      if (row.kind === 'json') assertion.pointer = row.pointer;
      if (row.operator !== 'exists') {
        if (row.kind !== 'json' || row.valueType === 'string') assertion.value = row.value;
        else if (row.valueType === 'null') assertion.value = null;
        else if (row.valueType === 'boolean') assertion.value = row.value === 'true';
        else { if (!row.value.trim() || !Number.isFinite(Number(row.value))) throw new Error('Numeric assertions require a finite number'); assertion.value = Number(row.value); }
      }
      return assertion as unknown as MonitoringHttpAssertion;
    });
    options.http = { ...form.http, headers, expectedStatuses: [...new Set(expectedStatuses)], assertions };
  } else if (form.checkType === 'tcp') options.tcp = form.tcp;
  else if (form.checkType === 'dns') options.dns = { ...form.dns, expectedValues: form.expectedRecords ? form.expectedRecords.split('\n').filter(value => value !== '') : [] };
  else if (form.checkType === 'smtp') options.smtp = { startTls: form.startTls };
  else if (form.checkType === 'imap') options.imap = { startTls: form.startTls };
  const usesTls = (form.checkType === 'imap' && form.port !== '143' && !form.startTls)
    || ((form.checkType === 'smtp' || form.checkType === 'imap') && form.startTls)
    || (form.checkType === 'http' && /^https:/i.test(form.endpoint))
    || (form.checkType === 'smtp' && form.port === '465')
    || (form.checkType === 'tcp' && form.tcp.tls);
  return { targetId: form.targetId, name: form.name, checkType: form.checkType, endpoint: form.endpoint,
    port: form.port ? Number(form.port) : null, intervalSeconds: form.intervalSeconds, timeoutSeconds: form.timeoutSeconds,
    confirmationSeconds: form.confirmationSeconds, recoverySeconds: form.recoverySeconds,
    placementMode: form.placementMode, locationIds: form.locationIds, quorum: form.quorum,
    ...(usesTls ? { certExpiryDays: form.certExpiryDays ? Number(form.certExpiryDays) : null, tlsMode: form.tlsMode, certificateErrorMode: form.certificateErrorMode } : {}),
    enabled: form.enabled, allowPrivate: form.allowPrivate, options, secretHeaders };
}
const OPERATORS = { body: ['contains', 'not_contains', 'equals'], header: ['exists', 'equals', 'contains', 'not_contains'], json: ['exists', 'equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'contains'] } as const;
const LABELS: Record<MonitoringHttpAssertion['operator'], string> = { contains: 'Contains', not_contains: 'Does not contain', equals: 'Equals', exists: 'Exists', not_equals: 'Does not equal', gt: 'Greater than', gte: 'At least', lt: 'Less than', lte: 'At most' };
export function CheckEditor({ form, targets, setForm, onSave, working }: { form: CheckForm; targets: MonitoringTarget[]; setForm: (form: CheckForm) => void; onSave: () => Promise<void>; working: boolean }) {
  const [error, setError] = useState('');
  const [locations, setLocations] = useState<MonitoringProbeLocation[]>([]);
  const [locationError, setLocationError] = useState('');
  useEffect(() => {
    let active = true;
    monitoringApi.listLocations().then(response => {
      if (active) setLocations(response.data?.locations ?? []);
    }).catch((err: unknown) => {
      if (active) setLocationError(err instanceof ApiError ? err.message : 'Failed to load probe locations');
    });
    return () => { active = false; };
  }, []);
  const enabledLocations = locations.filter(location => location.enabled);
  const votingIds = new Set(enabledLocations.filter(location => !location.shadow).map(location => location.id));
  const assignedCount = form.placementMode === 'all' ? votingIds.size : form.locationIds.filter(id => votingIds.has(id)).length;
  const effectiveQuorum = form.quorum || Math.floor(assignedCount / 2) + 1;
  const tls = (form.checkType === 'imap' && form.port !== '143' && !form.startTls) || ((form.checkType === 'smtp' || form.checkType === 'imap') && form.startTls) || (form.checkType === 'http' && /^https:/i.test(form.endpoint)) || (form.checkType === 'smtp' && form.port === '465') || (form.checkType === 'tcp' && form.tcp.tls);
  const push = form.checkType === 'push';
  const update = (values: Partial<CheckForm>) => setForm({ ...form, ...values });
  const updateHttp = (values: Partial<MonitoringHttpOptions>) => update({ http: { ...form.http, ...values } });
  const updateAssertion = (index: number, values: Partial<AssertionRow>) => update({ assertions: form.assertions.map((row, i) => i === index ? { ...row, ...values } : row) });
  const save = async () => { setError(''); try { checkPayload(form); await onSave(); } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save check'); } };
  return <div className="space-y-5">
    {error && <div role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</div>}
    <div className="grid gap-4 sm:grid-cols-2"><Field label="Target"><select className="input" value={form.targetId} onChange={e => update({ targetId: Number(e.target.value) })}>{targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}</select></Field><Input label="Name" value={form.name} onChange={e => update({ name: e.target.value })} /></div>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="Protocol"><select className="input" value={form.checkType} onChange={e => { const type = e.target.value as MonitoringCheckType; const defaults = emptyCheckForm(form.targetId); const port = type === 'imap' ? '993' : type === 'smtp' ? '25' : ''; update({ checkType: type, port, ...(type === 'push' ? { endpoint: 'push', intervalSeconds: 3600, confirmationSeconds: 300, recoverySeconds: 0 } : form.checkType === 'push' ? { endpoint: '', intervalSeconds: 60, confirmationSeconds: 180, recoverySeconds: 180 } : {}), startTls: startTlsDefault(type, port), http: defaults.http, statuses: defaults.statuses, headers: [], assertions: [], tcp: defaults.tcp, dns: defaults.dns, expectedRecords: '', certExpiryDays: '', tlsMode: 'strict', certificateErrorMode: 'down' }); }}>{['http', 'tcp', 'dns', 'smtp', 'imap', 'push'].map(type => <option key={type} value={type}>{type === 'http' ? 'HTTP / HTTPS' : type === 'push' ? 'Push (a job pings Robin Admin)' : type.toUpperCase()}</option>)}</select></Field>{form.checkType !== 'http' && !push && <Input label="Port" type="number" min={1} max={65535} value={form.port} onChange={e => { const startTls = startTlsDefault(form.checkType, e.target.value); const usesTls = (form.checkType === 'imap' && e.target.value !== '143' && !startTls) || ((form.checkType === 'smtp' || form.checkType === 'imap') && startTls) || (form.checkType === 'smtp' && e.target.value === '465') || (form.checkType === 'tcp' && form.tcp.tls); update({ port: e.target.value, startTls, ...(!usesTls ? { certExpiryDays: '', tlsMode: 'strict', certificateErrorMode: 'down' } : {}) }); }} />}</div>
    {push && <PushUrl checkId={form.id} />}
    {!push && <Input label={form.checkType === 'dns' ? 'Record name' : 'Endpoint'} value={form.endpoint} onChange={e => update({ endpoint: e.target.value, ...(form.checkType === 'http' && !/^https:/i.test(e.target.value) ? { certExpiryDays: '', tlsMode: 'strict' } : {}) })} />}
    {(form.checkType === 'smtp' || form.checkType === 'imap') && <Toggle label="Use STARTTLS" checked={form.startTls} disabled={(form.checkType === 'smtp' && form.port === '465') || (form.checkType === 'imap' && form.port === '993')} onChange={value => { const remainsTls = value || (form.checkType === 'imap' && form.port !== '143') || (form.checkType === 'smtp' && form.port === '465'); update({ startTls: value, ...(!remainsTls ? { certExpiryDays: '', tlsMode: 'strict', certificateErrorMode: 'down' } : {}) }); }} />}
    {!push && <Toggle label="Allow private network targets" checked={form.allowPrivate} onChange={value => update({ allowPrivate: value })} />}
    {!push && <fieldset className="space-y-3 border-t border-gray-200 pt-4 dark:border-robin-gray-700">
      <legend className="text-sm font-semibold">Probe locations</legend>
      <Field label="Run checks from">
        <select className="input" value={form.placementMode} onChange={event => update({
          placementMode: event.target.value as CheckForm['placementMode'],
          ...(event.target.value === 'all' ? { locationIds: [] } : {}),
        })}>
          <option value="all">All enabled locations</option>
          <option value="selected">Selected locations</option>
        </select>
      </Field>
      {form.placementMode === 'selected' && <Field label="Selected locations">
        <select
          className="input min-h-28"
          multiple
          value={form.locationIds.map(String)}
          onChange={event => update({ locationIds: Array.from(event.target.selectedOptions, option => Number(option.value)) })}
        >
          {enabledLocations.map(location => <option key={location.id} value={location.id}>
            {location.name}{location.region ? ` · ${location.region}` : ''} ({location.locationType === 'local' ? 'Local' : location.agentStatus ?? 'pending'}{location.shadow ? ', shadow' : ''})
          </option>)}
        </select>
      </Field>}
      <Input label="Quorum (0 = majority)" type="number" min={0} max={128} value={form.quorum} onChange={event => update({ quorum: Number(event.target.value) })} />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Down when {effectiveQuorum} of {assignedCount} voting locations report down. Shadow locations never vote. Fewer than {effectiveQuorum} fresh reports makes the check unknown.
      </p>
      {locationError && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{locationError}</p>}
    </fieldset>}
    {form.checkType === 'http' && <fieldset className="space-y-4 border-t border-gray-200 pt-4 dark:border-robin-gray-700"><legend className="text-sm font-semibold">HTTP</legend>
      <div className="grid gap-4 sm:grid-cols-3"><Field label="Method"><select className="input" value={form.http.method} onChange={e => updateHttp({ method: e.target.value as MonitoringHttpOptions['method'], ...(['GET', 'HEAD'].includes(e.target.value) ? { body: '' } : {}) })}>{['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(method => <option key={method}>{method}</option>)}</select></Field><Input label="Expected statuses" value={form.statuses} onChange={e => update({ statuses: e.target.value })} /><Input label="Maximum response time (ms)" type="number" min={1} max={120000} value={form.http.maxResponseTimeMs ?? ''} onChange={e => updateHttp({ maxResponseTimeMs: e.target.value ? Number(e.target.value) : null })} /></div>
      <div className="flex flex-wrap items-end gap-4"><Toggle label="Follow redirects" checked={form.http.followRedirects} onChange={value => updateHttp({ followRedirects: value, maxRedirects: value ? 3 : 0 })} />{form.http.followRedirects && <Input label="Maximum redirects" type="number" min={0} max={5} value={form.http.maxRedirects} onChange={e => updateHttp({ maxRedirects: Number(e.target.value) })} />}</div>
      {!['GET', 'HEAD'].includes(form.http.method) && <Field label="Request body"><textarea className="input min-h-24" value={form.http.body} onChange={e => updateHttp({ body: e.target.value })} /></Field>}
      <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Headers</h3><Button variant="secondary" size="sm" aria-label="Add header" title="Add header" disabled={form.headers.length >= 32} onClick={() => update({ headers: [...form.headers, { name: '', value: '', secret: false }] })}><Plus className="h-4 w-4" /></Button></div>
      {form.headers.map((row, index) => <div key={index} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto_auto]"><Input label={`Header ${index + 1} name`} value={row.name} onChange={e => update({ headers: form.headers.map((header, i) => i === index ? { ...header, name: e.target.value } : header) })} /><Input label={`Header ${index + 1} value`} type={row.secret ? 'password' : 'text'} autoComplete="off" placeholder={row.secret && form.storedHeaders.includes(row.name.toLowerCase()) ? 'Stored' : ''} value={row.value} onChange={e => update({ headers: form.headers.map((header, i) => i === index ? { ...header, value: e.target.value } : header) })} /><Toggle label="Credential" checked={row.secret} onChange={value => update({ headers: form.headers.map((header, i) => i === index ? { ...header, secret: value } : header) })} /><Remove label={`Remove header ${index + 1}`} onClick={() => update({ headers: form.headers.filter((_, i) => i !== index) })} /></div>)}
      <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Assertions</h3><Button variant="secondary" size="sm" aria-label="Add assertion" title="Add assertion" disabled={form.assertions.length >= 20} onClick={() => update({ assertions: [...form.assertions, { kind: 'body', operator: 'contains', name: '', pointer: '', value: '', valueType: 'string' }] })}><Plus className="h-4 w-4" /></Button></div>
      {form.assertions.map((row, index) => <fieldset key={index} className="space-y-3 border-t border-gray-200 py-3 dark:border-robin-gray-700"><legend className="text-sm">Assertion {index + 1}</legend><div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"><Field label="Subject"><select className="input" value={row.kind} onChange={e => updateAssertion(index, { kind: e.target.value as AssertionRow['kind'], operator: 'equals', valueType: 'string', value: '' })}><option value="body">Response body</option><option value="header">Response header</option><option value="json">JSON field</option></select></Field><Field label="Operator"><select className="input" value={row.operator} onChange={e => { const operator = e.target.value as AssertionRow['operator']; updateAssertion(index, { operator, ...(['gt', 'gte', 'lt', 'lte'].includes(operator) ? { valueType: 'number', value: '' } : operator === 'contains' || operator === 'not_contains' ? { valueType: 'string' } : {}) }); }}>{OPERATORS[row.kind].map(operator => <option key={operator} value={operator}>{LABELS[operator]}</option>)}</select></Field><Remove label={`Remove assertion ${index + 1}`} onClick={() => update({ assertions: form.assertions.filter((_, i) => i !== index) })} /></div>
        <div className="grid gap-3 sm:grid-cols-2">{row.kind === 'header' && <Input label="Response header name" value={row.name} onChange={e => updateAssertion(index, { name: e.target.value })} />}{row.kind === 'json' && <Input label="JSON pointer" value={row.pointer} onChange={e => updateAssertion(index, { pointer: e.target.value })} />}
        {row.kind === 'json' && row.operator !== 'exists' && <Field label="Value type"><select className="input" value={row.valueType} disabled={['gt', 'gte', 'lt', 'lte', 'contains'].includes(row.operator)} onChange={e => updateAssertion(index, { valueType: e.target.value as AssertionRow['valueType'], value: e.target.value === 'boolean' ? 'true' : '' })}>{['string', 'number', 'boolean', 'null'].map(type => <option key={type} value={type}>{type}</option>)}</select></Field>}
        {row.operator !== 'exists' && (row.kind !== 'json' || row.valueType !== 'null') && (row.kind === 'json' && row.valueType === 'boolean' ? <Field label="Expected value"><select className="input" value={row.value} onChange={e => updateAssertion(index, { value: e.target.value })}><option value="true">true</option><option value="false">false</option></select></Field> : <Input label="Expected value" type={row.kind === 'json' && row.valueType === 'number' ? 'number' : 'text'} value={row.value} onChange={e => updateAssertion(index, { value: e.target.value })} />)}</div>
      </fieldset>)}
    </fieldset>}
    {form.checkType === 'tcp' && <><Toggle label="Use TLS" checked={form.tcp.tls} onChange={value => update({ tcp: { ...form.tcp, tls: value }, ...(!value ? { certExpiryDays: '', tlsMode: 'strict' } : {}) })} /><Input label="Banner contains" value={form.tcp.bannerContains} onChange={e => update({ tcp: { ...form.tcp, bannerContains: e.target.value } })} /></>}
    {form.checkType === 'dns' && <><div className="grid gap-4 sm:grid-cols-2"><Field label="Record type"><select className="input" value={form.dns.recordType} onChange={e => update({ dns: { ...form.dns, recordType: e.target.value as typeof form.dns.recordType } })}>{['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].map(type => <option key={type}>{type}</option>)}</select></Field><Input label="Resolver IP" value={form.dns.resolver ?? ''} onChange={e => update({ dns: { ...form.dns, resolver: e.target.value || null } })} /></div><Field label="Expected records"><textarea className="input min-h-24" value={form.expectedRecords} onChange={e => update({ expectedRecords: e.target.value })} /></Field></>}
    {tls && <div className="grid gap-4 sm:grid-cols-2"><Input label="Certificate warning (days)" type="number" min={1} max={365} value={form.certExpiryDays} onChange={e => update({ certExpiryDays: e.target.value })} /><Field label="TLS verification"><select className="input" value={form.tlsMode} onChange={e => update({ tlsMode: e.target.value as MonitoringTlsMode })}><option value="strict">Strict</option><option value="allow_self_signed">Allow self-signed/local CA</option></select></Field><Field label="Certificate errors"><select className="input" value={form.certificateErrorMode} onChange={e => update({ certificateErrorMode: e.target.value as MonitoringCertificateErrorMode })}><option value="down">Mark check down</option><option value="warning">Show warning, exclude from availability</option></select></Field></div>}
    {push
      ? <div className="grid gap-4 sm:grid-cols-3">
        <Input label="Expected every (seconds)" type="number" min={60} max={2592000} value={form.intervalSeconds} onChange={e => update({ intervalSeconds: Number(e.target.value) })} />
        <Input label="Grace before an issue (seconds)" type="number" min={0} max={86400} value={form.confirmationSeconds} onChange={e => update({ confirmationSeconds: Number(e.target.value) })} />
        <Input label="Recover (seconds)" type="number" min={0} max={86400} value={form.recoverySeconds} onChange={e => update({ recoverySeconds: Number(e.target.value) })} />
        <p className="text-xs text-gray-500 sm:col-span-3 dark:text-gray-400">Down once no ping has arrived for the expected interval, or when the job calls the URL ending in <code>/fail</code>. An issue opens after the grace period. Evaluated every minute on this server.</p>
      </div>
      : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{(['intervalSeconds', 'timeoutSeconds', 'confirmationSeconds', 'recoverySeconds'] as const).map((key, index) => <Input key={key} label={['Interval (seconds)', 'Timeout (seconds)', 'Confirm (seconds)', 'Recover (seconds)'][index]} type="number" min={key === 'intervalSeconds' ? 10 : key === 'timeoutSeconds' ? 1 : 0} max={key === 'timeoutSeconds' ? 120 : 86400} value={form[key]} onChange={e => update({ [key]: Number(e.target.value) })} />)}</div>}
    <div className="flex items-center justify-between gap-3"><Toggle label="Enabled" checked={form.enabled} onChange={value => update({ enabled: value })} /><Button onClick={() => void save()} disabled={working || !form.name || !form.endpoint || !form.targetId}>Save check</Button></div>
  </div>;
}
/** The ping URL of a saved push check, with copy and rotate. */
function PushUrl({ checkId }: { checkId: number | null }) {
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (checkId === null) return undefined;
    let active = true;
    monitoringApi.getPushUrl(checkId).then(response => { if (active) setUrl(response.data?.url ?? ''); })
      .catch((err: unknown) => { if (active) setMessage(err instanceof ApiError ? err.message : 'Failed to load the ping URL'); });
    return () => { active = false; };
  }, [checkId]);
  if (checkId === null) return <p className="text-sm text-gray-600 dark:text-gray-300">The ping URL is created when the check is saved. Reopen the check to copy it.</p>;
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setMessage('Copied'); } catch { setMessage('Copy failed; select the URL instead'); }
  };
  const rotate = async () => {
    try { const response = await monitoringApi.rotatePushUrl(checkId); setUrl(response.data?.url ?? ''); setMessage('New URL created; the old one no longer works'); }
    catch (err) { setMessage(err instanceof ApiError ? err.message : 'Failed to rotate the ping URL'); }
  };
  return <div className="space-y-2 rounded-lg border border-gray-200 p-3 text-sm dark:border-robin-gray-700">
    <div className="font-medium">Ping URL</div>
    <code className="block break-all rounded bg-gray-50 p-2 text-xs dark:bg-robin-gray-800">{url || 'Loading…'}</code>
    <p className="text-xs text-gray-500 dark:text-gray-400">Call it with GET or POST when the job succeeds, for example <code>curl -fsS -m 10 --retry 3 &lt;URL&gt;</code>; add <code>/fail</code> to report a failure.</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={() => void copy()} disabled={!url}>Copy</Button>
      <Button size="sm" variant="secondary" onClick={() => void rotate()}>Create a new URL</Button>
      {message && <span className="text-xs text-gray-600 dark:text-gray-300">{message}</span>}
    </div>
  </div>;
}
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block min-w-0 space-y-1 text-sm"><span className="font-medium">{label}</span>{children}</label>; }
function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) { return <label className="flex items-center gap-2 py-2 text-sm"><input className="h-4 w-4 accent-robin-orange" type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />{label}</label>; }
function Remove({ label, onClick }: { label: string; onClick: () => void }) { return <Button variant="secondary" aria-label={label} title={label} onClick={onClick}><Trash2 className="h-4 w-4" /></Button>; }
