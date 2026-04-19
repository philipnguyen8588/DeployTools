import { useEffect, useMemo, useState } from "react";
import {
  Server as ServerIcon,
  Network,
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
  Copy as CopyIcon,
  MoreVertical,
} from "lucide-react";
import { toast } from "sonner";

import { useServers } from "@/stores/servers";
import { useProjects } from "@/stores/projects";
import { useSessions } from "@/stores/sessions";
import { useView } from "@/stores/view";
import * as api from "@/lib/api";
import { ServerDialog } from "./ServerDialog";
import { ProjectDialog } from "./ProjectDialog";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { ContextMenu, type ContextMenuItem } from "./ui/context-menu";
import { cn } from "@/lib/utils";
import type { Project, Server, ServerSummary } from "@/lib/types";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Shape of the open dropdown menu state (unified for server + project). */
interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function Sidebar() {
  const { servers, refresh: refreshServers, remove: removeServer } = useServers();
  const { projects, refresh: refreshProjects, remove: removeProject } = useProjects();
  const { openTab } = useSessions();
  const { view, setView } = useView();

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editingServer, setEditingServer] = useState<ServerSummary | "new" | null>(
    null,
  );
  /** Prefilled Server used by the Copy action — id is nil so Save
   *  creates a new record (keeping the original untouched). */
  const [copyingServer, setCopyingServer] = useState<Server | null>(null);
  const [editingProject, setEditingProject] = useState<
    Project | { forServer: string } | null
  >(null);
  /** Prefilled Project for the Copy action (id nil). */
  const [copyingProject, setCopyingProject] = useState<Project | null>(null);
  /** Pending deletes (resolved via DeleteConfirmDialog). */
  const [deletingServer, setDeletingServer] = useState<ServerSummary | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

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

  /** Clone a server — opens the editor pre-filled with the existing
   *  credentials but with a nil id. The user reviews / renames and
   *  hits Save to create a new record. The original is untouched. */
  async function handleDuplicateServer(s: ServerSummary) {
    try {
      const full = await api.getServer(s.id);
      setCopyingServer({ ...full, id: NIL_UUID, name: `${full.name} (copy)` });
    } catch (e) {
      toast.error(`${e}`);
    }
  }

  function handleDuplicateProject(p: Project) {
    setCopyingProject({ ...p, id: NIL_UUID, name: `${p.name} (copy)` });
  }

  /** Open the action menu for a server row, anchored below the ⋮ button. */
  function openServerMenu(s: ServerSummary, anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    const items: ContextMenuItem[] = [
      {
        label: "Add project",
        icon: <Plus className="h-3.5 w-3.5" />,
        onClick: () => setEditingProject({ forServer: s.id }),
      },
      {
        label: "Edit",
        icon: <Settings2 className="h-3.5 w-3.5" />,
        onClick: () => setEditingServer(s),
      },
      {
        label: "Copy",
        icon: <CopyIcon className="h-3.5 w-3.5" />,
        onClick: () => void handleDuplicateServer(s),
      },
      {
        label: "Test connection",
        icon: <Plug className="h-3.5 w-3.5" />,
        onClick: () => void handleTest(s.id),
      },
      { separator: true, label: "", onClick: () => {} },
      {
        label: "Delete",
        icon: <Trash2 className="h-3.5 w-3.5" />,
        danger: true,
        onClick: () => setDeletingServer(s),
      },
    ];
    setMenu({ x: r.right - 4, y: r.bottom + 2, items });
  }

  /** Open the action menu for a project row. */
  function openProjectMenu(p: Project, anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    const items: ContextMenuItem[] = [
      {
        label: "Edit",
        icon: <Settings2 className="h-3.5 w-3.5" />,
        onClick: () => setEditingProject(p),
      },
      {
        label: "Copy",
        icon: <CopyIcon className="h-3.5 w-3.5" />,
        onClick: () => handleDuplicateProject(p),
      },
      { separator: true, label: "", onClick: () => {} },
      {
        label: "Delete",
        icon: <Trash2 className="h-3.5 w-3.5" />,
        danger: true,
        onClick: () => setDeletingProject(p),
      },
    ];
    setMenu({ x: r.right - 4, y: r.bottom + 2, items });
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
                {s.protocol === "ssh" ? (
                  <ServerIcon
                    className="h-4 w-4 shrink-0 text-primary"
                    aria-label="SSH server"
                  />
                ) : (
                  <Network
                    className="h-4 w-4 shrink-0 text-amber-500"
                    aria-label={`${s.protocol.toUpperCase()} server`}
                  />
                )}
                <span className="flex-1 truncate font-medium">{s.name}</span>
                {s.protocol !== "ssh" && (
                  <span className="rounded bg-amber-500/15 px-1 py-0 text-[9px] font-semibold uppercase leading-4 text-amber-600 dark:text-amber-400">
                    {s.protocol}
                  </span>
                )}
                {/* Hover-visible action strip: Connect + ⋮. The dropdown
                    groups Edit/Copy/Test/Delete under the kebab to keep
                    the row calm. */}
                <div className="pointer-events-none flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                  <button
                    title="Connect"
                    className="rounded p-1 hover:bg-background"
                    onClick={() => handleOpen(s)}
                  >
                    <Play className="h-3 w-3" />
                  </button>
                  <button
                    title="More actions"
                    aria-label="More actions"
                    className="rounded p-1 hover:bg-background"
                    onClick={(e) => openServerMenu(s, e.currentTarget)}
                  >
                    <MoreVertical className="h-3.5 w-3.5" />
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
                          title="Connect"
                          className="rounded p-1 hover:bg-background"
                          onClick={() => handleOpen(s, p)}
                        >
                          <Play className="h-3 w-3" />
                        </button>
                        <button
                          title="More actions"
                          aria-label="More actions"
                          className="rounded p-1 hover:bg-background"
                          onClick={(e) => openProjectMenu(p, e.currentTarget)}
                        >
                          <MoreVertical className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {projs.length === 0 && (
                    <div className="px-2 py-1 text-[11px] italic text-muted-foreground">
                      No projects yet
                    </div>
                  )}
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

      {copyingServer && (
        <ServerDialog
          serverId={null}
          initialServer={copyingServer}
          onClose={() => setCopyingServer(null)}
          onSaved={() => {
            setCopyingServer(null);
            void refreshServers();
          }}
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

      {copyingProject && (
        <ProjectDialog
          project={copyingProject}
          onClose={() => setCopyingProject(null)}
          onSaved={() => {
            setCopyingProject(null);
            void refreshProjects();
          }}
        />
      )}

      {deletingServer && (
        <DeleteConfirmDialog
          itemName={`server "${deletingServer.name}"`}
          description={
            <span>
              All projects attached to this server will be removed too.
            </span>
          }
          onConfirm={async () => {
            try {
              await removeServer(deletingServer.id);
              await refreshProjects();
            } catch (e) {
              // eslint-disable-next-line no-console
              console.error("delete server:", e);
            }
          }}
          onClose={() => setDeletingServer(null)}
        />
      )}

      {deletingProject && (
        <DeleteConfirmDialog
          itemName={`project "${deletingProject.name}"`}
          onConfirm={async () => {
            try {
              await removeProject(deletingProject.id);
            } catch (e) {
              // eslint-disable-next-line no-console
              console.error("delete project:", e);
            }
          }}
          onClose={() => setDeletingProject(null)}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}
