import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { useMemo } from "react";

import { RemoteFileBrowser } from "./RemoteFileBrowser";
import { LocalFileBrowser } from "./LocalFileBrowser";
import { DeployPanel } from "./DeployPanel";
import { BottomPanel } from "./BottomPanel";
import { useProjects } from "@/stores/projects";
import { useSessions, type OpenTab } from "@/stores/sessions";

interface Props {
  tab: OpenTab;
}

/**
 * Content of a single server tab:
 *   1. Top bar: project info + deploy buttons
 *   2. Upper pane: Local ↔ Remote file browsers (JetBrains-style)
 *   3. Lower pane: tabbed panel with N terminals + an Activity log
 */
export function ServerTab({ tab }: Props) {
  const { projects } = useProjects();
  const { updateRemotePath, updateLocalPath } = useSessions();

  const project = useMemo(
    () => projects.find((p) => p.id === tab.session.project_id) ?? null,
    [projects, tab.session.project_id],
  );

  return (
    <div className="flex h-full flex-col">
      <DeployPanel
        projectId={project?.id ?? null}
        projectName={project?.name ?? ""}
        sessionId={tab.session.id}
      />

      <PanelGroup direction="vertical" className="flex-1">
        {/* TOP: dual-pane file browsers */}
        <Panel defaultSize={60} minSize={20}>
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

        {/* BOTTOM: Terminals + Activity tabs */}
        <Panel defaultSize={40} minSize={15}>
          <BottomPanel
            sessionId={tab.session.id}
            projectId={project?.id ?? null}
            projectRemoteBase={project?.remote_path ?? null}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
