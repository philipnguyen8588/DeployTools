import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { CfDnsRecord, CfRecordInput } from "@/lib/types";
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
  zoneId: string;
  zoneName: string;
  /** null = create new; otherwise edit. */
  record: CfDnsRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

const RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "TXT",
  "MX",
  "NS",
  "SRV",
  "CAA",
] as const;

const TTL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Auto" },
  { value: 60, label: "1 min" },
  { value: 300, label: "5 min" },
  { value: 600, label: "10 min" },
  { value: 1800, label: "30 min" },
  { value: 3600, label: "1 hour" },
  { value: 7200, label: "2 hours" },
  { value: 86400, label: "1 day" },
];

export function CloudflareRecordDialog({
  zoneId,
  zoneName,
  record,
  onClose,
  onSaved,
}: Props) {
  const [form, setForm] = useState<CfRecordInput>(() =>
    record
      ? {
          type: record.type,
          name: record.name,
          content: record.content,
          ttl: record.ttl || 1,
          proxied: record.proxied,
          priority: record.priority ?? null,
          comment: record.comment ?? null,
        }
      : {
          type: "A",
          name: "",
          content: "",
          ttl: 1,
          proxied: false,
          priority: null,
          comment: null,
        },
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Reset when the edited record changes
    if (record) {
      setForm({
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl || 1,
        proxied: record.proxied,
        priority: record.priority ?? null,
        comment: record.comment ?? null,
      });
    }
  }, [record]);

  const isMx = form.type === "MX";
  const isSrv = form.type === "SRV";
  const canBeProxied = ["A", "AAAA", "CNAME"].includes(form.type);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload: CfRecordInput = {
        ...form,
        priority: isMx || isSrv ? (form.priority ?? 10) : null,
        proxied: canBeProxied ? form.proxied : false,
        comment: form.comment?.trim() ? form.comment : null,
      };
      if (record) {
        await api.cfUpdateRecord(zoneId, record.id, payload);
        toast.success("Record updated");
      } else {
        await api.cfCreateRecord(zoneId, payload);
        toast.success("Record created");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {record ? "Edit DNS record" : "New DNS record"}
          </DialogTitle>
          <DialogDescription>Zone: {zoneName}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <select
                value={form.type}
                onChange={(e) =>
                  setForm({ ...form, type: e.target.value, priority: null })
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {RECORD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>Name</Label>
              <Input
                required
                placeholder={`@, www, or www.${zoneName}`}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                Use <code className="font-mono">@</code> for the root.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{form.type === "TXT" ? "Content (text)" : "Value"}</Label>
            {form.type === "TXT" ? (
              <textarea
                required
                rows={3}
                className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                value={form.content}
                onChange={(e) =>
                  setForm({ ...form, content: e.target.value })
                }
              />
            ) : (
              <Input
                required
                placeholder={
                  form.type === "A"
                    ? "192.0.2.1"
                    : form.type === "AAAA"
                      ? "2001:db8::1"
                      : form.type === "CNAME"
                        ? "example.com"
                        : ""
                }
                value={form.content}
                onChange={(e) =>
                  setForm({ ...form, content: e.target.value })
                }
              />
            )}
          </div>

          {(isMx || isSrv) && (
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Input
                type="number"
                required
                value={form.priority ?? 10}
                onChange={(e) =>
                  setForm({ ...form, priority: Number(e.target.value) })
                }
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>TTL</Label>
              <select
                value={form.ttl}
                onChange={(e) =>
                  setForm({ ...form, ttl: Number(e.target.value) })
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {TTL_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            {canBeProxied && (
              <div className="space-y-1.5">
                <Label>Proxy status</Label>
                <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                  <input
                    type="checkbox"
                    checked={form.proxied}
                    onChange={(e) =>
                      setForm({ ...form, proxied: e.target.checked })
                    }
                  />
                  Proxied through Cloudflare
                </label>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Comment (optional)</Label>
            <Input
              value={form.comment ?? ""}
              onChange={(e) =>
                setForm({ ...form, comment: e.target.value || null })
              }
              placeholder="Internal note for your team"
            />
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : record ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
