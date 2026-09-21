import { useEffect, useMemo, useRef, useState } from "react";
import {
  Server as ServerIcon,
  Network,
  Folder,
  Plus,
  Play,
  Plug,
  Loader2,
  Settings2,
  Trash2,
  ChevronRight,
  ChevronDown,
  Cloud,
  Braces,
  Copy as CopyIcon,
  MoreVertical,
  FolderPlus,
  FolderSymlink,
  Pencil,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { useGroups } from "@/stores/groups";
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
import type {
  Project,
  Server,
  ServerGroup,
  ServerSummary,
  UUID,
} from "@/lib/types";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** Synthetic id for the virtual bucket that holds servers with `group_id === null`.
 *  Never persisted — only exists in the sidebar rendering layer. */
const UNGROUPED_ID = "__ungrouped__";

/** A `Record` proxy that returns `true` for every key — used when
 *  filtering to force-expand all matching groups/servers without
 *  mutating the user's real expansion state. */
const FORCE_EXPANDED = new Proxy(
  {},
  { get: () => true },
) as Record<string, boolean>;

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function Sidebar() {
  const { groups, refresh: refreshGroups, create: createGroup, rename: renameGroup, remove: removeGroup, reorder: reorderGroups } =
    useGroups();
  const { servers, refresh: refreshServers, remove: removeServer, reorderWithinGroup } = useServers();
  const { projects, refresh: refreshProjects, remove: removeProject, reorderWithinServer } =
    useProjects();
  const { openTab } = useSessions();
  const { view, setView } = useView();

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [groupExpanded, setGroupExpanded] = useState<Record<string, boolean>>({});
  /** Keys (`${serverId}:${projectId ?? ""}`) whose session is currently
   *  being opened — drives the per-row spinner + blocks double-clicks. */
  const [connecting, setConnecting] = useState<Set<string>>(new Set());
  const [renamingGroup, setRenamingGroup] = useState<UUID | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<ServerGroup | null>(null);

  const [editingServer, setEditingServer] = useState<ServerSummary | "new" | null>(
    null,
  );
  /** Which group a brand-new server should land in (when opened via a
   *  group's ⋮ menu → Add server). */
  const [newServerGroup, setNewServerGroup] = useState<UUID | null>(null);
  const [copyingServer, setCopyingServer] = useState<Server | null>(null);
  const [editingProject, setEditingProject] = useState<
    Project | { forServer: string } | null
  >(null);
  const [copyingProject, setCopyingProject] = useState<Project | null>(null);
  const [deletingServer, setDeletingServer] = useState<ServerSummary | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  /** Search query — matches against server name/host/user and project name.
   *  Empty string = show everything (and re-enables drag reorder).
   *  Non-empty = read-only filtered view; drag is disabled because the
   *  visible set no longer mirrors the real ordering, and reordering a
   *  partial list would clobber hidden positions. */
  const [filter, setFilter] = useState("");
  const filterQ = filter.trim().toLowerCase();
  const isFiltering = filterQ.length > 0;

  useEffect(() => {
    void refreshGroups();
    void refreshServers();
    void refreshProjects();
  }, [refreshGroups, refreshServers, refreshProjects]);

  // ----- Derived: projects bucketed by server, servers bucketed by group -----

  const projectsByServer = useMemo(() => {
    const m = new Map<string, Project[]>();
    for (const p of projects) {
      if (!m.has(p.server_id)) m.set(p.server_id, []);
      m.get(p.server_id)!.push(p);
    }
    // Sort each bucket by (order asc, name asc) so stale/legacy entries
    // with order=0 still render in a deterministic sequence.
    for (const list of m.values()) {
      list.sort((a, b) => {
        const oa = a.order ?? 0;
        const ob = b.order ?? 0;
        if (oa !== ob) return oa - ob;
        return a.name.localeCompare(b.name);
      });
    }
    return m;
  }, [projects]);

  const serversByGroup = useMemo(() => {
    const m = new Map<string, ServerSummary[]>();
    for (const s of servers) {
      const key = s.group_id ?? UNGROUPED_ID;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(s);
    }
    for (const list of m.values()) {
      list.sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      });
    }
    return m;
  }, [servers]);

  /** Display list of group-like buckets, in render order:
   *  virtual "Ungrouped" (only if non-empty) + user groups (by `order`). */
  const displayGroups = useMemo(() => {
    const all: Array<{ id: string; name: string; isVirtual: boolean }> = [];
    if ((serversByGroup.get(UNGROUPED_ID)?.length ?? 0) > 0) {
      all.push({ id: UNGROUPED_ID, name: "Ungrouped", isVirtual: true });
    }
    const sorted = [...groups].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });
    for (const g of sorted) all.push({ id: g.id, name: g.name, isVirtual: false });
    return all;
  }, [groups, serversByGroup]);

  /**
   * Filtered view derived from the full dataset. Strategy:
   *   • A project "matches" if its name contains the query.
   *   • A server "matches" if its name / host / user contains the query,
   *     OR if any of its projects matches (so you can search by project
   *     and still see the parent server / its other siblings for context).
   *   • A group is visible if it contains at least one visible server,
   *     OR the group name itself matches.
   *
   * When a server matches by its own fields, we show ALL its projects.
   * When a server is only visible via a matching project, we narrow the
   * project list to only matching projects.
   */
  const filtered = useMemo(() => {
    if (!isFiltering) {
      return {
        projectsByServer,
        serversByGroup,
        matches: null as Map<string, Set<string>> | null,
      };
    }
    const matchStr = (s: string | undefined | null) =>
      (s ?? "").toLowerCase().includes(filterQ);

    // Projects keyed by server: only the matching projects.
    const projsByServer = new Map<string, Project[]>();
    const matchingProjectIds = new Set<string>();
    for (const p of projects) {
      if (matchStr(p.name)) {
        matchingProjectIds.add(p.id);
        if (!projsByServer.has(p.server_id)) projsByServer.set(p.server_id, []);
        projsByServer.get(p.server_id)!.push(p);
      }
    }

    // Which servers to show. If the server matches by its own fields,
    // surface the full project list (rewritten from projectsByServer).
    const serversVisible: ServerSummary[] = [];
    const serverProjects = new Map<string, Project[]>();
    for (const s of servers) {
      const selfMatch =
        matchStr(s.name) || matchStr(s.host) || matchStr(s.user);
      const projs = projsByServer.get(s.id) ?? [];
      if (selfMatch) {
        serversVisible.push(s);
        // Show ALL projects of a self-matching server.
        serverProjects.set(s.id, projectsByServer.get(s.id) ?? []);
      } else if (projs.length > 0) {
        serversVisible.push(s);
        serverProjects.set(s.id, projs);
      }
    }

    // Group visibility — either the group name matches (show all its
    // servers), or at least one server under it is visible.
    const groupsToServers = new Map<string, ServerSummary[]>();
    const groupNameMatches = new Set<string>();
    for (const g of groups) {
      if (matchStr(g.name)) groupNameMatches.add(g.id);
    }
    for (const s of serversVisible) {
      const key = s.group_id ?? UNGROUPED_ID;
      if (!groupsToServers.has(key)) groupsToServers.set(key, []);
      groupsToServers.get(key)!.push(s);
    }
    // A group whose name matches but has no visible servers should still
    // appear (empty bucket with highlighted header).
    for (const id of groupNameMatches) {
      if (!groupsToServers.has(id)) groupsToServers.set(id, []);
    }

    // Sort servers within each bucket identically to the unfiltered view.
    for (const list of groupsToServers.values()) {
      list.sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      });
    }

    const matches = new Map<string, Set<string>>();
    matches.set("project", matchingProjectIds);
    matches.set(
      "server",
      new Set(
        serversVisible
          .filter(
            (s) =>
              matchStr(s.name) || matchStr(s.host) || matchStr(s.user),
          )
          .map((s) => s.id),
      ),
    );
    matches.set("group", groupNameMatches);
    return {
      projectsByServer: serverProjects,
      serversByGroup: groupsToServers,
      matches,
    };
  }, [
    isFiltering,
    filterQ,
    servers,
    projects,
    groups,
    projectsByServer,
    serversByGroup,
  ]);

  /** Groups to render given the current filter. Always starts with
   *  Ungrouped (when it has visible servers) then real groups. */
  const visibleGroups = useMemo(() => {
    if (!isFiltering) return displayGroups;
    const all: Array<{ id: string; name: string; isVirtual: boolean }> = [];
    if ((filtered.serversByGroup.get(UNGROUPED_ID)?.length ?? 0) > 0) {
      all.push({ id: UNGROUPED_ID, name: "Ungrouped", isVirtual: true });
    }
    const sorted = [...groups].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });
    for (const g of sorted) {
      const hasVisible =
        (filtered.serversByGroup.get(g.id)?.length ?? 0) > 0 ||
        filtered.matches?.get("group")?.has(g.id);
      if (hasVisible) all.push({ id: g.id, name: g.name, isVirtual: false });
    }
    return all;
  }, [isFiltering, displayGroups, filtered, groups]);

  // When filtering, force-expand matching groups/servers so results are
  // actually visible without the user having to open each parent.
  const effectiveExpanded = isFiltering ? FORCE_EXPANDED : expanded;
  const effectiveGroupExpanded = isFiltering ? FORCE_EXPANDED : groupExpanded;

  // ----- Actions -----

  async function handleOpen(server: ServerSummary, project?: Project) {
    const key = `${server.id}:${project?.id ?? ""}`;
    // Ignore repeat clicks while this exact connection is in flight.
    if (connecting.has(key)) return;
    setConnecting((prev) => new Set(prev).add(key));
    try {
      const summary = await api.openSession(server.id, project?.id);
      openTab({
        session: summary,
        label: project ? `${server.name} · ${project.name}` : server.name,
        remotePath: project?.remote_path ?? "/",
        localPath: "",
      });
      setView("tabs");
    } catch (e) {
      toast.error(`Open session failed: ${e}`);
    } finally {
      setConnecting((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
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

  /** Shift a server into another group via menu (no drag required). */
  async function handleMoveServer(
    serverId: UUID,
    targetGroupId: UUID | null,
  ) {
    const target = targetGroupId ?? UNGROUPED_ID;
    const bucket = serversByGroup.get(target) ?? [];
    // Append at the end of the target bucket.
    const ids = [...bucket.map((s) => s.id).filter((id) => id !== serverId), serverId];
    try {
      await reorderWithinGroup(targetGroupId, ids);
    } catch (e) {
      toast.error(`Move failed: ${e}`);
    }
  }

  // ----- Menus -----

  function openGroupMenu(g: ServerGroup, x: number, y: number) {
    const items: ContextMenuItem[] = [
      {
        label: "Add server",
        icon: <Plus className="h-3.5 w-3.5" />,
        onClick: () => {
          setNewServerGroup(g.id);
          setEditingServer("new");
        },
      },
      {
        label: "Rename",
        icon: <Pencil className="h-3.5 w-3.5" />,
        onClick: () => setRenamingGroup(g.id),
      },
      { separator: true, label: "", onClick: () => {} },
      {
        label: "Delete group",
        icon: <Trash2 className="h-3.5 w-3.5" />,
        danger: true,
        onClick: () => setDeletingGroup(g),
      },
    ];
    setMenu({ x, y, items });
  }

  function openServerMenu(s: ServerSummary, x: number, y: number) {
    const items: ContextMenuItem[] = [
      {
        label: "Add project",
        icon: <FolderPlus className="h-3.5 w-3.5" />,
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
    ];
    // Offer "Move to …" for every group this server is NOT currently in.
    // The virtual "Ungrouped" bucket is always offered when the server
    // lives in a real group. Using a flat list (not a submenu) keeps the
    // menu code simple.
    const moveTargets: Array<{ id: UUID | null; name: string }> = [];
    if (s.group_id !== null) {
      moveTargets.push({ id: null, name: "Ungrouped" });
    }
    for (const g of groups) {
      if (g.id !== s.group_id) moveTargets.push({ id: g.id, name: g.name });
    }
    if (moveTargets.length > 0) {
      items.push({ separator: true, label: "", onClick: () => {} });
      for (const t of moveTargets) {
        items.push({
          label: `Move to: ${t.name}`,
          icon: <FolderSymlink className="h-3.5 w-3.5" />,
          onClick: () => void handleMoveServer(s.id, t.id),
        });
      }
    }
    items.push({ separator: true, label: "", onClick: () => {} });
    items.push({
      label: "Delete",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      danger: true,
      onClick: () => setDeletingServer(s),
    });
    setMenu({ x, y, items });
  }

  function openProjectMenu(p: Project, x: number, y: number) {
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
    setMenu({ x, y, items });
  }

  // ----- DnD setup -----

  const sensors = useSensors(
    // `activationConstraint` means a 4-pixel movement is required to start
    // a drag — a plain click on a row never gets interpreted as a drag,
    // so Connect / ⋮ buttons remain clickable.
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const [activeDrag, setActiveDrag] = useState<{
    kind: "group" | "server" | "project";
    id: UUID;
    label: string;
  } | null>(null);

  function handleDragStart(e: DragStartEvent) {
    const sid = String(e.active.id);
    const [kind, id] = sid.split(":", 2) as [
      "group" | "server" | "project",
      UUID,
    ];
    let label = "";
    if (kind === "group") label = groups.find((g) => g.id === id)?.name ?? "";
    else if (kind === "server") label = servers.find((s) => s.id === id)?.name ?? "";
    else if (kind === "project")
      label = projects.find((p) => p.id === id)?.name ?? "";
    setActiveDrag({ kind, id, label });
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveDrag(null);
    const { active, over } = e;
    if (!over) return;
    if (active.id === over.id) return;

    const [aKind, aId] = String(active.id).split(":", 2) as [string, UUID];
    const [oKind, oId] = String(over.id).split(":", 2) as [string, UUID];
    if (aKind !== oKind) return; // don't cross types

    if (aKind === "group") {
      const ids = [...groups]
        .sort((a, b) => a.order - b.order)
        .map((g) => g.id);
      const from = ids.indexOf(aId);
      const to = ids.indexOf(oId);
      if (from === -1 || to === -1) return;
      const next = arrayMove(ids, from, to);
      try {
        await reorderGroups(next);
      } catch (err) {
        toast.error(`Reorder failed: ${err}`);
      }
      return;
    }

    if (aKind === "server") {
      // Both servers must live in the same group — cross-group reorder
      // is wired through the ⋮ → "Move to" menu instead, which keeps
      // the DnD logic free of the inter-group bookkeeping.
      const aSrv = servers.find((s) => s.id === aId);
      const oSrv = servers.find((s) => s.id === oId);
      if (!aSrv || !oSrv) return;
      if ((aSrv.group_id ?? null) !== (oSrv.group_id ?? null)) return;
      const key = aSrv.group_id ?? UNGROUPED_ID;
      const bucket = serversByGroup.get(key) ?? [];
      const ids = bucket.map((s) => s.id);
      const from = ids.indexOf(aId);
      const to = ids.indexOf(oId);
      if (from === -1 || to === -1) return;
      const next = arrayMove(ids, from, to);
      try {
        await reorderWithinGroup(aSrv.group_id ?? null, next);
      } catch (err) {
        toast.error(`Reorder failed: ${err}`);
      }
      return;
    }

    if (aKind === "project") {
      const aProj = projects.find((p) => p.id === aId);
      const oProj = projects.find((p) => p.id === oId);
      if (!aProj || !oProj) return;
      if (aProj.server_id !== oProj.server_id) return;
      const bucket = projectsByServer.get(aProj.server_id) ?? [];
      const ids = bucket.map((p) => p.id);
      const from = ids.indexOf(aId);
      const to = ids.indexOf(oId);
      if (from === -1 || to === -1) return;
      const next = arrayMove(ids, from, to);
      try {
        await reorderWithinServer(aProj.server_id, next);
      } catch (err) {
        toast.error(`Reorder failed: ${err}`);
      }
    }
  }

  // ----- Render -----

  const groupItemIds = displayGroups
    .filter((g) => !g.isVirtual)
    .map((g) => `group:${g.id}`);

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-card">
      {/* Sidebar section header — click to switch back to the tabs view
          (useful when coming back from Cloudflare / Snippets). */}
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
          aria-label="New group"
          title="New group"
          onClick={(e) => {
            e.stopPropagation();
            setView("tabs");
            void createGroup("New group").then((g) => {
              setGroupExpanded((m) => ({ ...m, [g.id]: true }));
              setRenamingGroup(g.id);
            });
          }}
          className="rounded p-1 hover:bg-background"
        >
          <Plus className="h-3.5 w-3.5" />
        </span>
      </button>

      {/* Search / filter — always rendered so the user sees it without
          having to hunt for a toggle. When the query is non-empty the
          sidebar flips into a read-only filtered view (drag disabled). */}
      <div
        className={cn(
          "shrink-0 border-b bg-card px-2 py-1.5",
          view !== "tabs" && "hidden",
        )}
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilter("");
            }}
            placeholder="Filter servers / projects…"
            className="h-7 w-full rounded-md border bg-background pl-7 pr-6 text-xs outline-none ring-primary focus:ring-1"
          />
          {filter && (
            <button
              aria-label="Clear filter"
              title="Clear"
              onClick={() => setFilter("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto p-2",
          view !== "tabs" && "hidden",
        )}
      >
        {servers.length === 0 && groups.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">
            No servers yet. Click <Plus className="inline h-3 w-3" /> to create
            a group, then add servers into it.
          </div>
        ) : visibleGroups.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">
            Nothing matches <span className="font-mono">"{filter}"</span>.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            {/* Virtual "Ungrouped" bucket (non-sortable container, but
                its servers are sortable within the bucket). */}
            {visibleGroups
              .filter((g) => g.isVirtual)
              .map((g) => (
                <GroupContainer
                  key={g.id}
                  name={g.name}
                  virtual
                  expanded={effectiveGroupExpanded[g.id] ?? true}
                  onToggle={() =>
                    setGroupExpanded((m) => ({
                      ...m,
                      [g.id]: !(m[g.id] ?? true),
                    }))
                  }
                  onMenu={null}
                >
                  <ServerList
                    servers={filtered.serversByGroup.get(g.id) ?? []}
                    projectsByServer={filtered.projectsByServer}
                    expanded={effectiveExpanded}
                    dragDisabled={isFiltering}
                    onToggle={(id) =>
                      setExpanded((e) => ({ ...e, [id]: !(e[id] ?? true) }))
                    }
                    onOpenServer={handleOpen}
                    onOpenProject={(s, p) => handleOpen(s, p)}
                    onServerMenu={openServerMenu}
                    onProjectMenu={openProjectMenu}
                    connecting={connecting}
                  />
                </GroupContainer>
              ))}

            {/* Real user-defined groups — sortable. */}
            <SortableContext
              items={groupItemIds}
              strategy={verticalListSortingStrategy}
            >
              {visibleGroups
                .filter((g) => !g.isVirtual)
                .map((g) => (
                  <SortableGroup
                    key={g.id}
                    group={{
                      id: g.id,
                      name: g.name,
                      order:
                        groups.find((x) => x.id === g.id)?.order ?? 0,
                    }}
                    expanded={effectiveGroupExpanded[g.id] ?? true}
                    onToggle={() =>
                      setGroupExpanded((m) => ({
                        ...m,
                        [g.id]: !(m[g.id] ?? true),
                      }))
                    }
                    dragDisabled={isFiltering}
                    renaming={renamingGroup === g.id}
                    onStartRename={() => setRenamingGroup(g.id)}
                    onCommitRename={async (name) => {
                      setRenamingGroup(null);
                      if (!name.trim() || name.trim() === g.name) return;
                      try {
                        await renameGroup(g.id, name.trim());
                      } catch (e) {
                        toast.error(`Rename failed: ${e}`);
                      }
                    }}
                    onCancelRename={() => setRenamingGroup(null)}
                    onMenu={(x, y) =>
                      openGroupMenu(
                        groups.find((x2) => x2.id === g.id) ?? {
                          id: g.id,
                          name: g.name,
                          order: 0,
                        },
                        x,
                        y,
                      )
                    }
                  >
                    <ServerList
                      servers={filtered.serversByGroup.get(g.id) ?? []}
                      projectsByServer={filtered.projectsByServer}
                      expanded={effectiveExpanded}
                      dragDisabled={isFiltering}
                      onToggle={(id) =>
                        setExpanded((e) => ({ ...e, [id]: !(e[id] ?? true) }))
                      }
                      onOpenServer={handleOpen}
                      onOpenProject={(s, p) => handleOpen(s, p)}
                      onServerMenu={openServerMenu}
                      onProjectMenu={openProjectMenu}
                      connecting={connecting}
                    />
                  </SortableGroup>
                ))}
            </SortableContext>

            <DragOverlay>
              {activeDrag && (
                <div className="pointer-events-none rounded-md border border-primary/40 bg-popover px-2 py-1 text-xs font-medium text-foreground shadow-lg">
                  {activeDrag.label}
                </div>
              )}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* Spacer so Snippets/Cloudflare sit at the bottom on non-tabs views. */}
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

      {/* ---- Dialogs ---- */}
      {editingServer && (
        <ServerDialog
          serverId={editingServer === "new" ? null : editingServer.id}
          initialGroupId={
            editingServer === "new" ? newServerGroup ?? undefined : undefined
          }
          onClose={() => {
            setEditingServer(null);
            setNewServerGroup(null);
          }}
          onSaved={() => {
            setEditingServer(null);
            setNewServerGroup(null);
            void refreshServers();
          }}
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
              console.error("delete project:", e);
            }
          }}
          onClose={() => setDeletingProject(null)}
        />
      )}

      {deletingGroup && (
        <DeleteConfirmDialog
          itemName={`group "${deletingGroup.name}"`}
          description={
            <span>
              Servers in this group are <strong>not</strong> deleted — they
              move back to Ungrouped.
            </span>
          }
          onConfirm={async () => {
            try {
              await removeGroup(deletingGroup.id);
              await refreshServers();
            } catch (e) {
              console.error("delete group:", e);
            }
          }}
          onClose={() => setDeletingGroup(null)}
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

// ---------- Group container (virtual or sortable shells) ----------
//
// Interaction model (consistent for all sidebar rows):
//   • Click anywhere on a row → toggle expand (groups/servers) or open
//     the session (projects). Buttons inside the row (Connect, ⋮) stop
//     propagation so their click doesn't also trigger the row handler.
//   • Drag from anywhere on the row → reorder. The PointerSensor's
//     `distance: 4` activation constraint means a plain click never
//     registers as drag, and the onClick only fires if no drag started.
//   • No visible drag handle — rows themselves are the affordance.

interface GroupShellProps {
  name: string;
  expanded: boolean;
  onToggle: () => void;
  /** Null when the group is virtual ("Ungrouped") — no menu / no rename.
   *  Called with viewport coords (from a click or right-click). */
  onMenu: ((x: number, y: number) => void) | null;
  /** True when this is the virtual Ungrouped bucket. */
  virtual?: boolean;
  /** When true, drag attributes are omitted and the row acts as a
   *  click-only toggle (used during filtering). */
  dragAttrs?: React.HTMLAttributes<HTMLDivElement>;
  dragListeners?: Record<string, unknown>;
  renaming?: boolean;
  onCommitRename?: (name: string) => void;
  onCancelRename?: () => void;
  children: React.ReactNode;
}

function GroupHeader({
  name,
  expanded,
  onToggle,
  onMenu,
  virtual,
  dragAttrs,
  dragListeners,
  renaming,
  onCommitRename,
  onCancelRename,
}: Omit<GroupShellProps, "children">) {
  return (
    <div
      role={renaming ? undefined : "button"}
      tabIndex={renaming ? -1 : 0}
      onClick={() => {
        if (renaming) return;
        onToggle();
      }}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      {...(dragAttrs ?? {})}
      {...(dragListeners ?? {})}
      onContextMenu={
        onMenu && !renaming
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      className={cn(
        "group/grp flex cursor-pointer select-none items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/50",
        virtual && "italic",
      )}
    >
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      {renaming ? (
        <RenameInput
          initial={name}
          onCommit={(v) => onCommitRename?.(v)}
          onCancel={() => onCancelRename?.()}
        />
      ) : (
        <span className="flex-1 truncate">{name}</span>
      )}
      {onMenu && !renaming && (
        <button
          title="More actions"
          aria-label="Group actions"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(r.right - 4, r.bottom + 2);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="rounded p-0.5 opacity-0 transition-opacity hover:bg-background group-hover/grp:opacity-100"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Non-sortable shell — used for the virtual "Ungrouped" bucket. */
function GroupContainer(props: GroupShellProps) {
  return (
    <div className="mb-1">
      <GroupHeader {...props} />
      {props.expanded && <div className="ml-1 mt-0.5">{props.children}</div>}
    </div>
  );
}

// ---------- Sortable group ----------

interface SortableGroupProps {
  group: ServerGroup;
  expanded: boolean;
  onToggle: () => void;
  renaming: boolean;
  onStartRename: () => void;
  onCommitRename: (name: string) => Promise<void> | void;
  onCancelRename: () => void;
  onMenu: (x: number, y: number) => void;
  /** Filtering mode — don't wire drag listeners, keep click-to-toggle only. */
  dragDisabled?: boolean;
  children: React.ReactNode;
}

function SortableGroup({
  group,
  expanded,
  onToggle,
  renaming,
  onCommitRename,
  onCancelRename,
  onMenu,
  dragDisabled,
  children,
}: SortableGroupProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: `group:${group.id}`, disabled: dragDisabled || renaming });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="mb-1 touch-none">
      <GroupHeader
        name={group.name}
        expanded={expanded}
        onToggle={onToggle}
        onMenu={onMenu}
        renaming={renaming}
        onCommitRename={onCommitRename}
        onCancelRename={onCancelRename}
        dragAttrs={dragDisabled || renaming ? undefined : (attributes as unknown as React.HTMLAttributes<HTMLDivElement>)}
        dragListeners={dragDisabled || renaming ? undefined : (listeners as unknown as Record<string, unknown>)}
      />
      {expanded && <div className="ml-1 mt-0.5">{children}</div>}
    </div>
  );
}

// ---------- Server list (SortableContext + rows) ----------

interface ServerListProps {
  servers: ServerSummary[];
  projectsByServer: Map<string, Project[]>;
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
  onOpenServer: (s: ServerSummary) => void;
  onOpenProject: (s: ServerSummary, p: Project) => void;
  onServerMenu: (s: ServerSummary, x: number, y: number) => void;
  onProjectMenu: (p: Project, x: number, y: number) => void;
  dragDisabled?: boolean;
  /** Keys (`${serverId}:${projectId ?? ""}`) currently connecting. */
  connecting: Set<string>;
}

function ServerList({
  servers,
  projectsByServer,
  expanded,
  onToggle,
  onOpenServer,
  onOpenProject,
  onServerMenu,
  onProjectMenu,
  dragDisabled,
  connecting,
}: ServerListProps) {
  const serverItemIds = servers.map((s) => `server:${s.id}`);
  if (servers.length === 0) {
    return (
      <div className="ml-4 px-2 py-1 text-[11px] italic text-muted-foreground">
        No servers
      </div>
    );
  }
  return (
    <SortableContext items={serverItemIds} strategy={verticalListSortingStrategy}>
      {servers.map((s) => {
        const isOpen = expanded[s.id] ?? true;
        const projs = projectsByServer.get(s.id) ?? [];
        return (
          <SortableServer
            key={s.id}
            server={s}
            isOpen={isOpen}
            onToggle={() => onToggle(s.id)}
            onOpen={() => onOpenServer(s)}
            onMenu={(x, y) => onServerMenu(s, x, y)}
            dragDisabled={dragDisabled}
            connecting={connecting.has(`${s.id}:`)}
          >
            {isOpen && (
              <div className="ml-6 mt-0.5 space-y-0.5 border-l pl-2">
                {projs.length === 0 && (
                  <div className="px-2 py-1 text-[11px] italic text-muted-foreground">
                    No projects yet
                  </div>
                )}
                <SortableContext
                  items={projs.map((p) => `project:${p.id}`)}
                  strategy={verticalListSortingStrategy}
                >
                  {projs.map((p) => (
                    <SortableProject
                      key={p.id}
                      project={p}
                      onOpen={() => onOpenProject(s, p)}
                      onMenu={(x, y) => onProjectMenu(p, x, y)}
                      dragDisabled={dragDisabled}
                      connecting={connecting.has(`${s.id}:${p.id}`)}
                    />
                  ))}
                </SortableContext>
              </div>
            )}
          </SortableServer>
        );
      })}
    </SortableContext>
  );
}

// ---------- Sortable server row ----------

interface SortableServerProps {
  server: ServerSummary;
  isOpen: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  dragDisabled?: boolean;
  connecting?: boolean;
  children: React.ReactNode;
}

function SortableServer({
  server,
  isOpen,
  onToggle,
  onOpen,
  onMenu,
  dragDisabled,
  connecting,
  children,
}: SortableServerProps) {
  const s = server;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: `server:${s.id}`, disabled: dragDisabled });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };
  // Subline = just the hostname (or IP). User + port stay implicit —
  // visible in the edit dialog if needed. Keeping this minimal so long
  // server names don't wrap twice.
  const sub = s.host;
  return (
    <div ref={setNodeRef} style={style} className="group mb-1 touch-none">
      <div
        role="button"
        tabIndex={0}
        {...(dragDisabled ? {} : (attributes as unknown as React.HTMLAttributes<HTMLDivElement>))}
        {...(dragDisabled ? {} : (listeners as unknown as Record<string, unknown>))}
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu(e.clientX, e.clientY);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex cursor-pointer select-none items-start gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-accent"
      >
        {isOpen ? (
          <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        {s.protocol === "ssh" ? (
          <ServerIcon
            className="mt-0.5 h-4 w-4 shrink-0 text-primary"
            aria-label="SSH server"
          />
        ) : (
          <Network
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
            aria-label={`${s.protocol.toUpperCase()} server`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate font-medium">{s.name}</span>
            {s.protocol !== "ssh" && (
              <span className="rounded bg-amber-500/15 px-1 py-0 text-[9px] font-semibold uppercase leading-4 text-amber-600 dark:text-amber-400">
                {s.protocol}
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[10px] leading-tight text-muted-foreground/80">
            {sub}
          </div>
        </div>
        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5 self-center transition-opacity",
            connecting
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
          )}
        >
          <button
            title={connecting ? "Connecting…" : "Connect"}
            disabled={connecting}
            className="rounded p-1 hover:bg-background disabled:cursor-default disabled:hover:bg-transparent"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {connecting ? (
              <Loader2 className="h-3 w-3 animate-spin text-primary" />
            ) : (
              <Play className="h-3 w-3" />
            )}
          </button>
          <button
            title="More actions"
            aria-label="More actions"
            className="rounded p-1 hover:bg-background"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onMenu(r.right - 4, r.bottom + 2);
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

// ---------- Sortable project row ----------

interface SortableProjectProps {
  project: Project;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  dragDisabled?: boolean;
  connecting?: boolean;
}

function SortableProject({
  project,
  onOpen,
  onMenu,
  dragDisabled,
  connecting,
}: SortableProjectProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: `project:${project.id}`, disabled: dragDisabled });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      role="button"
      tabIndex={0}
      {...(dragDisabled ? {} : (attributes as unknown as React.HTMLAttributes<HTMLDivElement>))}
      {...(dragDisabled ? {} : (listeners as unknown as Record<string, unknown>))}
      onClick={() => {
        if (!connecting) onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !connecting) {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group/item flex cursor-pointer select-none items-center gap-1.5 rounded-md px-2 py-1 text-xs touch-none hover:bg-accent"
    >
      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{project.name}</span>
      <div
        className={cn(
          "flex items-center gap-0.5 transition-opacity",
          connecting
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0 group-hover/item:pointer-events-auto group-hover/item:opacity-100",
        )}
      >
        <button
          title={connecting ? "Connecting…" : "Connect"}
          disabled={connecting}
          className="rounded p-1 hover:bg-background disabled:cursor-default disabled:hover:bg-transparent"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {connecting ? (
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
          ) : (
            <Play className="h-3 w-3" />
          )}
        </button>
        <button
          title="More actions"
          aria-label="More actions"
          className="rounded p-1 hover:bg-background"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(r.right - 4, r.bottom + 2);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ---------- Inline rename input (group header) ----------

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const [value, setValue] = useState(initial);
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="h-5 min-w-0 flex-1 rounded bg-background px-1.5 text-[11px] font-semibold uppercase outline-none ring-1 ring-primary"
    />
  );
}
