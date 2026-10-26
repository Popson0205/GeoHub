import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "./ui";

/** A small drawing pad. "Use signature" hands the host a PNG, which it stores like any other photo. */
export default function SignaturePad({ onDone, disabled }: { onDone: (png: Blob) => void; disabled?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [inked, setInked] = useState(false);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#14302a";
  }, []);

  const pos = (e: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const c = e.currentTarget, r = c.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height];
  };
  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = e.currentTarget.getContext("2d"); const [x, y] = pos(e);
    ctx?.beginPath(); ctx?.moveTo(x, y); ctx?.lineTo(x + 0.1, y + 0.1); ctx?.stroke();
    setInked(true);
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d"); const [x, y] = pos(e);
    ctx?.lineTo(x, y); ctx?.stroke();
  };
  const up = () => { drawing.current = false; };
  const clear = () => {
    const c = ref.current, ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); setInked(false);
  };
  const done = () => { ref.current?.toBlob((b) => { if (b) { onDone(b); clear(); } }, "image/png"); };

  return (
    <div className="sig">
      <canvas ref={ref} width={640} height={240} className="sig-canvas" role="img" aria-label="Signature area. Draw with a finger or a mouse."
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="row">
        <Button small onClick={clear} disabled={!inked || disabled}>Clear</Button>
        <Button small variant="primary" onClick={done} disabled={!inked || disabled}>Use signature</Button>
      </div>
    </div>
  );
}
