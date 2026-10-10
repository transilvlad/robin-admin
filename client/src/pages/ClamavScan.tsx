import { useState } from 'react';
import { Search, ShieldCheck, ShieldX } from 'lucide-react';
import { ApiError, clamavApi } from '../api/client';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';
import type { ClamavScanResult } from '../types';

export function ClamavScanPage() {
  const { selectedClamavService } = useServices();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ClamavScanResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState('');

  const serviceId = selectedClamavService?.serviceId;

  const handleScan = async () => {
    if (!serviceId || !file) {
      return;
    }
    setIsScanning(true);
    setError('');
    setResult(null);
    try {
      const response = await clamavApi.scanFile(serviceId, file);
      setResult(response.data ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to scan file');
    } finally {
      setIsScanning(false);
    }
  };

  if (!serviceId) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.clamavScan}
          title="ClamAV Scan"
          description="Select an enabled ClamAV service from Fleet before uploading a file for INSTREAM scanning."
          actions={<PageServiceSelector serviceType="clamav" capability="scan" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled ClamAV service is currently selected.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.clamavScan}
        title="ClamAV Scan"
        description={<>Upload a single file and scan it through ClamD INSTREAM on <strong>{selectedClamavService?.name ?? serviceId}</strong>.</>}
        actions={<PageServiceSelector serviceType="clamav" capability="scan" />}
      />

      {error && (
        <div className="rounded-lg bg-red-100 p-3 text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(320px,1.1fr)]">
        <div className="card p-6">
          <h2 className="text-lg font-semibold">Upload file</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Files are streamed directly to the selected ClamD service. Use private-network-only endpoints.
          </p>
          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">File</span>
              <input
                type="file"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="input"
              />
            </label>
            <Button onClick={handleScan} isLoading={isScanning} disabled={!file}>
              <Search className="h-4 w-4" />
              Scan file
            </Button>
          </div>
        </div>

        <div className="card p-6">
          <h2 className="text-lg font-semibold">Scan result</h2>
          {!result ? (
            <div className="mt-6 rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
              Upload a file to run a manual ClamAV scan.
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <div className={`flex items-start gap-3 rounded-lg px-4 py-3 text-sm ${result.infected ? 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400' : 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400'}`}>
                {result.infected ? <ShieldX className="mt-0.5 h-5 w-5 shrink-0" /> : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />}
                <div>
                  <div className="font-medium">{result.infected ? 'Threats detected' : 'No threats detected'}</div>
                  <div className="mt-1 text-xs opacity-80">{result.fileName} · {result.sizeBytes.toLocaleString()} bytes · {result.durationMs} ms</div>
                </div>
              </div>

              <Stat label="Detected signatures" value={result.viruses.length > 0 ? result.viruses.join(', ') : 'None'} />
              <Stat label="Scanned at" value={new Date(result.scannedAt).toLocaleString()} />

              <div>
                <div className="mb-2 text-sm font-medium">Raw ClamD response</div>
                <pre className="overflow-x-auto rounded-lg bg-gray-50 p-4 text-xs dark:bg-robin-gray-900">{result.rawResponse}</pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-robin-gray-900">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="font-medium text-gray-900 dark:text-white">{value}</span>
    </div>
  );
}
