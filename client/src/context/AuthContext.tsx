/**
 * Authentication context and provider.
 * 
 * Provides authentication state and methods to the entire app via React Context.
 * 
 * Usage:
 *   const { user, login, logout } = useAuth();
 *   await login(email, password);
 *   if (user) { // authenticated }
 * 
 * State:
 * - user: Current authenticated user or null
 * - isLoading: True while checking auth status
 * - isAuthenticated: Convenience boolean
 * 
 * Methods:
 * - login(email, password): Authenticate and set user
 * - logout(): Clear authentication
 * - checkAuth(): Re-verify current session
 * 
 * isLoading is true on initial load while checking the session.
 * Invalid sessions are silently represented as a null user.
 */

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { authApi, ApiError } from '../api/client';
import { setSessionExpiredHandler } from '../utils/sessionExpiry';
import type { CurrentUser } from '../types';

interface AuthContextType {
  user: CurrentUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    try {
      const response = await authApi.me();
      setUser(response.data ?? null);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Fires on a 401 from any same-origin request made anywhere in the app —
  // including a federated module's own calls — so a session that expires
  // mid-use clears here too, not just on the next full page load.
  useEffect(() => {
    setSessionExpiredHandler(() => setUser(null));
    return () => setSessionExpiredHandler(null);
  }, []);

  const login = async (email: string, password: string) => {
    const response = await authApi.login(email, password);
    setUser(response.data ?? null);
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        throw error;
      }
    }
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        logout,
        checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
