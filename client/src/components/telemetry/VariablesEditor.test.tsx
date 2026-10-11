import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VariablesEditor } from './VariablesEditor';

const previewVariable = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({
  ApiError: class ApiError extends Error {},
  telemetryApi: { previewVariable },
}));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderEditor(onSave = vi.fn()) {
  render(
    <VariablesEditor
      variables={[{ name: 'role', label: 'Role', source: 'role', multi: true }]}
      start={100}
      end={200}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  return onSave;
}

describe('VariablesEditor', () => {
  it('adds a variable that depends on an earlier one and saves tidy definitions', async () => {
    const onSave = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    const names = screen.getAllByLabelText('Name');
    fireEvent.change(names[1], { target: { value: 'host' } });
    fireEvent.change(screen.getAllByLabelText('Label')[1], { target: { value: '  ' } });
    fireEvent.change(screen.getAllByLabelText('Only series matching (optional)')[1], { target: { value: ' host_uptime{role=~"$role"} ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onSave).toHaveBeenCalledWith([
      { name: 'role', label: 'Role', source: 'role', multi: true },
      { name: 'host', label: 'host', source: 'host', match: 'host_uptime{role=~"$role"}' },
    ]);
  });

  it('blocks invalid or duplicate names', () => {
    const onSave = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    fireEvent.change(screen.getAllByLabelText('Name')[1], { target: { value: 'role' } });
    expect(screen.getByText('Name role is used twice.')).toBeInTheDocument();
    fireEvent.change(screen.getAllByLabelText('Name')[1], { target: { value: '__x' } });
    expect(screen.getByText(/not starting with a digit or __/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('previews the values a variable would offer', async () => {
    previewVariable.mockResolvedValue({ success: true, data: ['worker', 'service'] });
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Preview values' }));
    expect(await screen.findByText('2 value(s): worker, service')).toBeInTheDocument();
    await waitFor(() => expect(previewVariable).toHaveBeenCalledWith({
      variables: [{ name: 'role', label: 'Role', source: 'role', multi: true, match: undefined }],
      name: 'role',
      values: {},
      start: 100,
      end: 200,
    }));
  });
});
