import { Modal } from '../ui/Modal';
import type { TelemetryPanel, TelemetryVariableValues } from '../../types/telemetry';
import type { ChartSpan } from './TimeSeriesChart';
import { PanelBody, usePanelData, type OpenLink, type PanelSource } from './TelemetryPanel';

interface PanelFullscreenProps {
  panel: TelemetryPanel;
  source: PanelSource;
  start: number;
  end: number;
  values: TelemetryVariableValues;
  refreshKey: number;
  annotations?: ChartSpan[];
  onZoom?: (start: number, end: number) => void;
  onOpenLink?: OpenLink;
  onClose: () => void;
}

/** One panel at a large size, with the same data and interactions as on the dashboard. */
export function PanelFullscreen({ panel, source, start, end, values, refreshKey, annotations, onZoom, onOpenLink, onClose }: PanelFullscreenProps) {
  const { data, error } = usePanelData(panel, source, start, end, values, refreshKey);
  const height = Math.max(240, Math.round(window.innerHeight * 0.6));
  return (
    <Modal isOpen onClose={onClose} title={panel.title} size="xl">
      {panel.description && <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{panel.description}</p>}
      <div style={panel.type === 'timeseries' ? undefined : { height }}>
        <PanelBody
          panel={panel}
          data={data}
          error={error}
          height={panel.type === 'timeseries' ? height : undefined}
          annotations={annotations}
          onZoom={onZoom}
          onOpenLink={onOpenLink}
        />
      </div>
    </Modal>
  );
}
