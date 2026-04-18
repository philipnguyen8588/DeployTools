import { useState } from "react";
import { Rocket, FlaskConical, Zap, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { motion } from "framer-motion";

import * as api from "@/lib/api";
import { Button } from "./ui/button";
import { useConfirm } from "./ConfirmDialog";

interface Props {
  projectId: string | null;
  projectName: string;
  sessionId?: string;
}

/**
 * Top bar inside a server tab — the project's deploy controls.
 *
 * Three actions:
 *   - Sync (SFTP)     : native-Rust smart sync, the default. No rsync needed.
 *   - Sync + delete   : same, but also removes remote-only files.
 *   - Deploy (rsync)  : advanced mode. Requires rsync on PATH / bundled.
 *   - Dry run (rsync) : rsync --dry-run preview.
 */
export function DeployPanel({ projectId, projectName, sessionId }: Props) {
  const [running, setRunning] = useState(false);
  const confirm = useConfirm();

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

  async function rsync(dryRun: boolean) {
    if (!projectId || running) return;

    if (!dryRun) {
      const ok = await confirm({
        title: "Deploy with rsync?",
        description: (
          <div className="space-y-1.5">
            <div>
              Requires <code className="font-mono">rsync</code> on the
              system (or bundled). If <code className="font-mono">--delete</code>{" "}
              is in the project's rsync flags, remote-only files will be
              permanently removed.
            </div>
          </div>
        ),
        confirmText: "Deploy now",
        danger: true,
      });
      if (!ok) return;
    }

    setRunning(true);
    const id = toast.loading(`rsync ${dryRun ? "dry-run" : "deploy"}…`);
    try {
      const code = await api.deployRsync(projectId, dryRun);
      toast.success(`rsync finished (exit ${code})`, { id });
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
      className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2"
    >
      <span className="text-xs font-medium">{projectName}</span>
      <div className="flex-1" />

      <Button
        size="sm"
        disabled={running}
        onClick={() => syncSftp(false)}
        title="Upload new/changed files via SFTP"
      >
        <Zap className="mr-1.5 h-3.5 w-3.5" />
        Sync
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={running}
        onClick={() => syncSftp(true)}
        title="Sync and delete remote files that don't exist locally"
      >
        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
        Sync + delete
      </Button>

      <div className="mx-2 h-5 w-px bg-border" />

      <Button
        size="sm"
        variant="outline"
        disabled={running}
        onClick={() => rsync(true)}
        title="Preview with rsync --dry-run"
      >
        <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
        Dry run (rsync)
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={running}
        onClick={() => rsync(false)}
        title="Run rsync (requires rsync binary)"
      >
        <Rocket className="mr-1.5 h-3.5 w-3.5" />
        rsync
      </Button>
    </motion.div>
  );
}
