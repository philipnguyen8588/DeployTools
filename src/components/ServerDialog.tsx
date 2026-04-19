import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Plug } from "lucide-react";
import { toast } from "sonner";

import type { AuthMethod, Server } from "@/lib/types";
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
  serverId: string | null;
  /** Seed the form with this data instead of the empty template. Used
   *  by the "Copy" action — pass a clone of an existing server with
   *  `id` reset to nil so Save creates a new record. */
  initialServer?: Server | null;
  onClose: () => void;
  onSaved: () => void;
}

const emptyServer: Server = {
  id: "00000000-0000-0000-0000-000000000000",
  name: "",
  host: "",
  port: 22,
  user: "",
  auth: { kind: "password", password: "" },
  protocol: "ssh",
  host_key_fingerprint: null,
};

const DEFAULT_PORT: Record<"ssh" | "ftp" | "ftps", number> = {
  ssh: 22,
  ftp: 21,
  ftps: 21,
};

export function ServerDialog({
  serverId,
  initialServer,
  onClose,
  onSaved,
}: Props) {
  const [server, setServer] = useState<Server>(initialServer ?? emptyServer);
  const [authKind, setAuthKind] = useState<"password" | "private_key">(
    initialServer?.auth.kind ?? "password",
  );
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Load the full server record (including decrypted auth) from the
    // backend when editing an existing server. Skipped when a prefill
    // was provided (Copy flow) or when creating fresh (serverId null).
    if (!serverId || initialServer) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const full = await api.getServer(serverId);
        if (cancelled) return;
        setServer(full);
        setAuthKind(full.auth.kind);
      } catch (e) {
        toast.error(`Load server failed: ${e}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, initialServer]);

  async function pickKey() {
    // Windows IFileOpenDialog validates the typed filename against the
    // active filter pattern. SSH keys like `id_rsa` / `id_ed25519` have
    // no extension, so any restrictive filter rejects them with
    // "The file name is not valid."
    //
    // Passing no `filters` at all gives the default "All Files (*.*)"
    // behaviour, which accepts any path.
    const selected = await openDialog({
      multiple: false,
      title: "Select private key",
    });
    if (typeof selected === "string") {
      setServer((s) => ({
        ...s,
        auth: { kind: "private_key", key_path: selected, passphrase: null },
      }));
    }
  }

  /**
   * Try connecting with whatever is currently in the form — without
   * saving. Useful to catch typos/wrong password before committing.
   */
  async function test() {
    if (testing || busy) return;
    // Normalize auth to match the selected kind, same logic as submit().
    let auth: AuthMethod = server.auth;
    if (authKind === "password" && auth.kind !== "password") {
      auth = { kind: "password", password: "" };
    } else if (authKind === "private_key" && auth.kind !== "private_key") {
      auth = { kind: "private_key", key_path: "", passphrase: null };
    }
    const probe = { ...server, auth };

    // Quick client-side sanity check. FTP allows anonymous (empty user).
    if (!probe.host) {
      toast.error("Host is required");
      return;
    }
    if (probe.protocol === "ssh" && !probe.user) {
      toast.error("User is required for SSH");
      return;
    }
    if (probe.auth.kind === "password" && !probe.auth.password) {
      toast.error("Password is empty");
      return;
    }
    if (probe.auth.kind === "private_key" && !probe.auth.key_path) {
      toast.error("Pick a private key file");
      return;
    }

    setTesting(true);
    const id = toast.loading(`Connecting to ${probe.user}@${probe.host}:${probe.port}…`);
    try {
      const fp = await api.testConnectionConfig(probe);
      toast.success(`✓ Connected. Host key: ${fp}`, { id, duration: 8000 });
    } catch (e) {
      toast.error(`${e}`, { id, duration: 8000 });
    } finally {
      setTesting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Make sure `auth` matches the selected kind.
      let auth: AuthMethod = server.auth;
      if (authKind === "password" && auth.kind !== "password") {
        auth = { kind: "password", password: "" };
      } else if (authKind === "private_key" && auth.kind !== "private_key") {
        auth = { kind: "private_key", key_path: "", passphrase: null };
      }
      await api.saveServer({ ...server, auth });
      toast.success("Server saved");
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{serverId ? "Edit server" : "New server"}</DialogTitle>
          <DialogDescription>
            Credentials are encrypted at rest with AES-256-GCM.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}

        <form onSubmit={submit} className="space-y-3" hidden={loading}>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label>Name</Label>
              <Input
                required
                placeholder="prod-web"
                value={server.name}
                onChange={(e) =>
                  setServer({ ...server, name: e.target.value })
                }
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>Protocol</Label>
              <div className="flex gap-2">
                {(["ssh", "ftp", "ftps"] as const).map((p) => (
                  <Button
                    key={p}
                    type="button"
                    size="sm"
                    variant={server.protocol === p ? "default" : "outline"}
                    onClick={() => {
                      // Keep the current port if the user had customised
                      // it (i.e. not matching the default for the old
                      // protocol); otherwise snap to the new default.
                      const wasDefault =
                        server.port === DEFAULT_PORT[server.protocol];
                      setServer({
                        ...server,
                        protocol: p,
                        port: wasDefault ? DEFAULT_PORT[p] : server.port,
                        // FTP/FTPS don't support key auth.
                        auth:
                          p !== "ssh" && server.auth.kind === "private_key"
                            ? { kind: "password", password: "" }
                            : server.auth,
                      });
                      if (p !== "ssh") setAuthKind("password");
                    }}
                  >
                    {p.toUpperCase()}
                  </Button>
                ))}
              </div>
              {server.protocol === "ftps" && (
                <p className="text-[11px] text-yellow-600 dark:text-yellow-400">
                  FTPS (TLS) is not yet supported — use plain FTP for now.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Host</Label>
              <Input
                required
                placeholder="1.2.3.4 or example.com"
                value={server.host}
                onChange={(e) =>
                  setServer({ ...server, host: e.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>Port</Label>
              <Input
                type="number"
                required
                value={server.port}
                onChange={(e) =>
                  setServer({ ...server, port: Number(e.target.value) })
                }
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>
                User
                {server.protocol !== "ssh" && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    (leave empty for anonymous FTP)
                  </span>
                )}
              </Label>
              <Input
                required={server.protocol === "ssh"}
                placeholder={
                  server.protocol === "ssh" ? "deploy" : "anonymous or blank"
                }
                value={server.user}
                onChange={(e) =>
                  setServer({ ...server, user: e.target.value })
                }
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Authentication</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={authKind === "password" ? "default" : "outline"}
                size="sm"
                onClick={() => setAuthKind("password")}
              >
                Password
              </Button>
              <Button
                type="button"
                variant={authKind === "private_key" ? "default" : "outline"}
                size="sm"
                disabled={server.protocol !== "ssh"}
                title={
                  server.protocol !== "ssh"
                    ? "Key auth is SSH-only"
                    : undefined
                }
                onClick={() => setAuthKind("private_key")}
              >
                Private key
              </Button>
            </div>
          </div>

          {authKind === "password" ? (
            <div className="space-y-1.5">
              <Label>Password</Label>
              <Input
                type="password"
                value={
                  server.auth.kind === "password" ? server.auth.password : ""
                }
                onChange={(e) =>
                  setServer({
                    ...server,
                    auth: { kind: "password", password: e.target.value },
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Key-based auth is strongly recommended. Password auth with
                rsync requires sshpass on the host.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Private key — path OR pasted content</Label>
                <div className="flex gap-2">
                  <textarea
                    rows={
                      server.auth.kind === "private_key" &&
                      server.auth.key_path.includes("\n")
                        ? 6
                        : 1
                    }
                    placeholder={"~/.ssh/id_ed25519\n…or paste the key starting with -----BEGIN OPENSSH PRIVATE KEY-----"}
                    value={
                      server.auth.kind === "private_key"
                        ? server.auth.key_path
                        : ""
                    }
                    onChange={(e) =>
                      setServer({
                        ...server,
                        auth: {
                          kind: "private_key",
                          key_path: e.target.value,
                          passphrase:
                            server.auth.kind === "private_key"
                              ? server.auth.passphrase
                              : null,
                        },
                      })
                    }
                    spellCheck={false}
                    className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={pickKey}
                    title="Pick a key file…"
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  A single-line path loads the file at runtime; pasted PEM
                  content (starts with <code className="font-mono">-----BEGIN</code>)
                  is stored encrypted in the vault and used directly.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Passphrase (optional)</Label>
                <Input
                  type="password"
                  value={
                    server.auth.kind === "private_key"
                      ? server.auth.passphrase ?? ""
                      : ""
                  }
                  onChange={(e) =>
                    setServer({
                      ...server,
                      auth: {
                        kind: "private_key",
                        key_path:
                          server.auth.kind === "private_key"
                            ? server.auth.key_path
                            : "",
                        passphrase: e.target.value || null,
                      },
                    })
                  }
                />
              </div>
            </>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="secondary"
              disabled={testing || busy}
              onClick={test}
              className="mr-auto"
            >
              <Plug className={`mr-1.5 h-3.5 w-3.5 ${testing ? "animate-pulse" : ""}`} />
              {testing ? "Testing…" : "Test connection"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || testing}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
