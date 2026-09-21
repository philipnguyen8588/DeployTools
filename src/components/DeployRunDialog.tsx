import { useEffect, useMemo, useState } from "react";
import { Rocket } from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { DeployProfile, GitCommit, GitFile, Project } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { cn } from "@/lib/utils";
import { runDeployJob, jumpToActivity } from "@/lib/deployJob";

interface Props {
  project: Project;
  sessionId: string;
  profile: DeployProfile;
  onClose: () => void;
}

type Source = "changes" | "commits" | "none";
const MAX_COMMITS = 3;

/**
 * Run a deploy profile: pick what to upload (git changes / recent commits /
 * nothing), review + tweak the commands (one-shot, not saved), then upload
 * and run the pipeline. Output streams to the Activity console.
 */
export function DeployRunDialog({ project, sessionId, profile, onClose }: Props) {
  const [source, setSource] = useState<Source>("changes");
  const [gitAvailable, setGitAvailable] = useState(true);
  const [changes, setChanges] = useState<GitFile[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [pickedCommits, setPickedCommits] = useState<Set<string>>(new Set());
  const [commitFiles, setCommitFiles] = useState<Record<string, GitFile[]>>({});
  const [text, setText] = useState(profile.commands.join("\n"));
  const [busy, setBusy] = useState(false);

  // Load git working-tree changes on mount; if the folder isn't a repo,
  // disable the git sources and fall back to commands-only.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const f = await api.gitStatus(project.id);
        if (cancelled) return;
        setChanges(f);
      } catch {
        if (cancelled) return;
        setGitAvailable(false);
        setSource("none");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Lazy-load the commit log the first time the user switches to commits,
  // then pre-select the 3 most recent commits (and fetch their files).
  useEffect(() => {
    if (source !== "commits" || commits.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const log = await api.gitLog(project.id, 10);
        if (cancelled) return;
        setCommits(log);
        const initial = log.slice(0, MAX_COMMITS);
        setPickedCommits(new Set(initial.map((c) => c.hash)));
        for (const c of initial) {
          try {
            const f = await api.gitFilesInCommit(project.id, c.hash);
            if (!cancelled) setCommitFiles((m) => ({ ...m, [c.hash]: f }));
          } catch {
            /* skip this commit's files */
          }
        }
      } catch (e) {
        if (!cancelled) toast.error(`${e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, project.id, commits.length]);

  async function toggleCommit(hash: string) {
    setPickedCommits((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        if (next.size >= MAX_COMMITS) return prev; // cap at 3
        next.add(hash);
      }
      return next;
    });
    // Fetch this commit's files once.
    if (!commitFiles[hash]) {
      try {
        const f = await api.gitFilesInCommit(project.id, hash);
        setCommitFiles((m) => ({ ...m, [hash]: f }));
      } catch (e) {
        toast.error(`${e}`);
      }
    }
  }

  // The concrete file list to upload, derived from the chosen source.
  const files = useMemo<string[]>(() => {
    if (source === "changes") {
      return changes.filter((f) => f.exists_on_disk).map((f) => f.relative_path);
    }
    if (source === "commits") {
      const seen = new Set<string>();
      for (const hash of pickedCommits) {
        for (const f of commitFiles[hash] ?? []) {
          if (f.exists_on_disk) seen.add(f.relative_path);
        }
      }
      return [...seen];
    }
    return [];
  }, [source, changes, pickedCommits, commitFiles]);

  const commands = useMemo(
    () => text.split("\n").map((s) => s.trim()).filter(Boolean),
    [text],
  );

  const canRun =
    !busy && (files.length > 0 || commands.length > 0);

  async function run() {
    onClose();
    let phase: "upload" | "cmd" = "upload";
    setBusy(true);
    try {
      await runDeployJob(
        `Deploy: ${profile.name}`,
        async ({ jobId, cancelled }) => {
          let uploaded = 0;
          let failedUp = 0;
          if (source !== "none" && files.length > 0) {
            const r = await api.deployFiles(project.id, files, sessionId, jobId);
            uploaded = r.uploaded;
            failedUp = r.failed.length;
          }
          if (cancelled()) return "Deploy cancelled";

          if (commands.length === 0) {
            if (failedUp > 0) {
              jumpToActivity(sessionId);
              return {
                text: `✓ ${uploaded} uploaded · ✗ ${failedUp} failed — see Activity`,
                warn: true as const,
              };
            }
            return `✓ Uploaded ${uploaded} file(s)`;
          }

          // Command phase — surface output in Activity.
          phase = "cmd";
          jumpToActivity(sessionId);
          const r = await api.deployRunCommands(
            project.id,
            sessionId,
            commands,
            jobId,
          );
          if (r.cancelled) return "Deploy cancelled";
          if (r.failed_step != null) {
            throw new Error(
              `Step ${r.failed_step}/${r.total} failed (exit ${r.exit_code}) — see Activity`,
            );
          }
          const base = `✓ ${profile.name}: ${uploaded} file(s) uploaded · ${r.steps_run}/${r.total} commands ok`;
          if (failedUp > 0) {
            return {
              text: `${base} · ✗ ${failedUp} upload(s) failed — see Activity`,
              warn: true as const,
            };
          }
          return base;
        },
        {
          formatProgress: (p) =>
            phase === "upload"
              ? `Deploy: ${profile.name} — uploading ${p.done}/${p.total}`
              : `Deploy: ${profile.name} — step ${p.done}/${p.total}: ${p.name}`,
        },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            Deploy — {profile.name}
          </DialogTitle>
          <DialogDescription>
            Choose what to upload, review the commands, then run. Commands run
            in <span className="font-mono">{project.remote_path}</span> and
            stop on the first failure.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Source picker */}
          <div className="space-y-1.5">
            <Label className="text-xs">Upload</Label>
            <div className="flex flex-wrap gap-3 text-xs">
              <SourceRadio
                checked={source === "changes"}
                disabled={!gitAvailable}
                onSelect={() => setSource("changes")}
                label="Git changes"
              />
              <SourceRadio
                checked={source === "commits"}
                disabled={!gitAvailable}
                onSelect={() => setSource("commits")}
                label="Recent commits"
              />
              <SourceRadio
                checked={source === "none"}
                onSelect={() => setSource("none")}
                label="No upload (commands only)"
              />
            </div>
            {!gitAvailable && (
              <p className="text-[11px] text-muted-foreground">
                This project&apos;s folder isn&apos;t a git repository — only
                commands-only deploy is available.
              </p>
            )}
          </div>

          {/* Commit picker */}
          {source === "commits" && (
            <div className="max-h-40 overflow-y-auto rounded border">
              {commits.length === 0 ? (
                <div className="p-3 text-center text-xs text-muted-foreground">
                  Loading commits…
                </div>
              ) : (
                commits.map((c) => {
                  const picked = pickedCommits.has(c.hash);
                  const atCap = pickedCommits.size >= MAX_COMMITS;
                  return (
                    <label
                      key={c.hash}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 border-b px-3 py-1.5 text-xs hover:bg-accent",
                        !picked && atCap && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-primary"
                        checked={picked}
                        disabled={!picked && atCap}
                        onChange={() => void toggleCommit(c.hash)}
                      />
                      <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                        {c.short_hash}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{c.summary}</span>
                        <span className="text-muted-foreground">
                          {c.author} · {new Date(c.time * 1000).toLocaleString()}
                        </span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          )}

          {/* File preview */}
          {source !== "none" && (
            <div className="space-y-1">
              <Label className="text-xs">
                {files.length} file{files.length === 1 ? "" : "s"} to upload
              </Label>
              <div className="max-h-32 overflow-y-auto rounded bg-muted px-2 py-1 font-mono text-[11px]">
                {files.length === 0 ? (
                  <div className="text-muted-foreground">
                    {source === "commits"
                      ? "Select 1–3 commits above."
                      : "Nothing to upload."}
                  </div>
                ) : (
                  files.map((f) => (
                    <div key={f} className="break-all">
                      {f}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Commands */}
          <div className="space-y-1">
            <Label className="text-xs">Commands (one per line)</Label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={5}
              placeholder={
                "docker compose run --rm upgrade-db\ndocker compose restart web nginx"
              }
              className="w-full resize-y rounded border bg-background p-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="text-[11px] text-muted-foreground">
              Edits here apply to this run only — they don&apos;t change the
              saved profile.
            </p>
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void run()} disabled={!canRun}>
            <Rocket className="mr-1 h-3.5 w-3.5" />
            Deploy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SourceRadio({
  checked,
  disabled,
  onSelect,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  label: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-1.5",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        type="radio"
        className="accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      {label}
    </label>
  );
}
