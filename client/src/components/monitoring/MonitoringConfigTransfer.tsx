import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { ApiError, monitoringApi } from '../../api/client';
import type { MonitoringImportReport } from '../../types/monitoring';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

export function MonitoringConfigTransfer({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [configuration, setConfiguration] = useState<unknown>(undefined);
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<MonitoringImportReport | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const exportConfig = async () => {
    setWorking(true); setError('');
    try {
      const response = await monitoringApi.exportConfiguration();
      if (!response.data) throw new Error('Export data is missing');
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'robin-admin-monitoring.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to export Monitoring configuration');
      setOpen(true);
    } finally { setWorking(false); }
  };

  const selectFile = async (file?: File) => {
    setConfiguration(undefined); setReport(null); setFileName(''); setError(''); setSuccess('');
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      setConfiguration(parsed);
      setFileName(file.name);
    } catch {
      setError('The selected file is not valid JSON');
    }
  };

  const preview = async () => {
    if (configuration === undefined) return;
    setWorking(true); setError(''); setSuccess('');
    try {
      const response = await monitoringApi.importConfiguration(configuration, true);
      if (!response.data) throw new Error('Import preview is missing');
      setReport(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to preview import');
    } finally { setWorking(false); }
  };

  const apply = async () => {
    if (configuration === undefined || !report || report.errors.length || report.conflicts.length) return;
    setWorking(true); setError(''); setSuccess('');
    try {
      const response = await monitoringApi.importConfiguration(configuration, false);
      if (!response.data) throw new Error('Import result is missing');
      setReport(response.data);
      setSuccess('Monitoring configuration imported');
      onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to import Monitoring configuration');
    } finally { setWorking(false); }
  };

  const close = () => { setOpen(false); setError(''); setSuccess(''); };
  return <>
    <Button variant="secondary" disabled={working} onClick={() => void exportConfig()}><Download aria-hidden="true" className="h-4 w-4" />Export</Button>
    <Button variant="secondary" disabled={working} onClick={() => { setOpen(true); setError(''); setSuccess(''); }}><Upload aria-hidden="true" className="h-4 w-4" />Import</Button>
    <Modal isOpen={open} title="Import Monitoring configuration" onClose={close} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">Import targets, checks, status-page sections and components. Secret headers are never exported or imported; existing secrets are preserved when a check is updated.</p>
        <label className="block space-y-1 text-sm font-medium">Configuration file
          <input className="input" type="file" accept="application/json,.json" disabled={working} onChange={event => void selectFile(event.target.files?.[0])} />
        </label>
        {fileName && <p className="text-sm text-gray-600 dark:text-gray-300">Selected: {fileName}</p>}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {success && <p role="status" className="text-sm text-green-700 dark:text-green-400">{success}</p>}
        <div className="flex justify-end"><Button variant="secondary" disabled={!fileName || working} onClick={() => void preview()}>{working ? 'Working...' : 'Preview import'}</Button></div>
        {report && <section aria-label="Import preview" className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-robin-gray-700">
          <h3 className="font-medium">Dry-run results</h3>
          <p className="text-sm">{report.changes.filter(change => change.action === 'create').length} creates · {report.changes.filter(change => change.action === 'update').length} updates · {report.conflicts.length} conflicts · {report.errors.length} invalid rows</p>
          {report.changes.length > 0 && <ul className="max-h-40 space-y-1 overflow-auto text-sm">{report.changes.map((change, index) => <li key={`${change.resource}-${change.identity}-${index}`}>{change.action}: {change.resource} — {change.identity}</li>)}</ul>}
          {[...report.conflicts, ...report.errors].map((item, index) => <p key={`${item.path}-${index}`} className="text-sm text-red-600 dark:text-red-400">{item.path}: {item.message}</p>)}
          <div className="flex justify-end"><Button disabled={working || report.errors.length > 0 || report.conflicts.length > 0} onClick={() => void apply()}>Apply import</Button></div>
        </section>}
      </div>
    </Modal>
  </>;
}
