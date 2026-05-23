import { create } from "zustand";
import * as api from "@/lib/api";
import type { Project, UUID } from "@/lib/types";

interface ProjectsState {
  projects: Project[];
  loading: boolean;
  refresh: () => Promise<void>;
  save: (project: Project) => Promise<Project>;
  remove: (id: string) => Promise<void>;
  /** Drag-drop: set `ids` as the new ordering under `serverId`.
   *  Cross-server drops re-parent each project to `serverId`. */
  reorderWithinServer: (serverId: UUID, ids: UUID[]) => Promise<void>;
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  loading: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const projects = await api.listProjects();
      set({ projects });
    } finally {
      set({ loading: false });
    }
  },
  save: async (project) => {
    const saved = await api.saveProject(project);
    await get().refresh();
    return saved;
  },
  remove: async (id) => {
    await api.deleteProject(id);
    await get().refresh();
  },

  reorderWithinServer: async (serverId, ids) => {
    set((s) => ({
      projects: s.projects.map((p) => {
        const idx = ids.indexOf(p.id);
        return idx === -1 ? p : { ...p, server_id: serverId, order: idx };
      }),
    }));
    await api.reorderProjects(serverId, ids);
  },
}));
