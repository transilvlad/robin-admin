import { cleanup, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import ClientConfigForm from './ClientConfigForm';
import { ConfigSection } from './ConfigSection';
import PropertiesConfigForm from './PropertiesConfigForm';
import { ServerConfigForm } from './ServerConfigForm';
import { StorageConfigForm } from './StorageConfigForm';
import { UsersConfigForm } from './UsersConfigForm';

function expectSectionBefore(first: HTMLElement, second: HTMLElement) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe('Robin config E2E labels', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders a right-side badge for tagged config sections', () => {
    render(
      <ConfigSection title="Tagged Section" description="Section description" badge="E2E">
        <div>Section body</div>
      </ConfigSection>,
    );

    const header = screen.getByRole('button', { name: /Tagged Section/ });
    expect(within(header).getByText('E2E')).toBeInTheDocument();
  });

  it('marks the client config sections that belong to Robin test flows', () => {
    render(<ClientConfigForm config={{}} onChange={() => undefined} />);

    expect(within(screen.getByRole('button', { name: /Destination/ })).getByText('E2E')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Default envelope/ })).getByText('E2E')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Assertions/ })).getByText('E2E')).toBeInTheDocument();
  });

  it('marks properties, storage, server, and users test sections', () => {
    render(
      <div>
        <PropertiesConfigForm config={{}} onChange={() => undefined} />
        <StorageConfigForm config={{}} onChange={() => undefined} />
        <ServerConfigForm config={{}} onChange={() => undefined} />
        <UsersConfigForm config={{}} onChange={() => undefined} />
      </div>,
    );

    expect(within(screen.getByRole('button', { name: /Logging/ })).getByText('E2E')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /IMAP Assertion Debug/ })).getByText('E2E')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /HTTP Request Settings/ })).getByText('E2E')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Humio configuration/ })).getByText('E2E')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Local test storage/ })).getByText('E2E')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Development options/ })).getByText('E2E')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Static test users/ })).getByText('E2E')).toBeInTheDocument();
  });

  it('keeps non-E2E cards above E2E cards and puts client EHLO first', () => {
    const { rerender } = render(<ClientConfigForm config={{}} onChange={() => undefined} />);

    const ehlo = screen.getByRole('button', { name: /EHLO Configuration/ });
    const tls = screen.getByRole('button', { name: /TLS Configuration/ });
    const destination = screen.getByRole('button', { name: /Destination/ });
    const envelope = screen.getByRole('button', { name: /Default envelope/ });
    const assertions = screen.getByRole('button', { name: /Assertions/ });

    expectSectionBefore(ehlo, tls);
    expectSectionBefore(tls, destination);
    expectSectionBefore(destination, envelope);
    expectSectionBefore(envelope, assertions);

    rerender(<PropertiesConfigForm config={{}} onChange={() => undefined} />);
    const clientSettings = screen.getByRole('button', { name: /Client settings/ });
    const propertiesReload = screen.getByRole('button', { name: /Properties auto-reload/ });
    const serverReload = screen.getByRole('button', { name: /Server auto-reload/ });
    const logging = screen.getByRole('button', { name: /Logging/ });
    const humio = screen.getByRole('button', { name: /Humio configuration/ });

    expectSectionBefore(clientSettings, propertiesReload);
    expectSectionBefore(propertiesReload, serverReload);
    expectSectionBefore(serverReload, logging);
    expectSectionBefore(logging, humio);

    rerender(<StorageConfigForm config={{}} onChange={() => undefined} />);
    const paths = screen.getByRole('button', { name: /Paths/ });
    const localTestStorage = screen.getByRole('button', { name: /Local test storage/ });
    expectSectionBefore(paths, localTestStorage);
  });
});
