/**
 * First-time setup page.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi, ApiError } from '../api/client';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';

export function SetupPage() {
  const navigate = useNavigate();
  const [setupId, setSetupId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    const checkSetup = async () => {
      try {
        const response = await authApi.getSetupStatus();
        setNeedsSetup(response.data?.setupRequired ?? false);
        if (!response.data?.setupRequired) {
          navigate('/login');
        }
      } catch {
        navigate('/login');
      } finally {
        setCheckingSetup(false);
      }
    };
    checkSetup();
  }, [navigate]);

  if (checkingSetup) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner className="text-robin-orange" size="lg" />
      </div>
    );
  }

  if (!needsSetup) {
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setErrors([]);

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setIsLoading(true);

    try {
      await authApi.setup(setupId, name, email, password);
      navigate('/login');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.details) {
          setErrors(err.details);
        }
      } else {
        setError('An unexpected error occurred');
      }
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
            <img src={`${import.meta.env.BASE_URL}robin-logo.svg`} alt="Robin" className="w-16 h-16 mb-4" />
            <h1 className="text-2xl font-bold text-robin-orange">Robin Admin setup</h1>
            <p className="text-gray-500 dark:text-gray-400 text-center">
              Create your first admin account
            </p>
          </div>

          {/* Info */}
          <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-sm text-sm text-blue-700 dark:text-blue-300">
            <p className="font-medium mb-2">Setup session ID required</p>
            <p>Ask the server root user to read the setup session ID from the server-local setup ID file. It looks like:</p>
            <code className="block mt-2 p-2 bg-white/50 dark:bg-black/20 rounded-sm text-xs break-all">
              xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
            </code>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-red-600 dark:text-red-400 text-sm">
                <p>{error}</p>
                {errors.length > 0 && (
                  <ul className="mt-2 list-disc list-inside">
                    {errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <Input
              label="Setup session ID"
              type="text"
              value={setupId}
              onChange={(e) => setSetupId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              required
              autoFocus
            />

            <Input
              label="Admin name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Robin Admin"
              required
            />

            <Input
              label="Admin email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              required
            />

            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />

            <Input
              label="Confirm password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              required
            />

            <div className="text-xs text-gray-500 dark:text-gray-400">
              Password must contain at least 8 characters, including uppercase, lowercase, and numbers.
            </div>

            <Button
              type="submit"
              className="w-full"
              isLoading={isLoading}
            >
              Create admin account
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
