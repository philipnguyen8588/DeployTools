import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CheckCircle2,
  Info,
  AlertTriangle,
  XCircle,
  Trash2,
  CircleDot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActivityLevel, ActivityLine } from "@/lib/types";
import { Button } from "./ui/button";

interface Props {
  sessionId: string;
  projectId: string | null;
}

interface DisplayLine {
  id: string;
  time: string;
  level: ActivityLevel;
  source: string;
  message: string;
}

/**
 * Unified activity log for the current tab.
 *
 * Subscribes to three event streams from the backend:
 *   - `activity://session/{id}` — SFTP, compare, SSH, generic
 *   - `rsync-log://{project_id}` — rsync output lines
 *   - `sftp-progress://{id}`    — upload/download byte progress (rate-limited)
 *
 * Keeps the last 2000 lines and auto-scrolls to the bottom.
 */
export function ActivityConsole({ sessionId, projectId }: Props) {
  const [lines, setLines] = useState<DisplayLine[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastProgressAtRef = useRef(0);
  const counterRef = useRef(0);

  const push = (l: Omit<DisplayLine, "id" | "time">) => {
    counterRef.current += 1;
    const id = `${Date.now()}-${counterRef.current}`;
    const time = new Date().toLocaleTimeString();
    setLines((prev) => [...prev.slice(-999), { id, time, ...l }]);
  };

  useEffect(() => {
    const uns: UnlistenFn[] = [];
    let alive = true;
    (async () => {
      // Scoped activity — single lines
      uns.push(
        await listen<ActivityLine>(
          `activity://session/${sessionId}`,
          (e) => {
            if (!alive) return;
            push({
              level: e.payload.level,
              source: e.payload.source,
              message: e.payload.message,
            });
          },
        ),
      );
      // Batched (used by docker logs follow).
      uns.push(
        await listen<ActivityLine[]>(
          `activity://session/${sessionId}/batch`,
          (e) => {
            if (!alive) return;
            counterRef.current += 1;
            const baseId = `${Date.now()}-${counterRef.current}`;
            const time = new Date().toLocaleTimeString();
            const toAdd: DisplayLine[] = e.payload.map((p, i) => ({
              id: `${baseId}-${i}`,
              time,
              level: p.level,
              source: p.source,
              message: p.message,
            }));
            setLines((prev) => [...prev.slice(-1000 + toAdd.length), ...toAdd]);
          },
        ),
      );

      // rsync lines (keyed by project)
      if (projectId) {
        uns.push(
          await listen<{ level: "info" | "warn" | "error"; line: string }>(
            `rsync-log://${projectId}`,
            (e) => {
              if (!alive) return;
              push({
                level: e.payload.level,
                source: "rsync",
                message: e.payload.line,
              });
            },
          ),
        );
      }

      // sftp progress — coalesce to at most every 250 ms
      uns.push(
        await listen<{
          phase: "upload" | "download";
          path: string;
          written: number;
          total: number;
        }>(`sftp-progress://${sessionId}`, (e) => {
          if (!alive) return;
          const now = performance.now();
          const done = e.payload.written >= e.payload.total;
          if (!done && now - lastProgressAtRef.current < 250) return;
          lastProgressAtRef.current = now;
          const pct =
            e.payload.total === 0
              ? 0
              : Math.round((e.payload.written / e.payload.total) * 100);
          push({
            level: "info",
            source: "sftp",
            message: `${e.payload.phase === "upload" ? "↑" : "↓"} ${pct}% ${e.payload.path} (${e.payload.written}/${e.payload.total} B)`,
          });
        }),
      );
    })();
    return () => {
      alive = false;
      uns.forEach((u) => u());
    };
  }, [sessionId, projectId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b px-2 py-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <CircleDot className="h-3 w-3 text-green-500" />
          {lines.length} events
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-[11px]"
          onClick={() => setLines([])}
        >
          <Trash2 className="mr-1 h-3 w-3" />
          Clear
        </Button>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-2 font-mono text-[11.5px] leading-5 text-foreground"
      >
        {lines.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground">
            No activity yet.
          </div>
        ) : (
          lines.map((l) => <Row key={l.id} line={l} />)
        )}
      </div>
    </div>
  );
}

function Row({ line }: { line: DisplayLine }) {
  const { color, Icon } = decorate(line.level);
  return (
    <div className="flex items-start gap-2 whitespace-pre-wrap">
      <span className="shrink-0 text-muted-foreground">{line.time}</span>
      <Icon className={cn("mt-[3px] h-3 w-3 shrink-0", color)} />
      <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {line.source}
      </span>
      <span className={cn("flex-1", color)}>{line.message}</span>
    </div>
  );
}

function decorate(level: ActivityLevel) {
  switch (level) {
    case "success":
      return { color: "text-green-500", Icon: CheckCircle2 };
    case "warn":
      return { color: "text-yellow-500", Icon: AlertTriangle };
    case "error":
      return { color: "text-red-500", Icon: XCircle };
    default:
      return { color: "text-foreground", Icon: Info };
  }
}
