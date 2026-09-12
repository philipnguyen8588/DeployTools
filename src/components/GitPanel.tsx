import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GitBranch,
  GitCommit as GitCommitIcon,
  FileText,
  RefreshCcw,
  Upload,
  CheckSquare,
  Square,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { GitCommit, GitFile, GitInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { useConfirm } from "./ConfirmDialog";

interface Props {
  projectId: string;
  sessionId: string;
  remoteBase: string;
  /** Whether the Git tab is currently the visible BottomPanel tab. The
   *  panel stays mounted when hidden, so we use this to auto-refresh the
   *  file list whenever the user switches back to it. */
  visible?: boolean;
}

type Tab = "changes" | "commits";

/**
 * Git integration for the active project.
 *
 *   Changes tab: `git status`-like view of uncommitted files. User
 *                can tick any subset and upload them via SFTP.
 *   Commits tab: list of recent commits. User picks one; a second view
 *                shows the files touched by that commit (current working-
 *                tree copy — not the historical blob) with multi-select
 *                + upload.
 */
export function GitPanel({
  projectId,
  sessionId,
  remoteBase,
  visible = true,
}: Props) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [tab, setTab] = useState<Tab>("changes");

  const refreshInfo = useCallback(async () => {
    try {
      const i = await api.gitInfo(projectId);
      setInfo(i);
    } catch (e) {
      toast.error(`git_info: ${e}`);
    }
  }, [projectId]);

  // Refresh branch/head info on mount and whenever the tab becomes
  // visible again (the sub-views refresh their own file lists).
  useEffect(() => {
    if (visible) void refreshInfo();
  }, [visible, refreshInfo]);

  if (!info) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading git state…
      </div>
    );
  }

  if (!info.is_repo) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        <div>
          <AlertTriangle className="mx-auto mb-2 h-5 w-5" />
          This project's local folder is not a git repository.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header — branch + head */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
        <GitBranch className="h-3.5 w-3.5 text-primary" />
        <span className="font-mono font-medium">{info.branch ?? "HEAD"}</span>
        {info.head_short && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {info.head_short}
          </span>
        )}
        <div className="flex-1" />
        <div className="flex gap-0.5">
          <TabBtn active={tab === "changes"} onClick={() => setTab("changes")}>
            Changes
          </TabBtn>
          <TabBtn active={tab === "commits"} onClick={() => setTab("commits")}>
            Commits
          </TabBtn>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "changes" ? (
          <ChangesView
            projectId={projectId}
            sessionId={sessionId}
            remoteBase={remoteBase}
            visible={visible}
          />
        ) : (
          <CommitsView
            projectId={projectId}
            sessionId={sessionId}
            remoteBase={remoteBase}
            visible={visible}
          />
        )}
      </div>
    </div>
  );
}

