import { useEffect, useState } from 'react';
import { CalendarDays, Key, LogOut, Save, Shield, ShieldCheck, UserCog } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { profileApi, ApiError } from '../api/client';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { UserAvatar } from '../components/ui/UserAvatar';
import { appIcons } from '../constants/appIcons';
import type { CurrentUser } from '../types';

export function ProfilePage() {
  const { user, logout, checkAuth } = useAuth();
  const [profile, setProfile] = useState<CurrentUser | null>(null);
  const [formName, setFormName] = useState(user?.name ?? '');
  const [formEmail, setFormEmail] = useState(user?.email ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  useEffect(() => {
    if (user) {
      setFormName(user.name);
      setFormEmail(user.email);
    }
  }, [user]);

  useEffect(() => {
    let mounted = true;
    profileApi.get()
      .then((response) => {
        if (mounted) {
          const nextProfile = response.data ?? null;
          setProfile(nextProfile);
          if (nextProfile) {
            setFormName(nextProfile.name);
            setFormEmail(nextProfile.email);
          }
        }
      })
      .catch(() => {
        if (mounted) {
          setProfile(null);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleProfileUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileError('');
    setProfileSuccess('');

    const trimmedName = formName.trim();
    const trimmedEmail = formEmail.trim();

    if (!trimmedName) {
      setProfileError('Name is required');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      setProfileError('Enter a valid email address');
      return;
    }

    setIsSavingProfile(true);
    try {
      const response = await profileApi.update(trimmedName, trimmedEmail);
      setProfile(response.data ?? null);
      setFormName(response.data?.name ?? trimmedName);
      setFormEmail(response.data?.email ?? trimmedEmail);
      setProfileSuccess('Profile updated successfully');
      await checkAuth();
    } catch (err) {
      if (err instanceof ApiError) {
        setProfileError(err.message);
      } else {
        setProfileError('Failed to update profile');
      }
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      return;
    }

    setIsChangingPassword(true);
    try {
      await profileApi.changePassword(currentPassword, newPassword);
      setPasswordSuccess('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      if (err instanceof ApiError) {
        setPasswordError(err.message);
      } else {
        setPasswordError('Failed to change password');
      }
    } finally {
      setIsChangingPassword(false);
    }
  };

  if (!user) {
    return null;
  }

  const resolvedProfile = profile ?? user;
  const allowedCidrs = resolvedProfile.allowedCidrs ?? [];
  const accessSummary = allowedCidrs.length === 0
    ? 'No extra CIDR restrictions are configured on this account.'
    : 'This administrator can only sign in from the CIDRs below, in addition to any global allowlist.';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        icon={appIcons.profile}
        title="Profile"
        description="Review your administrator identity, access restrictions, and account settings."
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <div className="card p-6">
          <div className="flex items-center gap-4">
            <UserAvatar email={resolvedProfile.email} size={64} />
            <div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
                {resolvedProfile.name}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">{resolvedProfile.email}</p>
              <p className="text-gray-500 dark:text-gray-400 capitalize">
                Role: {resolvedProfile.role}
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            <div className="rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">
                <CalendarDays className="h-4 w-4 text-robin-orange" />
                Account timeline
              </div>
              <div className="mt-3 space-y-2 text-sm text-gray-600 dark:text-gray-300">
                {resolvedProfile.createdAt && (
                  <div><span className="font-medium">Created:</span> {new Date(resolvedProfile.createdAt).toLocaleString()}</div>
                )}
                <div><span className="font-medium">Last sign-in:</span> {resolvedProfile.lastLogin ? new Date(resolvedProfile.lastLogin).toLocaleString() : 'Never'}</div>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">
                <Shield className="h-4 w-4 text-robin-orange" />
                Access restrictions
              </div>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{accessSummary}</p>
              {allowedCidrs.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {allowedCidrs.map((cidr) => (
                    <span key={cidr} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 dark:bg-robin-gray-800 dark:text-gray-200">
                      {cidr}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 border-t border-gray-200 pt-6 dark:border-robin-gray-700">
            <Button
              variant="danger"
              onClick={logout}
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </Button>
          </div>
        </div>

        <div className="card p-6">
          <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-white">
            <UserCog className="w-5 h-5 text-robin-orange" />
            Account settings
          </h3>

          {profileError && (
            <div className="mb-4 rounded-sm bg-red-100 p-3 text-red-700 dark:bg-red-900/20 dark:text-red-400">
              {profileError}
            </div>
          )}

          {profileSuccess && (
            <div className="mb-4 rounded-sm bg-green-100 p-3 text-green-700 dark:bg-green-900/20 dark:text-green-400">
              {profileSuccess}
            </div>
          )}

          <form onSubmit={handleProfileUpdate} className="space-y-4">
            <Input
              label="Display name"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              required
            />
            <Input
              label="Email address"
              type="email"
              value={formEmail}
              onChange={(e) => setFormEmail(e.target.value)}
              required
            />
            <Button type="submit" isLoading={isSavingProfile}>
              <Save className="w-4 h-4" />
              Save profile
            </Button>
          </form>

          <h3 className="mb-4 mt-6 flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-white">
            <ShieldCheck className="w-5 h-5 text-robin-orange" />
            Access policy
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Administrator CIDR restrictions never replace the global IP allowlist. If both are configured, your current IP must satisfy both policies.
          </p>

          <h3 className="mb-4 mt-6 flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-white">
            <Key className="w-5 h-5" />
            Change password
          </h3>

          {passwordError && (
            <div className="mb-4 rounded-sm bg-red-100 p-3 text-red-700 dark:bg-red-900/20 dark:text-red-400">
              {passwordError}
            </div>
          )}

          {passwordSuccess && (
            <div className="mb-4 rounded-sm bg-green-100 p-3 text-green-700 dark:bg-green-900/20 dark:text-green-400">
              {passwordSuccess}
            </div>
          )}

          <form onSubmit={handlePasswordChange} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Current password
              </label>
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                New password
              </label>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Confirm new password
              </label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" isLoading={isChangingPassword}>
              <Key className="w-4 h-4" />
              Change password
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
