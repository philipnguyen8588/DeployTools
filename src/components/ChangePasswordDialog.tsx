import { useState } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

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
 * Re-encrypts the vault with a new master password. The flow is:
 *   1. Verify the current password (by calling `vault_change_password`
 *      which internally re-unlocks + re-encrypts in one shot).
 *   2. Replace the cached key in the backend with the new one.
 *
 * If anything fails on the backend (wrong current password, I/O, etc.)
 * the vault state is left untouched — the existing key stays valid.
 */
export function ChangePasswordDialog({ onClose }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    if (next.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    if (next !== confirm) {
      toast.error("New passwords don't match");
      return;
    }
    if (next === current) {
      toast.error("New password must differ from the current one");
      return;
    }

    setBusy(true);
    try {
      await api.vaultChangePassword(current, next);
      toast.success("Master password changed. Vault re-encrypted.");
      onClose();
    } catch (err) {
      toast.error(`${err}`);
    } finally {
      setBusy(false);
      setCurrent("");
      setNext("");
      setConfirm("");
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            Change master password
          </DialogTitle>
          <DialogDescription>
            The vault will be re-encrypted with the new key. This can't be
            undone — make sure you remember the new password.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cur">Current password</Label>
            <Input
              id="cur"
              type="password"
              autoFocus
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new">New password</Label>
            <Input
              id="new"
              type="password"
              required
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Minimum 8 characters. Re-derivation uses Argon2id — it will
              take ~0.5 s after you hit Save.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="conf">Confirm new password</Label>
            <Input
              id="conf"
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>

          <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              There's no password-recovery. If you forget, the entire vault
              (servers, projects, Cloudflare token) is unrecoverable.
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Re-encrypting…" : "Change password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
