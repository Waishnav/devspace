import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Workspace web pages served by the DevSpace server under /web. Kept separate
// from the card build so each can change its bundling independently.
export default defineConfig({
  root: resolve(__dirname, "src/ui/web"),
  plugins: [react()],
  base: "/web/",
  build: {
    outDir: resolve(__dirname, "dist/web"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
