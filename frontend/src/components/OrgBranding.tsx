import { useRef, useState, type FormEvent } from "react";
import { Button, useToast } from "./ui";
import { loadApi } from "../lib/api";
import { contrast, parseHex, readable } from "../lib/brand";
import type { Org } from "../lib/types";

const GEOHUB_GREEN = "#17634c";

/** An organization's logo, colour and email sender (Organization plans). */
export default function OrgBranding({ org, onSaved }: { org: Org; onSaved: (o: Org) => void }) {
  const toast = useToast();
  const b = org.branding ?? { color: null, logo_url: null, sender_name: null, reply_to: null };
  const [color, setColor] = useState(b.color ?? "");
  const [sender, setSender] = useState(b.sender_name ?? "");
  const [reply, setReply] = useState(b.reply_to ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"save" | "logo" | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const valid = !color.trim() || !!parseHex(color.trim().startsWith("#") ? color.trim() : `#${color.trim()}`);
  const hex = valid && color.trim() ? (color.trim().startsWith("#") ? color.trim() : `#${color.trim()}`).toLowerCase() : "";
  const shown = hex ? readable(hex) : GEOHUB_GREEN;
  const darkened = !!hex && shown !== hex;
  const dirty = (hex || "") !== (b.color ?? "") || sender.trim() !== (b.sender_name ?? "") || reply.trim().toLowerCase() !== (b.reply_to ?? "");
  const msg = (e: unknown, what: string) => (e instanceof Error ? e.message : what);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!valid) { setError("Use a colour like #0b5cad."); return; }
    setBusy("save"); setError("");
    try {
      const o = await (await loadApi()).updateBranding({ color: hex, sender_name: sender.trim(), reply_to: reply.trim() });
      onSaved(o); setColor(o.branding?.color ?? ""); toast("Branding saved.", "success");
    } catch (err) { setError(msg(err, "Could not save.")); } finally { setBusy(null); }
  }
  async function upload(f: File | undefined) {
    if (!f) return;
    setBusy("logo"); setError("");
    try { onSaved(await (await loadApi()).uploadLogo(f)); toast("Logo updated.", "success"); }
    catch (err) { setError(msg(err, "Could not upload the logo.")); } finally { setBusy(null); if (file.current) file.current.value = ""; }
  }
  async function removeLogo() {
    setBusy("logo");
    try { onSaved(await (await loadApi()).removeLogo()); toast("Logo removed.", "success"); }
    catch (err) { setError(msg(err, "Could not remove the logo.")); } finally { setBusy(null); }
  }

  return (
    <section className="card org-branding" aria-labelledby="org-brand-h">
      <h2 id="org-brand-h">Branding</h2>
      <p className="field-hint">Your logo and colour appear for everyone in {org.name}, and on the emails Geohub sends them.</p>

      <div className="org-brand-logo">
        <div className="org-brand-logo-box">{b.logo_url ? <img src={b.logo_url} alt={`${org.name} logo`} /> : <span className="muted">No logo</span>}</div>
        <div className="org-brand-logo-actions">
          <input ref={file} id="brand-logo" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => void upload(e.target.files?.[0])} />
          <Button small busy={busy === "logo"} onClick={() => file.current?.click()}>{b.logo_url ? "Replace logo" : "Upload logo"}</Button>
          {b.logo_url && <Button small variant="ghost" onClick={() => void removeLogo()} disabled={busy === "logo"}>Remove</Button>}
          <span className="field-hint">PNG, JPEG or WebP, up to 1 MB. A wide logo on a clear background works best.</span>
        </div>
      </div>

      <form onSubmit={save} className="org-brand-form">
        <div className="field">
          <label htmlFor="brand-color">Colour</label>
          <div className="org-brand-color">
            <input type="color" aria-label="Pick a colour" value={hex || GEOHUB_GREEN} onChange={(e) => setColor(e.target.value)} />
            <input id="brand-color" value={color} placeholder={`${GEOHUB_GREEN} (Geohub green)`} spellCheck={false} maxLength={7}
              aria-invalid={!valid} aria-describedby="brand-color-hint" onChange={(e) => setColor(e.target.value)} />
            {color && <Button small variant="ghost" onClick={() => setColor("")}>Use Geohub green</Button>}
          </div>
          <span id="brand-color-hint" className="field-hint">
            {!valid ? "Use a colour like #0b5cad." : darkened ? `Darkened to ${shown} so white text on it stays readable.` : "Used for buttons, links and highlights."}
          </span>
          <div className="org-brand-preview" aria-hidden="true">
            <span className="org-brand-btn" style={{ background: shown }}>Button</span>
            <span style={{ color: shown, fontWeight: 600 }}>A link</span>
            <span className="muted tnum">{contrast(parseHex(shown)!, [255, 255, 255]).toFixed(1)}:1</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="brand-sender">Emails come from</label>
          <input id="brand-sender" maxLength={80} placeholder="Geohub" value={sender} onChange={(e) => setSender(e.target.value)} aria-describedby="brand-sender-hint" />
          <span id="brand-sender-hint" className="field-hint">The name people see in their inbox, e.g. "{org.name}". The address stays Geohub's, so emails keep arriving.</span>
        </div>
        <div className="field">
          <label htmlFor="brand-reply">Replies go to <span className="muted">(optional)</span></label>
          <input id="brand-reply" type="email" maxLength={200} placeholder="support@yourcompany.com" value={reply} onChange={(e) => setReply(e.target.value)} />
        </div>
        {error && <div className="field-error" role="alert">{error}</div>}
        <Button type="submit" busy={busy === "save"} disabled={!dirty}>Save branding</Button>
      </form>
    </section>
  );
}
