import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

const { mockState } = vi.hoisted(() => ({
  mockState: {
    isAdmin: true,
    hostedModules: [] as Array<Record<string, unknown>>,
    moduleDefinitions: {} as Record<string, unknown>,
    features: {
      mailboxes: true,
      users: true,
      aliases: true,
      autoAliases: true,
      robin: true,
      queue: true,
      robinConfig: true,
      fleet: true,
      dmarc: true,
      reporting: true,
      rspamd: true,
      clamav: false,
      fleetEnabled: true,
      monitoring: true,
      monitoringEnabled: true,
      telemetry: true,
      telemetryEnabled: true,
      modules: true,
      modulesEnabled: true,
      fleetServices: {
        total: 2,
        robin: 1,
        rspamd: 1,
        clamav: 0,
      },
    } as Record<string, unknown>,
  },
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Admin', email: 'admin@example.com', role: 'admin' },
    logout: vi.fn(),
  }),
}));

vi.mock('../../context/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'light',
    toggleTheme: vi.fn(),
  }),
}));

vi.mock('../../context/FeaturesContext', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../context/FeaturesContext')>(),
  useFeatures: () => ({
    features: mockState.features,
  }),
}));

vi.mock('../../context/ModulesContext', () => ({
  useModules: () => ({
    hostedModules: mockState.hostedModules,
    moduleDefinitions: mockState.moduleDefinitions,
  }),
}));

vi.mock('../../hooks/useAuth', () => ({
  useIsAdmin: () => mockState.isAdmin,
}));

const defaultFeatures = () => ({
  mailboxes: true,
  users: true,
  aliases: true,
  autoAliases: true,
  robin: true,
  queue: true,
  robinConfig: true,
  fleet: true,
  dmarc: true,
  reporting: true,
  rspamd: true,
  clamav: false,
  fleetEnabled: true,
  monitoring: true,
  monitoringEnabled: true,
  telemetry: true,
  telemetryEnabled: true,
  modules: true,
  modulesEnabled: true,
  fleetServices: {
    total: 2,
    robin: 1,
    rspamd: 1,
    clamav: 0,
  },
  capabilities: capabilitiesFor({
    robin: ['metrics', 'logs', 'config', 'reload', 'queue', 'deliveryTest'],
    rspamd: ['metrics', 'logs', 'config', 'reload', 'scan', 'training', 'classifiers', 'rules', 'dkim'],
  }),
});

function capabilitiesFor(byType: Record<string, string[]>) {
  return {
    services: [],
    byType: Object.fromEntries(Object.entries(byType).map(([type, ids]) => [type, Object.fromEntries(ids.map((id) => [id, true]))])),
  };
}

function getLinkByHref(href: string): HTMLElement {
  const link = screen.getAllByRole('link').find((candidate) => candidate.getAttribute('href') === href);
  expect(link).toBeDefined();
  return link as HTMLElement;
}

