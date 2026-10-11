import { describe, expect, it } from 'vitest';
import { normalizeRspamdRulesDocument, renderActionsFile, renderMultimapFile } from './rspamd-rules.js';

describe('renderMultimapFile', () => {
  it('names a local map by its absolute local.d path, where the agent writes it', () => {
    const document = normalizeRspamdRulesDocument({
      multimaps: [{ name: 'ALLOWED_SENDERS', ruleType: 'from', source: { type: 'local', localMapSlug: 'allowed-senders' } }],
    });

    expect(renderMultimapFile(document.multimaps)).toContain('  map = "$LOCAL_CONFDIR/local.d/maps/allowed-senders.map";');
  });
});

describe('renderActionsFile', () => {
  it('writes bare thresholds, since rspamd includes the file inside its actions block', () => {
    const document = normalizeRspamdRulesDocument({
      actions: [
        { name: 'reject', threshold: 15 },
        { name: 'rewrite_subject', threshold: 8, subject: '[SPAM] %s' },
      ],
    });

    const rendered = renderActionsFile(document.actions);

    expect(rendered).not.toMatch(/^actions \{/m);
    expect(rendered.split('\n')).toContain('reject = 15;');
    expect(rendered).toContain(['rewrite_subject {', '  threshold = 8;', '  subject = "[SPAM] %s";', '}'].join('\n'));
  });
});
