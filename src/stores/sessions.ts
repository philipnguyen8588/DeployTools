import { create } from "zustand";
import * as api from "@/lib/api";
import type { SessionSummary } from "@/lib/types";

/**
 * One "tab" in the UI = one OpenTab entry. It holds both the backend
 * session summary and some frontend-only view state (the currently
 * selected remote path, etc).
 */
export interface OpenTab {
  session: SessionSummary;
  /** Display label — derived from server + project name. */
  label: string;
  /** Remote path currently browsed. */
  remotePath: string;
  /** Local path currently browsed (defaults to project's local_path). */
  localPath: string;
}

interface SessionsState {
  tabs: OpenTab[];
  activeId: string | null;
  openTab: (tab: OpenTab) => void;
  closeTab: (sessionId: string) => Promise<void>;
  setActive: (sessionId: string) => void;
  updateRemotePath: (sessionId: string, path: string) => void;
  updateLocalPath: (sessionId: string, path: string) => void;
}

export const useSessions = create<SessionsState>((set) => ({
  tabs: [],
  activeId: null,

  openTab: (tab) =>
    set((s) => {
      // If a tab for this session already exists, just activate it.
      if (s.tabs.some((t) => t.session.id === tab.session.id)) {
        return { activeId: tab.session.id };
      }
      return { tabs: [...s.tabs, tab], activeId: tab.session.id };
    }),

  closeTab: async (sessionId) => {
    try {
      await api.closeSession(sessionId);
    } catch {
      // tolerate already-closed sessions
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.session.id !== sessionId);
      const nextActive =
        s.activeId === sessionId ? tabs[tabs.length - 1]?.session.id ?? null : s.activeId;
      return { tabs, activeId: nextActive };
    });
  },

  setActive: (sessionId) => set({ activeId: sessionId }),

  updateRemotePath: (sessionId, path) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.session.id === sessionId ? { ...t, remotePath: path } : t,
      ),
    })),

  updateLocalPath: (sessionId, path) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.session.id === sessionId ? { ...t, localPath: path } : t,
      ),
    })),
}));

export function activeTab(): OpenTab | null {
  const { tabs, activeId } = useSessions.getState();
  return tabs.find((t) => t.session.id === activeId) ?? null;
}
