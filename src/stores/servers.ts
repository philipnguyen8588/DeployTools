import { create } from "zustand";
import * as api from "@/lib/api";
import type { Server, ServerSummary, UUID } from "@/lib/types";

interface ServersState {
  servers: ServerSummary[];
  loading: boolean;
  refresh: () => Promise<void>;
  save: (server: Server) => Promise<Server>;
  remove: (id: string) => Promise<void>;
  /** Drag-drop: set `ids` as the new ordering inside `groupId`.
   *  Pass `null` for the virtual "Ungrouped" bucket. */
  reorderWithinGroup: (
    groupId: UUID | null,
    ids: UUID[],
  ) => Promise<void>;
}

export const useServers = create<ServersState>((set, get) => ({
  servers: [],
  loading: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const servers = await api.listServers();
      set({ servers });
    } finally {
      set({ loading: false });
    }
  },
  save: async (server) => {
    const saved = await api.saveServer(server);
    await get().refresh();
    return saved;
  },
  remove: async (id) => {
    await api.deleteServer(id);
    await get().refresh();
  },

  reorderWithinGroup: async (groupId, ids) => {
    // Optimistic: patch local state with the new group + order so the
    // sidebar doesn't flicker while the IPC round-trip finishes.
    set((s) => ({
      servers: s.servers.map((sv) => {
        const idx = ids.indexOf(sv.id);
        return idx === -1 ? sv : { ...sv, group_id: groupId, order: idx };
      }),
    }));
    await api.reorderServers(groupId, ids);
  },
}));
