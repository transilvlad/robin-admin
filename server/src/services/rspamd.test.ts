import { describe, expect, it } from 'vitest';
import { isAlreadyLearnedAs, summarizeRspamdReload } from './rspamd.js';

describe('isAlreadyLearnedAs', () => {
  const refusal = 'Rspamd learnham failed (404): {"error":"<a@example.test> has been already learned as ham, ignore it"}';

  it('treats a repeat learn with the same label as learned', () => {
    expect(isAlreadyLearnedAs('ham', refusal)).toBe(true);
  });

  it('keeps other refusals as failures', () => {
    expect(isAlreadyLearnedAs('spam', refusal)).toBe(false);
    expect(isAlreadyLearnedAs('ham', 'Rspamd learnham failed (500): {"error":"no statfiles"}')).toBe(false);
  });
});

describe('summarizeRspamdReload', () => {
  const worker = (id: number, type: string, status: number) => `    ${id} {\n        type = "${type}";\n        status = ${status};\n    }\n`;

  it('counts the workers that reloaded', () => {
    expect(summarizeRspamdReload(`workers {\n${worker(7, 'rspamd_proxy', 0)}${worker(9, 'normal', 0)}}\n`)).toBe('Reloaded 2 Rspamd workers');
  });

  it('names the workers that failed', () => {
    expect(summarizeRspamdReload(`workers {\n${worker(7, 'normal', 0)}${worker(8, 'controller', 1)}}\n`))
      .toBe('Reloaded 1 of 2 Rspamd workers; failed: controller');
  });
});
