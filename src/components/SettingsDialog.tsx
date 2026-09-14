import { useEffect, useState } from "react";
import {
  Settings as SettingsIcon,
  FolderCog,
  RotateCcw,
  AlertTriangle,
  Timer,
  Code2,
  CheckCircle2,
  XCircle,
  Sparkles,
  Bot,
  Copy,
  RefreshCw,
  Eye,
  EyeOff,
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
import { IdeIcon } from "./IdeIcon";

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
  const [ides, setIdes] = useState<api.IdeEntry[]>([]);
  const [mcp, setMcp] = useState<api.McpConfig | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [cmdPolicy, setCmdPolicy] = useState<api.McpCommandPolicy | null>(null);
  const [cmdMode, setCmdMode] = useState<string>("deny");
  const [denyDraft, setDenyDraft] = useState<string>("");
  const [activity, setActivity] = useState<api.McpActivityEntry[] | null>(null);

  async function loadActivity() {
    try {
      setActivity(await api.mcpActivityList(200));
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function clearActivity() {
    try {
      await api.mcpActivityClear();
      setActivity([]);
      toast.success("MCP activity log cleared");
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function reloadMcp() {
    try {
      setMcp(await api.mcpGetConfig());
      const pol = await api.mcpGetCommandPolicy();
      setCmdPolicy(pol);
      setCmdMode(pol.mode);
      setDenyDraft(pol.denylist.join("\n"));
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function saveCmdPolicy(nextMode?: string) {
    const mode = nextMode ?? cmdMode;
    const list = denyDraft
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await api.mcpSetCommandPolicy(mode, list);
      setCmdMode(mode);
      toast.success("Command guard updated");
      const pol = await api.mcpGetCommandPolicy();
      setCmdPolicy(pol);
      setDenyDraft(pol.denylist.join("\n"));
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function toggleMcp() {
    if (!mcp) return;
    try {
      await api.mcpSetEnabled(!mcp.enabled);
      await reloadMcp();
      toast.success(mcp.enabled ? "MCP server stopped" : "MCP server started");
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function regenMcpToken() {
    try {
      await api.mcpRegenerateToken();
      await reloadMcp();
      toast.success("New MCP token generated");
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  function copyText(text: string, what: string) {
    void navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  }

  async function reload() {
    try {
      const next = await api.getSettings();
      setS(next);
      setIdleDraft(String(next.idle_timeout_minutes));
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function reloadIdes() {
    try {
      setIdes(await api.listIdes());
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  useEffect(() => {
    void reload();
    void reloadIdes();
    void reloadMcp();
  }, []);

  async function pickIdeExe(key: string) {
    const picked = await openDialog({
      multiple: false,
      title: "Pick the IDE executable",
      filters: [{ name: "Executable", extensions: ["exe"] }],
    });
    if (!picked || typeof picked !== "string") return;
    try {
      await api.setIdePath(key, picked);
      await reloadIdes();
      toast.success("Path saved");
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function clearIde(key: string) {
    try {
      await api.clearIdePath(key);
      await reloadIdes();
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  async function autoFillIdes() {
    try {
      const filled = await api.autopopulateIdePaths();
      await reloadIdes();
      if (filled.length === 0) toast.info("No new IDEs detected.");
      else toast.success(`Auto-filled: ${filled.join(", ")}`);
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  // --- Custom IDE form state ---
  const [newIdeLabel, setNewIdeLabel] = useState("");
  const [newIdePath, setNewIdePath] = useState("");
  async function pickNewIdeExe() {
    const picked = await openDialog({
      multiple: false,
      title: "Pick the IDE executable",
      filters: [{ name: "Executable", extensions: ["exe"] }],
    });
    if (picked && typeof picked === "string") setNewIdePath(picked);
  }
  async function addCustomIde() {
    if (!newIdeLabel.trim() || !newIdePath.trim()) {
      toast.error("Label and path are required.");
      return;
    }
    try {
      await api.addCustomIde(newIdeLabel.trim(), newIdePath.trim());
      setNewIdeLabel("");
      setNewIdePath("");
      await reloadIdes();
      toast.success("IDE added");
    } catch (e) {
      toast.error(`${e}`);
    }
  }

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
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
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
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
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

            {/* IDEs — used by the "IDE" button on a server tab. */}
            <div className="space-y-1.5 border-t pt-3">
              <div className="flex items-center gap-2">
                <div className="flex flex-1 items-center gap-2 text-sm font-medium">
                  <Code2 className="h-4 w-4 text-primary" />
                  IDEs
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void autoFillIdes()}
                  title="Scan known install locations and pin the ones we find"
                >
                  <Sparkles className="mr-1 h-3 w-3" />
                  Auto-detect
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Path to each IDE's exe — used by the <strong>IDE</strong>{" "}
                button in the deploy bar. Auto-detect scans common install
                locations; browse manually if yours isn't found.
              </p>
              <ul className="divide-y rounded-md border">
                {ides.map((ide) => {
                  const active = ide.configured ?? ide.detected;
                  return (
                    <li
                      key={ide.key}
                      className="flex items-center gap-2 px-3 py-2"
                    >
                      <IdeIcon ideKey={ide.key} className="h-5 w-5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                          {active ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                          ) : (
                            <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          {ide.label}
                          {!ide.is_builtin && (
                            <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-mono text-blue-600 dark:text-blue-400">
                              custom
                            </span>
                          )}
                          {ide.is_builtin && !ide.configured && ide.detected && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                              auto-detected
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                          {active ?? "not installed / not set"}
                        </div>
                      </div>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void pickIdeExe(ide.key)}
                      >
                        Browse…
                      </Button>
                      {(ide.configured || !ide.is_builtin) && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => void clearIde(ide.key)}
                          title={
                            ide.is_builtin
                              ? "Remove the user override (falls back to auto-detected if any)"
                              : "Remove this custom IDE entirely"
                          }
                        >
                          {ide.is_builtin ? "Reset" : "Remove"}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* Add custom IDE form */}
              <div className="mt-1 space-y-2 rounded-md border border-dashed p-3">
                <div className="text-xs font-medium">Add custom IDE</div>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Label (e.g. Zed, Sublime)"
                    value={newIdeLabel}
                    onChange={(e) => setNewIdeLabel(e.target.value)}
                    className="h-8 text-xs"
                  />
                  <Input
                    placeholder="Path to .exe"
                    value={newIdePath}
                    onChange={(e) => setNewIdePath(e.target.value)}
                    className="h-8 flex-1 font-mono text-xs"
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void pickNewIdeExe()}
                  >
                    Browse…
                  </Button>
                  <Button
                    size="xs"
                    onClick={() => void addCustomIde()}
                    disabled={!newIdeLabel.trim() || !newIdePath.trim()}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </div>

            {/* MCP server — lets AI agents (Claude Code) drive the app. */}
            {mcp && (
              <div className="space-y-2 border-t pt-3">
                <div className="flex items-center gap-2">
                  <div className="flex flex-1 items-center gap-2 text-sm font-medium">
                    <Bot className="h-4 w-4 text-primary" />
                    AI agent control (MCP)
                    {mcp.running ? (
                      <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-green-600 dark:text-green-400">
                        RUNNING
                      </span>
                    ) : (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        STOPPED
                      </span>
                    )}
                  </div>
                  <Button
                    size="xs"
                    variant={mcp.enabled ? "outline" : "default"}
                    onClick={() => void toggleMcp()}
                  >
                    {mcp.enabled ? "Disable" : "Enable"}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Exposes a local MCP server on{" "}
                  <span className="font-mono">127.0.0.1:{mcp.port}</span> so
                  Claude Code / AI agents can connect to projects, upload git
                  changes, run sync, and execute commands on the connected
                  server. Requires the bearer token below.
                </p>

                {/* Token */}
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">
                    Token
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      type={showToken ? "text" : "password"}
                      value={mcp.token}
                      className="h-8 flex-1 font-mono text-xs"
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => setShowToken((v) => !v)}
                      title={showToken ? "Hide" : "Show"}
                    >
                      {showToken ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => copyText(mcp.token, "Token")}
                      title="Copy token"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => void regenMcpToken()}
                      title="Regenerate token (restarts the server)"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Ready-to-copy Claude Code command */}
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">
                    Add to Claude Code
                  </Label>
                  <div className="flex items-start gap-2">
                    <code className="flex-1 break-all rounded border bg-muted/30 px-2 py-1.5 font-mono text-[11px]">
                      {`claude mcp add deploytools --transport http --url http://127.0.0.1:${mcp.port}/mcp --header "Authorization: Bearer ${mcp.token}"`}
                    </code>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() =>
                        copyText(
                          `claude mcp add deploytools --transport http --url http://127.0.0.1:${mcp.port}/mcp --header "Authorization: Bearer ${mcp.token}"`,
                          "Command",
                        )
                      }
                      title="Copy command"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    The app must be open and the vault unlocked for agent calls
                    to work.
                  </p>
                </div>

                {/* Terminal command guard for run_command */}
                <div className="space-y-2 border-t pt-2">
                  <div className="text-[11px] font-medium">
                    Terminal command guard (run_command)
                  </div>
                  <div className="flex gap-1">
                    {(["off", "deny", "disabled"] as const).map((m) => (
                      <Button
                        key={m}
                        size="xs"
                        variant={cmdMode === m ? "default" : "outline"}
                        onClick={() => void saveCmdPolicy(m)}
                      >
                        {m === "off"
                          ? "Off"
                          : m === "deny"
                            ? "Block dangerous"
                            : "Disabled"}
                      </Button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {cmdMode === "off" &&
                      "All commands allowed — no protection."}
                    {cmdMode === "deny" &&
                      "Dangerous commands are blocked (denylist below). A denylist is a strong deterrent, not a full sandbox."}
                    {cmdMode === "disabled" &&
                      "run_command is fully disabled for AI agents."}
                  </p>
                  {cmdMode === "deny" && (
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">
                        Blocked programs (one per line)
                      </Label>
                      <textarea
                        value={denyDraft}
                        onChange={(e) => setDenyDraft(e.target.value)}
                        rows={4}
                        spellCheck={false}
                        className="w-full rounded border bg-background px-2 py-1 font-mono text-[11px]"
                      />
                      <div className="flex gap-2">
                        <Button size="xs" onClick={() => void saveCmdPolicy()}>
                          Save list
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            cmdPolicy &&
                            setDenyDraft(cmdPolicy.defaults.join("\n"))
                          }
                        >
                          Reset to defaults
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {/* MCP activity audit log */}
                <div className="space-y-2 border-t pt-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 text-[11px] font-medium">
                      MCP activity log
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        activity === null ? void loadActivity() : setActivity(null)
                      }
                    >
                      {activity === null ? "View" : "Hide"}
                    </Button>
                    {activity !== null && (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void loadActivity()}
                        >
                          Refresh
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={activity.length === 0}
                          onClick={() => void clearActivity()}
                        >
                          Clear
                        </Button>
                      </>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Every action an AI agent performs via MCP (connect, sync,
                    upload, run_command…) is recorded here. Stored as plaintext{" "}
                    <code className="font-mono">mcp-activity.jsonl</code> /{" "}
                    <code className="font-mono">terminal-history.jsonl</code>{" "}
                    next to your vault file.
                  </p>
                  {activity !== null &&
                    (activity.length === 0 ? (
                      <div className="rounded border p-3 text-center text-[11px] text-muted-foreground">
                        No MCP activity yet.
                      </div>
                    ) : (
                      <div className="max-h-48 overflow-y-auto rounded border">
                        <table className="w-full text-[11px]">
                          <tbody>
                            {activity.map((a) => (
                              <tr key={a.id} className="border-b last:border-0">
                                <td className="whitespace-nowrap px-2 py-1 align-top text-muted-foreground">
                                  {new Date(a.time_ms).toLocaleString()}
                                </td>
                                <td className="px-2 py-1 align-top font-mono">
                                  {a.tool}
                                </td>
                                <td className="px-2 py-1 align-top text-muted-foreground">
                                  {a.project ?? "—"}
                                </td>
                                <td className="break-all px-2 py-1 align-top font-mono">
                                  {a.detail}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                </div>
              </div>
            )}

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
