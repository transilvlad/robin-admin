import { useEffect, useMemo, useState } from 'react';
import { Brain, History, Play, RefreshCw, Search, ShieldCheck, ShieldX, Upload } from 'lucide-react';
import { ApiError, rspamdApi } from '../api/client';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';
import type {
  RspamdClassifierSummary,
  RspamdScanActionRecord,
  RspamdScanRequestMetadata,
  RspamdScanRunDetail,
  RspamdScanRunSummary,
} from '../types';

type ScanMode = 'raw' | 'upload';

export function RspamdScanPage() {
  const { selectedRspamdService } = useServices();
  const serviceId = selectedRspamdService?.serviceId;
  const [mode, setMode] = useState<ScanMode>('raw');
  const [rawMessage, setRawMessage] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [metadata, setMetadata] = useState({
    envelopeFrom: '',
    recipients: '',
    clientIp: '',
    helo: '',
    hostname: '',
    authenticatedUser: '',
    settingsId: '',
    queueId: '',
  });
  const [classifierSummary, setClassifierSummary] = useState<RspamdClassifierSummary | null>(null);
  const [classifierDraft, setClassifierDraft] = useState<RspamdClassifierSummary | null>(null);
  const [history, setHistory] = useState<RspamdScanRunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<RspamdScanRunDetail | null>(null);
  const [comparisonText, setComparisonText] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [isSavingClassifiers, setIsSavingClassifiers] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const normalizedMetadata = useMemo<Partial<RspamdScanRequestMetadata>>(() => ({
    envelopeFrom: metadata.envelopeFrom.trim(),
    recipients: metadata.recipients
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
    clientIp: metadata.clientIp.trim(),
    helo: metadata.helo.trim(),
    hostname: metadata.hostname.trim(),
    authenticatedUser: metadata.authenticatedUser.trim(),
    settingsId: metadata.settingsId.trim(),
    queueId: metadata.queueId.trim(),
  }), [metadata]);
  const selectedRunHasRetainedMessage = Boolean(selectedRun?.rawMessageRelpath);

  const load = async (focusRunId?: number) => {
    if (!serviceId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const [classifiersResponse, historyResponse] = await Promise.all([
        rspamdApi.getClassifiers(serviceId),
        rspamdApi.listScans({ serviceId, page: 1, limit: 25 }),
      ]);
      const classifiers = classifiersResponse.data ?? null;
      const historyRows = historyResponse.data ?? [];
      setClassifierSummary(classifiers);
      setClassifierDraft(classifiers ? structuredClone(classifiers) : null);
      setHistory(historyRows);

      const selectedId = focusRunId ?? selectedRun?.id ?? historyRows[0]?.id;
      if (selectedId) {
        const detailResponse = await rspamdApi.getScan(selectedId, serviceId);
        setSelectedRun(detailResponse.data ?? null);
      } else {
        setSelectedRun(null);
      }
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load scan lab');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setSelectedRun(null);
    setComparisonText('');
    void load();
  }, [serviceId]);

  const handleScan = async () => {
    if (!serviceId) return;
    setIsScanning(true);
    setError('');
    setSuccess('');
    setComparisonText('');
    try {
      let result: RspamdScanRunDetail | null = null;
      if (mode === 'upload') {
        if (!uploadFile) {
          throw new Error('Select a .eml file first');
        }
        const response = await rspamdApi.scanFile({
          serviceId,
          transport: classifierDraft?.defaultTransport ?? 'checkv2',
          fileName: uploadFile.name,
          bytes: await uploadFile.arrayBuffer(),
          metadata: normalizedMetadata,
        });
        result = response.data ?? null;
      } else {
        const response = await rspamdApi.scanMessage({
          serviceId,
          transport: classifierDraft?.defaultTransport ?? 'checkv2',
          rawMessage,
          metadata: normalizedMetadata,
        });
        result = response.data ?? null;
      }

      if (result) {
        setSelectedRun(result);
        setSuccess(`Scan completed with action ${formatAction(result.summaryAction)}.`);
        await load(result.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message || 'Failed to scan message');
    } finally {
      setIsScanning(false);
    }
  };

  const handleSelectRun = async (runId: number) => {
    if (!serviceId) return;
    setError('');
    try {
      const response = await rspamdApi.getScan(runId, serviceId);
      setSelectedRun(response.data ?? null);
      setComparisonText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load scan detail');
    }
  };

  const handleReplay = async () => {
    if (!serviceId || !selectedRun) return;
    setError('');
    try {
      const response = await rspamdApi.replayScan(selectedRun.id, serviceId);
      const replayed = response.data ?? null;
      if (replayed) {
        setComparisonText(buildComparisonText(selectedRun, replayed));
        setSelectedRun(replayed);
        setSuccess('Replay completed and added to history.');
        await load(replayed.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to replay scan');
    }
  };

  const handleLearn = async (label: 'spam' | 'ham') => {
    if (!serviceId || !selectedRun) return;
    setError('');
    try {
      const response = await rspamdApi.learnScan(selectedRun.id, {
        serviceId,
        label,
        classifier: classifierDraft?.defaultClassifier?.trim() || undefined,
      });
      mergeAction(response.data ?? null);
      setSuccess(`Sent ${label} learn request to Rspamd.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to learn scan');
    }
  };

  const handleFuzzy = async (operation: 'add' | 'remove', presetId?: string) => {
    if (!serviceId || !selectedRun) return;
    setError('');
    try {
      const response = await rspamdApi.fuzzyScan(selectedRun.id, {
        serviceId,
        operation,
        presetId,
      });
      mergeAction(response.data ?? null);
      setSuccess(operation === 'add' ? 'Added message to fuzzy storage.' : 'Removed message from fuzzy storage.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update fuzzy storage');
    }
  };

  const mergeAction = (action: RspamdScanActionRecord | null) => {
    if (!action) return;
    setSelectedRun((current) => current ? { ...current, actions: [action, ...current.actions] } : current);
  };

  const handleSaveClassifierSettings = async () => {
    if (!serviceId || !classifierDraft) return;
    setIsSavingClassifiers(true);
    setError('');
    try {
      const response = await rspamdApi.updateClassifiers({
        defaultTransport: classifierDraft.defaultTransport,
        defaultClassifier: classifierDraft.defaultClassifier,
        fuzzyPresets: classifierDraft.fuzzyPresets,
      }, serviceId);
      const saved = response.data ?? null;
      setClassifierSummary(saved);
      setClassifierDraft(saved ? structuredClone(saved) : null);
      setSuccess('Classifier defaults saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save classifier settings');
    } finally {
      setIsSavingClassifiers(false);
    }
  };

  if (!serviceId) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.rspamdScan}
          title="Rspamd scan"
          description="Select an enabled Rspamd service before scanning messages or experimenting with classifiers."
          actions={<PageServiceSelector serviceType="rspamd" capability="scan" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled Rspamd service is currently selected.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.rspamdScan}
        title="Rspamd scan"
        description={<>Paste raw RFC822 mail or upload a `.eml` file, then scan it on <strong>{selectedRspamdService?.name}</strong> with outbound metadata and retained history.</>}
        actions={
          <>
            <PageServiceSelector serviceType="rspamd" capability="scan" />
            <Button variant="secondary" onClick={() => load(selectedRun?.id)}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </>
        }
      />

      {error && <div className="rounded-lg bg-red-100 p-3 text-red-700 dark:bg-red-900/20 dark:text-red-400">{error}</div>}
      {success && <div className="rounded-lg bg-green-100 p-3 text-green-700 dark:bg-green-900/20 dark:text-green-400">{success}</div>}
      {comparisonText && <div className="rounded-lg bg-blue-50 p-3 text-sm text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">{comparisonText}</div>}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner className="text-robin-orange" /></div>
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.9fr)]">
            <section className="card space-y-5 p-6">
              <div className="flex flex-wrap items-center gap-3">
                <Button variant={mode === 'raw' ? 'primary' : 'secondary'} onClick={() => setMode('raw')}>Raw message</Button>
                <Button variant={mode === 'upload' ? 'primary' : 'secondary'} onClick={() => setMode('upload')}>Upload `.eml`</Button>
              </div>

              {mode === 'raw' ? (
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Message</span>
                  <textarea
                    className="input min-h-72 w-full font-mono text-xs"
                    value={rawMessage}
                    onChange={(event) => setRawMessage(event.target.value)}
                    placeholder={'From: sender@example.com\nTo: recipient@example.com\nSubject: test\n\nHello world'}
                  />
                </label>
              ) : (
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">File</span>
                  <input type="file" accept=".eml,message/rfc822" className="input" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} />
                </label>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <Input label="Envelope from" value={metadata.envelopeFrom} onChange={(event) => setMetadata((current) => ({ ...current, envelopeFrom: event.target.value }))} placeholder="bounce@example.com" />
                <Input label="Recipients" value={metadata.recipients} onChange={(event) => setMetadata((current) => ({ ...current, recipients: event.target.value }))} placeholder="user@example.com, ops@example.com" />
                <Input label="Client IP" value={metadata.clientIp} onChange={(event) => setMetadata((current) => ({ ...current, clientIp: event.target.value }))} placeholder="203.0.113.10" />
                <Input label="HELO" value={metadata.helo} onChange={(event) => setMetadata((current) => ({ ...current, helo: event.target.value }))} placeholder="mail.example.com" />
                <Input label="Hostname" value={metadata.hostname} onChange={(event) => setMetadata((current) => ({ ...current, hostname: event.target.value }))} placeholder="smtp-out.example.com" />
                <Input label="Authenticated user" value={metadata.authenticatedUser} onChange={(event) => setMetadata((current) => ({ ...current, authenticatedUser: event.target.value }))} placeholder="customer-123" />
                <Input label="Settings ID" value={metadata.settingsId} onChange={(event) => setMetadata((current) => ({ ...current, settingsId: event.target.value }))} placeholder="outbound-customer" />
                <Input label="Queue ID" value={metadata.queueId} onChange={(event) => setMetadata((current) => ({ ...current, queueId: event.target.value }))} placeholder="ABC123456" />
              </div>

              <Button onClick={handleScan} isLoading={isScanning} disabled={mode === 'raw' ? rawMessage.trim().length === 0 : !uploadFile}>
                {mode === 'upload' ? <Upload className="h-4 w-4" /> : <Search className="h-4 w-4" />}
                Scan message
              </Button>
            </section>

            <section className="card space-y-5 p-6">
              <div>
                <h2 className="text-lg font-semibold">Classifier defaults</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Set the default scan transport, optional classifier override, and fuzzy presets used from this page.</p>
              </div>

              <label className="block space-y-1">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Default transport</span>
                <select
                  className="input w-full"
                  value={classifierDraft?.defaultTransport ?? 'checkv2'}
                  onChange={(event) => setClassifierDraft((current) => current ? { ...current, defaultTransport: event.target.value === 'checkv3' ? 'checkv3' : 'checkv2' } : current)}
                >
                  <option value="checkv2">checkv2</option>
                  <option value="checkv3">checkv3</option>
                </select>
              </label>

              <Input
                label="Default classifier"
                value={classifierDraft?.defaultClassifier ?? ''}
                onChange={(event) => setClassifierDraft((current) => current ? { ...current, defaultClassifier: event.target.value } : current)}
                placeholder="Leave blank to learn all classifiers"
              />

              <div className="space-y-3">
                {classifierDraft?.fuzzyPresets.map((preset) => (
                  <div key={preset.id} className="rounded-lg border border-gray-200 p-3 dark:border-robin-gray-700">
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1.6fr)_120px_120px]">
                      <Input label="Preset" value={preset.label} onChange={(event) => setClassifierDraft((current) => current ? ({
                        ...current,
                        fuzzyPresets: current.fuzzyPresets.map((item) => item.id === preset.id ? { ...item, label: event.target.value } : item),
                      }) : current)} />
                      <Input label="Flag" type="number" value={String(preset.flag)} onChange={(event) => setClassifierDraft((current) => current ? ({
                        ...current,
                        fuzzyPresets: current.fuzzyPresets.map((item) => item.id === preset.id ? { ...item, flag: Number(event.target.value) || 0 } : item),
                      }) : current)} />
                      <Input label="Weight" type="number" step="0.1" value={String(preset.weight)} onChange={(event) => setClassifierDraft((current) => current ? ({
                        ...current,
                        fuzzyPresets: current.fuzzyPresets.map((item) => item.id === preset.id ? { ...item, weight: Number(event.target.value) || 0 } : item),
                      }) : current)} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg bg-gray-50 p-3 text-sm dark:bg-robin-gray-900">
                <div className="font-medium text-gray-900 dark:text-white">Classifier status</div>
                <div className="mt-2 grid gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <div className="flex items-center justify-between"><span>Controller</span><span>{classifierSummary?.controllerAuthenticated ? 'Authenticated' : classifierSummary?.controllerReachable ? 'Reachable' : 'Unavailable'}</span></div>
                  <div className="flex items-center justify-between"><span>Normal worker</span><span>{classifierSummary?.normalWorkerReachable ? 'Reachable' : 'Unavailable'}</span></div>
                  <div className="flex items-center justify-between"><span>Statfiles</span><span>{classifierSummary?.statfiles.length ?? 0}</span></div>
                </div>
              </div>

              <Button onClick={handleSaveClassifierSettings} isLoading={isSavingClassifiers}>
                Save classifier defaults
              </Button>
            </section>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
            <section className="card p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Result</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Latest selected scan, replay, learn, and fuzzy actions.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={handleReplay} disabled={!selectedRunHasRetainedMessage}>
                    <Play className="h-4 w-4" />
                    Replay
                  </Button>
                  <Button variant="danger" onClick={() => handleLearn('spam')} disabled={!selectedRunHasRetainedMessage}>
                    <Brain className="h-4 w-4" />
                    Learn spam
                  </Button>
                  <Button variant="success" onClick={() => handleLearn('ham')} disabled={!selectedRunHasRetainedMessage}>
                    <Brain className="h-4 w-4" />
                    Learn ham
                  </Button>
                </div>
              </div>

              {!selectedRun ? (
                <div className="mt-6 rounded-lg border border-dashed border-gray-300 px-4 py-12 text-center text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                  Run a scan or select an entry from history.
                </div>
              ) : (
                <div className="mt-5 space-y-5">
                  <div className={`flex items-start gap-3 rounded-lg px-4 py-3 text-sm ${isSpamAction(selectedRun.summaryAction) ? 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400' : 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400'}`}>
                    {isSpamAction(selectedRun.summaryAction) ? <ShieldX className="mt-0.5 h-5 w-5 shrink-0" /> : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />}
                    <div>
                      <div className="font-medium">{formatAction(selectedRun.summaryAction)}</div>
                      <div className="mt-1 text-xs opacity-80">
                        Score {formatNumber(selectedRun.summaryScore)} / {formatNumber(selectedRun.summaryRequiredScore)} · {selectedRun.transport} · {new Date(selectedRun.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <Stat label="Queue ID" value={selectedRun.metadata.queueId || 'Not set'} />
                    <Stat label="Envelope from" value={selectedRun.metadata.envelopeFrom || 'Not set'} />
                    <Stat label="Recipients" value={selectedRun.metadata.recipients.length > 0 ? selectedRun.metadata.recipients.join(', ') : 'Not set'} />
                  </div>

                  {!selectedRunHasRetainedMessage && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-200">
                      Raw message retention is disabled for this Rspamd service. Replay, learning, and fuzzy actions require a configured store directory.
                    </div>
                  )}

                  <div className="rounded-lg border border-gray-200 p-4 dark:border-robin-gray-700">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="font-medium">Fuzzy actions</div>
                      <div className="flex flex-wrap gap-2">
                        {classifierSummary?.fuzzyPresets.map((preset) => (
                          <Button key={preset.id} size="sm" variant="secondary" onClick={() => handleFuzzy('add', preset.id)} disabled={!selectedRunHasRetainedMessage}>
                            {preset.label}
                          </Button>
                        ))}
                        <Button size="sm" variant="secondary" onClick={() => handleFuzzy('remove')} disabled={!selectedRunHasRetainedMessage}>
                          Remove
                        </Button>
                      </div>
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Preset buttons add the selected message to fuzzy storage with the configured flag and weight.</div>
                  </div>

                  <div>
                    <div className="mb-2 text-sm font-medium">Triggered symbols</div>
                    <div className="space-y-2">
                      {extractSymbols(selectedRun.result).slice(0, 20).map((symbol) => (
                        <div key={symbol.name} className="rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-robin-gray-900">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-medium text-gray-900 dark:text-white">{symbol.name}</span>
                            <span className="text-gray-500 dark:text-gray-400">{formatNumber(symbol.score)}</span>
                          </div>
                          {symbol.options.length > 0 && (
                            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{symbol.options.join(' · ')}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <details className="rounded-lg border border-gray-200 dark:border-robin-gray-700">
                    <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Raw message and JSON result</summary>
                    <div className="space-y-4 border-t border-gray-200 px-4 py-4 dark:border-robin-gray-700">
                      <pre className="overflow-x-auto rounded-lg bg-gray-50 p-3 text-xs dark:bg-robin-gray-900">
                        {selectedRun.rawMessage || 'Raw message was not retained for this scan.'}
                      </pre>
                      <pre className="overflow-x-auto rounded-lg bg-gray-50 p-3 text-xs dark:bg-robin-gray-900">{JSON.stringify(selectedRun.result, null, 2)}</pre>
                    </div>
                  </details>

                  <div>
                    <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                      <History className="h-4 w-4" />
                      Follow-up actions
                    </div>
                    {selectedRun.actions.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-gray-300 px-4 py-4 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                        No follow-up actions recorded for this run yet.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {selectedRun.actions.map((action) => (
                          <div key={action.id} className="rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-robin-gray-700">
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-medium text-gray-900 dark:text-white">{formatActionType(action.actionType)}</span>
                              <span className="text-xs text-gray-500 dark:text-gray-400">{new Date(action.createdAt).toLocaleString()}</span>
                            </div>
                            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{JSON.stringify(action.details)}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>

            <section className="card p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Recent scans</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Persisted scan history with replayable content.</p>
                </div>
                <Button variant="secondary" onClick={() => load(selectedRun?.id)}>
                  <RefreshCw className="h-4 w-4" />
                  Reload
                </Button>
              </div>

              <div className="mt-5 space-y-3">
                {history.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                    No scans recorded yet.
                  </div>
                ) : history.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => handleSelectRun(run.id)}
                    className={`w-full rounded-lg border px-4 py-3 text-left transition ${selectedRun?.id === run.id ? 'border-robin-orange bg-robin-orange/5' : 'border-gray-200 hover:border-robin-orange/50 dark:border-robin-gray-700'}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-gray-900 dark:text-white">{formatAction(run.summaryAction)}</span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">{new Date(run.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {run.transport} · Score {formatNumber(run.summaryScore)} / {formatNumber(run.summaryRequiredScore)}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {run.summarySymbols.slice(0, 4).map((symbol) => (
                        <span key={symbol} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-robin-gray-900 dark:text-gray-300">{symbol}</span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function extractSymbols(result: Record<string, unknown>) {
  const symbols = typeof result.symbols === 'object' && result.symbols !== null
    ? Object.values(result.symbols as Record<string, unknown>)
    : [];

  return symbols
    .map((item) => typeof item === 'object' && item !== null ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name : 'UNKNOWN',
      score: typeof item.score === 'number' ? item.score : Number(item.score ?? 0),
      options: Array.isArray(item.options) ? item.options.filter((value): value is string => typeof value === 'string') : [],
    }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

function formatAction(action: string | null | undefined) {
  if (!action) return 'No action';
  return action.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatActionType(action: string) {
  return action.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '0';
  return value.toFixed(2).replace(/\.00$/, '');
}

function isSpamAction(action: string | null | undefined) {
  return typeof action === 'string' && ['reject', 'add header', 'quarantine', 'discard', 'soft reject'].includes(action.toLowerCase());
}

function buildComparisonText(previous: RspamdScanRunDetail, current: RspamdScanRunDetail) {
  const previousScore = previous.summaryScore ?? 0;
  const currentScore = current.summaryScore ?? 0;
  const delta = currentScore - previousScore;
  const direction = delta === 0 ? 'unchanged' : delta > 0 ? `up ${formatNumber(delta)}` : `down ${formatNumber(Math.abs(delta))}`;
  return `Replay comparison: action ${formatAction(previous.summaryAction)} -> ${formatAction(current.summaryAction)}, score ${formatNumber(previousScore)} -> ${formatNumber(currentScore)} (${direction}).`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-robin-gray-900">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 font-medium text-gray-900 dark:text-white">{value}</div>
    </div>
  );
}
