import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

function Form() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {/* An inline onClose changes on every render, as most callers pass it. */}
      <Modal isOpen={open} onClose={() => setOpen(false)} title="Edit location">
        <input aria-label="Location" value={value} onChange={(event) => setValue(event.target.value)} />
      </Modal>
    </>
  );
}

describe('Modal', () => {
  afterEach(cleanup);

  it('keeps focus in a field while typing re-renders the caller', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    render(<Form />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    await act(async () => { vi.runAllTimers(); });

    const input = screen.getByRole('textbox', { name: 'Location' });
    input.focus();
    for (const value of ['S', 'St', 'St.']) {
      fireEvent.change(input, { target: { value } });
      await act(async () => { vi.runAllTimers(); });
      expect(document.activeElement).toBe(input);
    }
    expect(input).toHaveValue('St.');
    vi.useRealTimers();
  });

  it('closes on Escape with the latest onClose and returns focus to the opener', async () => {
    render(<Form />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });
});
