import { create } from "zustand";
import * as api from "@/lib/api";

interface VaultState {
  exists: boolean;
  unlocked: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  init: (password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => Promise<void>;
}

export const useVault = create<VaultState>((set) => ({
  exists: false,
  unlocked: false,
  loading: true,

  refresh: async () => {
    const s = await api.vaultStatus();
    set({ exists: s.exists, unlocked: s.unlocked, loading: false });
  },
  init: async (p) => {
    await api.vaultInit(p);
    set({ exists: true, unlocked: true });
  },
  unlock: async (p) => {
    await api.vaultUnlock(p);
    set({ unlocked: true });
  },
  lock: async () => {
    await api.vaultLock();
    set({ unlocked: false });
  },
}));
