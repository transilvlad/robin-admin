/**
 * Lollipop chart for DMARC daily trends.
 * Shows multiple series as colored dots on vertical stems.
 */

interface LollipopChartProps {
  data: { date: string; values: number[] }[];
  colors: string[];
  labels: string[];
  height?: number;
}

export function LollipopChart({ data, colors, labels, height = 300 }: LollipopChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48">
        <span className="text-gray-400">No data</span>
      </div>
    );
  }

  // Find max value for scaling
  const allValues = data.flatMap((d) => d.values);
  const maxValue = Math.max(...allValues, 1);

  // Chart dimensions
  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const chartHeight = height - padding.top - padding.bottom;

  // Format date labels
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.getDate().toString().padStart(2, '0');
  };

  // Generate nice Y-axis ticks
  const yTicks: number[] = [];
  const tickCount = 5;
  const tickInterval = Math.ceil(maxValue / tickCount / 1000) * 1000 || Math.ceil(maxValue / tickCount);
  for (let i = 0; i <= maxValue; i += tickInterval) {
    yTicks.push(i);
  }
  if (yTicks[yTicks.length - 1] < maxValue) {
    yTicks.push(yTicks[yTicks.length - 1] + tickInterval);
  }
  const yMax = yTicks[yTicks.length - 1] || maxValue;

  return (
    <div className="w-full">
      <svg width="100%" height={height} viewBox={`0 0 800 ${height}`} preserveAspectRatio="xMidYMid meet">
        {/* Y-axis labels */}
        {yTicks.map((tick, i) => {
          const y = padding.top + chartHeight - (tick / yMax) * chartHeight;
          return (
            <g key={i}>
              <line
                x1={padding.left}
                y1={y}
                x2={800 - padding.right}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.1}
              />
              <text
                x={padding.left - 10}
                y={y + 4}
                textAnchor="end"
                className="text-xs fill-gray-500"
              >
                {tick >= 1000 ? `${(tick / 1000).toFixed(0)}k` : tick}
              </text>
            </g>
          );
        })}

        {/* Data points */}
        {data.map((day, dayIndex) => {
          const x = padding.left + ((800 - padding.left - padding.right) / (data.length - 1 || 1)) * dayIndex;

          return (
            <g key={dayIndex}>
              {/* Vertical stem */}
              <line
                x1={x}
                y1={padding.top}
                x2={x}
                y2={padding.top + chartHeight}
                stroke="currentColor"
                strokeOpacity={0.05}
              />

              {/* Data dots for each type */}
              {day.values.map((value, typeIndex) => {
                if (value === 0) return null;
                const y = padding.top + chartHeight - (value / yMax) * chartHeight;
                return (
                  <g key={typeIndex}>
                    {/* Stem from bottom to dot */}
                    <line
                      x1={x}
                      y1={padding.top + chartHeight}
                      x2={x}
                      y2={y}
                      stroke={colors[typeIndex]}
                      strokeWidth={1}
                      strokeOpacity={0.3}
                    />
                    {/* Dot */}
                    <circle
                      cx={x}
                      cy={y}
                      r={4}
                      fill={colors[typeIndex]}
                      className="transition-all duration-200 hover:r-6"
                    >
                      <title>{`${labels[typeIndex]}: ${value.toLocaleString()} (${day.date})`}</title>
                    </circle>
                  </g>
                );
              })}

              {/* X-axis label (show every few days to avoid crowding) */}
              {(dayIndex % Math.ceil(data.length / 15) === 0 || dayIndex === data.length - 1) && (
                <text
                  x={x}
                  y={padding.top + chartHeight + 20}
                  textAnchor="middle"
                  className="text-xs fill-gray-500"
                >
                  {formatDate(day.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 justify-center mt-2">
        {labels.map((label, i) => (
          <div key={i} className="flex items-center gap-1.5 text-sm">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: colors[i] }}
            />
            <span className="text-gray-600 dark:text-gray-400">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
