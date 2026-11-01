import qrcode from "qrcode-generator";
import { useMemo } from "react";
import { download } from "../lib/csv";
import { Icon } from "./icons";
import { Button } from "./ui";

/** The squares of a QR code as one SVG path, with the four-square quiet zone scanners need around it. */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), q = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  return { size: n + 2 * q, d };
}

/**
 * Ways to get a form to collectors besides copying the link: WhatsApp (where most field teams talk),
 * the phone's own Share menu, and a QR code to print or show at a training session.
 */
export default function ShareOptions({ url, formName, projectName }: { url: string; formName: string; projectName?: string }) {
  const message = `Please fill in “${formName}”${projectName ? ` for ${projectName}` : ""} on Geohub. It works on your phone, even without signal once opened:\n${url}`;
  const qr = useMemo(() => qrPath(url), [url]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.size} ${qr.size}" width="${qr.size * 12}" height="${qr.size * 12}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${qr.d}" fill="#000"/></svg>`;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const slug = formName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "form";

  return (
    <div className="share-options">
      <div className="share-buttons">
        <a className="btn btn-whatsapp" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm0 18.2a8.2 8.2 0 01-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1112 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 01-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 00-.7.3 3 3 0 00-.9 2.2 5.1 5.1 0 001.1 2.7 11.6 11.6 0 004.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.2-.2-.5-.3z" /></svg>
          Send on WhatsApp
        </a>
        {canShare && <Button onClick={() => { navigator.share({ title: formName, text: message, url }).catch(() => undefined); }}><Icon name="share" size={18} />Share…</Button>}
      </div>
      <div className="share-qr">
        <svg className="qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={`QR code that opens ${formName}`} shapeRendering="crispEdges">
          <rect width="100%" height="100%" fill="#fff" /><path d={qr.d} fill="#000" />
        </svg>
        <div className="share-qr-text">
          <strong>Scan to open the form</strong>
          <span className="muted">Show it at a training session, or print it on a poster. Any phone camera can read it.</span>
          <Button small onClick={() => download(`${slug}-qr.svg`, svg, "image/svg+xml")}><Icon name="download" size={16} />Download QR code</Button>
        </div>
      </div>
    </div>
  );
}
