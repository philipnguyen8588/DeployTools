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
  host_key_fingerprint: null,
};

export function ServerDialog({ serverId, onClose, onSaved }: Props) {
  const [server, setServer] = useState<Server>(emptyServer);
  const [authKind, setAuthKind] = useState<"password" | "private_key">("password");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Load the full server record (including decrypted auth) from the
    // backend when editing, so the form prefills.
    if (!serverId) return;
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
  }, [serverId]);

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

    // Quick client-side sanity check.
    if (!probe.host || !probe.user) {
      toast.error("Host and user are required");
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
              <Label>User</Label>
              <Input
                required
                placeholder="deploy"
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
                <Label>Private key file</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    placeholder="~/.ssh/id_ed25519"
                    value={
                      server.auth.kind === "private_key"
                        ? server.auth.key_path
                        : ""
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={pickKey}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
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
