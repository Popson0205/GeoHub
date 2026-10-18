import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { loadApi, tokens } from "./api";
import type { User } from "./types";
import { Loading } from "../components/ui";

interface AuthState { user: User | null; ready: boolean; login(email: string, password: string): Promise<void>; register(name: string, email: string, password: string): Promise<void>; logout(): Promise<void> }
const Ctx = createContext<AuthState>({ user: null, ready: false, login: async () => {}, register: async () => {}, logout: async () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      if (tokens.get()) {
        try { setUser(await (await loadApi()).me()); } catch { tokens.clear(); }
      }
      setReady(true);
    })();
  }, []);

  const login = async (email: string, password: string) => {
    const s = await (await loadApi()).login(email, password);
    setUser(s.user);
  };
  const register = async (name: string, email: string, password: string) => {
    const s = await (await loadApi()).register(name, email, password);
    setUser(s.user);
  };
  const logout = async () => {
    await (await loadApi()).logout();
    setUser(null);
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
