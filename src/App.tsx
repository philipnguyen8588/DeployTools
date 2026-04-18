import { useEffect, useState } from "react";
import { Lock, Rocket, KeyRound } from "lucide-react";

import { UnlockDialog } from "./components/UnlockDialog";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { ServerTab } from "./components/ServerTab";
import { TitleBar } from "./components/TitleBar";
import { StatusBar } from "./components/StatusBar";
import { CloudflarePanel } from "./components/CloudflarePanel";
import { SnippetManager } from "./components/SnippetManager";
import { ChangePasswordDialog } from "./components/ChangePasswordDialog";
import { Button } from "./components/ui/button";

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
        <ChangePasswordDialog onClose={() => setChangingPassword(false)} />
      )}

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          {view === "cloudflare" ? (
            <CloudflarePanel />
          ) : view === "snippets" ? (
            <SnippetManager />
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
