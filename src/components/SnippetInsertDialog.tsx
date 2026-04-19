import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, Search, ChevronLeft } from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { Snippet } from "@/lib/types";
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
import { Label } from "./ui/label";
import { cn } from "@/lib/utils";

interface Props {
  /** Session whose built-in variables (HOST, USER, REMOTE_PATH…) will fill the
   *  snippet before insertion. */
  sessionId: string;
  /** Called with the resolved command string. Caller is responsible for
   *  writing it into the active PTY (no trailing newline — user hits Enter). */
  onInsert: (command: string) => void;
  onClose: () => void;
}

type Step = "list" | "vars";

/**
 * Two-step snippet picker:
 *   1. "list"  — searchable list of snippets. Arrow keys move selection,
 *                Enter picks. The list scrolls the selected row into
 *                view automatically.
 *   2. "vars"  — prompt for user-defined variables, if any.
 *
 * On confirm we call `snippet_resolve` (not `snippet_run`) which does
 * the variable substitution server-side and returns the final command
 * string. The caller pastes it into the live terminal.
 */
export function SnippetInsertDialog({ sessionId, onInsert, onClose }: Props) {
  const [step, setStep] = useState<Step>("list");
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const [picked, setPicked] = useState<Snippet | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    (async () => {
      try {
        setSnippets(await api.snippetList());
      } catch (e) {
        toast.error(`${e}`);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q),
    );
  }, [snippets, filter]);

  // Keep selection inside the filtered window.
  useEffect(() => {
    setSelected((s) => {
      if (filtered.length === 0) return 0;
      return Math.min(s, filtered.length - 1);
    });
  }, [filtered]);

  // Scroll selected row into view.
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  async function pick(s: Snippet) {
    if (busy) return;
    if (s.variables.length > 0) {
      setPicked(s);
      setValues(
        Object.fromEntries(s.variables.map((v) => [v.key, v.default ?? ""])),
      );
      setStep("vars");
      return;
    }
    await resolveAndInsert(s, {});
  }

  async function submitVars(e: React.FormEvent) {
    e.preventDefault();
    if (!picked) return;
    await resolveAndInsert(picked, values);
  }

  async function resolveAndInsert(s: Snippet, vars: Record<string, string>) {
    setBusy(true);
    try {
      const cmd = await api.snippetResolve(sessionId, s.id, vars);
      onInsert(cmd);
      onClose();
    } catch (e) {
      toast.error(`${e}`);
      setBusy(false);
    }
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
      const s = filtered[selected];
      if (s) void pick(s);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === "vars" && (
              <button
                onClick={() => setStep("list")}
                className="rounded p-1 hover:bg-accent"
                title="Back"
                type="button"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            <Braces className="h-5 w-5 text-primary" />
            {step === "list" ? "Insert snippet" : `Fill: ${picked?.name}`}
          </DialogTitle>
          <DialogDescription>
            {step === "list"
              ? "↑↓ to navigate · Enter to pick · Esc to close. You'll review + press Enter in the terminal to run."
              : "Values will be substituted into the command template."}
          </DialogDescription>
        </DialogHeader>

        {step === "list" ? (
          <div className="flex min-h-0 flex-col gap-2">
            <div className="relative shrink-0">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                placeholder="Filter by name, description, command…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={onSearchKey}
                className="h-9 pl-7 text-sm"
              />
            </div>

            <div className="min-h-0 overflow-hidden rounded-md border">
              <div className="max-h-[50vh] overflow-y-auto">
                {filtered.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    {snippets.length === 0
                      ? "No snippets yet — create them in the Snippets sidebar."
                      : "No snippets match the filter."}
                  </div>
                ) : (
                  <ul ref={listRef}>
                    {filtered.map((s, i) => (
                      <li
                        key={s.id}
                        onClick={() => {
                          setSelected(i);
                          void pick(s);
                        }}
                        onMouseEnter={() => setSelected(i)}
                        className={cn(
                          "cursor-pointer border-b px-3 py-2 transition last:border-b-0",
                          selected === i
                            ? "bg-accent"
                            : "hover:bg-accent/60",
                        )}
                        title={s.description || s.command}
                      >
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold">
                            {s.name}
                          </span>
                          {s.variables.length > 0 && (
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                              {s.variables.length} var
                              {s.variables.length > 1 ? "s" : ""}
                            </span>
                          )}
                          {s.description && (
                            <span className="min-w-0 truncate text-xs text-muted-foreground">
                              — {s.description}
                            </span>
                          )}
                        </div>
                        <code className="mt-1 block truncate rounded bg-muted/60 px-2 py-1 font-mono text-[11px]">
                          {s.command}
                        </code>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submitVars} className="space-y-3">
            {picked?.variables.map((v) => (
              <div key={v.key} className="space-y-1.5">
                <Label>
                  {v.label || v.key}{" "}
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {`{{${v.key}}}`}
                  </span>
                </Label>
                {v.kind === "choice" ? (
                  <select
                    required
                    value={values[v.key] ?? ""}
                    onChange={(e) =>
                      setValues({ ...values, [v.key]: e.target.value })
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  >
                    <option value="">Select…</option>
                    {v.choices.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={v.kind === "secret" ? "password" : "text"}
                    required
                    autoFocus={v.key === picked!.variables[0].key}
                    value={values[v.key] ?? ""}
                    onChange={(e) =>
                      setValues({ ...values, [v.key]: e.target.value })
                    }
                  />
                )}
              </div>
            ))}
            <div className="max-h-32 overflow-y-auto rounded bg-muted/30 p-2 font-mono text-[11px]">
              {picked?.command}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep("list")}
              >
                Back
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Inserting…" : "Insert"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
