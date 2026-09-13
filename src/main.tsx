import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";

import App from "./App";
import { ConfirmProvider } from "./components/ConfirmDialog";
import "./index.css";
import "@xterm/xterm/css/xterm.css";

// ---------------------------------------------------------------------------
// Globally suppress the browser's native context menu (Inspect / Reload / …).
// Our own right-click menus call `preventDefault()` on their handler, so this
// listener only affects areas that DON'T register a custom menu.
//
// Exceptions are opt-in via `data-allow-contextmenu` on any element (or an
// ancestor) — useful for <input>/<textarea> copy-paste menus if we add any.
// ---------------------------------------------------------------------------
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest("[data-allow-contextmenu]")) return;
  e.preventDefault();
});

// macOS-only: mark the root so we can round the window corners in the
// current macOS style. The window itself is transparent on macOS (see
// tauri.macos.conf.json); this class clips the opaque app shell so the
// four corners show the desktop through them. Detected from the WebView
// user agent — same heuristic the title bar uses for traffic lights.
if (typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("is-mac");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <ConfirmProvider>
        <App />
        <Toaster richColors position="bottom-right" theme="system" />
      </ConfirmProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
