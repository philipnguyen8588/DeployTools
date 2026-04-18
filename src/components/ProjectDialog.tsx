import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, X } from "lucide-react";
import { toast } from "sonner";

import type { Project } from "@/lib/types";
import * as api from "@/lib/api";
import { useServers } from "@/stores/servers";
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

interface Props {
  project: Project | null;
  defaultServerId?: string;
  onClose: () => void;
  onSaved: () => void;
}

const empty = (serverId: string): Project => ({
  id: "00000000-0000-0000-0000-000000000000",
  name: "",
  server_id: serverId,
  local_path: "",
  remote_path: "/var/www/site",
  // Sensible defaults covering the ecosystems most likely in a web
  // project: Node, Python, Rust, .NET, IDEs, secrets, OS junk.
  excludes: [
    // VCS & IDE
    ".git",
    ".svn",
    ".hg",
    ".idea",
    ".vscode",
    ".vs",
    ".claude",
    // Secrets / env
    ".env",
    ".env.*",
    // Node
    "node_modules",
    ".next",
    ".nuxt",
    ".turbo",
    "dist",
    "build",
    "out",
    // Python
    "__pycache__",
    "*.pyc",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "venv",
    ".venv",
    "env",
    // Rust / .NET / JVM
    "target",
    "bin",
    "obj",
    ".gradle",
    // Testing & coverage
    "coverage",
    ".nyc_output",
    // Logs & tmp
    "*.log",
    "*.swp",
    "*.swo",
    "tmp",
    "temp",
    // OS
    ".DS_Store",
    "Thumbs.db",
  ],
  rsync_flags: "-avz --delete",
});

export function ProjectDialog({
  project,
  defaultServerId,
  onClose,
  onSaved,
}: Props) {
  const { servers, refresh } = useServers();
  const [form, setForm] = useState<Project>(
    project ?? empty(defaultServerId ?? ""),
  );
  const [excludeInput, setExcludeInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function pickLocal() {
    const selected = await openDialog({
      directory: true,
      title: "Select project folder",
    });
    if (typeof selected === "string") {
      setForm({ ...form, local_path: selected });
    }
  }

  function addExclude() {
    const v = excludeInput.trim();
    if (!v || form.excludes.includes(v)) return;
    setForm({ ...form, excludes: [...form.excludes, v] });
    setExcludeInput("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.server_id) {
      toast.error("Pick a server");
      return;
    }
    setBusy(true);
    try {
      await api.saveProject(form);
      toast.success("Project saved");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {project ? "Edit project" : "New project"}
          </DialogTitle>
          <DialogDescription>
            Map a local folder to a remote path. Excludes use glob patterns.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Server</Label>
              <select
                required
                value={form.server_id}
                onChange={(e) =>
                  setForm({ ...form, server_id: e.target.value })
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm"
              >
                <option value="">Select…</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Local path</Label>
            <div className="flex gap-2">
              <Input
                required
                placeholder="D:\\Projects\\my-web"
                value={form.local_path}
                onChange={(e) =>
                  setForm({ ...form, local_path: e.target.value })
                }
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={pickLocal}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Remote path</Label>
            <Input
              required
              placeholder="/var/www/my-web"
              value={form.remote_path}
              onChange={(e) =>
                setForm({ ...form, remote_path: e.target.value })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>Excludes</Label>
            <div className="flex flex-wrap gap-1.5">
              {form.excludes.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 font-mono text-xs"
                >
                  {p}
                  <button
                    type="button"
                    onClick={() =>
                      setForm({
                        ...form,
                        excludes: form.excludes.filter((x) => x !== p),
                      })
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="e.g. node_modules, *.log"
                value={excludeInput}
                onChange={(e) => setExcludeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addExclude();
                  }
                }}
              />
              <Button type="button" variant="outline" onClick={addExclude}>
                Add
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Rsync flags</Label>
            <Input
              value={form.rsync_flags}
              onChange={(e) =>
                setForm({ ...form, rsync_flags: e.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              Default <code className="font-mono">-avz --delete</code>. Each
              token is passed as a separate argv (no shell interpolation).
            </p>
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
