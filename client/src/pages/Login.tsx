/**
 * Login page.
 */

import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { ApiError, authApi } from '../api/client';

export function LoginPage() {
  const { login, isAuthenticated, isLoading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [showRecovery, setShowRecovery] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);

  // Check if setup is required
  useEffect(() => {
    authApi.getSetupStatus()
      .then((response) => {
        setSetupRequired(response.data?.setupRequired ?? false);
      })
      .catch(() => {
        setSetupRequired(false);
      });
  }, []);

  if (authLoading || setupRequired === null) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner className="text-robin-orange" size="lg" />
      </div>
    );
  }

  // Redirect to setup if no admins exist
  if (setupRequired) {
    return <Navigate to="/setup" replace />;
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await login(email, password);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setRecoveryMessage('');
    setIsLoading(true);
    try {
      await authApi.requestPasswordRecovery(email);
      setRecoveryMessage('If the account exists, recovery instructions will be emailed.');
    } catch {
      setRecoveryMessage('If the account exists, recovery instructions will be emailed.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-robin-gray-900 p-4">
      <div className="w-full max-w-md">
        <div className="card p-8">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <img src={`${import.meta.env.BASE_URL}robin-logo.svg`} alt="Robin" className="w-20 h-20 mb-4" />
            <h1 className="text-2xl font-bold text-robin-orange">Robin Admin</h1>
            <p className="text-gray-500 dark:text-gray-400">Sign in to your account</p>
          </div>

          {/* Form */}
          <form onSubmit={showRecovery ? handleRecovery : handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-red-600 dark:text-red-400 text-sm">
                {error}
              </div>
            )}
            {recoveryMessage && (
              <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-sm text-green-700 dark:text-green-300 text-sm">
                {recoveryMessage}
              </div>
            )}

            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              required
              autoFocus
            />

            {!showRecovery && (
              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            )}

            <Button
              type="submit"
              className="w-full"
              isLoading={isLoading}
            >
              {showRecovery ? 'Send recovery email' : 'Sign in'}
            </Button>
            <button
              type="button"
              className="w-full text-sm text-robin-orange hover:underline"
              onClick={() => { setShowRecovery(!showRecovery); setError(''); setRecoveryMessage(''); }}
            >
              {showRecovery ? 'Back to sign in' : 'Forgot password?'}
            </button>
          </form>

        </div>
      </div>
    </div>
  );
}
