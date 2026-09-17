import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { useSessions } from "@/stores/sessions";
import { useView } from "@/stores/view";
import type { SessionSummary } from "@/lib/types";

interface SessionOpened {
  session: SessionSummary;
  label: string;
  remote_path: string;
}

/**
 * Reflect MCP-driven backend actions in the UI. When the embedded MCP
 * server opens a session for an AI agent, we open a real tab for it (so
 * the agent's terminals / Activity log / progress render just like a
 * manual connection); when it disconnects we drop the tab.
 *
 * Mounted once from `App`. `openTab` de-dupes by session id, so if the
 * user later opens the same session manually there's no duplicate.
 */
export function useMcpBridge() {
  useEffect(() => {
    const uns: Array<() => void> = [];
    let alive = true;
    (async () => {
      uns.push(
        await listen<SessionOpened>("mcp://session-opened", (e) => {
          if (!alive) return;
          const { session, label, remote_path } = e.payload;
          const store = useSessions.getState();
          // Adopt into the existing tab for this project if one is open
          // (e.g. a disconnected tab after a timeout) so MCP reuses one
          // tab instead of piling up duplicates on every reconnect.
          store.adoptMcpSession({
            session,
            label,
            remotePath: remote_path || "/",
          });
          useView.getState().setView("tabs");
          toast.success(`MCP connected: ${label}`);
        }),
      );
      uns.push(
        await listen<{ session_id: string }>("mcp://session-closed", (e) => {
          if (!alive) return;
          useSessions.getState().dropTab(e.payload.session_id);
        }),
      );
    })();
    return () => {
      alive = false;
      uns.forEach((u) => u());
    };
  }, []);
}
