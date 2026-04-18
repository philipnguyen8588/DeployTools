import { create } from "zustand";

/**
 * The top-level "view" the main pane is showing. Sidebar sections
 * switch this: `tabs` is the default (server tabs); `cloudflare` swaps
 * in the Cloudflare DNS manager.
 */
export type MainView = "tabs" | "cloudflare" | "snippets";

interface ViewState {
  view: MainView;
  setView: (v: MainView) => void;
}

export const useView = create<ViewState>((set) => ({
  view: "tabs",
  setView: (view) => set({ view }),
}));
