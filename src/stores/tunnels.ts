import { create } from "zustand";
import * as api from "@/lib/api";

/**
 * Live count of active SSH tunnels per session. Kept in a store (rather
 * than TunnelPanel-local state) because two other places need it:
 *   - the BottomPanel tab strip highlights the Tunnels tab while any
 *     tunnel is up, even when the panel itself isn't the active tab;
 *   - the idle-timeout watcher in App.tsx skips auto-disconnect for
 *     sessions with running tunnels.
 * TunnelPanel refreshes it on every list change; BottomPanel polls it
 * lightly so tunnels killed server-side clear the indicator too.
 */
interface TunnelsState {
  counts: Record<string, number>;
  setCount: (sessionId: string, count: number) => void;
  /** Re-query the backend for one session's tunnels. Silent on error. */
  refresh: (sessionId: string) => Promise<void>;
}

export const useTunnels = create<TunnelsState>((set) => ({
  counts: {},

  setCount: (sessionId, count) =>
    set((s) =>
      s.counts[sessionId] === count
        ? s
        : { counts: { ...s.counts, [sessionId]: count } },
    ),

  refresh: async (sessionId) => {
    try {
      const list = await api.listTunnels(sessionId);
      set((s) =>
        s.counts[sessionId] === list.length
          ? s
          : { counts: { ...s.counts, [sessionId]: list.length } },
      );
    } catch {
      /* session may be gone — leave the last known value */
    }
  },
}));
