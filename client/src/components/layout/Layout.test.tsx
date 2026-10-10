import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './Layout';

const { sidebarProps } = vi.hoisted(() => ({
  sidebarProps: [] as Array<{ collapsed: boolean }>,
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock('./Sidebar', () => ({
  Sidebar: ({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) => {
    sidebarProps.push({ collapsed });
    return <aside data-testid="sidebar" data-collapsed={collapsed}><button onClick={onToggle}>Toggle sidebar</button></aside>;
  },
}));

function mockViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<div>Dashboard content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Layout', () => {
  beforeEach(() => {
    localStorage.clear();
    sidebarProps.length = 0;
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    sidebarProps.length = 0;
    vi.restoreAllMocks();
  });

  it('uses the compact sidebar offset on narrow viewports', () => {
    mockViewport(true);

    const { container } = renderLayout();

    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');
    expect(sidebarProps[sidebarProps.length - 1]).toEqual({ collapsed: true });
    expect(container.querySelector('main')).toHaveClass('ml-16');
  });

  it('uses the expanded sidebar offset on desktop viewports', () => {
    mockViewport(false);

    const { container } = renderLayout();

    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'false');
    expect(sidebarProps[sidebarProps.length - 1]).toEqual({ collapsed: false });
    expect(container.querySelector('main')).toHaveClass('ml-72');
  });

  it('persists the desktop sidebar collapse preference', () => {
    mockViewport(false);

    const { container, unmount } = renderLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));

    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');
    expect(container.querySelector('main')).toHaveClass('ml-16');
    expect(localStorage.getItem('robin-admin.sidebar.collapsed')).toBe('true');

    unmount();
    renderLayout();

    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');
  });
});
