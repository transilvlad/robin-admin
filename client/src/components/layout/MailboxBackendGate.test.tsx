import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MailboxBackendGate } from './MailboxBackendGate';

const { state, refresh } = vi.hoisted(() => ({
  state: { features: { users: false, aliases: false, autoAliases: false }, isLoading: false },
  refresh: vi.fn(async () => undefined),
}));
vi.mock('../../context/FeaturesContext', () => ({ useFeatures: () => ({ ...state, refresh }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); state.features.users = false; });

describe('Mailbox backend readiness', () => {
  it.each(['users', 'aliases', 'autoAliases'] as const)('keeps all tabs visible with an unconfigured %s backend and does not mount the editor', section => {
    const editor = vi.fn(() => <p>Mailbox editor</p>);
    const Editor = editor;
    render(<MemoryRouter><MailboxBackendGate section={section}><Editor /></MailboxBackendGate></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Backend not configured' })).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(editor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('renders the editor only for a ready backend', () => {
    state.features.users = true;
    render(<MemoryRouter><MailboxBackendGate section="users"><p>Mailbox editor</p></MailboxBackendGate></MemoryRouter>);
    expect(screen.getByText('Mailbox editor')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Backend not configured' })).not.toBeInTheDocument();
  });
});
