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
  FolderOpen,
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
  /** Absolute local root of the project (project.local_path). Used to
   *  compute absolute paths for "Copy absolute path" / "Show in …". */
  localBase: string;
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
  localBase,
  relativePath,
  onRelativePathChange,
}: Props) {
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<LocalEntry | null>(null);
  /** Multi-selection for batch upload — keyed by relative_path. */
  const [checked, setChecked] = useState<Set<string>>(new Set());
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

  // Clear the multi-selection whenever the directory changes — the
  // checked relative paths no longer correspond to visible rows.
  useEffect(() => {
    setChecked(new Set());
  }, [relativePath]);

  function toggleChecked(rel: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }

  function toggleAll() {
    setChecked((prev) =>
      prev.size === entries.length
        ? new Set()
        : new Set(entries.map((e) => e.relative_path)),
    );
  }

  /** Absolute path of an entry on the host OS (localBase + relative). */
  function absPath(rel: string): string {
    const sep = localBase.includes("\\") ? "\\" : "/";
    const base = localBase.replace(/[\\/]+$/, "");
    const relOs = sep === "\\" ? rel.replace(/\//g, "\\") : rel;
    return relOs ? `${base}${sep}${relOs}` : base;
  }

  function revealLabel(): string {
    const ua = navigator.userAgent;
    if (/Mac/i.test(ua)) return "Show in Finder";
    if (/Win/i.test(ua)) return "Show in Explorer";
    return "Show in file manager";
  }

  async function revealEntry(e: LocalEntry) {
    try {
      await api.revealPath(absPath(e.relative_path));
    } catch (err) {
      toast.error(`${err}`);
    }
  }

  /** Upload every checked entry in one batch (no per-item confirm). */
  async function uploadChecked() {
    if (!projectId || checked.size === 0) return;
    const targets = entries.filter((e) => checked.has(e.relative_path));
    const ok = await confirm({
      title: `Upload ${targets.length} item(s) to server?`,
      description: (
        <div className="space-y-1.5">
          <div>
            Folders are uploaded recursively (respecting excludes). Existing
            remote copies will be overwritten.
          </div>
          <div className="max-h-32 overflow-y-auto rounded bg-muted px-2 py-1 font-mono text-xs">
            {targets.map((t) => (
              <div key={t.relative_path}>
                {t.relative_path || t.name}
                {t.is_dir ? "/" : ""}
              </div>
            ))}
          </div>
        </div>
      ),
      confirmText: "Upload all",
    });
    if (!ok) return;

    const p = toast.loading(`Uploading ${targets.length} item(s)…`);
    let files = 0;
    try {
      for (const t of targets) {
        if (t.is_dir) {
          files += await api.deployFolder(projectId, t.relative_path, sessionId);
        } else {
          await api.deployFile(projectId, t.relative_path, sessionId);
          files += 1;
        }
      }
      toast.success(`Uploaded ${targets.length} item(s) — ${files} files`, {
        id: p,
      });
      setChecked(new Set());
    } catch (err) {
      toast.error(`${err}`, { id: p });
    }
  }

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
    const inBatch = checked.has(e.relative_path) && checked.size > 1;
    const items: ContextMenuItem[] = [];

    if (inBatch) {
      items.push({
        label: `Upload ${checked.size} selected to server`,
        icon: <Upload className="h-3.5 w-3.5" />,
        onClick: () => void uploadChecked(),
      });
    }
    items.push({
      label: e.is_dir ? "Upload folder to server" : "Upload to server",
      icon: <Upload className="h-3.5 w-3.5" />,
      onClick: () => void uploadEntry(e),
    });
    items.push({
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
    });
    items.push({ separator: true, label: "", onClick: () => {} });
    items.push({
      label: revealLabel(),
      icon: <FolderOpen className="h-3.5 w-3.5" />,
      onClick: () => void revealEntry(e),
    });
    items.push({
      label: "Copy absolute path",
      icon: <Copy className="h-3.5 w-3.5" />,
      onClick: () => {
        void navigator.clipboard.writeText(absPath(e.relative_path));
        toast.success("Copied");
      },
    });
    items.push({
      label: "Copy relative path",
      icon: <Copy className="h-3.5 w-3.5" />,
      onClick: () => {
        void navigator.clipboard.writeText(e.relative_path);
        toast.success("Copied");
      },
    });
    return items;
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
        {checked.size > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void uploadChecked()}
            title="Upload selected items"
            className="h-6 gap-1 px-2 text-xs"
          >
            <Upload className="h-3.5 w-3.5" />
            Upload {checked.size}
          </Button>
        )}
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
              <th className="w-8 px-2 py-1.5 text-center font-medium">
                <input
                  type="checkbox"
                  className="cursor-pointer align-middle accent-primary"
                  checked={entries.length > 0 && checked.size === entries.length}
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        checked.size > 0 && checked.size < entries.length;
                  }}
                  onChange={toggleAll}
                  title="Select all"
                />
              </th>
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
                <td
                  className="px-2 py-1 text-center"
                  onClick={(ev) => ev.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    className="cursor-pointer align-middle accent-primary"
                    checked={checked.has(e.relative_path)}
                    onChange={() => toggleChecked(e.relative_path)}
                  />
                </td>
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
