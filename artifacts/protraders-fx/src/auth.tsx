import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const authReturnPath = `${basePath || ''}/?view=dashboard`;

export type AccountMode = 'demo' | 'real';

export type AppAuthState = {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: { label: string; email?: string } | null;
  activeMode: AccountMode;
  balance: number | null;
  currency: string;
  signInHref: string;
  signUpHref: string;
  refreshAccount: () => Promise<void>;
  switchMode: (mode: AccountMode) => Promise<void>;
  signOut: () => Promise<void>;
};

export const AuthContext = createContext<AppAuthState | null>(null);

export function useAppAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAppAuth must be used inside an auth provider');
  return value;
}

function derivAuthHref(action: 'login' | 'signup') {
  const path = `${basePath || ''}/api/deriv/${action}`;
  return `${path}?returnTo=${encodeURIComponent(authReturnPath)}`;
}

type LegacyAccountResponse = {
  authenticated?: boolean;
  mode?: AccountMode;
  balance?: number;
  currency?: string;
  loginid?: string;
};

export function LegacyAuthProvider({ children }: { children: ReactNode }) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [activeMode, setActiveMode] = useState<AccountMode>('demo');
  const [balance, setBalance] = useState<number | null>(null);
  const [currency, setCurrency] = useState('USD');
  const [user, setUser] = useState<AppAuthState['user']>(null);

  const loadAccount = async (mode: AccountMode) => {
    const response = await fetch(`${basePath || ''}/api/account?mode=${mode}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      if (response.status === 401) {
        setIsSignedIn(false);
        setUser(null);
        setBalance(null);
      }
      return;
    }
    const payload = await response.json() as LegacyAccountResponse;
    if (!payload.authenticated) return;
    setIsSignedIn(true);
    setActiveMode(payload.mode ?? mode);
    setBalance(typeof payload.balance === 'number' ? payload.balance : null);
    setCurrency(payload.currency ?? 'USD');
    setUser(payload.loginid ? { label: payload.loginid } : { label: 'Deriv trader' });
  };

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        const response = await fetch(`${basePath || ''}/api/session`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const payload = await response.json() as { authenticated?: boolean; activeMode?: AccountMode };
        if (cancelled) return;
        if (payload.authenticated) {
          setIsSignedIn(true);
          await loadAccount(payload.activeMode === 'real' ? 'real' : 'demo');
        }
      } catch {
        if (!cancelled) {
          setIsSignedIn(false);
          setUser(null);
        }
      } finally {
        if (!cancelled) setIsLoaded(true);
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<AppAuthState>(() => ({
    isLoaded,
    isSignedIn,
    user,
    activeMode,
    balance,
    currency,
    signInHref: derivAuthHref('login'),
    signUpHref: derivAuthHref('signup'),
    refreshAccount: async () => {
      await loadAccount(activeMode);
    },
    switchMode: async (mode) => {
      const response = await fetch(`${basePath || ''}/api/account/switch`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const payload = await response.json() as LegacyAccountResponse & { error?: string; message?: string };
      if (!response.ok || !payload.authenticated) {
        throw new Error(payload.message ?? payload.error ?? `Unable to switch to ${mode} mode.`);
      }
      setActiveMode(payload.mode ?? mode);
      setBalance(typeof payload.balance === 'number' ? payload.balance : null);
      setCurrency(payload.currency ?? 'USD');
      if (payload.loginid) setUser({ label: payload.loginid });
    },
    signOut: async () => {
      await fetch(`${basePath || ''}/api/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      window.location.assign(basePath || '/');
    },
  }), [activeMode, balance, currency, isLoaded, isSignedIn, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}