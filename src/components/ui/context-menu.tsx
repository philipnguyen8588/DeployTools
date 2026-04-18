import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  /** When true, a horizontal divider is rendered in place of the label. */
  separator?: boolean;
  disabled?: boolean;
  danger?: boolean;
}

interface Props {
  /** Screen coordinates (clientX/clientY from the event). */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Lightweight right-click menu. Renders via a portal to `document.body`
 * so it escapes any `overflow: hidden` ancestor. Clicking outside or
 * pressing Escape closes it.
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Attach on the next tick so the mousedown that opened us
    // doesn't also close it.
    const t = setTimeout(() => {
      document.addEventListener("mousedown", onDocClick);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep the menu inside the viewport.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const menuW = 200;
  const menuH = items.length * 28 + 8;
  const left = Math.min(x, vw - menuW - 4);
  const top = Math.min(y, vh - menuH - 4);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] min-w-[180px] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left, top }}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition",
              it.disabled
                ? "cursor-not-allowed opacity-50"
                : "hover:bg-accent hover:text-accent-foreground",
              it.danger && !it.disabled && "text-destructive",
            )}
            onClick={() => {
              if (it.disabled) return;
              it.onClick();
              onClose();
            }}
          >
            {it.icon && <span className="shrink-0">{it.icon}</span>}
            <span className="flex-1 truncate">{it.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
