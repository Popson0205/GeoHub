import { createContext, useCallback, useContext, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type BtnVariant = "default" | "primary" | "accent" | "danger" | "ghost";
export function Button({ variant = "default", small, busy, children, className = "", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; small?: boolean; busy?: boolean }) {
  const cls = ["btn", variant !== "default" && `btn-${variant}`, small && "btn-sm", className].filter(Boolean).join(" ");
  return (
    <button type="button" {...rest} className={cls} aria-busy={busy || undefined} disabled={rest.disabled || busy}>
      {children}
    </button>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="state"><strong>{title}</strong>{children}{action}</div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="state state-error" role="alert">
      <strong>Something went wrong</strong>
      <span>{msg}</span>
      {onRetry && <Button small onClick={onRetry}>Try again</Button>}
    </div>
  );
}

// ---- toasts ----
type ToastKind = "info" | "success" | "error";
interface ToastItem { id: number; kind: ToastKind; text: string }
const ToastCtx = createContext<(text: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback((text: string, kind: ToastKind = "info") => {
    const id = Date.now() + Math.random();
    setItems((l) => [...l, { id, kind, text }]);
    setTimeout(() => dismiss(id), kind === "error" ? 7000 : 4000);
  }, [dismiss]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
            <span>{t.text}</span>
            <button aria-label="Dismiss message" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
