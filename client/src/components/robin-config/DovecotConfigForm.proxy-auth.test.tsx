import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DovecotConfigForm } from './DovecotConfigForm';
const onChange = vi.fn();
const input = (label: string) => screen.getByText(label).closest('.space-y-1')?.querySelector('input') ?? screen.getByText(label).parentElement!.parentElement!.querySelector('input')!;
beforeEach(() => { cleanup(); vi.clearAllMocks(); });
describe('Robin mail proxy authentication', () => {
  it('uses the backend defaults: disabled, empty backends and a three-second failure wait', () => {
    render(<DovecotConfigForm config={{}} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Mail proxy authentication/ }));
    expect(input('IMAP backend')).toHaveValue('');
    expect(input('POP3 backend')).toHaveValue('');
    expect(input('Failure wait (seconds)')).toHaveValue(3);
    fireEvent.click(screen.getByText('Proxy authentication enabled').parentElement!.parentElement!.querySelector('button')!);
    expect(onChange).toHaveBeenLastCalledWith({ proxyAuth: { enabled: true } });
  });
  it('preserves sibling settings while editing backend strings and seconds', () => {
    render(<DovecotConfigForm config={{ proxyAuth: { enabled: true, imap: 'mailbox:143', pop3: '', failureWait: 3 } }} onChange={onChange} />);
    fireEvent.change(input('IMAP backend'), { target: { value: 'backend:143' } });
    expect(onChange).toHaveBeenLastCalledWith({ proxyAuth: { enabled: true, imap: 'backend:143', pop3: '', failureWait: 3 } });
    fireEvent.change(input('Failure wait (seconds)'), { target: { value: '5' } });
    expect(onChange).toHaveBeenLastCalledWith({ proxyAuth: { enabled: true, imap: 'mailbox:143', pop3: '', failureWait: 5 } });
  });
});
