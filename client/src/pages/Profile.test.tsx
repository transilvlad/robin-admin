import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ProfilePage } from './Profile';

const { profileGetMock, profileChangePasswordMock, logoutMock, checkAuthMock, useAuthMock } = vi.hoisted(() => ({
  profileGetMock: vi.fn(),
  profileChangePasswordMock: vi.fn(),
  logoutMock: vi.fn(),
  checkAuthMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  profileApi: {
    get: profileGetMock,
    update: vi.fn(),
    changePassword: profileChangePasswordMock,
  },
  ApiError: class ApiError extends Error {},
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('../components/ui/PageHeader', () => ({
  PageHeader: ({ title, description }: any) => (
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  ),
}));

vi.mock('../constants/appIcons', () => ({
  appIcons: new Proxy({}, { get: () => () => null }),
}));

describe('ProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthMock.mockReturnValue({
      user: {
        id: 1,
        name: 'Robin Admin',
        email: 'admin@example.com',
        role: 'admin',
        allowedCidrs: [],
      },
      logout: logoutMock,
      checkAuth: checkAuthMock,
    });
    profileGetMock.mockResolvedValue({
      data: {
        id: 1,
        name: 'Robin Admin',
        email: 'admin@example.com',
        role: 'admin',
        allowedCidrs: ['203.0.113.0/24'],
        createdAt: '2024-01-01T00:00:00.000Z',
        lastLogin: '2024-01-02T00:00:00.000Z',
      },
    });
  });

  it('shows admin CIDR restrictions and policy copy', async () => {
    render(<ProfilePage />);

    expect(screen.getByText('Profile')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('203.0.113.0/24')).toBeInTheDocument();
    });

    expect(screen.getByText(/Administrator CIDR restrictions never replace the global IP allowlist/i)).toBeInTheDocument();
  });

  it('renders editable name and email controls for the current profile', async () => {
    render(<ProfilePage />);

    await screen.findByText('203.0.113.0/24');

    expect(screen.getAllByDisplayValue('Robin Admin').length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue('admin@example.com').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /save profile/i }).length).toBeGreaterThan(0);
  });
});
