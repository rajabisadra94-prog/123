import { useQuery } from '@tanstack/react-query'
import api from './api'
import { useAuthStore } from '../store/authStore'

/**
 * Frontend permission gate (Module 15). Reads the ROLE_PERMISSIONS matrix and the
 * current user's role. SUPER_ADMIN always allowed; if no matrix configured, allowed.
 */
export function usePermission(module: string, action: 'view' | 'create' | 'edit' | 'delete'): boolean {
  const { user } = useAuthStore()
  const { data: matrix } = useQuery({
    queryKey: ['role-permissions'],
    queryFn: () => api.get('/settings/config/ROLE_PERMISSIONS').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  })

  if (!user) return false
  if (user.role === 'SUPER_ADMIN') return true
  if (!matrix || !Object.keys(matrix).length) return true // not configured → allow
  return !!matrix?.[user.role]?.[module]?.[action]
}
