/**
 * Shared AFRF / forensic parsing helpers.
 *
 * The reporting routes and intelligence pipeline both need the same answer to
 * "what domain/message/auth result did this report actually describe?".
 * Keeping the parser in one place prevents the UI and the detectors from
 * disagreeing about the same forensic evidence.
 */

export interface ParsedAuthResult {
  axis: 'spf' | 'dkim' | 'dmarc' | 'arc' | string;
  result: string;
  detail?: string;
}

export interface ParsedHeaders {
  fromDomain: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  sourceIp: string | null;
  authResults: ParsedAuthResult[];
  dkimSignature: { domain: string; selector: string } | null;
}

export interface ForensicInterpretation {
  severity: 'info' | 'warn' | 'urgent';
  verdict: string;
  recommendation: string;
}

export interface ForensicNormalizationInput {
  originalHeaders?: string | null;
  originalMailFrom?: string | null;
  originalRcptTo?: string | null;
  sourceIp?: string | null;
  reportedDomain?: string | null;
  authFailure?: string | null;
  authenticationResults?: string | null;
  dkimDomain?: string | null;
  dkimSelector?: string | null;
  subject?: string | null;
}

export interface NormalizedForensicReport {
  domain: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  sourceIp: string | null;
  authResults: ParsedAuthResult[];
  dkimSignature: { domain: string; selector: string } | null;
  primaryFailure: string;
  interpretation: ForensicInterpretation;
}

const KNOWN_FORWARDER_HOST_RE =
  /(google\.com|googlemail\.com|outlook\.com|protection\.outlook\.com|yahoo\.com|amazonses\.com|sendgrid\.net|mailgun\.org)$/i;

function parseAuthHeaderValues(values: string[]): ParsedAuthResult[] {
  const authResults: ParsedAuthResult[] = [];

  for (const value of values) {
    const segments = value.split(';').slice(1).map((segment) => segment.trim()).filter(Boolean);
    for (const segment of segments) {
      const match = segment.match(/^(spf|dkim|dmarc|arc|iprev|auth)\s*=\s*([a-z0-9_-]+)(?:\s+(.*))?$/i);
      if (!match) continue;

      authResults.push({
        axis: match[1].toLowerCase(),
        result: match[2].toLowerCase(),
        detail: match[3]?.trim(),
      });
    }
  }

  return authResults;
}

function getLatestAuthResult(
  authResults: ParsedAuthResult[],
  axis: string
): ParsedAuthResult | undefined {
  return [...authResults].reverse().find((result) => result.axis === axis);
}

export function extractAddress(headerValue: string): string | null {
  const angle = headerValue.match(/<([^>]+@[^>]+)>/);
  if (angle) return angle[1].trim();

  const bare = headerValue.match(/([^\s<>"]+@[^\s<>"]+)/);
  return bare ? bare[1].trim() : null;
}

export function extractDomainFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;

  const at = address.lastIndexOf('@');
  if (at < 0) return null;

  const domain = address.slice(at + 1).toLowerCase().replace(/[>;,\s]+$/, '');
  return domain || null;
}

/**
 * Parse the embedded original-message headers carried inside the AFRF report.
 * The raw block is typically folded, so continuation lines are unfolded first.
 */
export function parseRawHeaders(raw: string): ParsedHeaders {
  if (!raw) {
    return {
      fromDomain: null,
      fromAddress: null,
      toAddress: null,
      subject: null,
      sourceIp: null,
      authResults: [],
      dkimSignature: null,
    };
  }

  const unfolded: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }

  const headerLine = (name: string): string | null => {
    const re = new RegExp(`^${name}:\\s*(.*)$`, 'i');
    for (const line of unfolded) {
      const match = line.match(re);
      if (match) return match[1].trim();
    }
    return null;
  };

  const allHeaderLines = (name: string): string[] => {
    const re = new RegExp(`^${name}:\\s*(.*)$`, 'i');
    return unfolded
      .map((line) => line.match(re))
      .filter((match): match is RegExpMatchArray => !!match)
      .map((match) => match[1].trim());
  };

  const from = headerLine('From');
  const fromAddress = from ? extractAddress(from) : null;
  const fromDomain = extractDomainFromAddress(fromAddress);
  const to = headerLine('To');
  const toAddress = to ? extractAddress(to) : null;
  const subject = headerLine('Subject');

  const authResults = parseAuthHeaderValues([
    ...allHeaderLines('Authentication-Results'),
    ...allHeaderLines('ARC-Authentication-Results'),
  ]);

  const dkimSig = headerLine('DKIM-Signature');
  let dkimSignature: ParsedHeaders['dkimSignature'] = null;
  if (dkimSig) {
    const dMatch = dkimSig.match(/[\s;]d\s*=\s*([^;\s]+)/i);
    const sMatch = dkimSig.match(/[\s;]s\s*=\s*([^;\s]+)/i);
    if (dMatch) {
      dkimSignature = {
        domain: dMatch[1],
        selector: sMatch ? sMatch[1] : '',
      };
    }
  }

  let sourceIp: string | null = null;
  const receivedSpf = headerLine('Received-SPF');
  if (receivedSpf) {
    const match = receivedSpf.match(/client-ip\s*=\s*([^\s;)]+)/i);
    if (match) sourceIp = match[1];
  }

  if (!sourceIp) {
    for (const received of allHeaderLines('Received')) {
      const match = received.match(/\[((?:\d+\.){3}\d+|[\da-f:]+)\]/i);
      if (match) {
        sourceIp = match[1];
        break;
      }
    }
  }

  return { fromDomain, fromAddress, toAddress, subject, sourceIp, authResults, dkimSignature };
}

