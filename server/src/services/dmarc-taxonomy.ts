/**
 * The DMARC compliance taxonomy — shared vocabulary for every reporting surface.
 *
 * This is deliberately the taxonomy the established DMARC products converged on
 * (Mimecast DMARC Analyzer states it most precisely; dmarcian's Detail Viewer,
 * EasyDMARC's four tabs and Valimail's disposition statuses are the same model
 * under different labels). Adopting it verbatim means our screens can be read by
 * anyone who has used one of those tools, and — more importantly — it puts
 * forwarded mail in its own benign bucket instead of counting it as a failure.
 *
 * Three classes, by DMARC evaluation:
 *
 *   compliant              SPF or DKIM passed *and* aligned. This is the actual
 *                          DMARC rule, so it is the only definition of "passing".
 *                          Sub-divided into fully_aligned / dkim_aligned /
 *                          spf_aligned for diagnosis.
 *   authenticated_unaligned
 *                          The message carried a valid signature or passed SPF,
 *                          but for a domain other than the From domain. Almost
 *                          always a misconfigured third-party sender.
 *   failed                 Neither check produced a usable result.
 *
 * Failures are then sub-classified by the receiver's own override reason
 * (`reason_type` in the aggregate report). This matters enormously here: on our
 * own data 1,938 of 2,169 failing messages are labelled `forwarded` by the
 * receiving provider, so forwarding must stay separate from actionable failure.
 */

export type ComplianceClass = 'compliant' | 'authenticated_unaligned' | 'failed';

export type ComplianceDetail =
  | 'fully_aligned'
  | 'dkim_aligned'
  | 'spf_aligned'
  | 'dkim_authenticated'
  | 'spf_authenticated'
  | 'unauthenticated';

/**
 * Receiver-declared reasons a message failed DMARC evaluation, per RFC 7489
 * §7.2 `PolicyOverrideType`, plus `other` for anything unrecognised and `none`
 * for failures the receiver did not annotate.
 */
export type FailureReason =
  | 'forwarded'
  | 'trusted_forwarder'
  | 'mailing_list'
  | 'sampled_out'
  | 'local_policy'
  | 'other'
  | 'none';

export interface RecordAuthInput {
  /** DMARC-evaluated (i.e. aligned) DKIM result. */
  dkim?: string | null;
  /** DMARC-evaluated (i.e. aligned) SPF result. */
  spf?: string | null;
  /** Raw DKIM authentication result, before alignment is considered. */
  dkimResult?: string | null;
  /** Raw SPF authentication result, before alignment is considered. */
  spfResult?: string | null;
  /** Receiver-supplied policy override reason, if any. */
  reasonType?: string | null;
}

export interface Classification {
  class: ComplianceClass;
  detail: ComplianceDetail;
  /** Only meaningful when class is 'failed'. */
  reason: FailureReason;
  /**
   * True when the receiver attributed the failure to forwarding or an
   * equivalent benign relay.
   */
  benignRelay: boolean;
}

const pass = (value?: string | null): boolean => (value ?? '').trim().toLowerCase() === 'pass';

const FAILURE_REASONS: Record<string, FailureReason> = {
  forwarded: 'forwarded',
  trusted_forwarder: 'trusted_forwarder',
  mailing_list: 'mailing_list',
  sampled_out: 'sampled_out',
  local_policy: 'local_policy',
  other: 'other',
};

/** Reasons the *receiver* has told us are not the domain owner's problem. */
const BENIGN_RELAY_REASONS: ReadonlySet<FailureReason> = new Set<FailureReason>([
  'forwarded',
  'trusted_forwarder',
  'mailing_list',
]);

