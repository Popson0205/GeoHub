import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button } from "./ui";

/** Small line icons on a 24px grid. They use the current text colour, so they follow the button state. */
const dot = (cx: number, cy: number, r = 1.9) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;
const ICONS = {
  select: <path d="M6 3l12 8.5-5.2 1.3 3 5.7-2.6 1.3-3-5.7L6 18z" />,
  point: <><path d="M12 21s-6.5-5.6-6.5-10.8a6.5 6.5 0 0113 0C18.5 15.4 12 21 12 21z" />{dot(12, 10.2, 2.3)}</>,
  line: <><path d="M4 18L9.5 8l5 6L20 5" />{dot(4, 18)}{dot(9.5, 8)}{dot(14.5, 14)}{dot(20, 5)}</>,
  polygon: <><path d="M5 9l7-5 7 4-2 11H7z" />{dot(5, 9)}{dot(12, 4)}{dot(19, 8)}{dot(17, 19)}{dot(7, 19)}</>,
  reshape: <><path d="M4 17.5L9 8l6 5.5L20 6" /><rect x="2.6" y="15.6" width="3.6" height="3.6" rx="0.5" fill="#fff" /><rect x="7.2" y="6.2" width="3.6" height="3.6" rx="0.5" fill="currentColor" /><rect x="13.2" y="11.7" width="3.6" height="3.6" rx="0.5" fill="#fff" /><rect x="18.2" y="4.2" width="3.6" height="3.6" rx="0.5" fill="#fff" /></>,
  move: <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />,
  split: <><path d="M3 12h6M15 12h6" />{dot(9, 12)}{dot(15, 12)}<path d="M12 3v18" strokeDasharray="2.2 2.2" /></>,
  cut: <><path d="M5 5h14v14H5z" strokeDasharray="0.1 0.1" opacity="0.55" /><path d="M2.5 21.5L21.5 2.5" strokeDasharray="3.4 2.2" /></>,
  merge: <path d="M3 5h10v5h8v10H11v-5H3z" />,
  duplicate: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7a2 2 0 002 2h3" /></>,
  delete: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  undo: <><path d="M9 4L4 9l5 5" /><path d="M4 9h9.5a6 6 0 010 12H10" /></>,
  redo: <><path d="M15 4l5 5-5 5" /><path d="M20 9h-9.5a6 6 0 000 12H14" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16" /></>,
  save: <><path d="M5 3h11l4 4v13a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1z" /><path d="M8 3v5h7V3M8 21v-7h8v7" /></>,
  snap: <><path d="M6 3v8a6 6 0 0012 0V3h-4v8a2 2 0 01-4 0V3z" /><path d="M6 7h4M14 7h4" /></>,
  multi: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M8 12.2l2.8 2.8L16 9.2" /></>,
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

/** A square button that shows a symbol. The name is for screen readers and the hover tooltip, and shows the shortcut key. */
export function IconButton({ icon, label, shortcut, active, danger, children, className = "", title, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: IconName; label: string; shortcut?: string; active?: boolean; danger?: boolean; busy?: boolean; children?: ReactNode;
}) {
  return (
    <Button {...rest} aria-label={label} title={title ?? (shortcut ? `${label} (${shortcut})` : label)} variant={active ? "primary" : danger ? "danger" : "default"}
      className={`icon-btn ${children ? "has-text" : ""} ${className}`}>
      <Icon name={icon} />{children}
    </Button>
  );
}
