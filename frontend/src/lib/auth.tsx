import { applyBrand } from "./brand";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ApiError, loadApi, MFA_SETUP_EVENT, tokens } from "./api";
import type { Session, User } from "./types";
import { Loading } from "../components/ui";
import { SuspendedPage } from "../components/LicenceBanner";

interface AuthState {
  user: User | null; ready: boolean;
  login(email: string, password: string): Promise<void>;
  register(name: string, email: string, password: string, organization?: string): Promise<void>;
  logout(): Promise<void>;
  /** Read the signed-in person again, e.g. after their organization was renamed. */
  refresh(): Promise<void>;
  /** Start a session someone else signed in for us (setting a password from an emailed link). */
  adopt(s: Session): void;
}
const Ctx = createContext<AuthState>({ user: null, ready: false, login: async () => {}, register: async () => {}, logout: async () => {}, refresh: async () => {}, adopt: () => {} });
export const useAuth = () => useContext(Ctx);

// The signed-in person is remembered on the device so the app still opens with no connection.
const USER_KEY = "geohub.user";
const cacheUser = (u: User | null) => { try { if (u) localStorage.setItem(USER_KEY, JSON.stringify(u)); else localStorage.removeItem(USER_KEY); } catch { /* storage full or blocked */ } };
const cachedUser = (): User | null => { try { return JSON.parse(localStorage.getItem(USER_KEY) ?? "null") as User | null; } catch { return null; } };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      if (tokens.get()) {
        try { const u = await (await loadApi()).me(); setUser(u); cacheUser(u); }
        catch (e) {
          // No connection (status 0) is not a sign-out: keep working from the saved session and sync later.
          const offline = e instanceof ApiError ? e.status === 0 : !navigator.onLine;
          const saved = cachedUser();
          if (offline && saved) setUser(saved); else { tokens.clear(); cacheUser(null); }
        }
      }
      setReady(true);
    })();
  }, []);

  const login = async (email: string, password: string) => {
    const s = await (await loadApi()).login(email, password);
    setUser(s.user); cacheUser(s.user);
  };
  const register = async (name: string, email: string, password: string, organization?: string) => {
    const s = await (await loadApi()).register(name, email, password, organization);
    setUser(s.user); cacheUser(s.user);
  };
  const logout = async () => {
    await (await loadApi()).logout();
    setUser(null); cacheUser(null);
  };
  const refresh = async () => {
    try { const u = await (await loadApi()).me(); setUser(u); cacheUser(u); } catch { /* keep what we have */ }
  };
  const adopt = (s: Session) => { setUser(s.user); cacheUser(s.user); };
  // the organization started requiring two-step sign-in while this person was signed in: read them again, and
  // RequireAuth sends them to set it up
  useEffect(() => {
    const again = () => { void refresh(); };
    window.addEventListener(MFA_SETUP_EVENT, again);
    return () => window.removeEventListener(MFA_SETUP_EVENT, again);
  }, []);
  // the organization's colour, for everyone in it
  const brandColor = user?.org?.brand?.color ?? null;
  useEffect(() => { applyBrand(brandColor ? { color: brandColor, logo_url: null } : null); }, [brandColor]);
  return <Ctx.Provider value={{ user, ready, login, register, logout, refresh, adopt }}>{children}</Ctx.Provider>;
}

export const SECURITY_PATH = "/settings/security";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading label="Checking your session…" />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  // signed in with a temporary password: nothing else until they choose their own
  if (user.must_change_password && loc.pathname !== "/change-password") return <Navigate to="/change-password" replace />;
  // the organization requires two-step sign-in: nothing else until it is set up
  if (user.mfa_setup_required && !user.must_change_password && loc.pathname !== SECURITY_PATH) return <Navigate to={SECURITY_PATH} replace />;
  // a suspended organization: only signing out, and the account's own security, until GeoEstate lifts it
  if (user.org?.licence?.status === "suspended" && loc.pathname !== SECURITY_PATH && loc.pathname !== "/change-password") return <SuspendedPage />;
  return <>{children}</>;
}