function TabBtn({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded px-2 py-0.5 text-xs transition",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ---------------- Changes (working tree + index) ----------------

function ChangesView({
  projectId,
  sessionId,
  remoteBase,
  visible,
}: {
  projectId: string;
  sessionId: string;
  remoteBase: string;
  visible: boolean;
}) {
  const [files, setFiles] = useState<GitFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const f = await api.gitStatus(projectId);
      setFiles(f);
      setSelected((prev) => {
        const next = new Set<string>();
        for (const p of prev) if (f.some((x) => x.relative_path === p)) next.add(p);
        return next;
      });
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Refresh on mount and whenever the Git tab becomes visible again, so
  // the changed-file list stays current without a manual reload.
  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh]);

  const allChecked =
    files.length > 0 && files.every((f) => selected.has(f.relative_path));

  const uploadable = useMemo(
    () => files.filter((f) => selected.has(f.relative_path) && f.exists_on_disk),
    [files, selected],
  );

  async function uploadSelected() {
    if (uploadable.length === 0) return;
    const ok = await confirm({
      title: `Upload ${uploadable.length} file${uploadable.length > 1 ? "s" : ""}?`,
      description: (
        <div className="space-y-1.5">
          <div>The selected files will be uploaded via SFTP to the project's remote path. Existing remote copies will be overwritten.</div>
          <div className="max-h-40 overflow-y-auto rounded bg-muted px-2 py-1 font-mono text-xs">
            {uploadable.map((f) => (
              <div key={f.relative_path} className="break-all">
                {f.relative_path}
              </div>
            ))}
          </div>
        </div>
      ),
      confirmText: "Upload",
    });
    if (!ok) return;

    setBusy(true);
    const id = toast.loading(`Uploading ${uploadable.length} files…`);
    let done = 0;
    try {
      for (const f of uploadable) {
        await api.deployFile(projectId, f.relative_path, sessionId);
        done += 1;
      }
      toast.success(`✓ Uploaded ${done} file(s)`, { id });
      setSelected(new Set());
    } catch (e) {
      toast.error(`${e} (after ${done} uploads)`, { id });
    } finally {
      setBusy(false);
    }
  }

  function toggleAll() {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(files.map((f) => f.relative_path)));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 p-1.5 text-xs">
        <button
          onClick={toggleAll}
          className="rounded p-1 hover:bg-accent"
          title={allChecked ? "Deselect all" : "Select all"}
        >
          {allChecked ? (
            <CheckSquare className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
        </button>
        <span className="text-muted-foreground">
          {files.length} changed · {selected.size} selected
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
          <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
        <Button
          size="sm"
          disabled={busy || uploadable.length === 0}
          onClick={uploadSelected}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          Upload {uploadable.length > 0 ? `(${uploadable.length})` : ""}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 && !loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Working tree is clean.
          </div>
        ) : (
          <FileList
            files={files}
            selected={selected}
            onToggle={(p) =>
              setSelected((s) => {
                const next = new Set(s);
                if (next.has(p)) next.delete(p);
                else next.add(p);
                return next;
              })
            }
            remoteBase={remoteBase}
          />
        )}
      </div>
    </div>
  );
}

// ---------------- Commits ----------------

