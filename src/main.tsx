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
