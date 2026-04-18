import { Suspense, lazy, useEffect, useState } from "react";
import {
  Plus,
  X,
  TerminalSquare,
  ScrollText,
  GitBranch,
  Container,
  Cog,
  Activity as ActivityIcon,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Terminal + ActivityConsole are eagerly imported — Terminal is the
// default landing tab and Activity is the only tab on FTP sessions.
import { Terminal } from "./Terminal";
import { ActivityConsole } from "./ActivityConsole";

// The rest are lazy — they only load when the user activates the tab,
// trimming the initial JS heap considerably on app start.
const GitPanel = lazy(() =>
  import("./GitPanel").then((m) => ({ default: m.GitPanel })),
);
const DockerPanel = lazy(() =>
  import("./DockerPanel").then((m) => ({ default: m.DockerPanel })),
);
const ServicePanel = lazy(() =>
  import("./ServicePanel").then((m) => ({ default: m.ServicePanel })),
);
const MetricsPanel = lazy(() =>
  import("./MetricsPanel").then((m) => ({ default: m.MetricsPanel })),
);

interface Props {
  sessionId: string;
  projectId: string | null;
  projectRemoteBase?: string | null;
  /** Wire protocol — gates SSH-only tabs (Terminal, Git, Docker, …). */
  protocol?: "ssh" | "ftp" | "ftps";
}

type TabKind =
  | "terminal"
  | "git"
  | "docker"
  | "services"
  | "resources"
  | "activity";

interface BottomTab {
  kind: TabKind;
  id: string;
  label: string;
}

/**
 * Bottom panel layout. Tab order is:
 *
 *   Terminal 1 | Terminal 2 | … | [+]  |  Git  |  Docker  |  Services  |  Resources  |  Activity
 *
 * Terminal tabs are first so they're the default landing. The "+" button
 * creates another terminal in the same SSH session (new shell channel —
 * no extra TCP handshake). All tabs stay mounted so their state survives
 * switching.
 */
export function BottomPanel({
  sessionId,
  projectId,
  projectRemoteBase,
  protocol = "ssh",
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

  function activate(id: string) {
    setActive(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
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
  }

  // SSH sessions get the full tab suite; FTP/FTPS only get Activity
  // (no terminal, no Docker, no metrics — these all need a shell).
  const ordered: BottomTab[] = isSsh
    ? [
        ...terminalTabs.map((t) => ({
          kind: "terminal" as const,
          id: t.id,
          label: t.label,
        })),
        ...(projectId
          ? [
              { kind: "git" as const, id: "git", label: "Git" },
              { kind: "docker" as const, id: "docker", label: "Docker" },
            ]
          : []),
        { kind: "services" as const, id: "services", label: "Services" },
        { kind: "resources" as const, id: "resources", label: "Resources" },
        { kind: "activity" as const, id: "activity", label: "Activity" },
      ]
    : [{ kind: "activity" as const, id: "activity", label: "Activity" }];

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip */}
      <div className="flex items-center gap-0.5 overflow-x-auto border-b bg-card px-1 py-1">
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
            <Terminal sessionId={sessionId} seed={t.seed} />
          </div>
        ))}

        {projectId && visited.has("git") && (
          <LazyPane visible={active === "git"}>
            <GitPanel
              projectId={projectId}
              sessionId={sessionId}
              remoteBase={projectRemoteBase ?? "/"}
            />
          </LazyPane>
        )}
        {projectId && visited.has("docker") && (
          <LazyPane visible={active === "docker"}>
            <DockerPanel sessionId={sessionId} projectId={projectId} />
          </LazyPane>
        )}
        {visited.has("services") && (
          <LazyPane visible={active === "services"}>
            <ServicePanel sessionId={sessionId} />
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
        {/* Activity mounts eagerly — cheap, and it's the FTP default. */}
        <Pane visible={active === "activity"}>
          <ActivityConsole sessionId={sessionId} projectId={projectId} />
        </Pane>
      </div>
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
}: {
  active: boolean;
  onActivate: () => void;
  onClose?: () => void;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  after?: React.ReactNode;
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
    case "git":
      return GitBranch;
    case "docker":
      return Container;
    case "services":
      return Cog;
    case "resources":
      return ActivityIcon;
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