export function normaliseFailureReason(reasonType?: string | null): FailureReason {
  const key = (reasonType ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return 'none';
  return FAILURE_REASONS[key] ?? 'other';
}

export function classifyRecord(input: RecordAuthInput): Classification {
  const dkimAligned = pass(input.dkim);
  const spfAligned = pass(input.spf);

  if (dkimAligned || spfAligned) {
    return {
      class: 'compliant',
      detail: dkimAligned && spfAligned ? 'fully_aligned' : dkimAligned ? 'dkim_aligned' : 'spf_aligned',
      reason: 'none',
      benignRelay: false,
    };
  }

  const reason = normaliseFailureReason(input.reasonType);
  const benignRelay = BENIGN_RELAY_REASONS.has(reason);

  // Authenticated but not aligned. DKIM is checked first because a surviving
  // DKIM signature is the stronger signal: it proves the message body is intact
  // across a relay, whereas SPF only ever describes the last hop.
  if (pass(input.dkimResult)) {
    return { class: 'authenticated_unaligned', detail: 'dkim_authenticated', reason, benignRelay };
  }
  if (pass(input.spfResult)) {
    return { class: 'authenticated_unaligned', detail: 'spf_authenticated', reason, benignRelay };
  }

  return { class: 'failed', detail: 'unauthenticated', reason, benignRelay };
}

export interface TaxonomyBreakdown {
  totalVolume: number;

  compliantVolume: number;
  fullyAlignedVolume: number;
  dkimAlignedVolume: number;
  spfAlignedVolume: number;

  authenticatedUnalignedVolume: number;
  dkimAuthenticatedVolume: number;
  spfAuthenticatedVolume: number;

  failedVolume: number;

  /** Volume the receiver attributed to forwarding / lists / trusted relays. */
  benignRelayVolume: number;
  /**
   * Volume that failed DMARC with no benign explanation. This is the number
   * that actually deserves attention.
   */
  actionableFailureVolume: number;

  byReason: Record<FailureReason, number>;
}

export function emptyBreakdown(): TaxonomyBreakdown {
  return {
    totalVolume: 0,
    compliantVolume: 0,
    fullyAlignedVolume: 0,
    dkimAlignedVolume: 0,
    spfAlignedVolume: 0,
    authenticatedUnalignedVolume: 0,
    dkimAuthenticatedVolume: 0,
    spfAuthenticatedVolume: 0,
    failedVolume: 0,
    benignRelayVolume: 0,
    actionableFailureVolume: 0,
    byReason: {
      forwarded: 0,
      trusted_forwarder: 0,
      mailing_list: 0,
      sampled_out: 0,
      local_policy: 0,
      other: 0,
      none: 0,
    },
  };
}

export function addToBreakdown(
  breakdown: TaxonomyBreakdown,
  input: RecordAuthInput,
  volume: number
): TaxonomyBreakdown {
  const count = Number.isFinite(volume) ? Math.max(0, volume) : 0;
  if (count === 0) return breakdown;

  const result = classifyRecord(input);
  breakdown.totalVolume += count;

  switch (result.detail) {
    case 'fully_aligned':
      breakdown.fullyAlignedVolume += count;
      break;
    case 'dkim_aligned':
      breakdown.dkimAlignedVolume += count;
      break;
    case 'spf_aligned':
      breakdown.spfAlignedVolume += count;
      break;
    case 'dkim_authenticated':
      breakdown.dkimAuthenticatedVolume += count;
      break;
    case 'spf_authenticated':
      breakdown.spfAuthenticatedVolume += count;
      break;
    case 'unauthenticated':
      break;
  }

  if (result.class === 'compliant') {
    breakdown.compliantVolume += count;
  } else {
    if (result.class === 'authenticated_unaligned') {
      breakdown.authenticatedUnalignedVolume += count;
    } else {
      breakdown.failedVolume += count;
    }
    breakdown.byReason[result.reason] += count;
    if (result.benignRelay) {
      breakdown.benignRelayVolume += count;
    } else {
      breakdown.actionableFailureVolume += count;
    }
  }

  return breakdown;
}

export function buildBreakdown(
  rows: Array<RecordAuthInput & { count?: number | string | null }>
): TaxonomyBreakdown {
  return rows.reduce(
    (acc, row) => addToBreakdown(acc, row, Number(row.count ?? 0)),
    emptyBreakdown()
  );
}

export function mergeBreakdowns(parts: TaxonomyBreakdown[]): TaxonomyBreakdown {
  return parts.reduce((acc, part) => {
    acc.totalVolume += part.totalVolume;
    acc.compliantVolume += part.compliantVolume;
    acc.fullyAlignedVolume += part.fullyAlignedVolume;
    acc.dkimAlignedVolume += part.dkimAlignedVolume;
    acc.spfAlignedVolume += part.spfAlignedVolume;
    acc.authenticatedUnalignedVolume += part.authenticatedUnalignedVolume;
    acc.dkimAuthenticatedVolume += part.dkimAuthenticatedVolume;
    acc.spfAuthenticatedVolume += part.spfAuthenticatedVolume;
    acc.failedVolume += part.failedVolume;
    acc.benignRelayVolume += part.benignRelayVolume;
    acc.actionableFailureVolume += part.actionableFailureVolume;
    for (const key of Object.keys(acc.byReason) as FailureReason[]) {
      acc.byReason[key] += part.byReason[key];
    }
    return acc;
  }, emptyBreakdown());
}

/**
 * SQL fragments implementing the identical taxonomy, for use where aggregating
 * hundreds of thousands of rows in Node would be wasteful. Kept beside the
 * TypeScript implementation so the two cannot drift apart unnoticed; the unit
 * tests assert both produce the same numbers for the same input.
 *
 * `alias` is the table alias holding the dmarc_records columns.
 */
/**
 * Reason keys that get their own SQL column. `other` and `none` are derived by
 * exclusion instead, so a reason type we have never seen still lands somewhere
 * rather than vanishing from the totals.
 */
const REASON_SQL_KEYS: Exclude<FailureReason, 'other' | 'none'>[] = [
  'forwarded',
  'trusted_forwarder',
  'mailing_list',
  'sampled_out',
  'local_policy',
];

/**
 * Per-record projection that normalises each verdict column exactly once.
 *
 * PERFORMANCE, and it is not a micro-optimisation: `taxonomySql` references
 * these values around fifty times per row across its aggregate columns. Written
 * inline, Postgres re-evaluates `LOWER(TRIM(COALESCE(...)))` for every one of
 * them — roughly fourteen million string allocations over this dataset, which
 * turned a one-second scan into a twelve-second one and made the reporting
 * screens take half a minute to paint.
 *
 * Must be used via `taxonomyScan`, which wraps it in an optimisation fence.
 * Without the fence Postgres inlines the subquery and re-expands these
 * expressions at every reference, defeating the whole point.
 */
export const TAXONOMY_PROJECTION = `
  COALESCE(r.count, 0) AS tx_volume,
  LOWER(TRIM(COALESCE(r.dkim, ''))) = 'pass' AS tx_dkim_aligned,
  LOWER(TRIM(COALESCE(r.spf, ''))) = 'pass' AS tx_spf_aligned,
  LOWER(TRIM(COALESCE(r.dkim_result, ''))) = 'pass' AS tx_dkim_auth,
  LOWER(TRIM(COALESCE(r.spf_result, ''))) = 'pass' AS tx_spf_auth,
  LOWER(TRIM(COALESCE(r.reason_type, ''))) AS tx_reason`;

/**
 * Aggregate columns for the taxonomy, over rows produced by `taxonomyScan`.
 *
 * NULL-safety lives in TAXONOMY_PROJECTION, not here: `dkim`, `spf` and
 * `reason_type` are all nullable, and a plain `<> 'pass'` on a NULL yields NULL
 * rather than TRUE, which would silently drop rows from every bucket.
 */
export function taxonomySql(alias = 'tx'): string {
  const a = alias;
  const dkimAligned = `${a}.tx_dkim_aligned`;
  const spfAligned = `${a}.tx_spf_aligned`;
  const dkimAuth = `${a}.tx_dkim_auth`;
  const spfAuth = `${a}.tx_spf_auth`;
  const reason = `${a}.tx_reason`;
  const aligned = `(${dkimAligned} OR ${spfAligned})`;
  const benign = `${reason} IN ('forwarded', 'trusted_forwarder', 'mailing_list')`;
  const vol = `${a}.tx_volume`;
  // Per-reason columns so the SQL path carries the same failure sub-classification
  // as the TypeScript path; without these, anything aggregated in SQL would lose
  // the override reasons and the two implementations would quietly diverge.
  const reasonColumns = REASON_SQL_KEYS.map(
    (key) =>
      `SUM(CASE WHEN NOT ${aligned} AND ${reason} = '${key}'
             THEN ${vol} ELSE 0 END) AS reason_${key}_volume`
  ).join(',\n    ');
  return `
    SUM(${vol}) AS total_volume,
    SUM(CASE WHEN ${aligned} THEN ${vol} ELSE 0 END) AS compliant_volume,
    SUM(CASE WHEN ${dkimAligned} AND ${spfAligned} THEN ${vol} ELSE 0 END) AS fully_aligned_volume,
    SUM(CASE WHEN ${dkimAligned} AND NOT ${spfAligned} THEN ${vol} ELSE 0 END) AS dkim_aligned_volume,
    SUM(CASE WHEN ${spfAligned} AND NOT ${dkimAligned} THEN ${vol} ELSE 0 END) AS spf_aligned_volume,
    SUM(CASE WHEN NOT ${aligned} AND (${dkimAuth} OR ${spfAuth})
             THEN ${vol} ELSE 0 END) AS authenticated_unaligned_volume,
    SUM(CASE WHEN NOT ${aligned} AND ${dkimAuth}
             THEN ${vol} ELSE 0 END) AS dkim_authenticated_volume,
    SUM(CASE WHEN NOT ${aligned} AND NOT ${dkimAuth} AND ${spfAuth}
             THEN ${vol} ELSE 0 END) AS spf_authenticated_volume,
    SUM(CASE WHEN NOT ${aligned} AND NOT ${dkimAuth} AND NOT ${spfAuth}
             THEN ${vol} ELSE 0 END) AS failed_volume,
    SUM(CASE WHEN NOT ${aligned} AND ${benign} THEN ${vol} ELSE 0 END) AS benign_relay_volume,
    SUM(CASE WHEN NOT ${aligned} AND NOT ${benign} THEN ${vol} ELSE 0 END) AS actionable_failure_volume,
    SUM(CASE WHEN NOT ${aligned} AND ${reason} = '' THEN ${vol} ELSE 0 END) AS reason_none_volume,
    SUM(CASE WHEN NOT ${aligned} AND ${reason} <> ''
             AND ${reason} NOT IN (${REASON_SQL_KEYS.map((r) => `'${r}'`).join(', ')})
             THEN ${vol} ELSE 0 END) AS reason_other_volume,
    ${reasonColumns}
  `;
}

/**
 * The columns `taxonomySql` emits, in order. Kept beside it so the re-sum below
 * can never drift out of step with the aggregate itself.
 */
export const TAXONOMY_COLUMNS: string[] = [
  'total_volume',
  'compliant_volume',
  'fully_aligned_volume',
  'dkim_aligned_volume',
  'spf_aligned_volume',
  'authenticated_unaligned_volume',
  'dkim_authenticated_volume',
  'spf_authenticated_volume',
  'failed_volume',
  'benign_relay_volume',
  'actionable_failure_volume',
  'reason_none_volume',
  'reason_other_volume',
  ...REASON_SQL_KEYS.map((key) => `reason_${key}_volume`),
];

/**
 * Roll an already-grouped taxonomy result up to a coarser grouping.
 *
 * Every column is a plain SUM of volumes, so partial aggregates compose: the
 * totals for a domain are the totals of its (domain, source) pairs. This lets a
 * query group once at a fine grain — which is what makes distinct counts cheap —
 * and then fold up, instead of paying for COUNT(DISTINCT) over the raw records.
 */
export function taxonomyResum(alias: string): string {
  return TAXONOMY_COLUMNS.map((column) => `SUM(${alias}.${column}) AS ${column}`).join(',\n    ');
}

// ── Rollup persistence ──────────────────────────────────────────────────────
// A rollup table stores exactly TAXONOMY_COLUMNS at some grain. The DDL, the
// insert column list, the ON CONFLICT accumulation, and the TypeScript ⇄ column
// mapping below are all derived from TAXONOMY_COLUMNS so a new reason bucket (or
// any other taxonomy column) can never land in one place and be forgotten in
// another. `dmarc-taxonomy.test.ts` asserts the round-trip.

/**
 * Column definitions for a rollup table storing the taxonomy. Every volume is
 * BIGINT: an INTEGER SUM overflows at fleet volume (2^31 ≈ 2.1B messages).
 */
export function rollupTaxonomyColumnDdl(): string {
  return TAXONOMY_COLUMNS.map((column) => `${column} BIGINT NOT NULL DEFAULT 0`).join(',\n    ');
}

/**
 * Map a breakdown to its column values in TAXONOMY_COLUMNS order — the inverse of
 * `breakdownFromSqlRow`, for writing a computed breakdown into a rollup row.
 * Values may be negative (incremental maintenance writes deltas).
 */
export function breakdownToColumnValues(breakdown: TaxonomyBreakdown): number[] {
  const byColumn: Record<string, number> = {
    total_volume: breakdown.totalVolume,
    compliant_volume: breakdown.compliantVolume,
    fully_aligned_volume: breakdown.fullyAlignedVolume,
    dkim_aligned_volume: breakdown.dkimAlignedVolume,
    spf_aligned_volume: breakdown.spfAlignedVolume,
    authenticated_unaligned_volume: breakdown.authenticatedUnalignedVolume,
    dkim_authenticated_volume: breakdown.dkimAuthenticatedVolume,
    spf_authenticated_volume: breakdown.spfAuthenticatedVolume,
    failed_volume: breakdown.failedVolume,
    benign_relay_volume: breakdown.benignRelayVolume,
    actionable_failure_volume: breakdown.actionableFailureVolume,
    reason_none_volume: breakdown.byReason.none,
    reason_other_volume: breakdown.byReason.other,
    reason_forwarded_volume: breakdown.byReason.forwarded,
    reason_trusted_forwarder_volume: breakdown.byReason.trusted_forwarder,
    reason_mailing_list_volume: breakdown.byReason.mailing_list,
    reason_sampled_out_volume: breakdown.byReason.sampled_out,
    reason_local_policy_volume: breakdown.byReason.local_policy,
  };
  return TAXONOMY_COLUMNS.map((column) => {
    const value = byColumn[column];
    if (value === undefined) {
      throw new Error(`breakdownToColumnValues: no mapping for rollup column "${column}"`);
    }
    return value;
  });
}

export interface TaxonomySqlRow {
  total_volume: string | number | null;
  compliant_volume: string | number | null;
  fully_aligned_volume: string | number | null;
  dkim_aligned_volume: string | number | null;
  spf_aligned_volume: string | number | null;
  authenticated_unaligned_volume: string | number | null;
  dkim_authenticated_volume: string | number | null;
  spf_authenticated_volume: string | number | null;
  failed_volume: string | number | null;
  benign_relay_volume: string | number | null;
  actionable_failure_volume: string | number | null;
  reason_forwarded_volume?: string | number | null;
  reason_trusted_forwarder_volume?: string | number | null;
  reason_mailing_list_volume?: string | number | null;
  reason_sampled_out_volume?: string | number | null;
  reason_local_policy_volume?: string | number | null;
  reason_other_volume?: string | number | null;
  reason_none_volume?: string | number | null;
}

const num = (value: string | number | null | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function breakdownFromSqlRow(row: TaxonomySqlRow | undefined): TaxonomyBreakdown {
  const breakdown = emptyBreakdown();
  addSqlBreakdown(breakdown, row);
  return breakdown;
}

/** Accumulate without allocating a temporary breakdown for every source row. */
export function addSqlBreakdown(breakdown: TaxonomyBreakdown, row: TaxonomySqlRow | undefined): void {
  if (!row) return;
  breakdown.totalVolume += num(row.total_volume);
  breakdown.compliantVolume += num(row.compliant_volume);
  breakdown.fullyAlignedVolume += num(row.fully_aligned_volume);
  breakdown.dkimAlignedVolume += num(row.dkim_aligned_volume);
  breakdown.spfAlignedVolume += num(row.spf_aligned_volume);
  breakdown.authenticatedUnalignedVolume += num(row.authenticated_unaligned_volume);
  breakdown.dkimAuthenticatedVolume += num(row.dkim_authenticated_volume);
  breakdown.spfAuthenticatedVolume += num(row.spf_authenticated_volume);
  breakdown.failedVolume += num(row.failed_volume);
  breakdown.benignRelayVolume += num(row.benign_relay_volume);
  breakdown.actionableFailureVolume += num(row.actionable_failure_volume);
  breakdown.byReason.forwarded += num(row.reason_forwarded_volume);
  breakdown.byReason.trusted_forwarder += num(row.reason_trusted_forwarder_volume);
  breakdown.byReason.mailing_list += num(row.reason_mailing_list_volume);
  breakdown.byReason.sampled_out += num(row.reason_sampled_out_volume);
  breakdown.byReason.local_policy += num(row.reason_local_policy_volume);
  breakdown.byReason.other += num(row.reason_other_volume);
  breakdown.byReason.none += num(row.reason_none_volume);
}

/**
 * Compliance rate as every DMARC product defines it: aligned-pass volume over
 * total reported volume. A domain with no mail is not "0% compliant" — there is
 * nothing to judge — so it reports as 1 and callers use `totalVolume` to decide
 * whether to show a figure at all.
 */
export function complianceRate(breakdown: TaxonomyBreakdown): number {
  return breakdown.totalVolume > 0 ? breakdown.compliantVolume / breakdown.totalVolume : 1;
}
