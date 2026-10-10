/**
 * Donut chart component for DMARC type distribution.
 */

interface DonutChartProps {
  values: number[];
  colors: string[];
  labels: string[];
  size?: number;
  strokeWidth?: number;
  // Off when the caller renders its own (typically more complete) legend
  // alongside the chart, so the two don't duplicate each other.
  showLegend?: boolean;
}

export function DonutChart({
  values,
  colors,
  labels,
  size = 200,
  strokeWidth = 40,
  showLegend = true,
}: DonutChartProps) {
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return (
      <div className="flex items-center justify-center" style={{ width: size, height: size }}>
        <span className="text-gray-400">No data</span>
      </div>
    );
  }

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  let currentOffset = 0;
  const segments = values.map((value, i) => {
    const percentage = value / total;
    const dashArray = percentage * circumference;
    const dashOffset = -currentOffset;
    currentOffset += dashArray;

    return {
      value,
      color: colors[i],
      label: labels[i],
      dashArray,
      dashOffset,
      percentage,
    };
  });

  return (
    <div className="flex items-start gap-4">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="transform -rotate-90">
          {segments.map((segment, i) => (
            <circle
              key={i}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={segment.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${segment.dashArray} ${circumference}`}
              strokeDashoffset={segment.dashOffset}
              className="transition-all duration-300"
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="text-2xl font-bold">{total.toLocaleString()}</div>
            <div className="text-xs text-gray-500">Total</div>
          </div>
        </div>
      </div>
      {showLegend && (
        <div className="space-y-2 pt-2">
          {segments.filter(s => s.value > 0).map((segment, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <div
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: segment.color }}
              />
              <span className="text-gray-600 dark:text-gray-400">{segment.label}</span>
              <span className="font-medium ml-auto">{segment.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
