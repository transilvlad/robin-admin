/**
 * Email provider (ESP) catalogue.
 *
 * Sender classification on its own answers "is this authorized?" but not
 * "who is this?". An issue that says `149.72.x.x is an unknown sender` is
 * unactionable; one that says `149.72.x.x — SendGrid` tells the operator
 * exactly which vendor account to go fix. Every mature DMARC product
 * treats this identification step as table stakes.
 *
 * This is a deliberately curated, deliberately incomplete lookup. It is
 * not a substitute for a full ASN database — it covers the providers that
 * actually show up in aggregate reports, and returns null for everything
 * else so the "Unknown" triage bucket stays honest.
 *
 * Two signals are consulted, cheapest first:
 *   1. rDNS/PTR hostname suffix — the strongest and most maintainable
 *      signal, since providers name their outbound MTAs consistently.
 *   2. Published IP ranges — for providers whose PTR records are absent
 *      or generic.
 *
 * Adding a provider: append to PROVIDER_RULES. Keep entries alphabetical
 * within their category and prefer host suffixes over IP ranges, since
 * ranges go stale and hostnames rarely do.
 */

import ipaddrLib from 'ipaddr.js';

export interface ProviderRule {
  /** Display name shown in the UI badge. */
  name: string;
  /** Broad category, used for grouping and for remediation wording. */
  category: 'mailbox' | 'esp' | 'security' | 'crm' | 'infrastructure';
  /** rDNS suffixes that identify this provider (matched case-insensitively). */
  hostSuffixes?: string[];
  /** CIDR ranges published by the provider. */
  cidrs?: string[];
  /** Documentation the operator can follow to fix auth for this provider. */
  authDocsUrl?: string;
}

export const PROVIDER_RULES: ProviderRule[] = [
  {
    name: 'Amazon SES',
    category: 'esp',
    hostSuffixes: ['.amazonses.com', '.smtp-out.amazonses.com'],
    authDocsUrl: 'https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim.html',
  },
  {
    name: 'Amazon Web Services',
    category: 'infrastructure',
    hostSuffixes: ['.compute.amazonaws.com', '.amazonaws.com'],
  },
  {
    name: 'Barracuda',
    category: 'security',
    hostSuffixes: ['.barracudanetworks.com', '.barracuda.com', '.ess.barracudanetworks.com'],
  },
  {
    name: 'Brevo',
    category: 'esp',
    hostSuffixes: ['.sendinblue.com', '.brevo.com'],
  },
  {
    name: 'Cloudflare',
    category: 'infrastructure',
    hostSuffixes: ['.cloudflare.com', '.mx.cloudflare.net'],
  },
  {
    name: 'Fastmail',
    category: 'mailbox',
    hostSuffixes: ['.messagingengine.com', '.fastmail.com'],
  },
  {
    name: 'Google Workspace',
    category: 'mailbox',
    hostSuffixes: [
      '.google.com',
      '.googlemail.com',
      '.gmail.com',
      '.mail-.google.com',
      '.bounces.google.com',
      // Google's own infrastructure PTRs land on 1e100.net, not google.com.
      // Without this, Google mail forwarded via Workspace shows up as an
      // unidentified "1e100.net" source rather than as Google.
      '.1e100.net',
    ],
    authDocsUrl: 'https://support.google.com/a/answer/174124',
  },
  {
    name: 'HubSpot',
    category: 'crm',
    hostSuffixes: ['.hubspot.com', '.hubspotemail.net'],
  },
  {
    name: 'Klaviyo',
    category: 'esp',
    hostSuffixes: ['.klaviyo.com', '.klaviyomail.com'],
  },
  {
    name: 'Mailchimp',
    category: 'esp',
    hostSuffixes: ['.mcsv.net', '.mcdlv.net', '.rsgsv.net', '.mailchimp.com'],
  },
  {
    name: 'Mailgun',
    category: 'esp',
    hostSuffixes: ['.mailgun.net', '.mailgun.org', '.mailgun.com'],
    authDocsUrl: 'https://help.mailgun.com/hc/en-us/articles/360026833053',
  },
  {
    name: 'Mailjet',
    category: 'esp',
    hostSuffixes: ['.mailjet.com', '.mjt.lu'],
  },
  {
    name: 'Mandrill',
    category: 'esp',
    hostSuffixes: ['.mandrillapp.com', '.mandrill.com'],
  },
  {
    name: 'Microsoft 365',
    category: 'mailbox',
    hostSuffixes: [
      '.outbound.protection.outlook.com',
      '.protection.outlook.com',
      '.outlook.com',
      '.hotmail.com',
      '.microsoft.com',
    ],
    authDocsUrl: 'https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure',
  },
  {
    name: 'Mimecast',
    category: 'security',
    hostSuffixes: ['.mimecast.com', '.mimecast.co.za', '.mimecast-offshore.com'],
  },
  {
    name: 'Postmark',
    category: 'esp',
    hostSuffixes: ['.mtasv.net', '.postmarkapp.com'],
    authDocsUrl: 'https://postmarkapp.com/support/article/1063-how-do-i-verify-a-domain',
  },
  {
    name: 'Proofpoint',
    category: 'security',
    hostSuffixes: ['.pphosted.com', '.proofpoint.com', '.ppe-hosted.com'],
  },
  {
    name: 'Salesforce',
    category: 'crm',
    hostSuffixes: ['.salesforce.com', '.exacttarget.com', '.et.salesforce.com'],
  },
  {
    name: 'SendGrid',
    category: 'esp',
    hostSuffixes: ['.sendgrid.net', '.sendgrid.com'],
    authDocsUrl: 'https://www.twilio.com/docs/sendgrid/ui/account-and-settings/how-to-set-up-domain-authentication',
  },
  {
    name: 'SparkPost',
    category: 'esp',
    hostSuffixes: ['.sparkpostmail.com', '.sparkpost.com'],
  },
  {
    name: 'Zendesk',
    category: 'crm',
    hostSuffixes: ['.zendesk.com', '.zdsys.com'],
  },
  {
    name: 'Zoho',
    category: 'mailbox',
    hostSuffixes: ['.zoho.com', '.zohomail.com', '.zoho.eu'],
  },
];

