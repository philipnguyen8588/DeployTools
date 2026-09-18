import { Suspense, lazy, useEffect, useRef, useState } from "react";
import {
  Plus,
  X,
  TerminalSquare,
  ScrollText,
  Container,
  Cog,
  Cable,
  Activity as ActivityIcon,
  Loader2,
  Braces,
  RefreshCcw,
  Search,
  History as HistoryIcon,
  Highlighter,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

import * as api from "@/lib/api";
import { useSessions } from "@/stores/sessions";
import { usePrefs } from "@/stores/prefs";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
// Terminal + ActivityConsole are eagerly imported — Terminal is the
// default landing tab and Activity is the only tab on FTP sessions.
import { Terminal } from "./Terminal";
import { ActivityConsole } from "./ActivityConsole";

// Snippets picker — lazy, only loads when the user clicks the button.
const SnippetInsertDialog = lazy(() =>
  import("./SnippetInsertDialog").then((m) => ({
    default: m.SnippetInsertDialog,
  })),
);
const HistoryInsertDialog = lazy(() =>
  import("./HistoryInsertDialog").then((m) => ({
    default: m.HistoryInsertDialog,
  })),
);

// The rest are lazy — they only load when the user activates the tab,
// trimming the initial JS heap considerably on app start.
const DockerPanel = lazy(() =>
  import("./DockerPanel").then((m) => ({ default: m.DockerPanel })),
);
const ServicePanel = lazy(() =>
  import("./ServicePanel").then((m) => ({ default: m.ServicePanel })),
);
const MetricsPanel = lazy(() =>
  import("./MetricsPanel").then((m) => ({ default: m.MetricsPanel })),
);
const TunnelPanel = lazy(() =>
  import("./TunnelPanel").then((m) => ({ default: m.TunnelPanel })),
);

interface Props {
  sessionId: string;
  /** Used to key the terminal command history per-server. */
  serverId: string;
  projectId: string | null;
  projectRemoteBase?: string | null;
  /** Wire protocol — gates SSH-only tabs (Terminal, Git, Docker, …). */
  protocol?: "ssh" | "ftp" | "ftps";
  /** Whether this BottomPanel is inside the currently visible ServerTab.
   *  Global keyboard shortcuts (Ctrl+Shift+S / Ctrl+Shift+H) are only
   *  registered by the active panel — otherwise N open sessions = N
   *  listeners = N modal opens per keystroke. */
  isActive?: boolean;
}

type TabKind =
  | "terminal"
  | "docker"
  | "services"
  | "resources"
  | "tunnels"
  | "activity";

interface BottomTab {
  kind: TabKind;
  id: string;
  label: string;
}

/**
 * Bottom panel layout. Tab order is:
 *
 *   Terminal 1 | Terminal 2 | … | [+]  |  Docker  |  Resources  |  Tunnels  |  Activity  |  Services
 *
 * (Git lives at the top level next to the file browsers — see ServerTab.)
 *
 * Terminal tabs are first so they're the default landing. The "+" button
 * creates another terminal in the same SSH session (new shell channel —
 * no extra TCP handshake). All tabs stay mounted so their state survives
 * switching.
 */
export function BottomPanel({
  sessionId,
  serverId,
  projectId,
  protocol = "ssh",
  isActive = true,
}: Props) {
  const isSsh = protocol === "ssh";
  const [terminalTabs, setTerminalTabs] = useState<
    { id: string; label: string; seed?: string }[]
  >(() =>
    isSsh ? [{ id: `t-${Date.now()}-1`, label: "Terminal 1" }] : [],
  );
  const [active, setActive] = useState<string>(
    isSsh ? terminalTabs[0]?.id ?? "activity" : "activity",
  );
  // Track which tabs have EVER been activated. We only render their
  // contents once visited so unused panels (e.g. Resources on an FTP
  // session, Docker on a non-compose project) never cost RAM.
  const [visited, setVisited] = useState<Set<string>>(
    () => new Set([active]),
  );
  const counterRef = useCounter(terminalTabs.length);

  // Per-tab PTY ids, populated by each Terminal when its shell is ready.
  // We need these to paste snippets into the currently visible terminal.
  const [terminalIds, setTerminalIds] = useState<Record<string, string>>({});
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Counter bumped whenever we want the active terminal to re-grab
   *  keyboard focus — e.g. after a Snippets/History modal closes. */
  const [focusBump, setFocusBump] = useState(0);
  const refocusTerminal = () => setFocusBump((n) => n + 1);

  // Per-terminal-tab "last time the user looked at it". A tab's dot
  // lights up only when the session's `lastActivityAt` is strictly
  // newer than `lastSeen[tabId]`. The field is refreshed on activate
  // (both arriving AND leaving tabs) so the moment the user turns
  // away we snapshot "everything up to NOW has been seen"; only
  // activity strictly after this point counts as unread.
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({});

  const sessionActivity = useSessions(
    (s) => s.tabs.find((t) => t.session.id === sessionId)?.lastActivityAt ?? 0,
  );

  // Quick output-colorization toggle, mirrored from the prefs store so the
  // toolbar button reflects (and flips) the live state.
  const highlightEnabled = usePrefs((s) => s.highlightEnabled);
  const toggleHighlight = usePrefs((s) => s.toggleHighlight);

  // Initialise lastSeen for whichever tab the user is on right now.
  // Without this, a brand-new tab's lastSeen starts at 0 and any
  // initial MOTD output trips the "unread" check.
  useEffect(() => {
    if (!terminalTabs.some((t) => t.id === active)) return;
    setLastSeen((prev) =>
      prev[active] ? prev : { ...prev, [active]: Date.now() },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any time the active terminal has new output, bump its `lastSeen`
  // in real time so the dot never starts appearing WHILE the user is
  // reading. This runs on every render that changes `sessionActivity`,
  // which is driven by the sessions store (debounced by 200 ms, so it
  // won't spam).
  useEffect(() => {
    if (!terminalTabs.some((t) => t.id === active)) return;
    setLastSeen((prev) => {
      if ((prev[active] ?? 0) >= sessionActivity) return prev;
      return { ...prev, [active]: sessionActivity };
    });
  }, [sessionActivity, active, terminalTabs]);

  // Lifted filter + refresh state for the Docker / Services panels.
  // Each panel reads `filter` as a prop and watches `refreshNonce` for
  // the shared toolbar's Refresh click.
  const [dockerFilter, setDockerFilter] = useState("");
  const [servicesFilter, setServicesFilter] = useState("");
  const [dockerNonce, setDockerNonce] = useState(0);
  const [servicesNonce, setServicesNonce] = useState(0);
  const [dockerBusy, setDockerBusy] = useState(false);
  const [servicesBusy, setServicesBusy] = useState(false);

  // Refs to the two filter inputs — we auto-focus them whenever their
  // tab becomes active so the user can start typing straight away.
  const dockerFilterRef = useRef<HTMLInputElement>(null);
  const servicesFilterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (active === "docker") {
      window.setTimeout(() => dockerFilterRef.current?.focus(), 0);
    } else if (active === "services") {
      window.setTimeout(() => servicesFilterRef.current?.focus(), 0);
    }
  }, [active]);

  const activeIsTerminal = terminalTabs.some((t) => t.id === active);
  const activeTerminalId = activeIsTerminal ? terminalIds[active] ?? null : null;

  // Global keyboard shortcuts while a terminal tab is active.
  //   Ctrl+Shift+S  → open Snippets picker
  //   Ctrl+Shift+H  → open History picker
  //
  // IMPORTANT: gated on `isActive` — multiple server tabs stay mounted,
  // so without this gate every open session registers its own listener
  // and you'd see the modal N times per keystroke.
  //
  // We run in the capture phase + stop propagation so xterm doesn't
  // see the keys as typed input.
  useEffect(() => {
    if (!isActive) return;
    if (!activeIsTerminal) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey)) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        e.stopPropagation();
        if (activeTerminalId) setSnippetOpen(true);
      } else if (key === "h") {
        e.preventDefault();
        e.stopPropagation();
        if (activeTerminalId) setHistoryOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [isActive, activeIsTerminal, activeTerminalId]);

  async function insertSnippetIntoActiveTerminal(cmd: string) {
    if (!activeTerminalId) return;
    try {
      await api.termWrite(sessionId, activeTerminalId, cmd);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("insert snippet:", e);
    }
  }

  function activate(id: string) {
    const prevActive = active;
    setActive(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    // Mark BOTH the leaving tab and the arriving tab as "seen now":
    // the leaving one because any activity from this instant on is what
    // the user actually misses, the arriving one so its dot clears
    // immediately instead of flickering on next render.
    const stamp = Date.now();
    setLastSeen((prev) => ({
      ...prev,
      [id]: stamp,
      [prevActive]: stamp,
    }));
  }

  function newTerminal(opts?: { label?: string; seed?: string }) {
    const n = counterRef() + 1;
    const id = `t-${Date.now()}-${n}`;
    setTerminalTabs((t) => [
      ...t,
      { id, label: opts?.label ?? `Terminal ${n}`, seed: opts?.seed },
    ]);
    activate(id);
  }

  // Anyone in the tree (DockerPanel, SnippetRunner, …) can open a new
  // terminal on THIS session by dispatching a `open-terminal` custom
  // event. We scope to our own sessionId so events meant for another
  // tab don't leak.
  useEffect(() => {
    const handler = (ev: Event) => {
      const e = ev as CustomEvent<{
        sessionId: string;
        label?: string;
        seed?: string;
      }>;
      if (!e.detail || e.detail.sessionId !== sessionId) return;
      newTerminal({ label: e.detail.label, seed: e.detail.seed });
    };
    window.addEventListener("open-terminal", handler);
    return () => window.removeEventListener("open-terminal", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function closeTerminal(id: string) {
    setTerminalTabs((prev) => {
      const remaining = prev.filter((t) => t.id !== id);
      if (active === id) {
        const next = remaining[remaining.length - 1]?.id ?? "activity";
        activate(next);
      }
      return remaining;
    });
    setTerminalIds((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // SSH sessions get the full tab suite; FTP/FTPS only get Activity
  // (no terminal, no Docker, no metrics — these all need a shell).
  //
  // Ordering by frequency of use: Terminal → Docker → Resources →
  // Activity → Services. "Services" (systemd unit list) sits last as
  // it's rarely touched during day-to-day deploys.
  const ordered: BottomTab[] = isSsh
    ? [
        ...terminalTabs.map((t) => ({
          kind: "terminal" as const,
          id: t.id,
          label: t.label,
        })),
        ...(projectId
          ? [{ kind: "docker" as const, id: "docker", label: "Docker" }]
          : []),
        { kind: "resources" as const, id: "resources", label: "Resources" },
        { kind: "tunnels" as const, id: "tunnels", label: "Tunnels" },
        { kind: "activity" as const, id: "activity", label: "Activity" },
        { kind: "services" as const, id: "services", label: "Services" },
      ]
    : [{ kind: "activity" as const, id: "activity", label: "Activity" }];

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip — tabs scroll horizontally; the right-side toolbar
          (Snippets button) stays pinned. */}
      <div className="flex items-center border-b bg-card">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 py-1">
        {/* Standalone "+" when there are zero terminal tabs — otherwise
            the inline + (rendered as `after` of the last terminal chip)
            covers this, but that disappears once the last terminal is
            closed and the user would be stuck. */}
        {isSsh && terminalTabs.length === 0 && (
          <button
            onClick={() => newTerminal()}
            aria-label="New terminal"
            title="New terminal"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        {ordered.map((t, idx) => {
          // Insert "+" button immediately after the last terminal tab.
          const isLastTerminal =
            t.kind === "terminal" &&
            (ordered[idx + 1]?.kind ?? "") !== "terminal";
          const isActive = active === t.id;
          const Icon = iconFor(t.kind);
          return (
            <TabChip
              key={t.id}
              active={isActive}
              onActivate={() => activate(t.id)}
              onClose={
                t.kind === "terminal"
                  ? () => closeTerminal(t.id)
                  : undefined
              }
              Icon={Icon}
              label={t.label}
              unread={
                t.kind === "terminal" &&
                !isActive &&
                sessionActivity > (lastSeen[t.id] ?? 0)
              }
              after={
                isLastTerminal && (
                  <button
                    onClick={() => newTerminal()}
                    aria-label="New terminal"
                    title="New terminal"
                    className="ml-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )
              }
            />
          );
        })}
        </div>

        {/* Pinned right-side toolbar — content depends on the active
            tab. Terminal → Snippets button. Docker / Services → search
            input + refresh. Other tabs → nothing. */}
        {activeIsTerminal && (
          <div className="flex shrink-0 items-center gap-1 border-l px-1 py-1">
            <Button
              size="xs"
              variant={highlightEnabled ? "default" : "ghost"}
              onClick={() => {
                toggleHighlight();
                // Explicit feedback — the toggle only affects NEW output
                // (existing text keeps its color, and colors the server
                // itself sends are never touched), so without a toast a
                // quick test on an already-colored screen looks like the
                // button did nothing.
                toast.info(
                  highlightEnabled
                    ? "Output coloring off — applies to new output"
                    : "Output coloring on — IPs & keywords in new output",
                );
              }}
              title={
                highlightEnabled
                  ? "Extra coloring of plain output (IPs, keywords) is ON — click to turn off. Colors sent by the server itself are unaffected."
                  : "Extra coloring of plain output (IPs, keywords) is OFF — click to turn on. Colors sent by the server itself are unaffected."
              }
            >
              <Highlighter
                className={cn(
                  "mr-1 h-3 w-3",
                  !highlightEnabled && "text-muted-foreground",
                )}
              />
              Colors
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                if (!activeTerminalId) {
                  toast.info("Terminal is still starting — try again in a second.");
                  return;
                }
                setHistoryOpen(true);
              }}
              title="Reuse a command from this server's terminal history (Ctrl+Shift+H)"
            >
              <HistoryIcon className="mr-1 h-3 w-3" />
              History
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                if (!activeTerminalId) {
                  toast.info("Terminal is still starting — try again in a second.");
                  return;
                }
                setSnippetOpen(true);
              }}
              title="Paste a saved snippet into this terminal (Ctrl+Shift+S)"
            >
              <Braces className="mr-1 h-3 w-3" />
              Snippets
            </Button>
          </div>
        )}
        {active === "docker" && (
          <div className="flex shrink-0 items-center gap-1 border-l px-1 py-1">
            <div className="relative">
              <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={dockerFilterRef}
                placeholder="Filter services…"
                value={dockerFilter}
                onChange={(e) => setDockerFilter(e.target.value)}
                className="h-6 w-40 pl-6 text-xs"
              />
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setDockerNonce((n) => n + 1)}
              disabled={dockerBusy}
              title="Refresh Docker Compose state"
            >
              <RefreshCcw
                className={cn("h-3.5 w-3.5", dockerBusy && "animate-spin")}
              />
            </Button>
          </div>
        )}
        {active === "services" && (
          <div className="flex shrink-0 items-center gap-1 border-l px-1 py-1">
            <div className="relative">
              <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={servicesFilterRef}
                placeholder="Filter units…"
                value={servicesFilter}
                onChange={(e) => setServicesFilter(e.target.value)}
                className="h-6 w-40 pl-6 text-xs"
              />
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setServicesNonce((n) => n + 1)}
              disabled={servicesBusy}
              title="Refresh systemd unit list"
            >
              <RefreshCcw
                className={cn("h-3.5 w-3.5", servicesBusy && "animate-spin")}
              />
            </Button>
          </div>
        )}
      </div>

      {/* Content — mount-on-first-activate.
          Terminals + Activity stay mounted once created (we need their
          live state). Lazy panels only render AFTER the user first
          visits the tab — unvisited tabs cost no JS heap at all. */}
      <div className="relative min-h-0 flex-1">
        {terminalTabs.map((t) => (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              active === t.id ? "block" : "hidden",
            )}
          >
            <Terminal
              sessionId={sessionId}
              serverId={serverId}
              isActive={active === t.id}
              focusTrigger={focusBump}
              seed={t.seed}
              onTerminalReady={(tid) =>
                setTerminalIds((prev) => {
                  if (tid === null) {
                    if (!(t.id in prev)) return prev;
                    const next = { ...prev };
                    delete next[t.id];
                    return next;
                  }
                  if (prev[t.id] === tid) return prev;
                  return { ...prev, [t.id]: tid };
                })
              }
              // onServerOutput removed: the "unread" dot is now driven
              // by `sessionActivity > lastSeen[tabId]` instead of a
              // per-Terminal callback, so no extra prop is needed.
            />
          </div>
        ))}

        {projectId && visited.has("docker") && (
          <LazyPane visible={active === "docker"}>
            <DockerPanel
              sessionId={sessionId}
              projectId={projectId}
              filter={dockerFilter}
              refreshNonce={dockerNonce}
              onBusyChange={setDockerBusy}
            />
          </LazyPane>
        )}
        {visited.has("services") && (
          <LazyPane visible={active === "services"}>
            <ServicePanel
              sessionId={sessionId}
              filter={servicesFilter}
              refreshNonce={servicesNonce}
              onBusyChange={setServicesBusy}
            />
          </LazyPane>
        )}
        {visited.has("resources") && (
          <LazyPane visible={active === "resources"}>
            <MetricsPanel
              sessionId={sessionId}
              active={active === "resources"}
            />
          </LazyPane>
        )}
        {visited.has("tunnels") && (
          <LazyPane visible={active === "tunnels"}>
            <TunnelPanel sessionId={sessionId} />
          </LazyPane>
        )}
        {/* Activity mounts eagerly — cheap, and it's the FTP default. */}
        <Pane visible={active === "activity"}>
          <ActivityConsole sessionId={sessionId} projectId={projectId} />
        </Pane>
      </div>

      {snippetOpen && (
        <Suspense fallback={null}>
          <SnippetInsertDialog
            sessionId={sessionId}
            onInsert={(cmd) => void insertSnippetIntoActiveTerminal(cmd)}
            onClose={() => {
              setSnippetOpen(false);
              refocusTerminal();
            }}
          />
        </Suspense>
      )}
      {historyOpen && (
        <Suspense fallback={null}>
          <HistoryInsertDialog
            serverId={serverId}
            onInsert={(cmd) => void insertSnippetIntoActiveTerminal(cmd)}
            onClose={() => {
              setHistoryOpen(false);
              refocusTerminal();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

function LazyPane({
  visible,
  children,
}: {
  visible: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("absolute inset-0", visible ? "block" : "hidden")}>
      <Suspense
        fallback={
          <div className="grid h-full place-items-center text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </span>
          </div>
        }
      >
        {children}
      </Suspense>
    </div>
  );
}

function Pane({
  visible,
  children,
}: {
  visible: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("absolute inset-0", visible ? "block" : "hidden")}>
      {children}
    </div>
  );
}

function TabChip({
  active,
  onActivate,
  onClose,
  Icon,
  label,
  after,
  unread,
}: {
  active: boolean;
  onActivate: () => void;
  onClose?: () => void;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  after?: React.ReactNode;
  unread?: boolean;
}) {
  return (
    <div className="flex items-center">
      <div
        role="tab"
        aria-selected={active}
        className={cn(
          "group flex min-w-0 cursor-pointer select-none items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-xs transition",
          active
            ? "border-border bg-background font-medium text-foreground shadow-sm"
            : "text-muted-foreground hover:bg-accent",
        )}
        onClick={onActivate}
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
        {unread && (
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            title="New output"
          />
        )}
        {onClose && (
          <button
            aria-label="Close"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {after}
    </div>
  );
}

function iconFor(kind: TabKind) {
  switch (kind) {
    case "terminal":
      return TerminalSquare;
    case "docker":
      return Container;
    case "services":
      return Cog;
    case "resources":
      return ActivityIcon;
    case "tunnels":
      return Cable;
    case "activity":
      return ScrollText;
  }
}

function useCounter(start: number) {
  const ref = useRefCell(start);
  return () => {
    ref.current += 1;
    return ref.current;
  };
}

function useRefCell<T>(initial: T): { current: T } {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [ref] = useState(() => ({ current: initial }));
  return ref;
}
