import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { detailsText, isChunkError, reloadForUpdate, reportError } from "../lib/errorReport";
import { Icon } from "./icons";

/**
 * When a page fails to draw, show what happened and what to do instead of a blank screen. The error is
 * reported with a reference the person can quote. A new `resetKey` (the page address) clears it, so moving
 * to another page works again.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string; inline?: boolean }, { error: unknown; ref: string | null; key?: string }> {
  state: { error: unknown; ref: string | null; key?: string } = { error: null, ref: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) { return { error }; }
  static getDerivedStateFromProps(props: { resetKey?: string }, state: { error: unknown; key?: string }) {
    return props.resetKey !== state.key ? { error: null, ref: null, key: props.resetKey } : null;
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (isChunkError(error) && reloadForUpdate()) return;
    this.setState({ ref: reportError(error, isChunkError(error) ? "chunk" : "render", info.componentStack ?? undefined) });
  }
  render() {
    if (this.state.error == null) return this.props.children;
    return <ErrorScreen error={this.state.error} reference={this.state.ref} inline={this.props.inline} onRetry={() => this.setState({ error: null, ref: null })} />;
  }
}

export function ErrorScreen({ error, reference, inline, onRetry }: { error: unknown; reference: string | null; inline?: boolean; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  const updated = isChunkError(error);
  async function copy() {
    try { await navigator.clipboard.writeText(detailsText(reference, error)); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    catch { setCopied(false); }
  }
  return (
    <div className={`crash${inline ? " is-inline" : ""}`} role="alert">
      <span className="crash-icon" aria-hidden="true"><Icon name={updated ? "download" : "close"} size={26} /></span>
      <h1>{updated ? "Geohub has been updated" : "Something went wrong on this page"}</h1>
      <p>{updated
        ? "This page needs the new version. Reload to get it."
        : "It is not something you did. Your saved work is safe, and records waiting to send stay on this device."}</p>
      <div className="crash-actions">
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>Reload the page</button>
        {!updated && onRetry && <button type="button" className="btn" onClick={onRetry}>Try again</button>}
        <a className="btn btn-ghost" href="/">Go to the start</a>
      </div>
      {!updated && (
        <p className="crash-ref">
          {reference ? <>We have been told about it. If you contact support, quote <strong className="mono">{reference}</strong>.</> : "If it keeps happening, copy the details and send them to support."}
          {" "}<button type="button" className="link-btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy details"}</button>
          <span className="sr-only" aria-live="polite">{copied ? "Details copied" : ""}</span>
        </p>
      )}
    </div>
  );
}
