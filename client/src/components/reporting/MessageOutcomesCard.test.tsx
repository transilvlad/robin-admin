import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MessageOutcomesCard } from './MessageOutcomesCard';
import type { TaxonomyBreakdown, TrendPoint } from '../../types/reporting';

afterEach(cleanup);

function buildBreakdown(overrides: Partial<TaxonomyBreakdown> = {}): TaxonomyBreakdown {
  return {
    totalVolume: 1000,
    compliantVolume: 950,
    fullyAlignedVolume: 900,
    dkimAlignedVolume: 30,
    spfAlignedVolume: 20,
    authenticatedUnalignedVolume: 30,
    dkimAuthenticatedVolume: 15,
    spfAuthenticatedVolume: 15,
    failedVolume: 20,
    benignRelayVolume: 5,
    actionableFailureVolume: 15,
    byReason: {} as TaxonomyBreakdown['byReason'],
    ...overrides,
  };
}

describe('MessageOutcomesCard', () => {
  it('renders the compliance breakdown without a trend strip when no trend is passed', () => {
    render(<MessageOutcomesCard breakdown={buildBreakdown()} />);
    expect(screen.getByText('Message outcomes')).toBeInTheDocument();
    expect(screen.queryByText('Daily compliance rate')).not.toBeInTheDocument();
  });

  it('renders a daily compliance trend strip when trend data is available', () => {
    const trend: TrendPoint[] = [
      { date: '2026-09-01', complianceRate: 0.99, breakdown: buildBreakdown({ totalVolume: 500 }) },
      { date: '2026-09-02', complianceRate: 0.95, breakdown: buildBreakdown({ totalVolume: 600 }) },
    ];

    render(<MessageOutcomesCard breakdown={buildBreakdown()} trend={trend} />);

    expect(screen.getByText('Daily compliance rate')).toBeInTheDocument();
    expect(screen.getByText('2026-09-01')).toBeInTheDocument();
    expect(screen.getByText('2026-09-02')).toBeInTheDocument();
  });

  it('does not render the trend strip for an empty trend array', () => {
    render(<MessageOutcomesCard breakdown={buildBreakdown()} trend={[]} />);
    expect(screen.queryByText('Daily compliance rate')).not.toBeInTheDocument();
  });
});
