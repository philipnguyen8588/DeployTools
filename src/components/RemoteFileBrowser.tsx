import { useCallback, useEffect, useState } from "react";
import {
  Folder,
  FileText,
  ArrowUp,
  RefreshCcw,
  FolderPlus,
  Trash2,
  Upload,
  Download,
  GitCompare,
  Edit3,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import * as api from "@/lib/api";
import type { RemoteEntry } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn, formatBytes, formatMtime } from "@/lib/utils";
import { ContextMenu, type ContextMenuItem } from "./ui/context-menu";
import { CompareDialog } from "./CompareDialog";
import { CompareFolderDialog } from "./CompareFolderDialog";
import { FolderGit2 } from "lucide-react";
import { useConfirm } from "./ConfirmDialog";

interface Props {
  sessionId: string;
  path: string;
  onPathChange: (p: string) => void;
  /** Project info (for compare / mirror-relative path) — optional. */
  projectId?: string | null;
  projectRemoteBase?: string | null;
}

interface MenuState {
  x: number;
  y: number;
  entry: RemoteEntry;
}

export function RemoteFileBrowser({
  sessionId,
  path,
  onPathChange,
  projectId,
  projectRemoteBase,
}: Props) {
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<RemoteEntry | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [compareFor, setCompareFor] = useState<string | null>(null);
  const [compareFolderFor, setCompareFolderFor] = useState<string | null>(null);
  const confirm = useConfirm();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.sftpList(sessionId, path);
      setEntries(res);
    } catch (e) {
      toast.error(`List failed: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId, path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function cdUp() {
    if (path === "/" || path === "") return;
    const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
    onPathChange(parent);
  }

  async function uploadFile() {
    const selected = await openDialog({ multiple: false, title: "Upload file" });
    if (typeof selected !== "string") return;
    const name = selected.split(/[\\/]/).pop() ?? "upload";
    const remote = path.replace(/\/+$/, "") + "/" + name;
    const ok = await confirm({
      title: "Upload file to server?",
      description: (
        <div className="space-y-1.5">
          <div>This will overwrite the remote copy if it already exists.</div>
          <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
            {selected} → {remote}
          </div>
        </div>
      ),
      confirmText: "Upload",
    });
    if (!ok) return;

    const p = toast.loading(`Uploading ${name}…`);
    try {
      await api.sftpUpload(sessionId, selected, remote);
      toast.success("Uploaded", { id: p });
      await refresh();
    } catch (e) {
      toast.error(`${e}`, { id: p });
    }
  }

  async function mkdir() {
    const name = prompt("New folder name:");
    if (!name) return;
    const p = path.replace(/\/+$/, "") + "/" + name;
    try {
      await api.sftpMkdir(sessionId, p);
      await refresh();
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function removeEntry(e: RemoteEntry) {
    const ok = await confirm({
      title: e.is_dir ? "Delete folder on server?" : "Delete file on server?",
      description: (
        <div className="space-y-1.5">
          <div>
            {e.is_dir
              ? "This will recursively delete the folder and everything inside it. This cannot be undone."
              : "This will delete the remote file. This cannot be undone."}
          </div>
          <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
            {e.full_path}
          </div>
        </div>
      ),
      confirmText: e.is_dir ? "Delete folder" : "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.sftpRm(sessionId, e.full_path, e.is_dir);
      if (selection?.full_path === e.full_path) setSelection(null);
      await refresh();
    } catch (err) {
      toast.error(`${err}`);
    }
  }

  async function downloadEntry(e: RemoteEntry) {
    if (e.is_dir) return;
    const dst = await saveDialog({
      defaultPath: e.name,
      title: `Save ${e.name} to…`,
    });
    if (typeof dst !== "string") return;

    const ok = await confirm({
      title: "Download file?",
      description: (
        <div className="space-y-1.5">
          <div>If the destination file exists, it will be overwritten.</div>
          <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
            {e.full_path} → {dst}
          </div>
        </div>
      ),
      confirmText: "Download",
    });
    if (!ok) return;

    const p = toast.loading(`Downloading ${e.name}…`);
    try {
      await api.sftpDownload(sessionId, e.full_path, dst);
      toast.success(`Saved to ${dst}`, { id: p });
    } catch (err) {
      toast.error(`${err}`, { id: p });
    }
  }

  async function renameEntry(e: RemoteEntry) {
    const newName = window.prompt("New name:", e.name);
    if (!newName || newName === e.name) return;
    const parent = e.full_path.split("/").slice(0, -1).join("/") || "/";
    const to = parent === "/" ? `/${newName}` : `${parent}/${newName}`;
    const ok = await confirm({
      title: "Rename?",
      description: (
        <div className="space-y-1.5">
          <div>The remote file / folder will be renamed.</div>
          <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
            {e.full_path} → {to}
          </div>
        </div>
      ),
      confirmText: "Rename",
    });
    if (!ok) return;
    try {
      await api.sftpRename(sessionId, e.full_path, to);
      await refresh();
    } catch (err) {
      toast.error(`${err}`);
    }
  }

  /**
   * Given a remote absolute path, compute the path relative to the
   * project's remote base — needed so `compare_file` knows where to
   * look on the local side. Returns null if it lies outside the base.
   */
  function relativeToProject(full: string): string | null {
    if (!projectRemoteBase) return null;
    const base = projectRemoteBase.replace(/\/+$/, "");
    if (full === base) return "";
    if (full.startsWith(base + "/")) return full.slice(base.length + 1);
    return null;
  }

  function buildMenuItems(e: RemoteEntry): ContextMenuItem[] {
    const rel = relativeToProject(e.full_path);
    const canCompare = !!projectId && rel !== null;
    return [
      {
        label: "Download…",
        icon: <Download className="h-3.5 w-3.5" />,
        disabled: e.is_dir,
        onClick: () => void downloadEntry(e),
      },
      {
        label: e.is_dir ? "Compare folder with local" : "Compare with local",
        icon: e.is_dir ? (
          <FolderGit2 className="h-3.5 w-3.5" />
        ) : (
          <GitCompare className="h-3.5 w-3.5" />
        ),
        disabled: !canCompare,
        onClick: () => {
          if (rel === null) return;
          if (e.is_dir) setCompareFolderFor(rel);
          else setCompareFor(rel);
        },
      },
      { separator: true, label: "", onClick: () => {} },
      {
        label: "Rename…",
        icon: <Edit3 className="h-3.5 w-3.5" />,
        onClick: () => void renameEntry(e),
      },
      {
        label: "Copy full path",
        icon: <Copy className="h-3.5 w-3.5" />,
        onClick: () => {
          void navigator.clipboard.writeText(e.full_path);
          toast.success("Copied");
        },
      },
      { separator: true, label: "", onClick: () => {} },
      {
        label: e.is_dir ? "Delete folder" : "Delete",
        icon: <Trash2 className="h-3.5 w-3.5" />,
        danger: true,
        onClick: () => void removeEntry(e),
      },
    ];
  }

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex items-center gap-1 border-b bg-muted/30 p-1">
        <Button size="icon-sm" variant="ghost" onClick={cdUp} title="Up">
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={refresh} title="Refresh">
          <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
        <Input
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && refresh()}
          className="h-6 flex-1 font-mono text-xs"
        />
        <Button size="icon-sm" variant="ghost" onClick={mkdir} title="New folder">
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={uploadFile} title="Upload">
          <Upload className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => selection && downloadEntry(selection)}
          title="Download"
          disabled={!selection || selection.is_dir}
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => selection && removeEntry(selection)}
          title="Delete"
          disabled={!selection}
        >
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-card text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Name</th>
              <th className="px-3 py-1.5 text-right font-medium">Size</th>
              <th className="px-3 py-1.5 text-left font-medium">Modified</th>
              <th className="px-3 py-1.5 text-left font-medium">Perm</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr
                key={e.full_path}
                onClick={() => setSelection(e)}
                onDoubleClick={() => {
                  if (e.is_dir) onPathChange(e.full_path);
                  else void downloadEntry(e);
                }}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  setSelection(e);
                  setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
                }}
                className={cn(
                  "cursor-pointer border-b hover:bg-accent",
                  selection?.full_path === e.full_path && "bg-primary/10",
                )}
              >
                <td className="px-3 py-1">
                  <span className="flex items-center gap-2">
                    {e.is_dir ? (
                      <Folder className="h-3.5 w-3.5 text-primary" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    {e.name}
                  </span>
                </td>
                <td className="px-3 py-1 text-right font-mono tabular-nums">
                  {e.is_dir ? "—" : formatBytes(e.size)}
                </td>
                <td className="px-3 py-1 text-muted-foreground">
                  {formatMtime(e.mtime ?? undefined)}
                </td>
                <td className="px-3 py-1 font-mono text-muted-foreground">
                  {e.mode ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && !loading && (
          <div className="p-8 text-center text-xs text-muted-foreground">
            Empty directory
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}

      {compareFor !== null && projectId && (
        <CompareDialog
          projectId={projectId}
          relativePath={compareFor}
          sessionId={sessionId}
          onClose={() => setCompareFor(null)}
        />
      )}

      {compareFolderFor !== null && projectId && (
        <CompareFolderDialog
          projectId={projectId}
          relativePath={compareFolderFor}
          sessionId={sessionId}
          onClose={() => setCompareFolderFor(null)}
        />
      )}
    </div>
  );
}
