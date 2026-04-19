import { useState } from "react";
import { Trash2 } from "lucide-react";

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
  /** What is being deleted — shown as the bold name in the prompt. */
  itemName: string;
  /** Free-form extra description (e.g. "Server + all its projects"). */
  description?: React.ReactNode;
  /** Keyword the user must type to confirm. Defaults to "delete". */
  keyword?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

/**
 * A stricter delete confirmation. Instead of a single "Yes" button,
 * forces the user to type the keyword (default: "delete") — catches
 * muscle-memory misclicks and doesn't autofocus a destructive action.
 */
export function DeleteConfirmDialog({
  itemName,
  description,
  keyword = "delete",
  onConfirm,
  onClose,
}: Props) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toLowerCase() === keyword.toLowerCase();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-destructive" />
            Delete {itemName}?
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              {description && <div>{description}</div>}
              <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                This action is permanent. Type{" "}
                <code className="rounded bg-destructive/20 px-1 font-mono font-semibold">
                  {keyword}
                </code>{" "}
                to confirm.
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="del-confirm" className="sr-only">
              Confirmation
            </Label>
            <Input
              id="del-confirm"
              autoFocus
              placeholder={keyword}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!matches || busy}
            >
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
