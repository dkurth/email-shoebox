import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  workers: 2,
  use: { viewport: { width: 1280, height: 800 } },
  reporter: "list",
});
