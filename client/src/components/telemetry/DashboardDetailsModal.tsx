import { useState } from 'react';
import { Modal } from '../ui/Modal';
import type { TelemetryDashboardDefaults } from '../../types/telemetry';
import { RANGE_PRESETS, REFRESH_OPTIONS } from '../../utils/telemetry';

interface DashboardDetailsModalProps {
  heading: string;
  submitLabel: string;
  initialTitle?: string;
  initialDescription?: string;
  initialDefaults?: TelemetryDashboardDefaults;
  onSubmit: (details: { title: string; description: string; defaults?: TelemetryDashboardDefaults }) => void;
  onClose: () => void;
}

/** Name and describe a dashboard, and choose the time range and refresh it opens with. */
export function DashboardDetailsModal({ heading, submitLabel, initialTitle = '', initialDescription = '', initialDefaults, onSubmit, onClose }: DashboardDetailsModalProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [range, setRange] = useState(initialDefaults?.range ?? '');
  const [refresh, setRefresh] = useState(initialDefaults?.refresh ?? 0);
  return (
    <Modal isOpen onClose={onClose} title={heading}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          const defaults: TelemetryDashboardDefaults = {
            ...(range ? { range: range as TelemetryDashboardDefaults['range'] } : {}),
            ...(refresh ? { refresh } : {}),
          };
          onSubmit({ title: title.trim(), description: description.trim(), defaults: Object.keys(defaults).length > 0 ? defaults : undefined });
        }}
      >
        <label className="block text-sm">
          <span className="form-label">Title</span>
          <input className="input" value={title} maxLength={120} autoFocus required onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="form-label">Description</span>
          <textarea className="input min-h-20" value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="form-label">Opens with range</span>
            <select className="input" value={range} onChange={(event) => setRange(event.target.value)}>
              <option value="">Default (6h)</option>
              {RANGE_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>Last {preset.label}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="form-label">Auto refresh</span>
            <select className="input" value={refresh} onChange={(event) => setRefresh(Number(event.target.value))}>
              {REFRESH_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.value ? `Every ${option.label}` : 'Off'}</option>)}
            </select>
          </label>
        </div>
        <p className="form-hint">A range or refresh chosen on the page, or in a shared link, still wins.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!title.trim()}>{submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