export function classifyForensicReport(input: {
  sourceIp: string | null;
  sourceRdns?: string | null;
  fromDomain: string | null;
  authResults: ParsedAuthResult[];
  reporterAuthFailure: string | null;
}): ForensicInterpretation {
  const { sourceIp, sourceRdns, authResults, reporterAuthFailure } = input;

  const dmarc = getLatestAuthResult(authResults, 'dmarc');
  const spf = getLatestAuthResult(authResults, 'spf');
  const dkim = getLatestAuthResult(authResults, 'dkim');

  const dmarcPass = dmarc?.result === 'pass';
  const spfPass = spf?.result === 'pass';
  const dkimPass = dkim?.result === 'pass';
  const isKnownForwarder = !!(sourceRdns && KNOWN_FORWARDER_HOST_RE.test(sourceRdns));

  if (dmarcPass) {
    return {
      severity: 'info',
      verdict: 'DMARC passed at the embedded receiver. This is receiver policy noise, not an operator action item.',
      recommendation: "No action. If these reports are noisy, reduce DMARC forensic scope (for example fo=d or fo=0).",
    };
  }

  if (!spfPass && dkimPass) {
    return {
      severity: 'info',
      verdict: 'SPF failed but DKIM passed. This matches a normal forwarding pattern.',
      recommendation: 'No action. DKIM preserved the message authentication through the forwarder.',
    };
  }

  if (!dkimPass && isKnownForwarder) {
    return {
      severity: 'info',
      verdict: 'DKIM failed after a known forwarder or mailing-list hop.',
      recommendation: 'Usually no action on your side. If this matters operationally, review ARC support on the downstream receiver.',
    };
  }

  if (!spfPass && !dkimPass) {
    return {
      severity: 'urgent',
      verdict: 'Both SPF and DKIM failed at the embedded receiver.',
      recommendation: `Investigate ${sourceIp ?? 'the source IP'} as either an unauthorized sender or an impersonation attempt.`,
    };
  }

  if (reporterAuthFailure) {
    return {
      severity: reporterAuthFailure === 'dmarc' ? 'warn' : 'info',
      verdict: `Reporter labelled this as ${reporterAuthFailure}, but the embedded evidence is incomplete.`,
      recommendation: 'Review the embedded headers before changing policy.',
    };
  }

  return {
    severity: 'warn',
    verdict: 'Mixed or incomplete signals in the forensic report.',
    recommendation: 'Inspect the embedded headers for the exact receiver verdict before acting.',
  };
}

export function determinePrimaryFailure(
  authResults: ParsedAuthResult[],
  reporterAuthFailure: string | null | undefined
): string {
  const dmarc = getLatestAuthResult(authResults, 'dmarc');
  const spf = getLatestAuthResult(authResults, 'spf');
  const dkim = getLatestAuthResult(authResults, 'dkim');

  if (dmarc?.result === 'fail') return 'dmarc';
  if (spf?.result === 'fail' && dkim?.result === 'fail') return 'multi';
  if (dkim?.result === 'fail') return 'dkim';
  if (spf?.result === 'fail') return 'spf';
  if (reporterAuthFailure) return reporterAuthFailure.toLowerCase();
  return 'unknown';
}

export function normalizeForensicReport(input: ForensicNormalizationInput): NormalizedForensicReport {
  const parsedHeaders = parseRawHeaders(input.originalHeaders ?? '');
  const authResults =
    parsedHeaders.authResults.length > 0
      ? parsedHeaders.authResults
      : parseAuthHeaderValues(input.authenticationResults ? [input.authenticationResults] : []);

  const domain =
    parsedHeaders.fromDomain ??
    extractDomainFromAddress(input.originalMailFrom) ??
    input.reportedDomain?.toLowerCase() ??
    input.dkimDomain?.toLowerCase() ??
    null;

  const sourceIp = input.sourceIp ?? parsedHeaders.sourceIp ?? null;
  const interpretation = classifyForensicReport({
    sourceIp,
    fromDomain: domain,
    authResults,
    reporterAuthFailure: input.authFailure ?? null,
  });

  return {
    domain,
    fromAddress: parsedHeaders.fromAddress ?? input.originalMailFrom ?? null,
    toAddress: parsedHeaders.toAddress ?? input.originalRcptTo ?? null,
    subject: parsedHeaders.subject ?? input.subject ?? null,
    sourceIp,
    authResults,
    dkimSignature: parsedHeaders.dkimSignature ?? (
      input.dkimDomain
        ? { domain: input.dkimDomain, selector: input.dkimSelector ?? '' }
        : null
    ),
    primaryFailure: determinePrimaryFailure(authResults, input.authFailure),
    interpretation,
  };
}
