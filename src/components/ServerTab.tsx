import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { useMemo, useState } from "react";
import { PlugZap, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { RemoteFileBrowser } from "./RemoteFileBrowser";
import { LocalFileBrowser } from "./LocalFileBrowser";
import { DeployPanel } from "./DeployPanel";
import { BottomPanel } from "./BottomPanel";
import { Button } from "./ui/button";
import { useProjects } from "@/stores/projects";
import { useSessions, type OpenTab } from "@/stores/sessions";

interface Props {
  tab: OpenTab;
  /** Whether this ServerTab is the one currently shown in the TabBar.
   *  Inactive tabs stay mounted for state preservation but MUST NOT
   *  register any global (window-level) keyboard listeners — otherwise
   *  a Ctrl+Shift+S keystroke would open N modals on an N-tab session. */
  isActive?: boolean;
}

/**
 * Content of a single server tab:
 *   1. Top bar: project info + deploy buttons
 *   2. Upper pane: Local ↔ Remote file browsers (JetBrains-style)
 *   3. Lower pane: tabbed panel with N terminals + an Activity log
 *
 * If the backend session got torn down (idle timeout, network drop),
 * the tab dims and an overlay is rendered with a Reconnect button.
 * File browsers + terminals are still mounted underneath — but become
 * active again only after the user clicks Reconnect.
 */
export function ServerTab({ tab, isActive = true }: Props) {
  const { projects } = useProjects();
  const { updateRemotePath, updateLocalPath, reconnect } = useSessions();
  const [reconnecting, setReconnecting] = useState(false);

  const project = useMemo(
    () => projects.find((p) => p.id === tab.session.project_id) ?? null,
    [projects, tab.session.project_id],
  );

  const isSsh = tab.session.protocol === "ssh";
  const dim = tab.status !== "connected";

  async function handleReconnect() {
    setReconnecting(true);
    try {
      await reconnect(tab.session.id);
      toast.success("Reconnected");
    } catch (e) {
      toast.error(`Reconnect failed: ${e}`);
    } finally {
      setReconnecting(false);
    }
  }

  return (
    <div className="relative flex h-full flex-col">
      <div
        className={dim ? "pointer-events-none flex h-full flex-col opacity-40" : "flex h-full flex-col"}
      >
        {/* DeployPanel uses rsync + SSH — only show for SSH sessions. */}
        {isSsh && (
          <DeployPanel
            projectId={project?.id ?? null}
            projectName={project?.name ?? ""}
            sessionId={tab.session.id}
          />
        )}

        {/* autoSaveId persists the user's drag ratio per-session to
            localStorage. The terminal pane is the default-dominant one
            (~70%) because that's where most interaction happens; the
            file browsers can be grown back when needed. */}
        <PanelGroup
          direction="vertical"
          className="flex-1"
          autoSaveId="deploy-tools/server-tab/vsplit"
        >
          {/* TOP: dual-pane file browsers */}
          <Panel
            id="browsers"
            order={1}
            defaultSize={30}
            minSize={15}
            collapsible
          >
            <PanelGroup direction="horizontal">
              <Panel defaultSize={50} minSize={20}>
                <LocalFileBrowser
                  sessionId={tab.session.id}
                  projectId={project?.id ?? null}
                  remoteBase={project?.remote_path ?? "/"}
                  relativePath={tab.localPath}
                  onRelativePathChange={(p) => updateLocalPath(tab.session.id, p)}
                />
              </Panel>
              <PanelResizeHandle className="w-px bg-border hover:bg-primary/50" />
              <Panel defaultSize={50} minSize={20}>
                <RemoteFileBrowser
                  sessionId={tab.session.id}
                  path={tab.remotePath}
                  onPathChange={(p) => updateRemotePath(tab.session.id, p)}
                  projectId={project?.id ?? null}
                  projectRemoteBase={project?.remote_path ?? null}
                />
              </Panel>
            </PanelGroup>
          </Panel>

          <PanelResizeHandle className="h-px bg-border hover:bg-primary/50" />

          {/* BOTTOM: Terminals + Activity tabs — the default-dominant pane. */}
          <Panel id="bottom" order={2} defaultSize={70} minSize={20}>
            <BottomPanel
              sessionId={tab.session.id}
              serverId={tab.session.server_id}
              projectId={project?.id ?? null}
              projectRemoteBase={project?.remote_path ?? null}
              protocol={tab.session.protocol}
              isActive={isActive}
            />
          </Panel>
        </PanelGroup>
      </div>

      {/* Disconnected overlay — sits on top of the whole tab content.
          Click-through is disabled on the dimmed content (opacity-40 +
          pointer-events-none above) so accidental clicks don't reach the
          idle file browser. */}
      {dim && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background/70 backdrop-blur-sm">
          <div className="max-w-sm rounded-lg border bg-card p-6 text-center shadow-lg">
            {tab.status === "reconnecting" || reconnecting ? (
              <>
                <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-primary" />
                <div className="text-sm font-semibold">Reconnecting…</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {tab.label}
                </div>
              </>
            ) : (
              <>
                <PlugZap className="mx-auto mb-3 h-8 w-8 text-yellow-500" />
                <div className="text-sm font-semibold">Session disconnected</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {tab.disconnectReason ?? "The SSH channel was closed."}
                </div>
                <Button
                  className="mt-4"
                  onClick={() => void handleReconnect()}
                  disabled={reconnecting}
                >
                  Reconnect
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
