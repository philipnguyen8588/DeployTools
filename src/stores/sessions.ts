import { create } from "zustand";
import * as api from "@/lib/api";
import type { SessionSummary } from "@/lib/types";

export type SessionStatus = "connected" | "reconnecting" | "disconnected";

/**
 * One "tab" in the UI = one OpenTab entry. It holds both the backend
 * session summary and some frontend-only view state (the currently
 * selected remote path, etc).
 *
 * Lifecycle:
 *   connected → (idle 30 min / channel error) → disconnected
 *   disconnected → (user clicks Reconnect) → reconnecting → connected
 */
export interface OpenTab {
  session: SessionSummary;
  /** Display label — derived from server + project name. */
  label: string;
  /** Remote path currently browsed. */
  remotePath: string;
  /** Local path currently browsed (defaults to project's local_path). */
  localPath: string;
  /** Connection lifecycle state — drives the overlay + StatusBar dot. */
  status: SessionStatus;
  /** Wall-clock ms of the last terminal I/O (user keystroke OR server
   *  output). Used by the idle-timeout watcher. */
  lastActivityAt: number;
  /** Human message shown in the disconnected overlay. */
  disconnectReason: string | null;
  /** Who opened this tab — "mcp" tabs get a badge in the TabBar. */
  origin?: "manual" | "mcp";
}

interface SessionsState {
  tabs: OpenTab[];
  activeId: string | null;
  openTab: (tab: Omit<OpenTab, "status" | "lastActivityAt" | "disconnectReason">) => void;
  /** Adopt an MCP-opened backend session: reuse the existing tab for the
   *  same project (in-place reconnect) if there is one, else open a new
   *  tab. Keeps MCP on a single tab per project across timeouts. */
  adoptMcpSession: (args: {
    session: SessionSummary;
    label: string;
    remotePath: string;
  }) => void;
  closeTab: (sessionId: string) => Promise<void>;
  /** Remove a tab from the UI WITHOUT closing the backend session (it was
   *  already closed elsewhere, e.g. by the MCP server). */
  dropTab: (sessionId: string) => void;
  setActive: (sessionId: string) => void;
  updateRemotePath: (sessionId: string, path: string) => void;
  updateLocalPath: (sessionId: string, path: string) => void;

  /** Mark the last activity timestamp of a tab (called from Terminal
   *  on every keystroke / server-output chunk). */
  bumpActivity: (sessionId: string) => void;

  /** Close the backend session but keep the tab visible — the overlay
   *  renders + the user can reconnect. */
  markDisconnected: (sessionId: string, reason: string) => Promise<void>;

  /** Recreate the backend session for a disconnected tab. Replaces the
   *  tab's `session` (new session id = new React keys = panels remount). */
  reconnect: (sessionId: string) => Promise<void>;
}

export const useSessions = create<SessionsState>((set, get) => ({
  tabs: [],
  activeId: null,

  openTab: (tab) =>
    set((s) => {
      // If a tab for this session already exists, just activate it.
      if (s.tabs.some((t) => t.session.id === tab.session.id)) {
        return { activeId: tab.session.id };
      }
      const full: OpenTab = {
        ...tab,
        status: "connected",
        lastActivityAt: Date.now(),
        disconnectReason: null,
      };
      return { tabs: [...s.tabs, full], activeId: tab.session.id };
    }),

  adoptMcpSession: (args) =>
    set((s) => {
      const { session, label, remotePath } = args;
      // Exact same session already open — just activate it.
      if (s.tabs.some((t) => t.session.id === session.id)) {
        return { activeId: session.id };
      }
      // Reuse an existing tab for the SAME project (e.g. one that went
      // "disconnected" after a timeout): adopt the fresh backend session
      // into it — an in-place reconnect — so MCP keeps using one tab.
      const pid = session.project_id;
      const idx = pid
        ? s.tabs.findIndex((t) => t.session.project_id === pid)
        : -1;
      if (idx >= 0) {
        const tabs = s.tabs.slice();
        const prev = tabs[idx];
        tabs[idx] = {
          ...prev,
          session,
          status: "connected",
          lastActivityAt: Date.now(),
          disconnectReason: null,
          origin: prev.origin ?? "mcp",
        };
        return { tabs, activeId: session.id };
      }
      // No tab for this project — the user closed it by hand. Open a new
      // one.
      const full: OpenTab = {
        session,
        label,
        remotePath: remotePath || "/",
        localPath: "",
        status: "connected",
        lastActivityAt: Date.now(),
        disconnectReason: null,
        origin: "mcp",
      };
      return { tabs: [...s.tabs, full], activeId: session.id };
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

  dropTab: (sessionId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.session.id !== sessionId);
      const nextActive =
        s.activeId === sessionId
          ? tabs[tabs.length - 1]?.session.id ?? null
          : s.activeId;
      return { tabs, activeId: nextActive };
    }),

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

  bumpActivity: (sessionId) =>
    set((s) => {
      const t = s.tabs.find((x) => x.session.id === sessionId);
      if (!t || t.status !== "connected") return {};
      // Skip trivial updates (<200 ms apart) — reduces re-renders for a
      // busy streaming log while keeping the timer responsive enough
      // that a single new log line clearly resets idle.
      if (Date.now() - t.lastActivityAt < 200) return {};
      return {
        tabs: s.tabs.map((x) =>
          x.session.id === sessionId ? { ...x, lastActivityAt: Date.now() } : x,
        ),
      };
    }),

  markDisconnected: async (sessionId, reason) => {
    const tab = get().tabs.find((t) => t.session.id === sessionId);
    if (!tab) return;
    try {
      await api.closeSession(sessionId);
    } catch {
      // Tolerate — connection may already be dead.
    }
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.session.id === sessionId
          ? { ...t, status: "disconnected", disconnectReason: reason }
          : t,
      ),
    }));
  },

  reconnect: async (sessionId) => {
    const tab = get().tabs.find((t) => t.session.id === sessionId);
    if (!tab) return;
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.session.id === sessionId ? { ...t, status: "reconnecting" } : t,
      ),
    }));
    try {
      const next = await api.openSession(
        tab.session.server_id,
        tab.session.project_id ?? undefined,
      );
      set((s) => {
        const newTabs = s.tabs.map((t) =>
          t.session.id === sessionId
            ? {
                ...t,
                session: next,
                status: "connected" as const,
                lastActivityAt: Date.now(),
                disconnectReason: null,
              }
            : t,
        );
        // If this tab was active, update activeId to the NEW session id —
        // otherwise ContentControl has no match.
        const wasActive = s.activeId === sessionId;
        return {
          tabs: newTabs,
          activeId: wasActive ? next.id : s.activeId,
        };
      });
    } catch (e) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.session.id === sessionId
            ? { ...t, status: "disconnected", disconnectReason: `${e}` }
            : t,
        ),
      }));
      throw e;
    }
  },
}));

export function activeTab(): OpenTab | null {
  const { tabs, activeId } = useSessions.getState();
  return tabs.find((t) => t.session.id === activeId) ?? null;
}
