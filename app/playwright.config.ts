import { defineConfig } from "@playwright/test";

// End-to-end tests of the built app (run `npm run build` first). Each test starts Electron with its own data folder.
export default defineConfig({
  testDir: "test/e2e",
  timeout: 90_000,
  workers: 1,
  reporter: "list",
});
