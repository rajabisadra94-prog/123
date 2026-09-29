import { create } from 'zustand';

interface AuthUser {
  id: string;
  name: string;
  username: string;
  email?: string | null;   // ایمیل اختیاری است — شناسهٔ ورود، username است
  role: string;
  avatarUrl?: string;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
  updateUser: (patch: Partial<AuthUser>) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  token: localStorage.getItem('token'),
  isAuthenticated: !!localStorage.getItem('token'),
  login: (token, user) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ token, user, isAuthenticated: true });
  },
  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    set({ token: null, user: null, isAuthenticated: false });
  },
  updateUser: (patch) => set((s) => {
    if (!s.user) return {};
    const user = { ...s.user, ...patch };
    localStorage.setItem('user', JSON.stringify(user));
    return { user };
  }),
}));
