import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, it, expect } from 'vitest';
import { JsonConfigForm } from './JsonConfigForm';

afterEach(cleanup);

// Mirrors how RobinConfigPage wires the form: local config state fed back via
// onChange after every valid JSON edit.
function Harness({ initial }: { initial: Record<string, unknown> }) {
  const [config, setConfig] = useState<Record<string, unknown>>(initial);
  return <JsonConfigForm config={config} onChange={setConfig} />;
}

describe('JsonConfigForm', () => {
  it('keeps the user\'s exact text while typing (no reformat / caret jump)', () => {
    render(<Harness initial={{ a: 1 }} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.value).toBe('{\n  "a": 1\n}');

    // Valid JSON but deliberately not canonical formatting.
    const typed = '{ "a": 1, "b": 2 }';
    fireEvent.change(ta, { target: { value: typed } });

    // Even though the parent echoed the parsed config back, the textarea keeps
    // the user's text verbatim.
    expect(ta.value).toBe(typed);
  });

  it('reformats when the config changes externally (e.g. switching files)', () => {
    const { rerender } = render(<JsonConfigForm config={{ a: 1 }} onChange={() => {}} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.value).toBe('{\n  "a": 1\n}');

    rerender(<JsonConfigForm config={{ b: 9 }} onChange={() => {}} />);
    expect(ta.value).toBe('{\n  "b": 9\n}');
  });
});