describe('Sidebar', () => {
  it('shows enabled Mailboxes without mailbox tables or Fleet services', () => {
    Object.assign(mockState.features, { mailboxes: true, users: false, aliases: false, autoAliases: false, fleet: false });
    render(<MemoryRouter><Sidebar collapsed={false} onToggle={() => undefined} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Mailboxes' })).toHaveAttribute('href', '/users');
  });

  it('hides disabled Mailboxes even when all mailbox tables exist', () => {
    mockState.features.mailboxes = false;
    render(<MemoryRouter><Sidebar collapsed={false} onToggle={() => undefined} /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: 'Mailboxes' })).not.toBeInTheDocument();
  });
  it('opens collapsed navigation by click and closes with Escape or an outside press', () => {
    render(<MemoryRouter><Sidebar collapsed={true} onToggle={() => undefined} /></MemoryRouter>);
    const trigger = screen.getByRole('button', { name: 'Administration' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Integrations' })).toBeVisible();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('link', { name: 'Integrations' })).not.toBeInTheDocument();
  });
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    mockState.isAdmin = true;
    mockState.hostedModules = [];
    mockState.moduleDefinitions = {};
    mockState.features = defaultFeatures();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the workflow-oriented reporting navigation labels', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /^Reports$/i }));

    // Reports is the derived-analysis workflow: four destinations, one
    // per question an operator asks. Attention is flagged inline on
    // Sources and Domains.
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/reporting');
    expect(screen.getByRole('link', { name: 'Sources' })).toHaveAttribute('href', '/reporting/sources');
    expect(screen.getByRole('link', { name: 'Domains' })).toHaveAttribute('href', '/reporting/domains');
    expect(screen.getByRole('link', { name: 'Explorer' })).toHaveAttribute('href', '/reporting/explorer');
    expect(screen.queryByRole('link', { name: 'Issues' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Senders' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'TLS Posture' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Forensic Incidents' })).toBeNull();
  });

  it('orders primary workspace groups from operations to extensions', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    const primaryGroups = screen.getAllByRole('button')
      .map((button) => button.textContent?.trim())
      .filter((label) => ['Fleet', 'Monitoring', 'Telemetry', 'Reports', 'Modules'].includes(label ?? ''));

    expect(primaryGroups).toEqual(['Fleet', 'Monitoring', 'Telemetry', 'Reports', 'Modules']);
  });

  it('links Telemetry dashboards, Explore and Sources', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /^Telemetry$/i }));
    expect(screen.getAllByRole('link', { name: 'Dashboard' }).map((link) => link.getAttribute('href'))).toContain('/telemetry');
    expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/telemetry/explore');
    expect(screen.getByRole('link', { name: 'Sources' })).toHaveAttribute('href', '/telemetry/sources');
  });

  it('nests raw report evidence underneath Reports', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    // Raw Data is a child of Reports, so Reports must be expanded before
    // it is reachable at all — that nesting is the point of the group.
    fireEvent.click(screen.getByRole('button', { name: /^Reports$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Raw data/i }));

    expect(screen.getByRole('link', { name: 'DMARC Reports' })).toHaveAttribute('href', '/dmarc');
    expect(screen.getByRole('link', { name: 'TLSRPT Reports' })).toHaveAttribute('href', '/tlsrpt');
    expect(screen.getByRole('link', { name: 'Forensic reports' })).toHaveAttribute('href', '/forensic');
  });

  it('keeps the fleet metrics route active without highlighting Services', () => {
    render(
      <MemoryRouter initialEntries={['/fleet/metrics']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    const instances = getLinkByHref('/fleet');
    const metrics = getLinkByHref('/fleet/metrics');

    expect(instances.className).not.toContain('active');
    expect(metrics.className).toContain('active');
  });

  it('keeps Fleet visible before the first service exists', () => {
    mockState.features = {
      ...defaultFeatures(),
      robin: false,
      rspamd: false,
      fleetServices: {
        total: 0,
        robin: 0,
        rspamd: 0,
        clamav: 0,
      },
    };

    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: 'Fleet' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));
    expect(screen.queryByRole('button', { name: 'Robin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rspamd' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Services' })).toBeInTheDocument();
    expect(getLinkByHref('/fleet/metrics')).toBeInTheDocument();
  });

  it('keeps Rspamd navigation hidden when no Rspamd service exists', () => {
    mockState.features = {
      ...defaultFeatures(),
      rspamd: false,
      fleetServices: {
        total: 1,
        robin: 1,
        rspamd: 0,
        clamav: 0,
      },
    };

    render(
      <MemoryRouter initialEntries={['/fleet']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: 'Fleet' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));
    expect(screen.queryByRole('button', { name: 'Rspamd' })).not.toBeInTheDocument();
  });

  it('shows Robin under Fleet and still hides Queue and Config when Robin tables are missing', () => {
    mockState.features = {
      ...defaultFeatures(),
      robin: true,
      queue: false,
      robinConfig: false,
      capabilities: capabilitiesFor({ robin: ['metrics', 'deliveryTest'] }),
      fleetServices: {
        total: 1,
        robin: 1,
        rspamd: 0,
        clamav: 0,
      },
    };

    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));
    expect(screen.getByRole('button', { name: 'Robin' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Robin' }));
    expect(getLinkByHref('/robin/metrics')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Delivery test' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Config' })).not.toBeInTheDocument();
  });

  it('shows Postfix Queue only when an agent can run the queue browser', () => {
    const renderPostfix = (postfixQueue: boolean) => {
      cleanup();
      mockState.features = {
        ...defaultFeatures(),
        postfix: true,
        capabilities: capabilitiesFor({ postfix: postfixQueue ? ['metrics', 'postfixQueue'] : ['metrics'] }),
      } as typeof mockState.features;
      render(
        <MemoryRouter initialEntries={['/postfix/metrics']}>
          <Sidebar collapsed={false} onToggle={() => undefined} />
        </MemoryRouter>
      );
    };

    renderPostfix(false);
    expect(getLinkByHref('/postfix/metrics')).toBeInTheDocument();
    expect(document.querySelector('a[href="/postfix/queue"]')).toBeNull();

    renderPostfix(true);
    expect(getLinkByHref('/postfix/queue')).toBeInTheDocument();
  });

  it('persists nested Fleet subgroup expansion state', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Robin' }));

    expect(JSON.parse(localStorage.getItem('sidebar-expanded-groups') ?? '[]')).toEqual(
      expect.arrayContaining(['fleet', 'fleet-robin'])
    );
  });

  it('uses normalized robin child paths in navigation', () => {
    render(
      <MemoryRouter initialEntries={['/robin/metrics']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Queue' })).toHaveAttribute('href', '/robin/queue');
    expect(getLinkByHref('/robin/metrics')).toHaveAttribute('href', '/robin/metrics');
    expect(screen.getByRole('link', { name: 'Config' })).toHaveAttribute('href', '/robin/config');
    expect(screen.getByRole('link', { name: 'Delivery test' })).toHaveAttribute('href', '/robin/delivery-test');
  });

  it('keeps Administration focused on top-level settings areas', () => {
    render(
      <MemoryRouter initialEntries={['/administration/access']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    const administrationLinks = screen.getAllByRole('link')
      .map((link) => link.textContent?.trim())
      .filter((label) => ['Access', 'Security', 'Integrations', 'Reporting', 'Alerts', 'Email'].includes(label ?? ''));

    expect(administrationLinks).toEqual([
      'Access',
      'Security',
      'Integrations',
      'Reporting',
      'Alerts',
      'Email',
    ]);
  });

  it('renders modules with empty navigation as direct links', () => {
    mockState.hostedModules = [
      {
        slug: 'robin-sheriff',
        routeSlug: 'robin-sheriff',
        displayName: 'Robin Sheriff',
      },
    ];
    mockState.moduleDefinitions = {
      'robin-sheriff': {
        defaultPath: '',
        navigation: [],
      },
    };

    render(
      <MemoryRouter initialEntries={['/modules/robin-sheriff']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Robin Sheriff' })).toHaveAttribute(
      'href',
      '/modules/robin-sheriff'
    );
    expect(screen.queryByRole('button', { name: 'Robin Sheriff' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
  });

  it('renders module child pages from the remote definition', () => {
    mockState.hostedModules = [
      {
        slug: 'robin-qa',
        routeSlug: 'robin-qa',
        displayName: 'Robin QA',
      },
    ];
    mockState.moduleDefinitions = {
      'robin-qa': {
        navigation: [
          { label: 'Overview', path: '' },
          { label: 'Environments', path: 'environments' },
          {
            label: 'Cases',
            children: [
              { label: 'Library', path: 'cases' },
              {
                label: 'Flows',
                children: [
                  { label: 'SMTP', path: 'cases/smtp' },
                ],
              },
            ],
          },
          { label: 'Runs', path: 'runs' },
        ],
      },
    };

    render(
      <MemoryRouter initialEntries={['/modules/robin-qa/cases/smtp']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: 'Robin QA' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cases' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Flows' })).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/modules/robin-qa');
    expect(screen.getByRole('link', { name: 'Environments' })).toHaveAttribute('href', '/modules/robin-qa/environments');
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('href', '/modules/robin-qa/cases');
    expect(screen.getByRole('link', { name: 'SMTP' })).toHaveAttribute('href', '/modules/robin-qa/cases/smtp');
    expect(screen.getByRole('link', { name: 'Runs' })).toHaveAttribute('href', '/modules/robin-qa/runs');
  });

  it('renders Mailboxes as a single flat link instead of an expandable group', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );

    // Users/Aliases/Auto Aliases are in-page tabs now (MailboxesLayout), so
    // this entry links straight to Users — there's nothing to expand.
    expect(screen.getByRole('link', { name: 'Mailboxes' })).toHaveAttribute('href', '/users');
    expect(screen.queryByRole('button', { name: /Mailboxes/i })).toBeNull();
  });

  it('highlights Mailboxes when on Aliases or Auto Aliases, not just Users', () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/aliases']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'Mailboxes' }).className).toContain('active');
    unmount();

    render(
      <MemoryRouter initialEntries={['/auto-aliases']}>
        <Sidebar collapsed={false} onToggle={() => undefined} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'Mailboxes' }).className).toContain('active');
  });
});
