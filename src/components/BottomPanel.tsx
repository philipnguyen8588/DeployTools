import { useState } from "react";
import {
  Plus,
  X,
  TerminalSquare,
  ScrollText,
  GitBranch,
  Container,
  Cog,
  Activity as ActivityIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

import { Terminal } from "./Terminal";
import { ActivityConsole } from "./ActivityConsole";
import { GitPanel } from "./GitPanel";
import { DockerPanel } from "./DockerPanel";
import { ServicePanel } from "./ServicePanel";
import { MetricsPanel } from "./MetricsPanel";

interface Props {
  sessionId: string;
  projectId: string | null;
  projectRemoteBase?: string | null;
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
}: Props) {
  const [terminalTabs, setTerminalTabs] = useState<
    { id: string; label: string }[]
  >(() => [{ id: `t-${Date.now()}-1`, label: "Terminal 1" }]);
  const [active, setActive] = useState<string>(terminalTabs[0].id);
  const counterRef = useCounter(terminalTabs.length);

  function newTerminal() {
    const n = counterRef() + 1;
    const id = `t-${Date.now()}-${n}`;
    setTerminalTabs((t) => [...t, { id, label: `Terminal ${n}` }]);
    setActive(id);
  }

  function closeTerminal(id: string) {
    setTerminalTabs((prev) => {
      const remaining = prev.filter((t) => t.id !== id);
      if (active === id) {
        setActive(remaining[remaining.length - 1]?.id ?? "activity");
      }
      return remaining;
    });
  }

  const ordered: BottomTab[] = [
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
    { kind: "services", id: "services", label: "Services" },
    { kind: "resources", id: "resources", label: "Resources" },
    { kind: "activity", id: "activity", label: "Activity" },
  ];

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
              onActivate={() => setActive(t.id)}
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
                    onClick={newTerminal}
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

      {/* Content — keep everything mounted */}
      <div className="relative min-h-0 flex-1">
        {terminalTabs.map((t) => (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              active === t.id ? "block" : "hidden",
            )}
          >
            <Terminal sessionId={sessionId} />
          </div>
        ))}

        {projectId && (
          <>
            <Pane visible={active === "git"}>
              <GitPanel
                projectId={projectId}
                sessionId={sessionId}
                remoteBase={projectRemoteBase ?? "/"}
              />
            </Pane>
            <Pane visible={active === "docker"}>
              <DockerPanel sessionId={sessionId} projectId={projectId} />
            </Pane>
          </>
        )}

        <Pane visible={active === "services"}>
          <ServicePanel sessionId={sessionId} />
        </Pane>
        <Pane visible={active === "resources"}>
          <MetricsPanel sessionId={sessionId} active={active === "resources"} />
        </Pane>
        <Pane visible={active === "activity"}>
          <ActivityConsole sessionId={sessionId} projectId={projectId} />
        </Pane>
      </div>
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
