/**
 * Line Chart component using Chart.js.
 * 
 * Renders smooth, professional line charts with proper styling
 * for metrics visualization.
 */

import { useMemo, useRef, useEffect } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ChartOptions,
  ChartData,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

export interface DataSeries {
  label: string;
  data: number[];
  color: string;
  fill?: boolean;
}

interface LineChartProps {
  labels: string[];
  series: DataSeries[];
  height?: number;
  yAxisFormatter?: (value: number) => string;
  tooltipFormatter?: (value: number) => string;
  showLegend?: boolean;
  stacked?: boolean;
}

export function LineChart({
  labels,
  series,
  height = 220,
  yAxisFormatter,
  tooltipFormatter,
  showLegend = true,
  stacked = false,
}: LineChartProps) {
  const chartRef = useRef<ChartJS<'line'>>(null);

  // Detect dark mode
  const isDark = useMemo(() => {
    if (typeof window !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    return false;
  }, []);

  const textColor = isDark ? '#9ca3af' : '#6b7280';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  const data: ChartData<'line'> = useMemo(() => ({
    labels,
    datasets: series.map((s) => ({
      label: s.label,
      data: s.data,
      borderColor: s.color,
      backgroundColor: s.fill ? `${s.color}20` : 'transparent',
      fill: s.fill ?? false,
      tension: 0.3,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: s.color,
      pointHoverBorderColor: '#fff',
      pointHoverBorderWidth: 2,
    })),
  }), [labels, series]);

  const options: ChartOptions<'line'> = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        display: showLegend && series.length > 1,
        position: 'top' as const,
        align: 'end' as const,
        labels: {
          color: textColor,
          font: { size: 11 },
          boxWidth: 12,
          boxHeight: 12,
          padding: 12,
          usePointStyle: true,
          pointStyle: 'circle',
        },
      },
      tooltip: {
        backgroundColor: isDark ? '#1f2937' : '#fff',
        titleColor: isDark ? '#fff' : '#111',
        bodyColor: isDark ? '#d1d5db' : '#374151',
        borderColor: isDark ? '#374151' : '#e5e7eb',
        borderWidth: 1,
        padding: 10,
        cornerRadius: 6,
        displayColors: true,
        boxWidth: 10,
        boxHeight: 10,
        usePointStyle: true,
        callbacks: {
          label: (context) => {
            const value = context.parsed.y ?? 0;
            const formatted = tooltipFormatter ? tooltipFormatter(value) : value.toLocaleString();
            return `${context.dataset.label}: ${formatted}`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          color: textColor,
          font: { size: 10 },
          maxTicksLimit: 12,
          maxRotation: 0,
        },
        border: { display: false },
      },
      y: {
        stacked,
        grid: { color: gridColor },
        ticks: {
          color: textColor,
          font: { size: 10 },
          padding: 8,
          callback: (value) => {
            const num = typeof value === 'number' ? value : parseFloat(value as string);
            return yAxisFormatter ? yAxisFormatter(num) : num.toLocaleString();
          },
        },
        border: { display: false },
        beginAtZero: true,
      },
    },
    elements: {
      line: { tension: 0.3, borderWidth: 2 },
      point: { radius: 0 },
    },
  }), [isDark, textColor, gridColor, showLegend, series.length, stacked, yAxisFormatter, tooltipFormatter]);

  // Update chart on theme change
  useEffect(() => {
    const observer = new MutationObserver(() => {
      chartRef.current?.update();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div style={{ height, position: 'relative' }}>
      <Line ref={chartRef} data={data} options={options} />
    </div>
  );
}

// Utility function to format timestamps for chart labels
export function formatChartLabels(timestamps: (Date | string)[], window: string): string[] {
  return timestamps.map((d) => {
    const date = new Date(d);
    if (window === '7d' || window === '30d') {
      return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:00`;
    }
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  });
}

// Utility to downsample data for large datasets
export function downsampleData<T>(data: T[], maxPoints: number): T[] {
  if (data.length <= maxPoints) return data;
  
  const step = Math.ceil(data.length / maxPoints);
  const result: T[] = [];
  
  for (let i = 0; i < data.length; i += step) {
    result.push(data[i]);
  }
  
  // Always include the last point
  if (result.length > 0 && result[result.length - 1] !== data[data.length - 1]) {
    result.push(data[data.length - 1]);
  }
  
  return result;
}
