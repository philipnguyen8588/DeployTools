import { Suspense, lazy, useEffect, useRef, useState } from "react";
import {
  GitCompare,
  Check,
  ChevronDown,
  ChevronUp,
  FileWarning,
} from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { FileComparison } from "@/lib/types";
import type { DiffViewHandle } from "./MonacoDiffView";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { cn, formatBytes, formatMtime } from "@/lib/utils";

// Monaco diff — lazy so its ~2 MB chunk loads on first compare only.
const MonacoDiffView = lazy(() =>
  import("./MonacoDiffView").then((m) => ({ default: m.MonacoDiffView })),
);

interface Props {
  projectId: string;
  relativePath: string;
  sessionId: string;
  onClose: () => void;
}

/**
 * Local ↔ remote diff of a single file, rendered by the Monaco diff
 * editor: word-level intra-line highlights, unchanged regions collapsed
 * (click to expand), side-by-side or inline view, prev/next navigation.
 * The header keeps the size/mtime/identical summary.
 */
export function CompareDialog({
  projectId,
  relativePath,
  sessionId,
  onClose,
}: Props) {
  const [result, setResult] = useState<FileComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [sideBySide, setSideBySide] = useState(true);
  const [changes, setChanges] = useState<number | null>(null);
  const diffRef = useRef<DiffViewHandle>(null);

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
      <DialogContent className="select-text flex h-[85vh] max-w-5xl flex-col gap-3 overflow-hidden p-4 sm:max-w-6xl">
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

            <div className="flex shrink-0 items-center gap-1 border-b pb-2">
              <button
                className={cn(
                  "rounded px-2 py-1 text-xs transition",
                  sideBySide
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-accent",
                )}
                onClick={() => setSideBySide(true)}
              >
                Side-by-side
              </button>
              <button
                className={cn(
                  "rounded px-2 py-1 text-xs transition",
                  !sideBySide
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-accent",
                )}
                onClick={() => setSideBySide(false)}
              >
                Inline
              </button>
              {!result.is_binary && (
                <div className="ml-auto flex items-center gap-1">
                  {changes != null && (
                    <span className="mr-1 text-xs text-muted-foreground">
                      {changes === 0
                        ? "No changes"
                        : `${changes} change${changes === 1 ? "" : "s"}`}
                    </span>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => diffRef.current?.prev()}
                    disabled={!changes}
                    title="Previous change"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => diffRef.current?.next()}
                    disabled={!changes}
                    title="Next change"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
              {result.is_binary ? (
                <div className="flex h-full items-center justify-center gap-2 bg-muted/30 p-4 text-sm text-muted-foreground">
                  <FileWarning className="h-4 w-4" />
                  Binary content — showing size/mtime only.
                </div>
              ) : (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      Loading diff viewer…
                    </div>
                  }
                >
                  <MonacoDiffView
                    ref={diffRef}
                    original={result.local_text ?? ""}
                    modified={result.remote_text ?? ""}
                    fileName={relativePath}
                    renderSideBySide={sideBySide}
                    onStats={setChanges}
                  />
                </Suspense>
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
