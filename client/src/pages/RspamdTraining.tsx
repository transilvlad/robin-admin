import { useEffect, useState } from 'react';
import { Brain, RefreshCw, Trash2, Upload } from 'lucide-react';
import { ApiError, rspamdApi } from '../api/client';
import type { RspamdClassifierSummary, RspamdTrainingImportJob, RspamdTrainingSample } from '../types';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';

export function RspamdTrainingPage() {
  const { selectedRspamdService } = useServices();
  const [samples, setSamples] = useState<RspamdTrainingSample[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [label, setLabel] = useState<'spam' | 'ham'>('spam');
  const [lastImport, setLastImport] = useState<RspamdTrainingImportJob | null>(null);
  const [skipped, setSkipped] = useState<Array<{ fileName: string; reason: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [search, setSearch] = useState('');
  const [labelFilter, setLabelFilter] = useState<'' | 'spam' | 'ham'>('');
  const [statusFilter, setStatusFilter] = useState<'' | 'pending' | 'learned' | 'failed'>('');
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [classifierSummary, setClassifierSummary] = useState<RspamdClassifierSummary | null>(null);
  const [classifierOverride, setClassifierOverride] = useState('');

  const load = async (nextPage = page) => {
    setIsLoading(true);
    try {
      const response = await rspamdApi.listSamples({
        page: nextPage,
        limit,
        search: search.trim() || undefined,
        label: labelFilter,
        status: statusFilter,
      });
      const classifierResponse = await rspamdApi.getClassifiers(selectedRspamdService?.serviceId);
      setSamples(response.data ?? []);
      setClassifierSummary(classifierResponse.data ?? null);
      setPage(response.pagination?.page ?? nextPage);
      setLimit(response.pagination?.limit ?? limit);
      setTotalPages(response.pagination?.totalPages ?? 1);
      setTotal(response.pagination?.total ?? 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load training corpus');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (selectedRspamdService) {
      void load();
    }
  }, [limit, labelFilter, selectedRspamdService, statusFilter]);

  if (!selectedRspamdService) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.rspamdTraining}
          title="Rspamd training"
          description="Select an enabled Rspamd service before importing or relearning managed corpus data."
          actions={<PageServiceSelector serviceType="rspamd" capability="training" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled Rspamd service is currently selected.
        </div>
      </div>
    );
  }

  const handleImport = async () => {
    if (files.length === 0) return;
    setIsUploading(true);
    setError('');
    setSuccess('');
    try {
      const aggregateSkipped: Array<{ fileName: string; reason: string }> = [];
      let lastJob: RspamdTrainingImportJob | null = null;
      let importedSamples = 0;
      for (const file of files) {
        const response = await rspamdApi.importTrainingFile(label, file.name, await file.arrayBuffer(), selectedRspamdService.serviceId);
        lastJob = response.data?.job ?? null;
        importedSamples += response.data?.samples.length ?? 0;
        aggregateSkipped.push(...(response.data?.skipped ?? []));
      }
      setLastImport(lastJob);
      setSkipped(aggregateSkipped);
      setFiles([]);
      await load(1);
      setSuccess(`Imported ${importedSamples} sample(s) from ${files.length} file(s)`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to import training data');
    } finally {
      setIsUploading(false);
    }
  };

  const handleLearn = async (id: number) => {
    setError('');
    try {
      await rspamdApi.learnSample(id, classifierOverride.trim() || undefined, selectedRspamdService?.serviceId);
      await load(page);
      setSuccess('Sample relearned');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to learn sample');
    }
  };

  const handleRelabel = async (id: number, nextLabel: 'spam' | 'ham') => {
    setError('');
    try {
      await rspamdApi.relabelSample(id, nextLabel, classifierOverride.trim() || undefined, selectedRspamdService?.serviceId);
      await load(page);
      setSuccess(`Sample moved to ${nextLabel}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to relabel sample');
    }
  };

  const handleDelete = async (id: number) => {
    setError('');
    try {
      await rspamdApi.deleteSample(id);
      await load(page);
      setSuccess('Sample deleted');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete sample');
    }
  };

  if (isLoading) {
    return <div className="flex justify-center py-8"><Spinner className="text-robin-orange" /></div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.rspamdTraining}
        title="Rspamd training"
        description={<>Upload raw mail, keep a managed corpus, and relearn samples for <strong>{selectedRspamdService.name}</strong>.</>}
        actions={
          <>
            <PageServiceSelector serviceType="rspamd" capability="training" />
            <Button variant="secondary" onClick={() => load(page)}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </>
        }
      />

      {error && <div className="rounded-lg bg-red-100 p-3 text-red-700 dark:bg-red-900/20 dark:text-red-400">{error}</div>}
      {success && <div className="rounded-lg bg-green-100 p-3 text-green-700 dark:bg-green-900/20 dark:text-green-400">{success}</div>}

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="card space-y-5 p-6">
          <div>
            <h2 className="text-lg font-semibold">Import corpus data</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Accepted inputs: `.eml`, `.mbox`, `.zip`, `.tar`, `.tar.gz`, `.tgz`.</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button variant={label === 'spam' ? 'primary' : 'secondary'} onClick={() => setLabel('spam')}>
              <Brain className="h-4 w-4" />
              Spam
            </Button>
            <Button variant={label === 'ham' ? 'primary' : 'secondary'} onClick={() => setLabel('ham')}>
              <Brain className="h-4 w-4" />
              Ham
            </Button>
          </div>

          <label className="flex min-h-40 cursor-pointer items-center justify-center rounded-lg border border-dashed border-gray-300 px-6 py-10 text-center text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            />
            <div>
              <div className="font-medium text-gray-700 dark:text-gray-300">Choose one or more training files</div>
              <div className="mt-1">Each file is uploaded as-is; robin-admin extracts the messages, keeps them, and has Rspamd learn them.</div>
            </div>
          </label>

          {files.length > 0 && (
            <div className="rounded-lg border border-gray-200 p-4 text-sm dark:border-robin-gray-700">
              <div className="font-medium">Pending upload</div>
              <ul className="mt-2 space-y-1 text-gray-500 dark:text-gray-400">
                {files.map((file) => <li key={`${file.name}-${file.size}`}>{file.name}</li>)}
              </ul>
            </div>
          )}

          <Button onClick={handleImport} isLoading={isUploading} disabled={files.length === 0}>
            <Upload className="h-4 w-4" />
            Import and learn
          </Button>

          {lastImport && (
            <div className="rounded-lg border border-gray-200 p-4 text-sm dark:border-robin-gray-700">
              <div className="font-medium">Last import</div>
              <div className="mt-1 text-gray-500 dark:text-gray-400">
                {lastImport.totalSamples} sample(s), {lastImport.learnedSamples} learned, status {lastImport.status}
              </div>
              {lastImport.errors.length > 0 && (
                <ul className="mt-2 space-y-1 text-red-600 dark:text-red-400">
                  {lastImport.errors.map((message) => <li key={message}>{message}</li>)}
                </ul>
              )}
              {skipped.length > 0 && (
                <ul className="mt-2 space-y-1 text-amber-600 dark:text-amber-300">
                  {skipped.map((item) => <li key={`${item.fileName}-${item.reason}`}>{item.fileName}: {item.reason}</li>)}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className="card space-y-5 p-6">
          <div>
            <h2 className="text-lg font-semibold">Managed corpus</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Stored samples can be relearned, relabeled, filtered, paged, or removed later.</p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <Input
              label="Classifier override"
              value={classifierOverride}
              onChange={(event) => setClassifierOverride(event.target.value)}
              placeholder={classifierSummary?.defaultClassifier || 'Leave blank to learn all classifiers'}
            />
            <div className="rounded-lg bg-gray-50 px-4 py-3 text-sm dark:bg-robin-gray-900">
              <div className="font-medium text-gray-900 dark:text-white">Classifier status</div>
              <div className="mt-2 space-y-1 text-xs text-gray-500 dark:text-gray-400">
                <div className="flex items-center justify-between gap-3"><span>Controller</span><span>{classifierSummary?.controllerAuthenticated ? 'Authenticated' : classifierSummary?.controllerReachable ? 'Reachable' : 'Unavailable'}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Normal worker</span><span>{classifierSummary?.normalWorkerReachable ? 'Reachable' : 'Unavailable'}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Learned messages</span><span>{classifierSummary?.learnedMessages ?? 'Unknown'}</span></div>
                {Boolean(classifierSummary?.statfiles.length) && (
                  <div className="flex items-center justify-between gap-3"><span>Statfiles</span><span>{classifierSummary?.statfiles.length}</span></div>
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            <Input
              label="Search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void load(1);
                }
              }}
              placeholder="filename or hash"
            />
            <label className="space-y-1 text-sm">
              <span className="block font-medium text-gray-700 dark:text-gray-300">Label</span>
              <select value={labelFilter} onChange={(event) => { setLabelFilter(event.target.value as '' | 'spam' | 'ham'); setPage(1); }} className="input">
                <option value="">All</option>
                <option value="spam">Spam</option>
                <option value="ham">Ham</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="block font-medium text-gray-700 dark:text-gray-300">Status</span>
              <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as '' | 'pending' | 'learned' | 'failed'); setPage(1); }} className="input">
                <option value="">All</option>
                <option value="pending">Pending</option>
                <option value="learned">Learned</option>
                <option value="failed">Failed</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="block font-medium text-gray-700 dark:text-gray-300">Page size</span>
              <select value={limit} onChange={(event) => { setLimit(parseInt(event.target.value, 10)); setPage(1); }} className="input">
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 px-4 py-3 text-sm dark:border-robin-gray-700">
            <span>{total} sample(s) total</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => load(1)}>
                <RefreshCw className="h-4 w-4" />
                Apply filters
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setSearch(''); setLabelFilter(''); setStatusFilter(''); setPage(1); void load(1); }}>
                Reset
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            {samples.length === 0 && (
              <div className="rounded-lg border border-dashed border-gray-300 p-8 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                No training samples stored yet.
              </div>
            )}

            {samples.map((sample) => (
              <div key={sample.id} className="rounded-lg border border-gray-200 p-4 dark:border-robin-gray-700">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{sample.filename}</div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {sample.label} · {sample.sourceType} · {sample.learnStatus}
                    </div>
                    {sample.learnError && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{sample.learnError}</div>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={() => handleLearn(sample.id)}>
                      <RefreshCw className="h-4 w-4" />
                      Relearn
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => handleRelabel(sample.id, sample.label === 'spam' ? 'ham' : 'spam')}>
                      <Brain className="h-4 w-4" />
                      Mark {sample.label === 'spam' ? 'Ham' : 'Spam'}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => handleDelete(sample.id)}>
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                </div>
                <div className="mt-3 break-all rounded-sm bg-gray-50 p-3 font-mono text-xs dark:bg-robin-gray-900">{sample.storedRelpath}</div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-gray-200 pt-4 text-sm dark:border-robin-gray-700">
            <span>Page {page} of {Math.max(totalPages, 1)}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => load(page - 1)}>
                Previous
              </Button>
              <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => load(page + 1)}>
                Next
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
