import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckEditor, checkPayload, editCheckForm, emptyCheckForm } from './CheckEditor';
import type { MonitoringCheck } from '../../types/monitoring';
afterEach(cleanup);
describe('monitoring check editor', () => {
  it('builds canonical HTTP settings and typed numeric JSON assertions', () => {
    const form = emptyCheckForm(1);
    form.assertions = [{ kind: 'json', operator: 'gte', name: '', pointer: '/count', value: '3', valueType: 'number' }];
    const payload = checkPayload(form);
    expect(payload.options.http?.expectedStatuses).toHaveLength(100);
    expect(payload.options.http?.assertions).toEqual([{ kind: 'json', operator: 'gte', pointer: '/count', value: 3 }]);
    form.assertions[0].value = '';
    expect(() => checkPayload(form)).toThrow('finite number');
  });
  it('preserves stored credentials without exposing their value and deletes removed headers', () => {
    const form = editCheckForm({ ...emptyCheckForm(1), id: 7, port: null, certExpiryDays: null, options: {}, secretHeaderNames: ['authorization', 'x-api-key'] } as unknown as MonitoringCheck);
    expect(form.headers.every(header => header.value === '')).toBe(true);
    expect(checkPayload(form).secretHeaders).toEqual({});
    form.headers = form.headers.slice(0, 1);
    expect(checkPayload(form).secretHeaders).toEqual({ 'x-api-key': null });
    form.headers[0].value = 'Bearer replacement';
    expect(checkPayload(form).secretHeaders).toEqual({ authorization: 'Bearer replacement', 'x-api-key': null });
    form.checkType = 'tcp';
    expect(checkPayload(form).secretHeaders).toEqual({ authorization: null, 'x-api-key': null });
  });
  it('omits stale TLS fields when editing plaintext checks', () => {
    const form = emptyCheckForm(1);
    form.endpoint = 'http://example.test';
    form.certExpiryDays = '14';
    form.tlsMode = 'allow_self_signed';
    expect(checkPayload(form)).not.toHaveProperty('tlsMode');
    expect(checkPayload(form)).not.toHaveProperty('certExpiryDays');
  });
  it('saves certificate policy and enables IMAP STARTTLS on port 143', () => {
    const form = emptyCheckForm(1);
    form.endpoint = 'https://example.test';
    form.certificateErrorMode = 'warning';
    expect(checkPayload(form)).toMatchObject({ certificateErrorMode: 'warning' });
    form.checkType = 'imap'; form.port = '143'; form.endpoint = 'mail.example.test';
    form.startTls = true;
    expect(checkPayload(form)).toMatchObject({ options: { imap: { startTls: true } }, certificateErrorMode: 'warning' });
    render(<CheckEditor form={form} targets={[]} setForm={vi.fn()} onSave={async () => {}} working={false} />);
    expect(screen.getByLabelText('Use STARTTLS')).toBeChecked();
  });
  it('offers all protocols and resets incompatible options when changing type', () => {
    const setForm = vi.fn();
    render(<CheckEditor form={emptyCheckForm(1)} targets={[]} setForm={setForm} onSave={async () => {}} working={false} />);
    const protocol = screen.getByLabelText('Protocol');
    expect(protocol.querySelectorAll('option')).toHaveLength(6);
    fireEvent.change(protocol, { target: { value: 'tcp' } });
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ checkType: 'tcp', headers: [], assertions: [], certExpiryDays: '', tlsMode: 'strict' }));
  });
  it('switches to a push check with push defaults and hides probe-only settings', () => {
    const setForm = vi.fn();
    render(<CheckEditor form={emptyCheckForm(1)} targets={[]} setForm={setForm} onSave={async () => {}} working={false} />);
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'push' } });
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ checkType: 'push', endpoint: 'push', intervalSeconds: 3600, confirmationSeconds: 300 }));
    cleanup();
    const form = { ...emptyCheckForm(1), checkType: 'push' as const, endpoint: 'push', intervalSeconds: 3600 };
    render(<CheckEditor form={form} targets={[]} setForm={vi.fn()} onSave={async () => {}} working={false} />);
    expect(screen.getByLabelText('Expected every (seconds)')).toHaveValue(3600);
    expect(screen.getByLabelText('Grace before an issue (seconds)')).toBeTruthy();
    expect(screen.queryByLabelText('Endpoint')).toBeNull();
    expect(screen.queryByLabelText('Timeout (seconds)')).toBeNull();
    expect(screen.queryByText('Probe locations')).toBeNull();
    expect(screen.getByText(/ping URL is created when the check is saved/)).toBeTruthy();
  });
  it('keeps credential values masked and renders bounded typed assertion controls', () => {
    const form = emptyCheckForm(1); form.headers = [{ name: 'authorization', value: '', secret: true }];
    form.assertions = [{ kind: 'json', operator: 'equals', name: '', pointer: '/ready', value: 'true', valueType: 'boolean' }];
    render(<CheckEditor form={form} targets={[]} setForm={vi.fn()} onSave={async () => {}} working={false} />);
    expect(screen.getByLabelText('Header 1 value').getAttribute('type')).toBe('password');
    expect(screen.getByLabelText('Value type')).toBeTruthy();
    expect(screen.getByLabelText('JSON pointer')).toBeTruthy();
    expect(screen.getByLabelText('Allow private network targets')).toBeTruthy();
  });
});
