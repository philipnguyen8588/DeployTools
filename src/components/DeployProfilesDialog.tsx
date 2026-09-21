import { useState } from "react";
import { Plus, Trash2, Rocket, Copy } from "lucide-react";
import { toast } from "sonner";

import type { DeployProfile, Project } from "@/lib/types";
import { useProjects } from "@/stores/projects";
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
import { useConfirm } from "./ConfirmDialog";
import { cn } from "@/lib/utils";

interface Props {
  project: Project;
  onClose: () => void;
}

/**
 * Manage a project's deploy profiles (named command recipes). Master-detail:
 * a list of profiles on the left, a name + commands editor on the right.
 * Commands are one per line. Saving persists the whole project via the
 * projects store (whole-struct upsert), so the Deploy menu updates at once.
 */
export function DeployProfilesDialog({ project, onClose }: Props) {
  const saveProject = useProjects((s) => s.save);
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<DeployProfile[]>(
    () => project.deploy_profiles?.map((p) => ({ ...p })) ?? [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    () => project.deploy_profiles?.[0]?.id ?? null,
  );
  const [busy, setBusy] = useState(false);

  const selected = profiles.find((p) => p.id === selectedId) ?? null;

  function addProfile() {
    const p: DeployProfile = {
      id: crypto.randomUUID(),
      name: "New profile",
      commands: [],
    };
    setProfiles((ps) => [...ps, p]);
    setSelectedId(p.id);
  }

  function duplicateProfile(src: DeployProfile) {
    const p: DeployProfile = {
      id: crypto.randomUUID(),
      name: `${src.name} (copy)`,
      commands: [...src.commands],
    };
    setProfiles((ps) => [...ps, p]);
    setSelectedId(p.id);
  }

  async function removeProfile(id: string) {
    const p = profiles.find((x) => x.id === id);
    const ok = await confirm({
      title: `Delete profile "${p?.name ?? ""}"?`,
      description: <div>This deploy profile will be removed.</div>,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    setProfiles((ps) => ps.filter((x) => x.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function patchSelected(patch: Partial<DeployProfile>) {
    if (!selected) return;
    setProfiles((ps) =>
      ps.map((p) => (p.id === selected.id ? { ...p, ...patch } : p)),
    );
  }

  async function save() {
    // Trim names + drop blank command lines before persisting.
    const cleaned = profiles.map((p) => ({
      ...p,
      name: p.name.trim() || "Untitled",
      commands: p.commands.map((c) => c.trim()).filter(Boolean),
    }));
    setBusy(true);
    try {
      await saveProject({ ...project, deploy_profiles: cleaned });
      toast.success("Deploy profiles saved");
      onClose();
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            Deploy profiles — {project.name}
          </DialogTitle>
          <DialogDescription>
            Each profile is a list of shell commands run in order in the
            project&apos;s remote folder after upload. The pipeline stops on the
            first command that fails.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-[20rem] gap-3">
          {/* Left — profile list */}
          <div className="flex w-52 shrink-0 flex-col rounded border">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {profiles.length === 0 ? (
                <div className="p-3 text-center text-xs text-muted-foreground">
                  No profiles yet.
                </div>
              ) : (
                profiles.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className={cn(
                      "flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs hover:bg-accent",
                      selectedId === p.id && "bg-primary/10 font-medium",
                    )}
                  >
                    <Rocket className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {p.commands.length}
                    </span>
                  </button>
                ))
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={addProfile}
              className="m-1 justify-start gap-1"
            >
              <Plus className="h-3.5 w-3.5" />
              Add profile
            </Button>
          </div>

          {/* Right — editor */}
          <div className="min-w-0 flex-1">
            {selected ? (
              <div className="flex h-full flex-col gap-2">
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={selected.name}
                      onChange={(e) => patchSelected({ name: e.target.value })}
                      placeholder="Deploy web"
                      className="h-7 text-xs"
                    />
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => duplicateProfile(selected)}
                    title="Duplicate this profile"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => void removeProfile(selected.id)}
                    title="Delete profile"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
                <div className="flex min-h-0 flex-1 flex-col space-y-1">
                  <Label className="text-xs">Commands (one per line)</Label>
                  <textarea
                    value={selected.commands.join("\n")}
                    onChange={(e) =>
                      patchSelected({ commands: e.target.value.split("\n") })
                    }
                    spellCheck={false}
                    placeholder={
                      "docker compose run --rm upgrade-db\ndocker compose restart web nginx"
                    }
                    className="min-h-0 flex-1 resize-none rounded border bg-background p-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Runs in{" "}
                    <span className="font-mono">{project.remote_path}</span>.
                    Stops on the first non-zero exit. No TTY — <code>sudo</code>{" "}
                    needs NOPASSWD.
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid h-full place-items-center text-xs text-muted-foreground">
                Select a profile, or add one.
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