function CommitsView({
  projectId,
  sessionId,
  remoteBase,
  visible,
}: {
  projectId: string;
  sessionId: string;
  remoteBase: string;
  visible: boolean;
}) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<GitCommit | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const c = await api.gitLog(projectId, 100);
      setCommits(c);
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Refresh on mount and whenever the Git tab becomes visible again.
  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh]);

  if (picked) {
    return (
      <CommitFilesView
        projectId={projectId}
        sessionId={sessionId}
        commit={picked}
        onBack={() => setPicked(null)}
        remoteBase={remoteBase}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 p-1.5 text-xs text-muted-foreground">
        <GitCommitIcon className="h-3.5 w-3.5" />
        <span className="flex-1">
          {commits.length} commits · click one to see its files
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Loading log…
          </div>
        ) : (
          commits.map((c) => (
            <button
              key={c.hash}
              onClick={() => setPicked(c)}
              className="flex w-full items-start gap-2 border-b px-3 py-2 text-left text-xs hover:bg-accent"
            >
              <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                {c.short_hash}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{c.summary}</div>
                <div className="text-muted-foreground">
                  {c.author} · {new Date(c.time * 1000).toLocaleString()}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function CommitFilesView({
  projectId,
  sessionId,
  commit,
  onBack,
  remoteBase,
}: {
  projectId: string;
  sessionId: string;
  commit: GitCommit;
  onBack: () => void;
  remoteBase: string;
}) {
  const [files, setFiles] = useState<GitFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const f = await api.gitFilesInCommit(projectId, commit.hash);
        if (!cancelled) {
          setFiles(f);
          // Preselect all uploadable files to match user intent:
          // "lấy những file hiện tại có trong commit này để upload".
          setSelected(
            new Set(f.filter((x) => x.exists_on_disk).map((x) => x.relative_path)),
          );
        }
      } catch (e) {
        toast.error(`${e}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, commit.hash]);

  const uploadable = useMemo(
    () => files.filter((f) => selected.has(f.relative_path) && f.exists_on_disk),
    [files, selected],
  );
  const allChecked =
    files.length > 0 && files.every((f) => selected.has(f.relative_path));

  function toggleAll() {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(files.map((f) => f.relative_path)));
  }

  async function uploadSelected() {
    if (uploadable.length === 0) return;
    const ok = await confirm({
      title: `Upload ${uploadable.length} file${uploadable.length > 1 ? "s" : ""} from commit ${commit.short_hash}?`,
      description: (
        <div className="space-y-1.5">
          <div>
            These are the CURRENT working-tree versions of the files
            touched by this commit — not historical snapshots. Existing
            remote copies will be overwritten.
          </div>
          <div className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
            {commit.short_hash} — {commit.summary}
          </div>
        </div>
      ),
      confirmText: "Upload",
    });
    if (!ok) return;

    setBusy(true);
    const id = toast.loading(`Uploading ${uploadable.length} files…`);
    let done = 0;
    try {
      for (const f of uploadable) {
        await api.deployFile(projectId, f.relative_path, sessionId);
        done += 1;
      }
      toast.success(`✓ Uploaded ${done} file(s)`, { id });
    } catch (e) {
      toast.error(`${e} (after ${done} uploads)`, { id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 p-1.5 text-xs">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <button
          onClick={toggleAll}
          className="rounded p-1 hover:bg-accent"
          title={allChecked ? "Deselect all" : "Select all"}
        >
          {allChecked ? (
            <CheckSquare className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
        </button>
        <span className="truncate font-mono text-muted-foreground">
          {commit.short_hash} · {files.length} files · {selected.size} selected
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          disabled={busy || uploadable.length === 0}
          onClick={uploadSelected}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          Upload {uploadable.length > 0 ? `(${uploadable.length})` : ""}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Loading diff…
          </div>
        ) : (
          <FileList
            files={files}
            selected={selected}
            onToggle={(p) =>
              setSelected((s) => {
                const next = new Set(s);
                if (next.has(p)) next.delete(p);
                else next.add(p);
                return next;
              })
            }
            remoteBase={remoteBase}
          />
        )}
      </div>
    </div>
  );
}

// ---------------- Shared file list ----------------

function FileList({
  files,
  selected,
  onToggle,
  remoteBase,
}: {
  files: GitFile[];
  selected: Set<string>;
  onToggle: (p: string) => void;
  remoteBase: string;
}) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {files.map((f) => {
          const checked = selected.has(f.relative_path);
          return (
            <tr
              key={f.relative_path}
              className={cn(
                "cursor-pointer border-b hover:bg-accent",
                checked && "bg-primary/5",
                !f.exists_on_disk && "opacity-50",
              )}
              onClick={() => f.exists_on_disk && onToggle(f.relative_path)}
              title={
                f.exists_on_disk
                  ? `Upload to ${remoteBase.replace(/\/+$/, "")}/${f.relative_path}`
                  : "File no longer exists on disk — can't upload"
              }
            >
              <td className="w-6 py-1 pl-3">
                {checked ? (
                  <CheckSquare className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <Square className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </td>
              <td className="w-14 py-1 text-center">
                <StatusBadge code={f.status} />
              </td>
              <td className="px-2 py-1">
                <span className="flex items-center gap-1.5">
                  <FileText className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono">{f.relative_path}</span>
                  {!f.exists_on_disk && (
                    <span className="ml-1 rounded bg-muted px-1 text-[10px] uppercase">
                      deleted
                    </span>
                  )}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StatusBadge({ code }: { code: string }) {
  const c = code.trim();
  const color =
    c === "A" || c === "AM"
      ? "bg-green-500/20 text-green-700 dark:text-green-400"
      : c === "M" || c.includes("M")
        ? "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400"
        : c === "D"
          ? "bg-red-500/20 text-red-700 dark:text-red-400"
          : c === "R"
            ? "bg-blue-500/20 text-blue-700 dark:text-blue-400"
            : c === "?" || c === "??"
              ? "bg-purple-500/20 text-purple-700 dark:text-purple-400"
              : "bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold",
        color,
      )}
    >
      {code}
    </span>
  );
}
