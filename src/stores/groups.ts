import { create } from "zustand";
import * as api from "@/lib/api";
import type { ServerGroup, UUID } from "@/lib/types";

interface GroupsState {
  groups: ServerGroup[];
  loading: boolean;
  refresh: () => Promise<void>;
  /** Create a new group. Name may be empty; backend coerces to "New group". */
  create: (name: string) => Promise<ServerGroup>;
  /** Rename. */
  rename: (id: UUID, name: string) => Promise<ServerGroup>;
  /** Deletes the group; orphaned servers fall back to the "Ungrouped" bucket. */
  remove: (id: UUID) => Promise<void>;
  /** Bulk-update order from a drag-drop reorder. */
  reorder: (ids: UUID[]) => Promise<void>;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const useGroups = create<GroupsState>((set, get) => ({
  groups: [],
  loading: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const groups = await api.listGroups();
      set({ groups });
    } finally {
      set({ loading: false });
    }
  },

  create: async (name) => {
    const g = await api.saveGroup({
      id: NIL_UUID,
      name,
      order: 0,
    });
    await get().refresh();
    return g;
  },

  rename: async (id, name) => {
    // Keep existing order — backend only mutates `name` on update.
    const existing = get().groups.find((g) => g.id === id);
    const g = await api.saveGroup({
      id,
      name,
      order: existing?.order ?? 0,
    });
    await get().refresh();
    return g;
  },

  remove: async (id) => {
    await api.deleteGroup(id);
    await get().refresh();
  },

  reorder: async (ids) => {
    // Optimistic local reorder so the UI doesn't flicker while the
    // IPC round-trip finishes.
    set((s) => ({
      groups: ids
        .map((id, i) => {
          const g = s.groups.find((x) => x.id === id);
          return g ? { ...g, order: i } : null;
        })
        .filter((x): x is ServerGroup => x !== null),
    }));
    await api.reorderGroups(ids);
  },
}));
