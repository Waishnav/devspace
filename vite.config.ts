import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/ui"),
  plugins: [react()],
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: {
        "workspace-app": resolve(__dirname, "src/ui/workspace-app.html"),
        "workspace-inspector": resolve(__dirname, "src/ui/workspace-inspector.html"),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
