import { useEffect, useState } from "react";
import {
  Zap,
  Trash2,
  FolderOpen,
  Network,
  Code2,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { motion } from "framer-motion";

import * as api from "@/lib/api";
import { useProjects } from "@/stores/projects";
import { useSessions } from "@/stores/sessions";
import { Button } from "./ui/button";
import { ContextMenu, type ContextMenuItem } from "./ui/context-menu";
import { useConfirm } from "./ConfirmDialog";
import { IdeIcon } from "./IdeIcon";

interface Props {
  projectId: string | null;
  projectName: string;
  sessionId?: string;
}

/**
 * Top bar inside a server tab — the project's deploy controls.
 *
 * Two actions, both native-Rust SFTP sync (no external rsync binary):
 *   - Sync           : upload every new or changed file.
 *   - Sync + delete  : same, plus remove remote files that don't exist locally.
 */
export function DeployPanel({ projectId, projectName, sessionId }: Props) {
  const [running, setRunning] = useState(false);
  const confirm = useConfirm();
  const project = useProjects((s) =>
    s.projects.find((p) => p.id === projectId),
  );
  const sessionTab = useSessions((s) =>
    s.tabs.find((t) => t.session.id === sessionId),
  );
  const serverId = sessionTab?.session.server_id ?? null;

  async function openLocalTerminal() {
    try {
      await api.openLocalTerminal(project?.local_path ?? undefined);
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function openSshTerminal() {
    if (!serverId) return;
    try {
      await api.openSshTerminal(serverId, project?.remote_path ?? undefined);
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  // IDE launcher — load the list once + refresh when the menu opens so
  // changes in Settings are reflected without an app restart.
  const [ides, setIdes] = useState<api.IdeEntry[]>([]);
  const [ideMenu, setIdeMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  useEffect(() => {
    api.listIdes().then(setIdes).catch(() => {});
  }, []);

  async function openIde(key: string, label: string) {
    if (!project?.local_path) {
      toast.error("No project local path");
      return;
    }
    try {
      await api.openIde(key, project.local_path);
    } catch (e) {
      toast.error(`${label}: ${e}`);
    }
  }

  async function openIdeMenu(anchor: HTMLElement) {
    // Refresh the list so Settings changes apply immediately.
    try {
      const fresh = await api.listIdes();
      setIdes(fresh);
    } catch {
      /* keep whatever we had */
    }
    const r = anchor.getBoundingClientRect();
    setIdeMenu({ x: r.left, y: r.bottom + 2 });
  }

  const ideMenuItems: ContextMenuItem[] = ides.map((ide) => {
    const available = !!(ide.configured || ide.detected);
    return {
      label: ide.label + (available ? "" : " (not installed)"),
      icon: <IdeIcon ideKey={ide.key} />,
      disabled: !available,
      onClick: () => void openIde(ide.key, ide.label),
    };
  });

  async function syncSftp(deleteExtraneous: boolean) {
    if (!projectId || running) return;

    const ok = await confirm({
      title: deleteExtraneous
        ? "Sync (with deletion of remote extras)?"
        : "Sync project to server?",
      description: (
        <div className="space-y-1.5">
          <div>
            This will upload every new or changed local file via SFTP,
            skipping files whose size already matches the server.
          </div>
          {deleteExtraneous && (
            <div className="rounded border border-destructive/50 bg-destructive/10 px-2 py-1 text-sm text-destructive">
              <strong>Files on the server that don't exist locally will
              be permanently deleted.</strong>
            </div>
          )}
          <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
            project: {projectName}
          </div>
        </div>
      ),
      confirmText: deleteExtraneous ? "Sync + delete" : "Sync",
      danger: deleteExtraneous,
    });
    if (!ok) return;

    setRunning(true);
    const id = toast.loading(`Sync${deleteExtraneous ? " + delete" : ""}…`);
    try {
      const s = await api.deploySync(projectId, sessionId ?? null, deleteExtraneous);
      toast.success(
        `✓ ${s.uploaded} uploaded · ${s.deleted} deleted · ${s.unchanged} unchanged`,
        { id },
      );
    } catch (e) {
      toast.error(`${e}`, { id });
    } finally {
      setRunning(false);
    }
  }

  if (!projectId) {
    return (
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Open a session from a project to enable deploy.
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-wrap items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5"
    >
      <span className="text-xs font-medium">{projectName}</span>
      <div className="flex-1" />

      <Button
        size="xs"
        variant="outline"
        onClick={openLocalTerminal}
        title="Open the system terminal (Windows Terminal / cmd) at the project's local path"
      >
        <FolderOpen className="mr-1 h-3 w-3" />
        Local
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={!serverId}
        onClick={openSshTerminal}
        title="Open a new system terminal running ssh to this server"
      >
        <Network className="mr-1 h-3 w-3" />
        SSH
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={!project?.local_path}
        onClick={(e) => void openIdeMenu(e.currentTarget)}
        title="Open the project's local folder in an IDE"
      >
        <Code2 className="mr-1 h-3 w-3" />
        IDE
        <ChevronDown className="ml-0.5 h-3 w-3 opacity-70" />
      </Button>

      <div className="mx-1 h-4 w-px bg-border" />

      <Button
        size="xs"
        disabled={running}
        onClick={() => syncSftp(false)}
        title="Upload new/changed files via SFTP"
      >
        <Zap className="mr-1 h-3 w-3" />
        Sync
      </Button>
      <Button
        size="xs"
        variant="destructive"
        disabled={running}
        onClick={() => syncSftp(true)}
        title="Sync and delete remote files that don't exist locally"
      >
        <Trash2 className="mr-1 h-3 w-3" />
        Sync + delete
      </Button>

      {ideMenu && (
        <ContextMenu
          x={ideMenu.x}
          y={ideMenu.y}
          items={ideMenuItems}
          onClose={() => setIdeMenu(null)}
        />
      )}
    </motion.div>
  );
}
