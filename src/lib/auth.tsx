import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ApiError, loadApi, tokens } from "./api";
import type { User } from "./types";
import { Loading } from "../components/ui";

interface AuthState { user: User | null; ready: boolean; login(email: string, password: string): Promise<void>; register(name: string, email: string, password: string): Promise<void>; logout(): Promise<void> }
const Ctx = createContext<AuthState>({ user: null, ready: false, login: async () => {}, register: async () => {}, logout: async () => {} });
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
  const register = async (name: string, email: string, password: string) => {
    const s = await (await loadApi()).register(name, email, password);
    setUser(s.user); cacheUser(s.user);
  };
  const logout = async () => {
    await (await loadApi()).logout();
    setUser(null); cacheUser(null);
  };
  return <Ctx.Provider value={{ user, ready, login, register, logout }}>{children}</Ctx.Provider>;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading label="Checking your session…" />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <>{children}</>;
}
