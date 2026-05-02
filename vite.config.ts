// Stub vite.config.ts for shadcn CLI detection.
// Actual Vite config lives in electron.vite.config.ts.
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer"),
    },
  },
  plugins: [tailwindcss(), react()],
});
