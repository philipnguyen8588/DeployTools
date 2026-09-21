import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ScrollText,
  StopCircle,
  Pause,
  Play,
  Trash2,
  Download,
  Search,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { ActivityLine } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";

interface Props {
  sessionId: string;
  projectId: string;
  service: string;
  onClose: () => void;
}

/**
 * Modal log viewer for `docker compose logs -f <service>`. Spawns the
 * follow stream on mount, subscribes to the batched activity channel,
 * tears everything down on unmount. Includes pause, filter, and clear.
 */
export function DockerLogDialog({
  sessionId,
  projectId,
  service,
  onClose,
}: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  // Guard against React StrictMode's double-invocation of effects in
  // dev: we only want ONE follow stream per dialog, not two.
  const startedRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let alive = true;
    // Skip the second invocation in dev StrictMode — otherwise we
    // fire two `logs_follow` calls and the second one races against
    // its own cancellation.
    if (startedRef.current) {
      return () => {
        /* noop cleanup for the dupe pass */
      };
    }
    startedRef.current = true;

    (async () => {
      unlisteners.push(
        await listen<ActivityLine>(
          `activity://session/${sessionId}`,
          (e) => {
            if (!alive || pausedRef.current) return;
            if (e.payload.source !== "docker-logs") return;
            if (e.payload.tag && e.payload.tag !== service) return;
            setLines((prev) => append(prev, [e.payload.message]));
          },
        ),
      );
      unlisteners.push(
        await listen<ActivityLine[]>(
          `activity://session/${sessionId}/batch`,
          (e) => {
            if (!alive || pausedRef.current) return;
            const add = e.payload.filter(
              (l) =>
                l.source === "docker-logs" && (!l.tag || l.tag === service),
            );
            if (add.length === 0) return;
            setLines((prev) => append(prev, add.map((a) => a.message)));
          },
        ),
      );

      try {
        await api.dockerComposeLogsFollow(sessionId, projectId, service);
      } catch (e) {
        // Keep the dialog open and show the error inline — user needs
        // the full message (e.g. "Compose V2 not found") and a chance
        // to copy it, not a half-second toast flash.
        if (alive) setError(String(e));
      }
    })();

    return () => {
      alive = false;
      unlisteners.forEach((u) => u());
      void api.dockerComposeLogsStop(sessionId, service).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectId, service]);

  // Auto-scroll to bottom on new lines.
  useEffect(() => {
    if (!paused) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [lines, paused]);

  const shown = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  async function download() {
    try {
      const blob = new Blob([lines.join("\n")], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${service}-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="select-text flex h-[85vh] max-w-5xl flex-col gap-3 overflow-hidden p-4 sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4" />
            docker compose logs -f
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {service}
            </code>
          </DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2 border-b pb-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? (
              <>
                <Play className="mr-1 h-3.5 w-3.5" /> Resume
              </>
            ) : (
              <>
                <Pause className="mr-1 h-3.5 w-3.5" /> Pause
              </>
            )}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setLines([])}>
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
          <Button size="sm" variant="outline" onClick={download} disabled={lines.length === 0}>
            <Download className="mr-1 h-3.5 w-3.5" />
            Save
          </Button>
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 w-64 pl-7 text-xs"
            />
          </div>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {shown.length}/{lines.length} lines
            {paused ? " · paused" : ""}
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={onClose}
          >
            <StopCircle className="mr-1 h-3.5 w-3.5" />
            Stop
          </Button>
        </div>

        <div
          ref={scrollRef}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto rounded bg-background p-2 font-mono text-[11.5px] leading-5 text-foreground",
          )}
        >
          {error ? (
            <div className="flex h-full items-center justify-center p-4">
              <div className="max-w-md rounded border border-destructive/50 bg-destructive/10 p-4 text-center text-sm text-destructive">
                <AlertTriangle className="mx-auto mb-2 h-5 w-5" />
                <div className="whitespace-pre-wrap">{error}</div>
              </div>
            </div>
          ) : shown.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground">
              Waiting for output…
            </div>
          ) : (
            shown.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {line}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function append(prev: string[], add: string[]): string[] {
  // 2k lines keeps the in-memory tail bounded. Users can "Save" the
  // current buffer to disk if they need a longer capture.
  const MAX = 2000;
  const next = [...prev, ...add];
  return next.length > MAX ? next.slice(next.length - MAX) : next;
}
