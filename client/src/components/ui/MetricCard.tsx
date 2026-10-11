import type { ReactNode } from 'react';

export type MetricTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

interface MetricValueProps {
  children: ReactNode;
  className?: string;
}

export function MetricValue({ children, className = '' }: MetricValueProps) {
  return (
    <div className={`min-w-0 wrap-break-word text-2xl font-semibold leading-tight tabular-nums ${className}`}>
      {children}
    </div>
  );
}

interface MetricCardProps {
  /** Omit to render a card with no icon chip. */
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  /** Caption below the value — a count the percentage was derived from, a link, a status row. */
  sub?: ReactNode;
  tone?: MetricTone;
  /** Also color the value text with `tone` (off by default — most cards keep the value neutral and only tone the icon). */
  toneValue?: boolean;
}

const chipToneClasses: Record<MetricTone, string> = {
  neutral: 'bg-gray-100 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300',
  info: 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400',
  success: 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400',
  warning: 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-300',
  danger: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400',
};

const valueToneClasses: Record<MetricTone, string> = {
  neutral: '',
  info: 'text-blue-600 dark:text-blue-400',
  success: 'text-green-600 dark:text-green-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
};

export function MetricCard({ icon, label, value, sub, tone = 'neutral', toneValue = false }: MetricCardProps) {
  return (
    <div className="card min-w-[160px] flex-1 p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
          <MetricValue className={`mt-1 ${toneValue ? valueToneClasses[tone] : ''}`}>{value}</MetricValue>
          {sub && <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{sub}</div>}
        </div>
        {icon && <div className={`shrink-0 rounded-full p-3 ${chipToneClasses[tone]}`}>{icon}</div>}
      </div>
    </div>
  );
}
