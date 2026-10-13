import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app's own pages (welcome, import, manage, upgrade). They load from file://, so paths are relative.
export default defineConfig({
  root: "ui",
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist/ui", emptyOutDir: true },
});
