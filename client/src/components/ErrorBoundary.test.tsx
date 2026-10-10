import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { recoverChunkLoad } from '../utils/chunkRecovery';

vi.mock('../utils/chunkRecovery', () => ({ recoverChunkLoad: vi.fn(() => false) }));

function BrokenComponent(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('renders a recovery screen for uncaught render errors', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    expect(recoverChunkLoad).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });
  it('hands an import failure to guarded recovery', () => {
    const error = new TypeError('Failed to fetch dynamically imported module');
    function StaleChunk(): never { throw error; }
    vi.mocked(recoverChunkLoad).mockReturnValueOnce(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><StaleChunk /></ErrorBoundary>);
    expect(recoverChunkLoad).toHaveBeenCalledWith(error);
  });
});
