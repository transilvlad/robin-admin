import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, authApi } from '../api/client';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = useMemo(() => params.get('token') ?? '', [params]);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [working, setWorking] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setWorking(true);
    try {
      await authApi.resetPassword(token, password);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Password reset failed');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-robin-gray-900">
      <div className="card w-full max-w-md p-8">
        <div className="mb-8 flex flex-col items-center">
          <img src={`${import.meta.env.BASE_URL}robin-logo.svg`} alt="Robin" className="mb-4 h-20 w-20" />
          <h1 className="text-2xl font-bold text-robin-orange">Reset password</h1>
          <p className="text-gray-500 dark:text-gray-400">Choose a new Robin Admin password</p>
        </div>
        {success ? (
          <div className="space-y-4">
            <div className="rounded-sm border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-200">Password updated.</div>
            <Link className="btn btn-primary w-full justify-center" to="/login">Back to sign in</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">{error}</div>}
            {!token && <div className="rounded-sm border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">Recovery token is missing.</div>}
            <Input label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Input label="Confirm password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            <Button type="submit" className="w-full" isLoading={working} disabled={!token}>Reset password</Button>
          </form>
        )}
      </div>
    </div>
  );
}
