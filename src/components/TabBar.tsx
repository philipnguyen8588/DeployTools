import { X, Plug } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSessions } from "@/stores/sessions";

/**
 * Horizontal tab strip across the top of the main panel. One tab per
 * open SSH session. Closing a tab disconnects its SSH session on the
 * backend.
 */
export function TabBar() {
  const { tabs, activeId, setActive, closeTab } = useSessions();

  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto border-b bg-card px-2 py-1">
      {tabs.map((t) => {
        const active = t.session.id === activeId;
        return (
          <div
            key={t.session.id}
            role="tab"
            aria-selected={active}
            className={cn(
              "group flex min-w-0 cursor-pointer select-none items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1 text-xs transition",
              active
                ? "border-border bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-accent",
            )}
            onClick={() => setActive(t.session.id)}
          >
            <Plug
              className={cn(
                "h-3 w-3 shrink-0",
                active ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="truncate">{t.label}</span>
            <button
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(t.session.id);
              }}
              className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
