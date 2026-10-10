/**
 * Compliance metrics — the single definition of the reporting KPIs.
 *
 * Every surface (overview, domain list, domain detail, issue evidence)
 * must show the same number for the same domain and window, so the KPI
 * math lives here once rather than being re-derived per page — no two
 * screens can legitimately disagree.
 *
 * Two numbers matter, and they are the same two every mature DMARC
 * product leads with:
 *
 *   complianceRate     — aligned-pass volume / total reported volume.
 *                        "How much of my mail passes DMARC?"
 *   unidentifiedVolume — volume from senders still classified unknown and
 *                        pending operator review.
 *                        "How much triage work is left?"
 *
 * Aligned-pass means SPF *or* DKIM passed and aligned, which is exactly
 * the DMARC evaluation rule. It is deliberately not the average of the
 * SPF and DKIM pass rates: a domain whose mail is 100% DKIM-aligned but
 * 0% SPF-aligned (every message forwarded) is fully compliant, and
 * averaging would report it as 50%.
 */

export interface ComplianceInput {
  totalVolume: number;
  /** Volume where SPF or DKIM passed and aligned. */
  alignedPassVolume: number;
  /** Volume from unknown senders that have not been reviewed. */
  unidentifiedVolume?: number;
}

export interface ComplianceMetrics {
  totalVolume: number;
  alignedPassVolume: number;
  complianceRate: number;
  unidentifiedVolume: number;
  unidentifiedRate: number;
}

export function computeComplianceMetrics(input: ComplianceInput): ComplianceMetrics {
  const totalVolume = Math.max(0, input.totalVolume);
  const alignedPassVolume = Math.max(0, Math.min(input.alignedPassVolume, totalVolume));
  const unidentifiedVolume = Math.max(0, Math.min(input.unidentifiedVolume ?? 0, totalVolume));

  return {
    totalVolume,
    alignedPassVolume,
    // A domain with no reported mail is not "0% compliant" — there is
    // simply nothing to judge. Reporting 0 there produced alarming red
    // rows for domains that had never sent.
    complianceRate: totalVolume > 0 ? alignedPassVolume / totalVolume : 1,
    unidentifiedVolume,
    unidentifiedRate: totalVolume > 0 ? unidentifiedVolume / totalVolume : 0,
  };
}

/** Aggregate several domains' metrics into one volume-weighted figure. */
export function aggregateComplianceMetrics(parts: ComplianceInput[]): ComplianceMetrics {
  const totals = parts.reduce<Required<ComplianceInput>>(
    (acc, part) => ({
      totalVolume: acc.totalVolume + Math.max(0, part.totalVolume),
      alignedPassVolume: acc.alignedPassVolume + Math.max(0, part.alignedPassVolume),
      unidentifiedVolume: acc.unidentifiedVolume + Math.max(0, part.unidentifiedVolume ?? 0),
    }),
    { totalVolume: 0, alignedPassVolume: 0, unidentifiedVolume: 0 }
  );
  return computeComplianceMetrics(totals);
}

export type ComplianceBand = 'compliant' | 'at_risk' | 'failing' | 'no_data';

/**
 * Bucket a compliance rate for colour-coding. Thresholds match the risk
 * factors in the DMARC analyzer so a "failing" badge and a "low pass
 * rate" risk factor never contradict each other.
 */
export function complianceBand(rate: number, totalVolume: number): ComplianceBand {
  if (totalVolume <= 0) return 'no_data';
  if (rate >= 0.95) return 'compliant';
  if (rate >= 0.8) return 'at_risk';
  return 'failing';
}
