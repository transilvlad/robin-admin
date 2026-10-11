import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { QueueConfigForm } from './QueueConfigForm';

describe('QueueConfigForm', () => {
  beforeEach(() => {
    cleanup();
  });

  it('keeps the MapDB backend collapsed when explicitly disabled', () => {
    render(
      <QueueConfigForm
        config={{ queueMapDB: { enabled: false } }}
        onChange={() => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: /MapDB Backend/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Queue file')).not.toBeInTheDocument();
  });

  it('expands the MapDB backend when enabled', () => {
    render(
      <QueueConfigForm
        config={{ queueMapDB: { enabled: true } }}
        onChange={() => undefined}
      />,
    );

    expect(screen.getByText('Queue file')).toBeInTheDocument();
    expect(screen.getByDisplayValue('/usr/local/robin/relayQueue.db')).toBeInTheDocument();
  });
});
