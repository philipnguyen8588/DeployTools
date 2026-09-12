import { Suspense, lazy, useEffect, useState } from "react";
import {
  Lock,
  Rocket,
  KeyRound,
  Loader2,
  Settings,
  HelpCircle,
} from "lucide-react";

/**
 * Swallow every keyboard combo that could trigger DevTools when running
 * a production build. Tauri 2 already ships Release with the `devtools`
 * feature disabled, but the WebView2 host can still honour F12 / the
 * right-click "Inspect" menu if the OS Edge version is set up for it —
 * this is a belt-and-suspenders net at the frontend.
 *
 * Only active when Vite built in production mode, so dev mode (`npm run
 * tauri:dev`) keeps F12 working for debugging.
 */
function installDevToolsGuard() {
  if (!import.meta.env.PROD) return;
  const block = (e: KeyboardEvent) => {
    const k = e.key;
    // F12 and Fn combinations vary between keyboards; check by key + code.
    const isF12 = k === "F12" || e.code === "F12";
    const isInspect =
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      ["i", "I", "j", "J", "c", "C"].includes(k);
    const isViewSource =
      (e.ctrlKey || e.metaKey) && !e.shiftKey && (k === "u" || k === "U");
    if (isF12 || isInspect || isViewSource) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener("keydown", block, { capture: true });
}
installDevToolsGuard();

import { UnlockDialog } from "./components/UnlockDialog";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { ServerTab } from "./components/ServerTab";
import { TitleBar } from "./components/TitleBar";
import { StatusBar } from "./components/StatusBar";
import { Button } from "./components/ui/button";

// Lazy-load view-level panels — they only mount when the user
// navigates to their sidebar entry (or opens the dialog), saving the
// initial JS heap + V8 parse cost at startup.
const CloudflarePanel = lazy(() =>
  import("./components/CloudflarePanel").then((m) => ({
    default: m.CloudflarePanel,
  })),
);
const SnippetManager = lazy(() =>
  import("./components/SnippetManager").then((m) => ({
    default: m.SnippetManager,
  })),
);
const ChangePasswordDialog = lazy(() =>
  import("./components/ChangePasswordDialog").then((m) => ({
    default: m.ChangePasswordDialog,
  })),
);
const SettingsDialog = lazy(() =>
  import("./components/SettingsDialog").then((m) => ({
    default: m.SettingsDialog,
  })),
);
const HelpDialog = lazy(() =>
  import("./components/HelpDialog").then((m) => ({
    default: m.HelpDialog,
  })),
);

import { useVault } from "./stores/vault";
import { useSessions } from "./stores/sessions";
import { cn } from "./lib/utils";
import * as api from "./lib/api";
import { useServers } from "./stores/servers";
import { useProjects } from "./stores/projects";
import { useView } from "./stores/view";

export default function App() {
  const { unlocked, lock } = useVault();
  const { tabs, activeId } = useSessions();
  const { refresh: refreshServers } = useServers();
  const { refresh: refreshProjects } = useProjects();
  const view = useView((s) => s.view);
  const [changingPassword, setChangingPassword] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const helpButton = (
    <Button
      size="icon"
      variant="ghost"
      aria-label="Help"
      title="Help · shortcuts · about"
      onClick={() => setHelpOpen(true)}
    >
      <HelpCircle className="h-4 w-4" />
    </Button>
  );

  const gearButton = (
    <Button
      size="icon"
      variant="ghost"
      aria-label="Settings"
      title="Settings"
      onClick={() => setSettingsOpen(true)}
    >
      <Settings className="h-4 w-4" />
    </Button>
  );

  const floatingDialogs = (
    <>
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
      {helpOpen && (
        <Suspense fallback={null}>
          <HelpDialog onClose={() => setHelpOpen(false)} />
        </Suspense>
      )}
    </>
  );

  useEffect(() => {
    if (unlocked) {
      void refreshServers();
      void refreshProjects();
      // Fire-and-forget: on first unlock after install, auto-pin any
      // detected IDE paths so the deploy-bar IDE menu works without
      // the user visiting Settings.
      api.autopopulateIdePaths().catch(() => {});
    }
  }, [unlocked, refreshServers, refreshProjects]);

  // Idle-timeout watcher. Every 60 s, scan open tabs and close any that
  // haven't had terminal I/O in `idleTimeoutMin` minutes (read fresh on
  // each tick — so changes made in the Settings dialog apply within a
  // minute, no restart needed). `0` disables the watcher.
  useEffect(() => {
    if (!unlocked) return;
    let idleTimeoutMin = 30;
    const reloadCfg = async () => {
      try {
        idleTimeoutMin = (await api.getSettings()).idle_timeout_minutes;
      } catch {
        /* fallback to 30 */
      }
    };
    void reloadCfg();
    const tick = async () => {
      await reloadCfg();
      if (idleTimeoutMin <= 0) return; // disabled
      const ms = idleTimeoutMin * 60_000;
      const now = Date.now();
      const tabs = useSessions.getState().tabs;
      for (const t of tabs) {
        if (t.status !== "connected") continue;
        if (now - t.lastActivityAt > ms) {
          void useSessions
            .getState()
            .markDisconnected(
              t.session.id,
              `Auto-disconnected after ${idleTimeoutMin} min idle.`,
            );
        }
      }
    };
    const h = setInterval(() => void tick(), 60_000);
    return () => clearInterval(h);
  }, [unlocked]);

  if (!unlocked) {
    return (
      <div className="flex h-screen flex-col">
        <TitleBar
          rightSlot={
            <>
              {helpButton}
              {gearButton}
            </>
          }
        />
        <div className="min-h-0 flex-1">
          <UnlockDialog />
        </div>
        {floatingDialogs}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <TitleBar
        rightSlot={
          <>
            {helpButton}
            {gearButton}
            <Button
              size="icon"
              variant="ghost"
              aria-label="Change master password"
              title="Change master password"
              onClick={() => setChangingPassword(true)}
            >
              <KeyRound className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Lock vault"
              title="Lock vault"
              onClick={() => void lock()}
            >
              <Lock className="h-4 w-4" />
            </Button>
          </>
        }
      />

      {changingPassword && (
        <Suspense fallback={null}>
          <ChangePasswordDialog onClose={() => setChangingPassword(false)} />
        </Suspense>
      )}
      {floatingDialogs}

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* The server-tabs tree stays ALWAYS mounted — we only hide it
              with CSS when another top-level view (Snippets / Cloudflare)
              is active. Unmounting it would tear down every terminal's
              shell channel + xterm scrollback and force a reconnect when
              the user comes back. Snippets/Cloudflare hold no SSH state,
              so they're free to mount/unmount on demand. */}
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              view !== "tabs" && "hidden",
            )}
          >
            <TabBar />
            {/* Keep every session tab mounted once opened. We toggle
                visibility with CSS instead of conditional rendering
                so switching between servers doesn't unmount the
                terminals / file browsers — they'd otherwise lose
                scrollback + any in-flight work. */}
            <div className="relative min-h-0 flex-1">
              {tabs.length === 0 ? (
                <EmptyState />
              ) : (
                tabs.map((t) => (
                  <div
                    key={t.session.id}
                    className={cn(
                      "absolute inset-0",
                      t.session.id === activeId ? "block" : "hidden",
                    )}
                  >
                    <ServerTab
                      tab={t}
                      isActive={t.session.id === activeId}
                    />
                  </div>
                ))
              )}
            </div>
          </div>

          {view === "cloudflare" && (
            <Suspense fallback={<LazyLoading />}>
              <CloudflarePanel />
            </Suspense>
          )}
          {view === "snippets" && (
            <Suspense fallback={<LazyLoading />}>
              <SnippetManager />
            </Suspense>
          )}
        </main>
      </div>

      <StatusBar />
    </div>
  );
}

/** Minimal skeleton shown while a lazy-loaded chunk streams in. */
function LazyLoading() {
  return (
    <div className="grid h-full place-items-center text-sm text-muted-foreground">
      <span className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="grid h-full place-items-center bg-gradient-to-br from-background to-muted/30">
      <div className="max-w-md space-y-2 text-center">
        <Rocket className="mx-auto h-10 w-10 text-primary/60" />
        <h2 className="text-lg font-semibold">No active session</h2>
        <p className="text-sm text-muted-foreground">
          Add a server in the sidebar, then click the <strong>▶</strong> button
          to open a tab. Each tab gives you a remote file browser, an
          integrated SSH terminal, and folder diff tools. You can open
          multiple tabs to the same server or to different servers at once.
        </p>
      </div>
    </div>
  );
}
