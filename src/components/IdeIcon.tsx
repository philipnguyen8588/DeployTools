import { Code2 } from "lucide-react";

interface Props {
  /** IDE key from the backend (`vscode`, `pycharm`, `antigravity`,
   *  `intellij`, or any custom key — custom falls back to the generic
   *  code icon). */
  ideKey: string;
  className?: string;
}

/**
 * Brand-ish mark for each supported IDE. Pure inline SVG so there's no
 * image-asset pipeline to maintain, and the icons scale + theme via
 * `currentColor` / explicit brand fills.
 *
 * These are simplified shapes inspired by each IDE's public brand —
 * not an exact trace. Goal is "instantly recognisable at 14 px in the
 * dropdown", not pixel-perfect copy of the official logo.
 */
export function IdeIcon({ ideKey, className = "h-3.5 w-3.5" }: Props) {
  switch (ideKey) {
    case "vscode":
      return (
        // VSCode — blue angular ribbon; Microsoft trademark.
        <svg viewBox="0 0 100 100" className={className} aria-hidden>
          <path
            d="M70 8 L90 18 L90 82 L70 92 L22 56 L10 64 L10 36 L22 44 L70 8 Z"
            fill="#0078D4"
          />
          <path d="M70 30 L70 70 L40 50 Z" fill="#0062a3" />
        </svg>
      );
    case "pycharm":
      return (
        // PyCharm — JetBrains tri-color wedge (green/yellow/blue).
        <svg viewBox="0 0 100 100" className={className} aria-hidden>
          <rect x="4" y="4" width="92" height="92" rx="10" fill="#111" />
          <polygon points="10,10 50,10 10,60" fill="#21D789" />
          <polygon points="50,10 90,10 90,60 50,50" fill="#FCF84A" />
          <polygon points="10,60 50,50 90,60 90,90 10,90" fill="#09B3FF" />
        </svg>
      );
    case "intellij":
      return (
        // IntelliJ IDEA — red/orange/blue wedges, JetBrains style.
        <svg viewBox="0 0 100 100" className={className} aria-hidden>
          <rect x="4" y="4" width="92" height="92" rx="10" fill="#111" />
          <polygon points="10,10 50,10 10,60" fill="#FF318C" />
          <polygon points="50,10 90,10 90,60 50,50" fill="#FE2857" />
          <polygon points="10,60 50,50 90,60 90,90 10,90" fill="#FCF84A" />
        </svg>
      );
    case "antigravity":
      // Google Antigravity — speculative mark (gradient orb on dark).
      return (
        <svg viewBox="0 0 100 100" className={className} aria-hidden>
          <defs>
            <linearGradient id="ag-g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#4285F4" />
              <stop offset="100%" stopColor="#34A853" />
            </linearGradient>
          </defs>
          <rect x="4" y="4" width="92" height="92" rx="16" fill="#0F172A" />
          <circle cx="50" cy="50" r="26" fill="url(#ag-g)" />
          <circle cx="42" cy="42" r="8" fill="#fff" opacity="0.6" />
        </svg>
      );
    default:
      return <Code2 className={className} />;
  }
}
