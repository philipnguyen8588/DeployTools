import { useCallback, useEffect, useState } from "react";
import {
  Folder,
  FileText,
  ArrowUp,
  RefreshCcw,
  Upload,
  GitCompare,
  Copy,
  FolderGit2,
} from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { LocalEntry } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn, formatBytes, formatMtime } from "@/lib/utils";
import { ContextMenu, type ContextMenuItem } from "./ui/context-menu";
import { CompareDialog } from "./CompareDialog";
import { CompareFolderDialog } from "./CompareFolderDialog";
import { useConfirm } from "./ConfirmDialog";

interface Props {
  sessionId: string;
  projectId: string | null;
  remoteBase: string;
  relativePath: string;
  onRelativePathChange: (p: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  entry: LocalEntry;
}

export function LocalFileBrowser({
  sessionId,
  projectId,
  remoteBase,
  relativePath,
  onRelativePathChange,
}: Props) {
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<LocalEntry | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [compareFor, setCompareFor] = useState<string | null>(null);
  const [compareFolderFor, setCompareFolderFor] = useState<string | null>(null);
  const confirm = useConfirm();

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await api.listLocalTree(projectId, relativePath);
      setEntries(res);
    } catch (e) {
      toast.error(`List failed: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [projectId, relativePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function cdUp() {
    if (!relativePath) return;
    const parent = relativePath.split("/").slice(0, -1).join("/");
    onRelativePathChange(parent);
  }

  async function uploadEntry(e: LocalEntry) {
    if (!projectId) return;
    const mirror = remoteBase.replace(/\/+$/, "") + "/" + e.relative_path;
    const ok = await confirm({
      title: e.is_dir ? "Upload folder to server?" : "Upload file to server?",
      description: (
        <div className="space-y-1.5">
          <div>
            This will {e.is_dir ? "upload every file in the folder (respecting excludes) and" : ""}
            {" "}overwrite the remote copy if it exists.
          </div>
          <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
            {e.relative_path || e.name} → {mirror}
          </div>
        </div>
      ),
      confirmText: e.is_dir ? "Upload folder" : "Upload",
    });
    if (!ok) return;

    const p = toast.loading(`Uploading ${e.name}${e.is_dir ? "/" : ""}…`);
    try {
      if (e.is_dir) {
        const n = await api.deployFolder(projectId, e.relative_path, sessionId);
        toast.success(`Uploaded ${e.name}/ — ${n} files`, { id: p });
      } else {
        await api.deployFile(projectId, e.relative_path, sessionId);
        toast.success(`Uploaded ${e.name}`, { id: p });
      }
    } catch (err) {
      toast.error(`${err}`, { id: p });
    }
  }

  function buildMenuItems(e: LocalEntry): ContextMenuItem[] {
    return [
      {
        label: e.is_dir ? "Upload folder to server" : "Upload to server",
        icon: <Upload className="h-3.5 w-3.5" />,
        onClick: () => void uploadEntry(e),
      },
      {
        label: e.is_dir ? "Compare folder with remote" : "Compare with remote",
        icon: e.is_dir ? (
          <FolderGit2 className="h-3.5 w-3.5" />
        ) : (
          <GitCompare className="h-3.5 w-3.5" />
        ),
        disabled: !projectId,
        onClick: () =>
          e.is_dir
            ? setCompareFolderFor(e.relative_path)
            : setCompareFor(e.relative_path),
      },
      { separator: true, label: "", onClick: () => {} },
      {
        label: "Copy relative path",
        icon: <Copy className="h-3.5 w-3.5" />,
        onClick: () => {
          void navigator.clipboard.writeText(e.relative_path);
          toast.success("Copied");
        },
      },
    ];
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        No project attached to this session — open a session from a project
        in the sidebar to enable the local browser.
      </div>
    );
  }

  const mirrorRemote = remoteBase.replace(/\/+$/, "") + "/" + relativePath;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b bg-muted/30 p-1">
        <Button size="icon-sm" variant="ghost" onClick={cdUp} title="Up">
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={refresh} title="Refresh">
          <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
        <Input
          value={relativePath || "/"}
          readOnly
          className="h-6 flex-1 font-mono text-xs"
        />
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => selection && uploadEntry(selection)}
          title={`Upload to ${mirrorRemote}`}
          disabled={!selection}
        >
          <Upload className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-card text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Name</th>
              <th className="px-3 py-1.5 text-right font-medium">Size</th>
              <th className="px-3 py-1.5 text-left font-medium">Modified</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr
                key={e.relative_path}
                onClick={() => setSelection(e)}
                onDoubleClick={() => {
                  if (e.is_dir) onRelativePathChange(e.relative_path);
                  else void uploadEntry(e);
                }}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  setSelection(e);
                  setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
                }}
                className={cn(
                  "cursor-pointer border-b hover:bg-accent",
                  selection?.relative_path === e.relative_path &&
                    "bg-primary/10",
                  e.excluded && "opacity-50",
                )}
                title={e.excluded ? "Excluded by pattern" : undefined}
              >
                <td className="px-3 py-1">
                  <span className="flex items-center gap-2">
                    {e.is_dir ? (
                      <Folder className="h-3.5 w-3.5 text-primary" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    {e.name}
                    {e.excluded && (
                      <span className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px] uppercase tracking-wide">
                        excl
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-1 text-right font-mono tabular-nums">
                  {e.is_dir ? "—" : formatBytes(e.size)}
                </td>
                <td className="px-3 py-1 text-muted-foreground">
                  {formatMtime(e.mtime ?? undefined)}
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

      {compareFor && projectId && (
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
