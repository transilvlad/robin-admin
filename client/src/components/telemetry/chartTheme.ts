/**
 * Telemetry chart colours. The categorical palette is the validated
 * eight-slot reference palette, stepped separately for light and dark
 * surfaces (checked against white and robin-gray-800). Slots are assigned in
 * fixed order and never cycled: series past the eighth are drawn in a muted
 * neutral and identified by the legend and tooltip.
 */

export type ChartTheme = 'light' | 'dark';

const CATEGORICAL: Record<ChartTheme, string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

/** Status colours are reserved for state and always paired with a label. */
export const STATUS_COLORS = {
  ok: '#0ca30c',
  warning: '#fab219',
  critical: '#d03b3b',
} as const;

export interface ChartChrome {
  axis: string;
  grid: string;
  overflow: string;
  surface: string;
}

const CHROME: Record<ChartTheme, ChartChrome> = {
  light: { axis: '#6b7280', grid: '#e5e7eb', overflow: '#9ca3af', surface: '#ffffff' },
  dark: { axis: '#9ca3af', grid: '#3a3a3a', overflow: '#6b7280', surface: '#2d2d2d' },
};

export const MAX_COLORED_SERIES = CATEGORICAL.light.length;

export function chartChrome(theme: ChartTheme): ChartChrome {
  return CHROME[theme];
}

/** Colour for the series at `index` of a name-sorted list. */
export function seriesColor(index: number, theme: ChartTheme): string {
  return index < MAX_COLORED_SERIES ? CATEGORICAL[theme][index] : CHROME[theme].overflow;
}

/** `#rrggbb` with an alpha channel, for area fills. */
export function withAlpha(hex: string, alpha: number): string {
  const value = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return `${hex}${value}`;
}
