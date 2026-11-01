import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon, type IconName } from "./icons";

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

/** What a list shows before it has anything in it: what goes here, and the one action that starts it. */
export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="state">
      {icon && <span className="state-icon" aria-hidden="true"><Icon name={icon} size={24} /></span>}
      <strong>{title}</strong>
      {children && <span className="state-text">{children}</span>}
      {action && <div className="state-action">{action}</div>}
    </div>
  );
}

/**
 * The top of a page: an optional way back, the title, one line on what the page is for, and its actions.
 * Put the main action last; it sits at the right edge where people look for it.
 */
export function PageHeader({ title, lede, back, actions, children }: {
  title: ReactNode; lede?: ReactNode; back?: { to: string; label: string }; actions?: ReactNode; children?: ReactNode;
}) {
  return (
    <header className="page-header">
      {back && <Link className="page-back" to={back.to}><Icon name="arrowLeft" size={16} />{back.label}</Link>}
      <div className="page-header-row">
        <div className="page-header-text">
          <h1>{title}</h1>
          {lede && <p className="page-header-lede">{lede}</p>}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/**
 * Placeholder artwork for a card: contour rings like a topographic map, placed from the item's id. Every card gets its
 * own stable picture, which makes a list easier to scan than identical placeholders.
 */
export function thumbStyle(id: string): CSSProperties {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  const n = (shift: number, min: number, max: number) => min + (((h >>> shift) & 255) / 255) * (max - min);
  return {
    ["--tx1" as string]: `${n(0, 12, 48).toFixed(0)}%`, ["--ty1" as string]: `${n(8, 30, 90).toFixed(0)}%`,
    ["--tx2" as string]: `${n(16, 55, 92).toFixed(0)}%`, ["--ty2" as string]: `${n(24, 5, 60).toFixed(0)}%`,
    ["--thue" as string]: `${n(4, -18, 22).toFixed(0)}deg`,
  };
}

/** Grey placeholder cards in the shape of the real ones, so the page does not jump when the list arrives. */
export function CardSkeletons({ count = 3 }: { count?: number }) {
  return (
    <div className="grid-cards" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div className="card item-card" key={i} aria-hidden="true">
          <span className="skeleton" style={{ height: 120, borderRadius: "calc(var(--r-lg) - 1px) calc(var(--r-lg) - 1px) 0 0" }} />
          <div className="item-card-body"><span className="skeleton" style={{ height: 20, width: "70%" }} /><span className="skeleton" style={{ height: 14, width: "55%" }} /></div>
          <div className="item-card-foot"><span className="skeleton" style={{ height: 40, width: 120 }} /></div>
        </div>
      ))}
    </div>
  );
}

export interface MoreMenuItem { label: string; onSelect: () => void; icon?: IconName; danger?: boolean; disabled?: boolean }
/**
 * A "⋯" button that opens a short list of less common actions, so cards and rows keep one clear main action.
 * Escape and a click outside close it; arrow keys move between the items.
 */
export function MoreMenu({ label, items, align = "right", text, icon }: {
  label: string; items: MoreMenuItem[]; align?: "left" | "right";
  /** Show a labelled button ("Download ▾") instead of the bare "⋯". */
  text?: string; icon?: IconName;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const list = Array.from(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? []);
      if (!list.length) return;
      e.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLElement);
      list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length].focus({ preventScroll: true });
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey, true); };
  }, [open]);
  return (
    <div className="menu more-menu" ref={root}>
      {text ? (
        <button ref={btn} type="button" className="btn btn-sm menu-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {icon && <Icon name={icon} size={16} />}{text}<Icon name="chevronDown" size={14} />
        </button>
      ) : (
        <button ref={btn} type="button" className="btn btn-ghost icon-btn more-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name="more" size={20} />
        </button>
      )}
      {open && (
        <div className={`menu-pop menu-pop-${align}`} role="menu" aria-label={label}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" disabled={it.disabled} className={`menu-item${it.danger ? " is-danger" : ""}`}
              onClick={() => { setOpen(false); it.onSelect(); }}>
              {it.icon && <Icon name={it.icon} size={18} />}{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
