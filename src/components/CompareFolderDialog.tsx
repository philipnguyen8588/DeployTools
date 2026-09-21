import { useEffect, useMemo, useState } from "react";
import {
  FolderGit2,
  Check,
  ChevronLeft,
  ChevronRight,
  Minus,
  Folder,
  FileText,
  RefreshCcw,
} from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type {
  FolderCompareEntry,
  FolderCompareResult,
  FolderCompareStatus,
} from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { cn, formatBytes, formatMtime } from "@/lib/utils";
import { CompareDialog } from "./CompareDialog";

interface Props {
  projectId: string;
  relativePath: string;
  sessionId: string;
  onClose: () => void;
}

type Filter = "all" | FolderCompareStatus;

/**
 * Folder-level comparison: walks both sides, lists every path, and for
 * each row shows whether it exists on both / only local / only remote,
 * and whether sizes match.
 *
 * Click a row to open the file-level diff for that path.
 */
export function CompareFolderDialog({
  projectId,
  relativePath,
  sessionId,
  onClose,
}: Props) {
  const [result, setResult] = useState<FolderCompareResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [hideExcluded, setHideExcluded] = useState(true);
  const [fileCompareFor, setFileCompareFor] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.compareFolder(projectId, relativePath, sessionId);
      setResult(r);
    } catch (e) {
      toast.error(`${e}`);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, relativePath, sessionId]);

  const entries = useMemo(() => {
    if (!result) return [];
    return result.entries
      .filter((e) => filter === "all" || e.status === filter)
      .filter((e) => !hideExcluded || !e.excluded)
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.relative_path.localeCompare(b.relative_path);
      });
  }, [result, filter, hideExcluded]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="select-text flex h-[85vh] max-w-5xl flex-col gap-3 overflow-hidden p-4 sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderGit2 className="h-4 w-4" />
            Compare folder
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {relativePath || "/"}
            </code>
          </DialogTitle>
          <DialogDescription>Local ↔ Remote (by size only)</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            Walking both trees…
          </div>
        )}

        {!loading && result && (
          <>
            {/* Summary + filter bar — fixed height */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b pb-2">
              <FilterChip
                active={filter === "all"}
                onClick={() => setFilter("all")}
                label={`All (${result.entries.length})`}
              />
              <FilterChip
                active={filter === "only_local"}
                onClick={() => setFilter("only_local")}
                label={`Only local (${result.only_local})`}
                className="text-blue-600 dark:text-blue-400"
              />
              <FilterChip
                active={filter === "only_remote"}
                onClick={() => setFilter("only_remote")}
                label={`Only remote (${result.only_remote})`}
                className="text-purple-600 dark:text-purple-400"
              />
              <FilterChip
                active={filter === "differs"}
                onClick={() => setFilter("differs")}
                label={`Differ (${result.differs})`}
                className="text-yellow-600 dark:text-yellow-400"
              />
              <FilterChip
                active={filter === "identical"}
                onClick={() => setFilter("identical")}
                label={`Identical (${result.identical})`}
                className="text-green-600 dark:text-green-400"
              />
              <div className="flex-1" />
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={hideExcluded}
                  onChange={(e) => setHideExcluded(e.target.checked)}
                />
                Hide excluded
              </label>
              <Button size="sm" variant="outline" onClick={load}>
                <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
                Refresh
              </Button>
            </div>

            {/* Table — fills remaining height regardless of row count */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-card text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Path</th>
                    <th className="w-24 px-3 py-1.5 text-left font-medium">
                      Status
                    </th>
                    <th className="w-24 px-3 py-1.5 text-right font-medium">
                      Local
                    </th>
                    <th className="w-24 px-3 py-1.5 text-right font-medium">
                      Remote
                    </th>
                    <th className="w-40 px-3 py-1.5 text-left font-medium">
                      Modified (remote)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <Row
                      key={e.relative_path}
                      entry={e}
                      onOpen={() =>
                        !e.is_dir && setFileCompareFor(e.relative_path)
                      }
                    />
                  ))}
                </tbody>
              </table>
              {entries.length === 0 && (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  Nothing matches this filter.
                </div>
              )}
            </div>
          </>
        )}

        {fileCompareFor && (
          <CompareDialog
            projectId={projectId}
            relativePath={fileCompareFor}
            sessionId={sessionId}
            onClose={() => setFileCompareFor(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  className,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "hover:bg-accent",
        !active && className,
      )}
    >
      {label}
    </button>
  );
}

function Row({
  entry,
  onOpen,
}: {
  entry: FolderCompareEntry;
  onOpen: () => void;
}) {
  const { chip, color, Icon } = statusChip(entry.status);
  return (
    <tr
      onDoubleClick={onOpen}
      className={cn(
        "cursor-pointer border-b hover:bg-accent",
        entry.excluded && "opacity-50",
      )}
      title={entry.excluded ? "Excluded by project pattern" : "Double-click to open file diff"}
    >
      <td className="px-3 py-1">
        <span className="flex items-center gap-2">
          {entry.is_dir ? (
            <Folder className="h-3.5 w-3.5 text-primary" />
          ) : (
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="font-mono">{entry.relative_path || "/"}</span>
          {entry.excluded && (
            <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] uppercase tracking-wide">
              excl
            </span>
          )}
        </span>
      </td>
      <td className={cn("px-3 py-1", color)}>
        <span className="inline-flex items-center gap-1">
          <Icon className="h-3 w-3" />
          {chip}
        </span>
      </td>
      <td className="px-3 py-1 text-right font-mono tabular-nums">
        {entry.status === "only_remote" || entry.is_dir
          ? "—"
          : formatBytes(entry.local_size)}
      </td>
      <td className="px-3 py-1 text-right font-mono tabular-nums">
        {entry.status === "only_local" || entry.is_dir
          ? "—"
          : formatBytes(entry.remote_size)}
      </td>
      <td className="px-3 py-1 text-muted-foreground">
        {formatMtime(entry.remote_mtime ?? undefined)}
      </td>
    </tr>
  );
}

function statusChip(status: FolderCompareStatus) {
  switch (status) {
    case "only_local":
      return {
        chip: "only local",
        color: "text-blue-600 dark:text-blue-400",
        Icon: ChevronLeft,
      };
    case "only_remote":
      return {
        chip: "only remote",
        color: "text-purple-600 dark:text-purple-400",
        Icon: ChevronRight,
      };
    case "differs":
      return {
        chip: "differs",
        color: "text-yellow-600 dark:text-yellow-400",
        Icon: Minus,
      };
    case "identical":
      return {
        chip: "identical",
        color: "text-green-600 dark:text-green-400",
        Icon: Check,
      };
  }
}
