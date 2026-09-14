import { useEffect, useMemo, useRef, useState } from "react";
import { History as HistoryIcon, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import { useConfirm } from "./ConfirmDialog";

interface Props {
  /** Server whose history we display. */
  serverId: string;
  /** Called with the selected command. Caller writes it into the PTY
   *  without a trailing newline (user hits Enter). */
  onInsert: (command: string) => void;
  onClose: () => void;
}

/**
 * Lists everything the user has pressed Enter on in the integrated
 * terminal for this server. Newest first. Search by substring.
 *
 * Keyboard:
 *   ↑↓     — move the highlight
 *   Enter  — insert the highlighted command into the PTY
 *   Esc    — close the dialog
 *
 * Clicking a row has the same effect as selecting + Enter.
 */
type SourceFilter = "all" | "user" | "mcp";

export function HistoryInsertDialog({ serverId, onInsert, onClose }: Props) {
  const [items, setItems] = useState<api.TerminalHistoryEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const confirm = useConfirm();

  async function reload() {
    try {
      setItems(await api.historyList(serverId));
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  useEffect(() => {
    void reload();
  }, [serverId]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return items.filter(
      (i) =>
        (sourceFilter === "all" || i.source === sourceFilter) &&
        (!q || i.command.toLowerCase().includes(q)),
    );
  }, [items, filter, sourceFilter]);

  useEffect(() => {
    setSelected((s) => {
      if (filtered.length === 0) return 0;
      return Math.min(s, filtered.length - 1);
    });
  }, [filtered]);

  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  async function clearAll() {
    const ok = await confirm({
      title: "Clear terminal history?",
      description:
        "All stored commands for this server will be deleted. Cannot be undone.",
      confirmText: "Clear",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.historyClear(serverId);
      await reload();
      toast.success("History cleared");
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  function pick(cmd: string) {
    onInsert(cmd);
    onClose();
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) =>
        filtered.length === 0 ? 0 : (s + 1) % filtered.length,
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) =>
        filtered.length === 0
          ? 0
          : (s - 1 + filtered.length) % filtered.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = filtered[selected];
      if (h) pick(h.command);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[92vw] max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HistoryIcon className="h-5 w-5 text-primary" />
            Terminal history
          </DialogTitle>
          <DialogDescription>
            ↑↓ to navigate · Enter to insert · Esc to close. The command
            pastes at the cursor without a trailing newline.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-2">
          <div className="flex shrink-0 items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                placeholder="Filter commands…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={onSearchKey}
                className="h-9 pl-7 text-sm"
              />
            </div>
            <div className="flex gap-0.5">
              {(["all", "user", "mcp"] as const).map((sf) => (
                <Button
                  key={sf}
                  size="sm"
                  variant={sourceFilter === sf ? "default" : "outline"}
                  onClick={() => setSourceFilter(sf)}
                  className="h-9"
                >
                  {sf === "all" ? "All" : sf === "user" ? "Me" : "MCP"}
                </Button>
              ))}
            </div>
          </div>

          <div className="min-h-0 overflow-hidden rounded-md border">
            <div className="max-h-[55vh] overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  {items.length === 0
                    ? "No history yet — type commands in the terminal to build it."
                    : "No history matches the filter."}
                </div>
              ) : (
                <ul ref={listRef}>
                  {filtered.map((h, i) => (
                    <li
                      key={h.id}
                      onClick={() => {
                        setSelected(i);
                        pick(h.command);
                      }}
                      onMouseEnter={() => setSelected(i)}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 border-b px-3 py-2 transition last:border-b-0",
                        selected === i
                          ? "bg-accent"
                          : "hover:bg-accent/60",
                      )}
                      title={new Date(h.time_ms).toLocaleString()}
                    >
                      <span className="mt-0.5 w-20 shrink-0 text-[10px] text-muted-foreground">
                        {formatRelative(h.time_ms)}
                      </span>
                      {h.source === "mcp" && (
                        <span className="mt-0.5 shrink-0 rounded bg-primary/15 px-1 py-0 text-[9px] font-semibold uppercase leading-4 text-primary">
                          MCP
                        </span>
                      )}
                      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
                        {h.command}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            disabled={items.length === 0}
            onClick={() => void clearAll()}
            className="mr-auto"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Clear all
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  const s = Math.floor(delta / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
