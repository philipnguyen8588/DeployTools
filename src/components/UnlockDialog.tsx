import { useEffect, useState } from "react";
import { Lock, KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { useVault } from "@/stores/vault";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/**
 * Blocking overlay shown on app launch until the user either:
 *  - enters a master password for an existing vault, or
 *  - sets one up for a brand-new vault.
 *
 * Nothing else in the app mounts while `unlocked === false`.
 */
export function UnlockDialog() {
  const { exists, loading, refresh, init, unlock } = useVault();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <span className="animate-pulse">Loading…</span>
      </div>
    );
  }

  const isInit = !exists;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (isInit && password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      toast.error("Use at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      if (isInit) {
        await init(password);
        toast.success("Vault created and unlocked");
      } else {
        await unlock(password);
      }
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(false);
      setPassword("");
      setConfirm("");
    }
  }

  return (
    <div className="grid h-full place-items-center bg-gradient-to-br from-background to-muted/30 p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-6 rounded-xl border bg-card p-8 shadow-xl"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="rounded-full bg-primary/10 p-3 text-primary">
            {isInit ? <ShieldCheck className="h-8 w-8" /> : <Lock className="h-8 w-8" />}
          </div>
          <h1 className="text-xl font-semibold">
            {isInit ? "Set a master password" : "Unlock DeployTools"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isInit
              ? "This password encrypts your SSH credentials at rest (AES-256-GCM + Argon2id). It is never stored."
              : "Enter your master password to decrypt the vault."}
          </p>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pw">Master password</Label>
            <Input
              id="pw"
              type="password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {isInit && (
            <div className="space-y-1.5">
              <Label htmlFor="pw2">Confirm password</Label>
              <Input
                id="pw2"
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          )}
        </div>

        <Button type="submit" disabled={busy} className="w-full">
          <KeyRound className="mr-2 h-4 w-4" />
          {busy ? "Working…" : isInit ? "Create vault" : "Unlock"}
        </Button>

        {!isInit && (
          <p className="text-center text-xs text-muted-foreground">
            Forgot your password? There is no recovery — the vault is
            cryptographically sealed.
          </p>
        )}
      </form>
    </div>
  );
}
