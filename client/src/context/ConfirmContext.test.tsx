import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfirmProvider, useConfirm } from './ConfirmContext';

afterEach(() => {
  cleanup();
});

function Harness() {
  const confirm = useConfirm();
  const [result, setResult] = useState('idle');

  return (
    <div>
      <div data-testid="result">{result}</div>
      <button
        type="button"
        onClick={async () => {
          const answer = await confirm('Delete this thing?');
          setResult(answer ? 'confirmed' : 'cancelled');
        }}
      >
        Ask
      </button>
    </div>
  );
}

describe('ConfirmContext', () => {
  it('resolves true when the user clicks Confirm', async () => {
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>,
    );

    fireEvent.click(screen.getByText('Ask'));
    expect(await screen.findByText('Delete this thing?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('confirmed'));
    expect(screen.queryByText('Delete this thing?')).not.toBeInTheDocument();
  });

  it('resolves false when the user clicks Cancel', async () => {
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>,
    );

    fireEvent.click(screen.getByText('Ask'));
    expect(await screen.findByText('Delete this thing?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('cancelled'));
    expect(screen.queryByText('Delete this thing?')).not.toBeInTheDocument();
  });

  it('resolves false when the dialog is dismissed via Escape', async () => {
    render(
      <ConfirmProvider>
        <Harness />
      </ConfirmProvider>,
    );

    fireEvent.click(screen.getByText('Ask'));
    expect(await screen.findByText('Delete this thing?')).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('cancelled'));
  });

  it('throws when useConfirm is used outside a ConfirmProvider', () => {
    const consoleError = console.error;
    console.error = () => {};
    function Bare() {
      useConfirm();
      return null;
    }
    expect(() => render(<Bare />)).toThrow('useConfirm must be used within a ConfirmProvider');
    console.error = consoleError;
  });
});
