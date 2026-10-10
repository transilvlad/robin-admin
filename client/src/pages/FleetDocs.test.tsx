import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FleetDocsPage } from './FleetDocs';

const { matrix } = vi.hoisted(() => ({ matrix: vi.fn() }));

vi.mock('../api/client', () => ({ fleetCapabilitiesApi: { matrix } }));

const works = { available: true };
const noFiles = { available: false, reason: 'An agent reaching the service over ssh cannot place config files' };
const setups = [
  { agent: 'none', reachable: true },
  { agent: 'container', reachable: false },
  { agent: 'ssh', reachable: false },
];
const postfix = [
  { setup: setups[0], features: { metrics: works, config: { available: false, reason: 'Needs an agent that applies config on the service host' }, postfixQueue: { available: false, reason: 'Needs Postfix in agent mode' } } },
  { setup: setups[1], features: { metrics: works, config: works, postfixQueue: works } },
  { setup: setups[2], features: { metrics: works, config: noFiles, postfixQueue: works } },
];

matrix.mockResolvedValue({
  data: {
    rules: [
      { id: 'metrics', label: 'Metrics', surface: 'Metrics page', types: ['postfix'] },
      { id: 'config', label: 'Managed config', surface: 'Config page', types: ['postfix'] },
      { id: 'postfixQueue', label: 'Queue browser', surface: 'Postfix → Queue', types: ['postfix'] },
    ],
    setups,
    matrix: { postfix, robin: [], rspamd: [], clamav: [], dovecot: [], redis: [], postgres: [], mariadb: [] },
  },
});

describe('FleetDocsPage', () => {
  it('shows what a setup supports and why the rest is hidden', async () => {
    render(<MemoryRouter><FleetDocsPage /></MemoryRouter>);

    const worksList = await screen.findByRole('heading', { name: 'Works (3)' });
    expect(worksList).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Hidden (0)' })).toBeInTheDocument();
    expect(screen.getByText(/ROBIN_AGENT_EXEC_PREFIX=postfix-primary=docker exec postfix/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Agent over ssh/ }));
    const hidden = screen.getByRole('heading', { name: 'Hidden (1)' }).closest('section')!;
    expect(within(hidden).getByText(/cannot place config files/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /No agent/ }));
    expect(screen.getByRole('heading', { name: 'Hidden (2)' })).toBeInTheDocument();
    expect(screen.queryByText(/ROBIN_ENROLLMENT_TOKEN/)).not.toBeInTheDocument();
  });
});
