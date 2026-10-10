import { describe, expect, it } from 'vitest';
import { cfgStr } from './managed-config-file.js';

describe('cfgStr', () => {
  it('keeps a value on one line so it cannot inject directives', () => {
    expect(cfgStr('256M\nservice imap {\n  executable = /bin/sh\n}', '')).toBe('256M service imap {   executable = /bin/sh }');
    expect(cfgStr('%Y" \r\nmailbox_command = /bin/sh', '')).toBe('%Y   mailbox_command = /bin/sh');
  });

  it('falls back for non-strings', () => {
    expect(cfgStr(42, 'default')).toBe('default');
  });
});
