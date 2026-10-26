import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

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

// ---- confirmation dialog ----
export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** Label of the button that goes ahead. Name the action ("Delete map"), not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button, for things that cannot be undone. */
  danger?: boolean;
}
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
/** Without a provider (unit tests, isolated renders) fall back to the browser prompt so callers never break. */
const fallbackConfirm: ConfirmFn = async (o) => (typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(typeof o.message === "string" ? `${o.title}\n${o.message}` : o.title) : true);
const ConfirmCtx = createContext<ConfirmFn>(fallbackConfirm);
/** `const confirm = useConfirm(); if (!(await confirm({ title, message, danger: true }))) return;` */
export const useConfirm = () => useContext(ConfirmCtx);

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<{ opts: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const reqRef = useRef(req);
  reqRef.current = req;
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => new Promise<boolean>((resolve) => {
    reqRef.current?.resolve(false);                       // a second request cancels the first
    opener.current = document.activeElement as HTMLElement | null;
    setReq({ opts, resolve });
  }), []);
  const close = useCallback((ok: boolean) => {
    reqRef.current?.resolve(ok);
    setReq(null);
    const back = opener.current;
    opener.current = null;
    if (back && typeof back.focus === "function") setTimeout(() => back.focus(), 0);
  }, []);

  // Focus lands on the safe choice (Cancel), Escape cancels, Tab stays inside the dialog.
  useEffect(() => {
    if (!req) return;
    const root = dialog.current;
    root?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); return; }
      if (e.key !== "Tab" || !root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [req, close]);

  const o = req?.opts;
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {o && (
        <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}>
          <div ref={dialog} className="dialog" role={o.danger ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby="confirm-title" aria-describedby={o.message ? "confirm-body" : undefined}>
            <h2 id="confirm-title">{o.title}</h2>
            {o.message && <div id="confirm-body" className="dialog-body">{o.message}</div>}
            <div className="dialog-actions">
              <Button data-autofocus onClick={() => close(false)}>{o.cancelLabel ?? "Cancel"}</Button>
              <Button variant={o.danger ? "danger" : "primary"} onClick={() => close(true)}>{o.confirmLabel ?? "Confirm"}</Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
