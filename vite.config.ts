import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://tauri.app/v2/reference/config/#vite
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // monaco-editor's exports map only exposes "*.js" subpaths, which
      // blocks direct CSS imports (codicon font). Alias around it.
      "monaco-esm": path.resolve(__dirname, "./node_modules/monaco-editor/esm/vs"),
    },
  },
  // Vite options tailored for Tauri dev
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
