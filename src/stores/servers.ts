import { create } from "zustand";
import * as api from "@/lib/api";
import type { Server, ServerSummary } from "@/lib/types";

interface ServersState {
  servers: ServerSummary[];
  loading: boolean;
  refresh: () => Promise<void>;
  save: (server: Server) => Promise<Server>;
  remove: (id: string) => Promise<void>;
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
}));