export interface ProviderMatch {
  name: string;
  category: ProviderRule['category'];
  authDocsUrl?: string;
  /** Which signal produced the match — useful when explaining a badge. */
  via: 'rdns' | 'cidr';
}

interface ParsedRule {
  rule: ProviderRule;
  ranges: Array<[ipaddrLib.IPv4 | ipaddrLib.IPv6, number]>;
}

let parsedRules: ParsedRule[] | null = null;

function getParsedRules(): ParsedRule[] {
  if (parsedRules) return parsedRules;
  parsedRules = PROVIDER_RULES.map((rule) => {
    const ranges: Array<[ipaddrLib.IPv4 | ipaddrLib.IPv6, number]> = [];
    for (const cidr of rule.cidrs ?? []) {
      try {
        ranges.push(ipaddrLib.parseCIDR(cidr));
      } catch {
        // A malformed entry must never break enrichment for every sender.
      }
    }
    return { rule, ranges };
  });
  return parsedRules;
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Identify the provider behind a sending source.
 *
 * `host` should be the FCrDNS-verified hostname where available, falling
 * back to the bare PTR. A bare PTR is attacker-controlled, so a CIDR match
 * takes precedence when the two disagree.
 */
export function lookupProvider(
  host: string | null | undefined,
  ip?: string | null
): ProviderMatch | null {
  if (ip) {
    const cidrMatch = matchByCidr(ip);
    if (cidrMatch) return cidrMatch;
  }
  if (host) {
    const hostMatch = matchByHost(host);
    if (hostMatch) return hostMatch;
  }
  return null;
}

function matchByHost(host: string): ProviderMatch | null {
  const normalized = normalizeHost(host);
  if (!normalized) return null;

  let best: { rule: ProviderRule; suffixLength: number } | null = null;
  for (const rule of PROVIDER_RULES) {
    for (const suffix of rule.hostSuffixes ?? []) {
      const needle = suffix.toLowerCase();
      const matches =
        normalized.endsWith(needle) || normalized === needle.replace(/^\./, '');
      // Longest suffix wins so ".outbound.protection.outlook.com" beats
      // ".outlook.com" and ".amazonses.com" beats ".amazonaws.com".
      if (matches && (!best || needle.length > best.suffixLength)) {
        best = { rule, suffixLength: needle.length };
      }
    }
  }

  if (!best) return null;
  return {
    name: best.rule.name,
    category: best.rule.category,
    authDocsUrl: best.rule.authDocsUrl,
    via: 'rdns',
  };
}

function matchByCidr(ip: string): ProviderMatch | null {
  let addr: ipaddrLib.IPv4 | ipaddrLib.IPv6;
  try {
    addr = ipaddrLib.parse(ip);
  } catch {
    return null;
  }

  for (const { rule, ranges } of getParsedRules()) {
    for (const range of ranges) {
      try {
        if (addr.kind() === range[0].kind() && addr.match(range)) {
          return {
            name: rule.name,
            category: rule.category,
            authDocsUrl: rule.authDocsUrl,
            via: 'cidr',
          };
        }
      } catch {
        // Kind mismatch or malformed range — skip.
      }
    }
  }
  return null;
}

/** Documentation link for a provider name, if the catalogue has one. */
export function providerAuthDocs(name: string | null | undefined): string | null {
  if (!name) return null;
  return PROVIDER_RULES.find((rule) => rule.name === name)?.authDocsUrl ?? null;
}
