import { useEffect, useState } from "react";
import {
  Settings as SettingsIcon,
  FolderCog,
  RotateCcw,
  AlertTriangle,
  Timer,
} from "lucide-react";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

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
import { Label } from "./ui/label";

interface Props {
  onClose: () => void;
}

/**
 * App settings — currently scoped to the vault file location. Changing
 * the location writes `settings.json` beside the exe and triggers a
 * full app restart so `AppState` is rebuilt from the new path.
 */
export function SettingsDialog({ onClose }: Props) {
  const [s, setS] = useState<api.AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [idleDraft, setIdleDraft] = useState<string>("");

  async function reload() {
    try {
      const next = await api.getSettings();
      setS(next);
      setIdleDraft(String(next.idle_timeout_minutes));
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function saveIdleTimeout() {
    const n = Number.parseInt(idleDraft, 10);
    if (Number.isNaN(n) || n < 0) {
      toast.error("Idle timeout must be a non-negative integer (minutes).");
      return;
    }
    try {
      await api.setIdleTimeoutMinutes(n);
      toast.success(
        n === 0
          ? "Idle auto-disconnect disabled."
          : `Idle timeout set to ${n} min.`,
      );
      await reload();
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function pickDir() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Pick a folder for vault.enc",
    });
    if (!picked || typeof picked !== "string") return;
    await applyDir(picked);
  }

  async function applyDir(dir: string) {
    setBusy(true);
    try {
      await api.setVaultDir(dir);
      toast.success(
        "Vault location updated. The app needs to restart to apply.",
      );
      await confirmRestart();
    } catch (e) {
      toast.error(`${e}`);
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      await api.resetVaultDir();
      toast.success("Vault location reset to default.");
      await confirmRestart();
    } catch (e) {
      toast.error(`${e}`);
      setBusy(false);
    }
  }

  async function useLegacy() {
    if (!s?.legacy_appdata_path) return;
    // The legacy path is `…\com.deploytools.app\vault.enc` — the directory
    // we want is the parent.
    const dir = s.legacy_appdata_path.replace(/[\\/]vault\.enc$/, "");
    await applyDir(dir);
  }

  /** Small pause + auto-restart so the toast has a moment to render. */
  async function confirmRestart() {
    await new Promise((r) => setTimeout(r, 400));
    try {
      await api.restartApp();
    } catch (e) {
      toast.error(`Failed to restart: ${e}`);
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon className="h-5 w-5 text-primary" />
            Settings
          </DialogTitle>
          <DialogDescription>
            Configuration lives in <code className="font-mono">settings.json</code>
            {" "}next to the app exe — moving the install folder keeps your
            preferences intact.
          </DialogDescription>
        </DialogHeader>

        {!s ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4">
            {/* Current vault location */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <FolderCog className="h-4 w-4 text-primary" />
                Vault file
              </div>
              <div className="rounded border bg-muted/30 px-3 py-2 font-mono text-xs break-all">
                {s.vault_path}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {s.is_default
                  ? "Using the default location (beside the exe)."
                  : `Using a custom folder (default would be ${s.default_dir}).`}
              </p>
            </div>

            {/* Legacy warning */}
            {s.legacy_appdata_exists && s.legacy_appdata_path && (
              <div className="space-y-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-700 dark:text-yellow-400">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    <strong>A legacy vault was detected in AppData:</strong>
                    <div className="mt-1 font-mono break-all">
                      {s.legacy_appdata_path}
                    </div>
                    {s.is_default && !s.vault_path.endsWith("vault.enc")
                      ? null
                      : s.vault_path === s.legacy_appdata_path
                        ? " — currently in use."
                        : " — not currently in use."}
                  </div>
                </div>
                {s.vault_path !== s.legacy_appdata_path && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={useLegacy}
                  >
                    Point to legacy AppData vault
                  </Button>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={pickDir}
                title="Choose a folder that will contain vault.enc"
              >
                <FolderCog className="mr-1.5 h-3.5 w-3.5" />
                Change location…
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || s.is_default}
                onClick={reset}
                title="Reset to the default location (beside the exe)"
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Reset to default
              </Button>
            </div>

            {/* Idle auto-disconnect timeout */}
            <div className="space-y-1.5 border-t pt-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Timer className="h-4 w-4 text-primary" />
                Idle auto-disconnect
              </div>
              <p className="text-[11px] text-muted-foreground">
                A session is closed if the terminal has no keystrokes or
                server output for this many minutes. <strong>0</strong> to
                disable. Default {s.idle_timeout_default_minutes} min. Takes
                effect within 60&nbsp;s — no restart needed.
              </p>
              <div className="flex items-center gap-2">
                <Label htmlFor="idle-timeout" className="sr-only">
                  Minutes
                </Label>
                <Input
                  id="idle-timeout"
                  type="number"
                  min={0}
                  max={1440}
                  value={idleDraft}
                  onChange={(e) => setIdleDraft(e.target.value)}
                  className="h-8 w-28 text-sm"
                />
                <span className="text-xs text-muted-foreground">minutes</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void saveIdleTimeout()}
                  disabled={idleDraft === String(s.idle_timeout_minutes)}
                >
                  Save
                </Button>
                {s.idle_timeout_minutes === 0 && (
                  <span className="ml-1 rounded bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-600 dark:text-yellow-400">
                    DISABLED
                  </span>
                )}
              </div>
            </div>

            {/* Info */}
            <div className="space-y-1 border-t pt-3 text-[11px] text-muted-foreground">
              <div>
                <span className="text-foreground/80">exe dir:</span>{" "}
                <span className="font-mono">{s.exe_dir}</span>
              </div>
              <div>
                <span className="text-foreground/80">default vault dir:</span>{" "}
                <span className="font-mono">{s.default_dir}</span>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Changing the vault location triggers an app restart. Open sessions
              will be closed.
            </p>
          </div>
        )}

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
