/**
 * Custom hooks for authentication.
 */

import { useAuth } from '../context/AuthContext';
import type { AdminRole } from '../types';

// Re-export useAuth for convenience
export { useAuth };

const roleHierarchy: Record<AdminRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

/**
 * Hook to check if user has at least the specified role.
 */
export function useHasRole(requiredRole: AdminRole): boolean {
  const { user } = useAuth();
  if (!user) return false;
  return roleHierarchy[user.role] >= roleHierarchy[requiredRole];
}

/**
 * Hook to check if user is an admin.
 */
export function useIsAdmin(): boolean {
  return useHasRole('admin');
}

/**
 * Hook to check if user can edit (editor or admin).
 */
export function useCanEdit(): boolean {
  return useHasRole('editor');
}
