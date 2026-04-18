import { useEffect, useState } from "react";
import { GitCompare, Check, FileWarning } from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { FileComparison } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { cn, formatBytes, formatMtime } from "@/lib/utils";

interface Props {
  projectId: string;
  relativePath: string;
  sessionId: string;
  onClose: () => void;
}

/**
 * Side-by-side + unified diff view for local vs remote of a single file.
 *
 * Shows three views:
 *   1. A header comparing size / mtime / identical flag
 *   2. Side-by-side panes with line numbers
 *   3. Unified diff with +/- coloring
 */
export function CompareDialog({
  projectId,
  relativePath,
  sessionId,
  onClose,
}: Props) {
  const [result, setResult] = useState<FileComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"split" | "diff">("split");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await api.compareFile(projectId, relativePath, sessionId);
        if (!cancelled) setResult(r);
      } catch (e) {
        toast.error(`Compare failed: ${e}`);
        if (!cancelled) onClose();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, relativePath, sessionId, onClose]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex h-[85vh] max-w-5xl flex-col gap-3 overflow-hidden p-4 sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompare className="h-4 w-4" />
            Compare
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {relativePath || "/"}
            </code>
          </DialogTitle>
          <DialogDescription>Local ↔ Remote</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            Reading files…
          </div>
        )}

        {!loading && result && (
          <>
            <SummaryRow r={result} />

            <div className="flex shrink-0 gap-1 border-b pb-2">
              <button
                className={cn(
                  "rounded px-2 py-1 text-xs transition",
                  view === "split"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-accent",
                )}
                onClick={() => setView("split")}
              >
                Side-by-side
              </button>
              <button
                className={cn(
                  "rounded px-2 py-1 text-xs transition",
                  view === "diff"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-accent",
                )}
                onClick={() => setView("diff")}
              >
                Unified diff
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {result.is_binary ? (
                <div className="flex h-full items-center justify-center gap-2 rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                  <FileWarning className="h-4 w-4" />
                  Binary content — showing size/mtime only.
                </div>
              ) : view === "split" ? (
                <SplitView
                  local={result.local_text ?? ""}
                  remote={result.remote_text ?? ""}
                />
              ) : (
                <UnifiedView diff={result.unified_diff} />
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SummaryRow({ r }: { r: FileComparison }) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 text-xs">
      <div>
        <div className="mb-1 font-semibold text-muted-foreground">Local</div>
        {r.local_exists ? (
          <div>
            <span className="font-mono">{formatBytes(r.local_size)}</span>
            <span className="ml-2 text-muted-foreground">
              {formatMtime(r.local_mtime ?? undefined)}
            </span>
          </div>
        ) : (
          <div className="italic text-muted-foreground">(missing)</div>
        )}
      </div>
      <div>
        <div className="mb-1 font-semibold text-muted-foreground">Remote</div>
        {r.remote_exists ? (
          <div>
            <span className="font-mono">{formatBytes(r.remote_size)}</span>
            <span className="ml-2 text-muted-foreground">
              {formatMtime(r.remote_mtime ?? undefined)}
            </span>
          </div>
        ) : (
          <div className="italic text-muted-foreground">(missing)</div>
        )}
      </div>
      <div className="col-span-2 flex items-center gap-1.5 pt-1">
        {r.identical ? (
          <>
            <Check className="h-3.5 w-3.5 text-green-500" />
            <span className="text-xs text-green-600 dark:text-green-400">
              Files are identical
            </span>
          </>
        ) : (
          <span className="text-xs text-yellow-600 dark:text-yellow-400">
            Files differ
          </span>
        )}
      </div>
    </div>
  );
}

function SplitView({ local, remote }: { local: string; remote: string }) {
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  const maxLen = Math.max(localLines.length, remoteLines.length);

  return (
    <div className="grid h-full grid-cols-2 gap-2 overflow-auto rounded-md border">
      <pre className="overflow-x-auto border-r bg-muted/10 p-2 font-mono text-xs leading-5">
        {Array.from({ length: maxLen }, (_, i) => {
          const l = localLines[i] ?? "";
          const r = remoteLines[i] ?? "";
          const diff = l !== r;
          return (
            <div
              key={i}
              className={cn("whitespace-pre", diff && "bg-red-500/10")}
            >
              <span className="mr-2 inline-block w-8 select-none text-right text-muted-foreground">
                {i + 1}
              </span>
              {l || " "}
            </div>
          );
        })}
      </pre>
      <pre className="overflow-x-auto bg-muted/10 p-2 font-mono text-xs leading-5">
        {Array.from({ length: maxLen }, (_, i) => {
          const l = localLines[i] ?? "";
          const r = remoteLines[i] ?? "";
          const diff = l !== r;
          return (
            <div
              key={i}
              className={cn("whitespace-pre", diff && "bg-green-500/10")}
            >
              <span className="mr-2 inline-block w-8 select-none text-right text-muted-foreground">
                {i + 1}
              </span>
              {r || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function UnifiedView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="h-full overflow-auto rounded-md border bg-muted/10 p-2 font-mono text-xs leading-5">
      {lines.map((line, i) => {
        const cls =
          line.startsWith("+") && !line.startsWith("+++")
            ? "bg-green-500/15 text-green-700 dark:text-green-400"
            : line.startsWith("-") && !line.startsWith("---")
              ? "bg-red-500/15 text-red-700 dark:text-red-400"
              : "";
        return (
          <div key={i} className={cn("whitespace-pre", cls)}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
