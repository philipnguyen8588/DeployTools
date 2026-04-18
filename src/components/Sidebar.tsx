import { useEffect, useMemo, useState } from "react";
import {
  Server as ServerIcon,
  Folder,
  Plus,
  Play,
  Plug,
  Settings2,
  Trash2,
  ChevronRight,
  ChevronDown,
  Cloud,
  Braces,
} from "lucide-react";
import { toast } from "sonner";

import { useServers } from "@/stores/servers";
import { useProjects } from "@/stores/projects";
import { useSessions } from "@/stores/sessions";
import { useView } from "@/stores/view";
import * as api from "@/lib/api";
import { ServerDialog } from "./ServerDialog";
import { ProjectDialog } from "./ProjectDialog";
import { cn } from "@/lib/utils";
import type { Project, ServerSummary } from "@/lib/types";

export function Sidebar() {
  const { servers, refresh: refreshServers, remove: removeServer } = useServers();
  const { projects, refresh: refreshProjects, remove: removeProject } = useProjects();
  const { openTab } = useSessions();
  const { view, setView } = useView();

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editingServer, setEditingServer] = useState<ServerSummary | "new" | null>(
    null,
  );
  const [editingProject, setEditingProject] = useState<
    Project | { forServer: string } | null
  >(null);

  useEffect(() => {
    void refreshServers();
    void refreshProjects();
  }, [refreshServers, refreshProjects]);

  const byServer = useMemo(() => {
    const m = new Map<string, Project[]>();
    for (const p of projects) {
      if (!m.has(p.server_id)) m.set(p.server_id, []);
      m.get(p.server_id)!.push(p);
    }
    return m;
  }, [projects]);

  async function handleOpen(server: ServerSummary, project?: Project) {
    try {
      const summary = await api.openSession(server.id, project?.id);
      openTab({
        session: summary,
        label: project ? `${server.name} · ${project.name}` : server.name,
        remotePath: project?.remote_path ?? "/",
        // LocalFileBrowser expects a RELATIVE path (vs. project.local_path).
        // Empty string = project root.
        localPath: "",
      });
      // Opening a session implies "show me the tabs view".
      setView("tabs");
    } catch (e) {
      toast.error(`Open session failed: ${e}`);
    }
  }

  async function handleTest(id: string) {
    const p = toast.loading("Testing connection…");
    try {
      const fp = await api.testConnection(id);
      toast.success(`Connected. Host key: ${fp}`, { id: p });
      await refreshServers();
    } catch (e) {
      toast.error(`${e}`, { id: p });
    }
  }

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-card">
      {/* Top: Servers section header. Click it to ensure view=tabs
          (useful when coming back from Cloudflare). */}
      <button
        onClick={() => setView("tabs")}
        className={cn(
          "flex items-center gap-2 border-b px-3 py-2 text-sm transition",
          view === "tabs"
            ? "bg-primary/10 font-semibold text-primary"
            : "font-semibold text-foreground hover:bg-accent",
        )}
      >
        <ServerIcon className="h-4 w-4" />
        <span className="flex-1 text-left">Servers</span>
        <span
          role="button"
          aria-label="Add server"
          title="Add server"
          onClick={(e) => {
            e.stopPropagation();
            setView("tabs");
            setEditingServer("new");
          }}
          className="rounded p-1 hover:bg-background"
        >
          <Plus className="h-3.5 w-3.5" />
        </span>
      </button>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto p-2",
          view !== "tabs" && "hidden",
        )}
      >
        {servers.length === 0 && (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">
            No servers yet. Click <Plus className="inline h-3 w-3" /> to add one.
          </div>
        )}

        {servers.map((s) => {
          const isOpen = expanded[s.id] ?? true;
          const projs = byServer.get(s.id) ?? [];
          return (
            <div key={s.id} className="group mb-1">
              <div className="flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-accent">
                <button
                  aria-label="Toggle"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setExpanded((e) => ({ ...e, [s.id]: !isOpen }))
                  }
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>
                <ServerIcon className="h-4 w-4 shrink-0 text-primary" />
                <span className="flex-1 truncate font-medium">{s.name}</span>
                {/* Keep layout stable: always render the action strip and
                    fade it in on hover. `pointer-events-none` keeps it
                    unclickable while invisible. */}
                <div className="pointer-events-none flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                  <button
                    title="Open session"
                    className="rounded p-1 hover:bg-background"
                    onClick={() => handleOpen(s)}
                  >
                    <Play className="h-3 w-3" />
                  </button>
                  <button
                    title="Test connection"
                    className="rounded p-1 hover:bg-background"
                    onClick={() => handleTest(s.id)}
                  >
                    <Plug className="h-3 w-3" />
                  </button>
                  <button
                    title="Edit"
                    className="rounded p-1 hover:bg-background"
                    onClick={() => setEditingServer(s)}
                  >
                    <Settings2 className="h-3 w-3" />
                  </button>
                  <button
                    title="Delete"
                    className="rounded p-1 hover:bg-background"
                    onClick={async () => {
                      if (!confirm(`Delete server ${s.name}?`)) return;
                      await removeServer(s.id);
                      await refreshProjects();
                    }}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="ml-6 mt-0.5 space-y-0.5 border-l pl-2">
                  {projs.map((p) => (
                    <div
                      key={p.id}
                      className="group/item flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-accent"
                    >
                      <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="flex-1 truncate">{p.name}</span>
                      <div className="pointer-events-none flex items-center gap-0.5 opacity-0 transition-opacity group-hover/item:pointer-events-auto group-hover/item:opacity-100">
                        <button
                          title="Open session"
                          className="rounded p-1 hover:bg-background"
                          onClick={() => handleOpen(s, p)}
                        >
                          <Play className="h-3 w-3" />
                        </button>
                        <button
                          title="Edit"
                          className="rounded p-1 hover:bg-background"
                          onClick={() => setEditingProject(p)}
                        >
                          <Settings2 className="h-3 w-3" />
                        </button>
                        <button
                          title="Delete"
                          className="rounded p-1 hover:bg-background"
                          onClick={async () => {
                            if (!confirm(`Delete project ${p.name}?`)) return;
                            await removeProject(p.id);
                          }}
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => setEditingProject({ forServer: s.id })}
                  >
                    <Plus className="h-3 w-3" />
                    Add project
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Spacer — pushes Cloudflare to the bottom when server list
          is hidden (i.e. we're already on the Cloudflare view). */}
      {view !== "tabs" && <div className="flex-1" />}

      {/* Bottom: other views */}
      <button
        onClick={() => setView("snippets")}
        className={cn(
          "flex shrink-0 items-center gap-2 border-t px-3 py-2 text-sm transition",
          view === "snippets"
            ? "bg-primary/10 font-semibold text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Braces className="h-4 w-4" />
        <span>Snippets</span>
      </button>
      <button
        onClick={() => setView("cloudflare")}
        className={cn(
          "flex shrink-0 items-center gap-2 border-t px-3 py-2 text-sm transition",
          view === "cloudflare"
            ? "bg-primary/10 font-semibold text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Cloud className="h-4 w-4" />
        <span>Cloudflare</span>
      </button>

      {editingServer && (
        <ServerDialog
          serverId={editingServer === "new" ? null : editingServer.id}
          onClose={() => setEditingServer(null)}
          onSaved={() => refreshServers()}
        />
      )}

      {editingProject && (
        <ProjectDialog
          project={"id" in editingProject ? editingProject : null}
          defaultServerId={
            "forServer" in editingProject ? editingProject.forServer : undefined
          }
          onClose={() => setEditingProject(null)}
          onSaved={() => refreshProjects()}
        />
      )}
    </aside>
  );
}
