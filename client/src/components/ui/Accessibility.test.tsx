import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Activity } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveFilterChip } from './ActiveFilterChip';
import { Button } from './Button';
import { Input } from './Input';
import { MetricCard } from './MetricCard';
import { MetricTabs } from './MetricTabs';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { Table } from './Table';

describe('accessible UI primitives', () => {
  afterEach(cleanup);

  it('associates input errors with the input', () => {
    render(<Input label="Email" error="Email is required" />);
    const input = screen.getByLabelText('Email');
    const error = screen.getByRole('alert');

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', error.id);
  });

  it('labels dialogs and provides an accessible close button', () => {
    const onClose = vi.fn();
    render(<Modal isOpen onClose={onClose} title="Edit admin">Content</Modal>);

    expect(screen.getByRole('dialog', { name: 'Edit admin' })).toHaveAttribute('aria-modal', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('exposes accessible loading text and honors reduced motion', () => {
    render(<Spinner label="Loading metrics" />);

    const spinner = screen.getByRole('status', { name: 'Loading metrics' });
    expect(spinner.querySelector('svg')).toHaveClass('motion-reduce:animate-none');
    expect(spinner.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps decorative tab icons hidden from assistive technology', () => {
    render(
      <MetricTabs
        tabs={[{ id: 'overview', label: 'Overview', icon: Activity }]}
        activeTab="overview"
        onChange={() => undefined}
      />
    );

    const tab = screen.getByRole('button', { name: 'Overview' });
    expect(tab).toHaveClass('text-robin-orange');
    expect(tab.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('uses the shared accessible spinner for loading buttons', () => {
    render(<Button isLoading>Save</Button>);

    expect(screen.getByRole('status', { name: 'Loading action' })).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('gives filter clear icons an explicit accessible action name', () => {
    const onClear = vi.fn();
    render(<ActiveFilterChip label="Domain: example.com" onClear={onClear} />);

    const button = screen.getByRole('button', { name: 'Clear Domain: example.com filter' });
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(button);
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('keeps long metric values inside a responsive card', () => {
    render(
      <MetricCard
        icon={<Activity />}
        label="Cache hit ratio"
        value="12345678901234567890.12%"
      />
    );

    const value = screen.getByText('12345678901234567890.12%');
    expect(value).toHaveClass('min-w-0', 'wrap-break-word', 'tabular-nums', 'text-2xl');
    expect(value.parentElement).toHaveClass('min-w-0', 'flex-1');
  });

  it('makes horizontally scrollable tables keyboard focusable and labeled', () => {
    render(
      <Table
        columns={[{ key: 'name', header: 'Name' }]}
        data={[{ id: 1, name: 'PostgreSQL' }]}
        keyField="id"
        scrollLabel="PostgreSQL services table"
      />,
    );

    const scroller = screen.getByRole('region', { name: 'PostgreSQL services table' });
    expect(scroller).toHaveAttribute('tabindex', '0');
    expect(scroller).toHaveClass('table-container');
  });
});
