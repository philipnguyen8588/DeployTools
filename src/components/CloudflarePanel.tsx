import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cloud,
  KeyRound,
  RefreshCcw,
  Globe,
  Plus,
  Edit3,
  Trash2,
  ShieldCheck,
  Shield,
  Search,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type { CfDnsRecord, CfZone } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { cn } from "@/lib/utils";
import { useConfirm } from "./ConfirmDialog";
import { CloudflareRecordDialog } from "./CloudflareRecordDialog";

/**
 * Full-screen Cloudflare DNS manager. Rendered in place of the tabs
 * area when the sidebar "Cloudflare" entry is active.
 *
 * Flow:
 *   1. If no API token → setup screen.
 *   2. Otherwise: left column lists zones, right column lists records.
 *   3. Records can be created / edited / deleted inline.
 */
export function CloudflarePanel() {
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setHasToken(await api.cfHasToken());
      } catch (e) {
        toast.error(`${e}`);
        setHasToken(false);
      }
    })();
  }, []);

  if (hasToken === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!hasToken) {
    return <TokenSetup onReady={() => setHasToken(true)} />;
  }

  return <ZonesView onRevoke={() => setHasToken(false)} />;
}

// ---------------- Token setup ----------------

function TokenSetup({ onReady }: { onReady: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    try {
      const status = await api.cfSetToken(token.trim());
      toast.success(`Token saved (${status})`);
      onReady();
    } catch (err) {
      toast.error(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center bg-gradient-to-br from-background to-muted/30 p-6">
      <form
        onSubmit={save}
        className="w-full max-w-lg space-y-5 rounded-xl border bg-card p-8 shadow-xl"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="rounded-full bg-[#F38020]/10 p-3 text-[#F38020]">
            <Cloud className="h-8 w-8" />
          </div>
          <h1 className="text-xl font-semibold">Connect Cloudflare</h1>
          <p className="text-sm text-muted-foreground">
            Paste an API token with <strong>Zone · DNS · Edit</strong>{" "}
            permission. It's encrypted at rest in the same vault as your
            SSH credentials.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tok">API token</Label>
          <Input
            id="tok"
            type="password"
            autoFocus
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Cloudflare API token"
          />
        </div>

        <Button type="submit" disabled={busy} className="w-full">
          <KeyRound className="mr-2 h-4 w-4" />
          {busy ? "Verifying…" : "Verify & save"}
        </Button>

        <a
          href="https://dash.cloudflare.com/profile/api-tokens"
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-1 text-xs text-muted-foreground hover:underline"
        >
          Create a token
          <ExternalLink className="h-3 w-3" />
        </a>
      </form>
    </div>
  );
}

// ---------------- Zones + records ----------------

function ZonesView({ onRevoke }: { onRevoke: () => void }) {
  const [zones, setZones] = useState<CfZone[]>([]);
  const [zonesLoading, setZonesLoading] = useState(true);
  const [zoneFilter, setZoneFilter] = useState("");
  const [selected, setSelected] = useState<CfZone | null>(null);
  const confirm = useConfirm();

  const refreshZones = useCallback(async () => {
    setZonesLoading(true);
    try {
      const z = await api.cfListZones();
      setZones(z);
      if (!selected && z.length > 0) setSelected(z[0]);
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setZonesLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void refreshZones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = zoneFilter.trim().toLowerCase();
    return q ? zones.filter((z) => z.name.toLowerCase().includes(q)) : zones;
  }, [zones, zoneFilter]);

  return (
    <div className="flex h-full">
      {/* Zones sidebar */}
      <aside className="flex w-72 flex-col border-r bg-card">
        <div className="flex items-center gap-2 border-b p-3">
          <Cloud className="h-4 w-4 text-[#F38020]" />
          <span className="font-semibold">Cloudflare</span>
          <div className="flex-1" />
          <Button
            size="icon"
            variant="ghost"
            onClick={refreshZones}
            title="Refresh zones"
          >
            <RefreshCcw
              className={cn("h-4 w-4", zonesLoading && "animate-spin")}
            />
          </Button>
        </div>

        <div className="border-b p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter zones…"
              value={zoneFilter}
              onChange={(e) => setZoneFilter(e.target.value)}
              className="h-8 pl-7 text-xs"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && !zonesLoading && (
            <div className="p-4 text-center text-xs text-muted-foreground">
              No zones match.
            </div>
          )}
          {filtered.map((z) => (
            <button
              key={z.id}
              onClick={() => setSelected(z)}
              className={cn(
                "flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm transition",
                selected?.id === z.id
                  ? "bg-primary/10 font-medium"
                  : "hover:bg-accent",
              )}
            >
              <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{z.name}</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {z.status} · {z.type}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="border-t p-2">
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={async () => {
              const ok = await confirm({
                title: "Disconnect Cloudflare?",
                description:
                  "The API token will be removed from the vault. You can add a new one any time.",
                confirmText: "Disconnect",
                danger: true,
              });
              if (!ok) return;
              await api.cfClearToken();
              onRevoke();
            }}
          >
            Disconnect
          </Button>
        </div>
      </aside>

      {/* Records */}
      <div className="min-w-0 flex-1">
        {selected ? (
          <RecordsTable zone={selected} />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            Select a zone on the left.
          </div>
        )}
      </div>
    </div>
  );
}

function RecordsTable({ zone }: { zone: CfZone }) {
  const [records, setRecords] = useState<CfDnsRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<CfDnsRecord | null | "new">(null);
  const confirm = useConfirm();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.cfListRecords(zone.id);
      setRecords(r);
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setLoading(false);
    }
  }, [zone.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return records;
    return records.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.content.toLowerCase().includes(q) ||
        r.type.toLowerCase() === q,
    );
  }, [records, filter]);

  async function removeRecord(r: CfDnsRecord) {
    const ok = await confirm({
      title: "Delete DNS record?",
      description: (
        <div className="space-y-1.5">
          <div>This will permanently remove the record from Cloudflare.</div>
          <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
            {r.type} {r.name} → {r.content}
          </div>
        </div>
      ),
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.cfDeleteRecord(zone.id, r.id);
      toast.success("Record deleted");
      await refresh();
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-2">
        <Globe className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold">{zone.name}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {records.length} records
        </span>
        <div className="flex-1" />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 w-56 pl-7 text-xs"
          />
        </div>
        <Button size="sm" variant="ghost" onClick={refresh}>
          <RefreshCcw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          New record
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/50 text-muted-foreground">
            <tr>
              <th className="w-16 px-3 py-2 text-left font-medium">Type</th>
              <th className="px-3 py-2 text-left font-medium">Name</th>
              <th className="px-3 py-2 text-left font-medium">Content</th>
              <th className="w-16 px-3 py-2 text-left font-medium">Proxy</th>
              <th className="w-20 px-3 py-2 text-left font-medium">TTL</th>
              <th className="w-24 px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.id}
                className="group border-b hover:bg-accent"
                onDoubleClick={() => setEditing(r)}
              >
                <td className="px-3 py-1.5 font-mono">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-semibold">
                    {r.type}
                  </span>
                </td>
                <td className="max-w-[20ch] truncate px-3 py-1.5 font-medium">
                  {r.name}
                </td>
                <td className="max-w-[30ch] truncate px-3 py-1.5 font-mono text-muted-foreground">
                  {r.content}
                </td>
                <td className="px-3 py-1.5">
                  {["A", "AAAA", "CNAME"].includes(r.type) ? (
                    r.proxied ? (
                      <span
                        className="inline-flex items-center gap-0.5 text-[#F38020]"
                        title="Proxied"
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-0.5 text-muted-foreground"
                        title="DNS only"
                      >
                        <Shield className="h-3.5 w-3.5" />
                      </span>
                    )
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {r.ttl === 1 ? "Auto" : `${r.ttl}s`}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <div className="inline-flex gap-1 opacity-0 group-hover:opacity-100">
                    <button
                      title="Edit"
                      onClick={() => setEditing(r)}
                      className="rounded p-1 hover:bg-background"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      title="Delete"
                      onClick={() => void removeRecord(r)}
                      className="rounded p-1 hover:bg-background"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && filtered.length === 0 && (
          <div className="p-8 text-center text-xs text-muted-foreground">
            {records.length === 0
              ? "No records in this zone yet."
              : "No records match the filter."}
          </div>
        )}
      </div>

      {editing !== null && (
        <CloudflareRecordDialog
          zoneId={zone.id}
          zoneName={zone.name}
          record={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      )}
    </div>
  );
}
