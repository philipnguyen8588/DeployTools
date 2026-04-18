import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Braces,
  Plus,
  Play,
  Edit3,
  Trash2,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { Snippet, SnippetVar, SnippetVarKind } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { cn } from "@/lib/utils";
import { useConfirm } from "./ConfirmDialog";
import { useSessions } from "@/stores/sessions";

/**
 * Full-screen snippet library — the place to create, edit, and run
 * reusable shell commands. Rendered when `useView().view === "snippets"`.
 *
 * Running a snippet requires an active SSH session (picked via the
 * top-right dropdown). Output streams into the Activity console of
 * that session.
 */
export function SnippetManager() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<Snippet | "new" | null>(null);
  const [running, setRunning] = useState<Snippet | null>(null);
  const tabs = useSessions((s) => s.tabs);
  const activeId = useSessions((s) => s.activeId);
  const setActive = useSessions((s) => s.setActive);
  const confirm = useConfirm();

  const refresh = useCallback(async () => {
    try {
      setSnippets(await api.snippetList());
    } catch (e) {
      toast.error(`${e}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const activeTab = tabs.find((t) => t.session.id === activeId);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b p-3">
        <Braces className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Snippet Library</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {snippets.length} snippets
        </span>
        <div className="flex-1" />
        {tabs.length > 0 ? (
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            Run on:
            <select
              value={activeId ?? ""}
              onChange={(e) => setActive(e.target.value)}
              className="h-7 rounded-md border border-input bg-background px-2 text-xs"
            >
              {tabs.map((t) => (
                <option key={t.session.id} value={t.session.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-xs text-muted-foreground">
            Open a session to run snippets
          </span>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 w-56 pl-7 text-xs"
          />
        </div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          New
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {filtered.length === 0 ? (
          <div className="grid h-full place-items-center text-center text-sm text-muted-foreground">
            {snippets.length === 0 ? (
              <div>
                <Braces className="mx-auto mb-2 h-8 w-8 opacity-50" />
                No snippets yet. Click <strong>+ New</strong> to create your
                first.
                <div className="mt-2 text-xs">
                  Use <code className="rounded bg-muted px-1 font-mono">
                    {`{{HOST}} {{USER}} {{REMOTE_PATH}}`}
                  </code>{" "}
                  for built-in variables.
                </div>
              </div>
            ) : (
              "No snippets match the filter."
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map((s) => (
              <div
                key={s.id}
                className="group rounded-md border bg-card p-3 transition hover:border-primary/50"
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="flex-1 truncate text-sm font-semibold">
                    {s.name}
                  </span>
                  <button
                    title="Run"
                    className="rounded p-1 text-primary opacity-70 hover:bg-accent hover:opacity-100"
                    onClick={() => {
                      if (!activeTab) {
                        toast.error("Open a session first");
                        return;
                      }
                      setRunning(s);
                    }}
                  >
                    <Play className="h-3.5 w-3.5" />
                  </button>
                  <button
                    title="Edit"
                    className="rounded p-1 opacity-0 hover:bg-accent group-hover:opacity-100"
                    onClick={() => setEditing(s)}
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    title="Delete"
                    className="rounded p-1 opacity-0 hover:bg-accent group-hover:opacity-100"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Delete snippet "${s.name}"?`,
                        confirmText: "Delete",
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await api.snippetDelete(s.id);
                        await refresh();
                      } catch (e) {
                        toast.error(`${e}`);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </button>
                </div>
                {s.description && (
                  <p className="mb-2 line-clamp-2 text-xs text-muted-foreground">
                    {s.description}
                  </p>
                )}
                <pre className="overflow-x-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-4">
                  {s.command}
                </pre>
                {s.variables.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {s.variables.map((v) => (
                      <span
                        key={v.key}
                        className="inline-flex items-center rounded-full border bg-muted px-1.5 text-[10px] font-mono"
                      >
                        {`{{${v.key}}}`}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {editing !== null && (
        <SnippetEditDialog
          snippet={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => refresh()}
        />
      )}

      {running && activeTab && (
        <SnippetRunDialog
          snippet={running}
          sessionId={activeTab.session.id}
          onClose={() => setRunning(null)}
        />
      )}
    </div>
  );
}

// ----------- Edit dialog ------------

function SnippetEditDialog({
  snippet,
  onClose,
  onSaved,
}: {
  snippet: Snippet | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Snippet>(
    snippet ?? {
      id: "00000000-0000-0000-0000-000000000000",
      name: "",
      description: "",
      command: "",
      variables: [],
    },
  );
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.snippetSave(form);
      toast.success(snippet ? "Snippet updated" : "Snippet created");
      onSaved();
      onClose();
    } catch (err) {
      toast.error(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  function addVar() {
    setForm({
      ...form,
      variables: [
        ...form.variables,
        { key: "", label: "", default: null, kind: "text", choices: [] },
      ],
    });
  }

  function updateVar(i: number, patch: Partial<SnippetVar>) {
    const next = [...form.variables];
    next[i] = { ...next[i], ...patch };
    setForm({ ...form, variables: next });
  }

  function removeVar(i: number) {
    setForm({
      ...form,
      variables: form.variables.filter((_, idx) => idx !== i),
    });
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{snippet ? "Edit snippet" : "New snippet"}</DialogTitle>
          <DialogDescription>
            Variables use{" "}
            <code className="font-mono">{`{{KEY}}`}</code> syntax. Built-ins:{" "}
            <code className="font-mono">{`{{HOST}} {{USER}} {{PORT}} {{REMOTE_PATH}} {{LOCAL_PATH}} {{PROJECT_NAME}}`}</code>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label>Name</Label>
              <Input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Input
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>Command</Label>
            <textarea
              required
              rows={5}
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
              className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs"
              placeholder={`tail -f /var/log/{{LOGFILE}}.log`}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Variables (prompted before run)</Label>
              <Button type="button" size="sm" variant="outline" onClick={addVar}>
                <Plus className="mr-1 h-3 w-3" />
                Add
              </Button>
            </div>
            {form.variables.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No user-defined variables.
              </p>
            ) : (
              <div className="space-y-2">
                {form.variables.map((v, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-12 items-center gap-2 rounded-md border p-2"
                  >
                    <Input
                      placeholder="KEY"
                      value={v.key}
                      onChange={(e) =>
                        updateVar(i, {
                          key: e.target.value.toUpperCase().replace(/\s/g, "_"),
                        })
                      }
                      className="col-span-2 h-7 font-mono text-xs"
                    />
                    <Input
                      placeholder="Label"
                      value={v.label}
                      onChange={(e) => updateVar(i, { label: e.target.value })}
                      className="col-span-3 h-7 text-xs"
                    />
                    <select
                      value={v.kind}
                      onChange={(e) =>
                        updateVar(i, {
                          kind: e.target.value as SnippetVarKind,
                        })
                      }
                      className="col-span-2 h-7 rounded-md border border-input bg-background px-2 text-xs"
                    >
                      <option value="text">text</option>
                      <option value="path">path</option>
                      <option value="secret">secret</option>
                      <option value="choice">choice</option>
                    </select>
                    <Input
                      placeholder={
                        v.kind === "choice" ? "a,b,c" : "default (optional)"
                      }
                      value={
                        v.kind === "choice"
                          ? v.choices.join(",")
                          : v.default ?? ""
                      }
                      onChange={(e) =>
                        v.kind === "choice"
                          ? updateVar(i, {
                              choices: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            })
                          : updateVar(i, { default: e.target.value || null })
                      }
                      className="col-span-4 h-7 text-xs"
                    />
                    <button
                      type="button"
                      className="rounded p-1 hover:bg-accent"
                      onClick={() => removeVar(i)}
                    >
                      <X className="h-3.5 w-3.5 text-destructive" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ----------- Run dialog ------------

function SnippetRunDialog({
  snippet,
  sessionId,
  onClose,
}: {
  snippet: Snippet;
  sessionId: string;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const v of snippet.variables) {
      m[v.key] = v.default ?? "";
    }
    return m;
  });
  const [busy, setBusy] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const code = await api.snippetRun(sessionId, snippet.id, values);
      toast.success(`Snippet exited ${code}`);
      onClose();
    } catch (err) {
      toast.error(`${err}`);
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Run: {snippet.name}</DialogTitle>
          {snippet.description && (
            <DialogDescription>{snippet.description}</DialogDescription>
          )}
        </DialogHeader>

        <form onSubmit={run} className="space-y-3">
          {snippet.variables.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No variables — click Run to execute.
            </p>
          ) : (
            snippet.variables.map((v) => (
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
                    value={values[v.key] ?? ""}
                    onChange={(e) =>
                      setValues({ ...values, [v.key]: e.target.value })
                    }
                  />
                )}
              </div>
            ))
          )}

          <div
            className={cn(
              "max-h-32 overflow-y-auto rounded bg-muted/30 p-2 font-mono text-[11px]",
            )}
          >
            {snippet.command}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              <Play className="mr-1 h-3.5 w-3.5" />
              {busy ? "Running…" : "Run"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
