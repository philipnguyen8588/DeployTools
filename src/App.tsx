import { Suspense, lazy, useEffect, useState } from "react";
import { Lock, Rocket, KeyRound, Loader2 } from "lucide-react";

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

import { useVault } from "./stores/vault";
import { useSessions } from "./stores/sessions";
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

  useEffect(() => {
    if (unlocked) {
      void refreshServers();
      void refreshProjects();
    }
  }, [unlocked, refreshServers, refreshProjects]);

  if (!unlocked) {
    return (
      <div className="flex h-screen flex-col">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <UnlockDialog />
        </div>
      </div>
    );
  }

  const active = tabs.find((t) => t.session.id === activeId);

  return (
    <div className="flex h-screen flex-col">
      <TitleBar
        rightSlot={
          <>
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

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          {view === "cloudflare" ? (
            <Suspense fallback={<LazyLoading />}>
              <CloudflarePanel />
            </Suspense>
          ) : view === "snippets" ? (
            <Suspense fallback={<LazyLoading />}>
              <SnippetManager />
            </Suspense>
          ) : (
            <>
              <TabBar />
              <div className="min-h-0 flex-1">
                {active ? (
                  <ServerTab key={active.session.id} tab={active} />
                ) : (
                  <EmptyState />
                )}
              </div>
            </>
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
