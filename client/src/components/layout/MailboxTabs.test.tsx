import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MailboxTabs } from './MailboxTabs';

afterEach(cleanup);

describe('MailboxTabs', () => {
  it('renders every mailbox section independently of backend readiness', () => {
    render(
      <MemoryRouter initialEntries={['/aliases']}>
        <MailboxTabs />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users');
    expect(screen.getByRole('link', { name: 'Aliases' })).toHaveAttribute('href', '/aliases');
    expect(screen.getByRole('link', { name: 'Auto aliases' })).toHaveAttribute('href', '/auto-aliases');
  });

  it('marks only the current section active', () => {
    render(
      <MemoryRouter initialEntries={['/users']}>
        <MailboxTabs />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Users' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Aliases' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Auto aliases' })).not.toHaveAttribute('aria-current');
  });
});
