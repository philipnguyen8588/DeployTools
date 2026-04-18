import { useState } from "react";
import {
  Plus,
  X,
  TerminalSquare,
  ScrollText,
  GitBranch,
  Container,
  Cog,
} from "lucide-react";
import { cn } from "@/lib/utils";

import { Terminal } from "./Terminal";
import { ActivityConsole } from "./ActivityConsole";
import { GitPanel } from "./GitPanel";
import { DockerPanel } from "./DockerPanel";
import { ServicePanel } from "./ServicePanel";

interface Props {
  sessionId: string;
  projectId: string | null;
  projectRemoteBase?: string | null;
}

type BottomTab =
  | { kind: "terminal"; id: string; label: string }
  | { kind: "activity"; id: "activity"; label: "Activity" }
  | { kind: "git"; id: "git"; label: "Git" }
  | { kind: "docker"; id: "docker"; label: "Docker" }
  | { kind: "services"; id: "services"; label: "Services" };

/**
 * The bottom half of each server tab: a tab-strip with N terminals +
 * an Activity log. The "+" button spawns a new terminal tab that opens
 * another shell channel on the same SSH session (no extra TCP/SSH
 * handshake).
 *
 * All inactive tabs remain mounted with `display: none` so their state
 * (terminal buffer, scrollback, activity history) survives tab switching.
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
      // If closing the active tab, switch to the last remaining terminal
      // or fall back to the activity tab.
      if (active === id) {
        setActive(remaining[remaining.length - 1]?.id ?? "activity");
      }
      return remaining;
    });
  }

  const allTabs: BottomTab[] = [
    ...terminalTabs.map((t) => ({
      kind: "terminal" as const,
      id: t.id,
      label: t.label,
    })),
    { kind: "activity", id: "activity", label: "Activity" },
    ...(projectId
      ? ([
          { kind: "docker", id: "docker", label: "Docker" },
          { kind: "git", id: "git", label: "Git" },
        ] as BottomTab[])
      : []),
    { kind: "services", id: "services", label: "Services" },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip */}
      <div className="flex items-center gap-0.5 border-b bg-card px-1 py-1">
        {allTabs.map((t) => {
          const isActive = active === t.id;
          const Icon =
            t.kind === "terminal"
              ? TerminalSquare
              : t.kind === "git"
                ? GitBranch
                : t.kind === "docker"
                  ? Container
                  : t.kind === "services"
                    ? Cog
                    : ScrollText;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={isActive}
              className={cn(
                "group flex min-w-0 cursor-pointer select-none items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-xs transition",
                isActive
                  ? "border-border bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent",
              )}
              onClick={() => setActive(t.id)}
            >
              <Icon className="h-3 w-3 shrink-0" />
              <span className="truncate">{t.label}</span>
              {t.kind === "terminal" && terminalTabs.length > 0 && (
                <button
                  aria-label="Close terminal"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(t.id);
                  }}
                  className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}

        <button
          onClick={newTerminal}
          aria-label="New terminal"
          title="New terminal"
          className="ml-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Content — keep all panes mounted so state survives switching */}
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
        <div
          className={cn(
            "absolute inset-0",
            active === "activity" ? "block" : "hidden",
          )}
        >
          <ActivityConsole sessionId={sessionId} projectId={projectId} />
        </div>
        {projectId && (
          <>
            <div
              className={cn(
                "absolute inset-0",
                active === "git" ? "block" : "hidden",
              )}
            >
              <GitPanel
                projectId={projectId}
                sessionId={sessionId}
                remoteBase={projectRemoteBase ?? "/"}
              />
            </div>
            <div
              className={cn(
                "absolute inset-0",
                active === "docker" ? "block" : "hidden",
              )}
            >
              <DockerPanel sessionId={sessionId} projectId={projectId} />
            </div>
          </>
        )}
        <div
          className={cn(
            "absolute inset-0",
            active === "services" ? "block" : "hidden",
          )}
        >
          <ServicePanel sessionId={sessionId} />
        </div>
      </div>
    </div>
  );
}

/** Counter hook returning a stable getter that always yields an increasing number. */
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
