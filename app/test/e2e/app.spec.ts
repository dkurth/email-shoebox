import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { APP_DIR, takeoutFolder, tempDir } from "../helpers.ts";

// SHOEBOX_APP_EXECUTABLE runs these tests on a packaged app (with its bundled Python), for example
// "release/mac-arm64/Email Shoebox.app/Contents/MacOS/Email Shoebox". Without it, they run the app from dist/.
const executable = process.env.SHOEBOX_APP_EXECUTABLE;

async function launch(userData: string): Promise<ElectronApplication> {
  const env = { ...process.env, SHOEBOX_USER_DATA: userData, SHOEBOX_NO_UPDATES: "1" };
  return executable ? electron.launch({ executablePath: path.resolve(APP_DIR, executable), env }) : electron.launch({ args: [APP_DIR], env });
}

/** The next file or folder dialog returns these paths. */
async function nextOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: chosen })) as typeof dialog.showOpenDialog;
  }, paths);
}

/** The next question dialog is answered with this button. */
async function nextMessageBox(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    dialog.showMessageBox = (async () => ({ response: r, checkboxChecked: false })) as typeof dialog.showMessageBox;
  }, response);
}

const isViewer = (p: Page) => p.url().startsWith("http://127.0.0.1");

async function viewerWindow(app: ElectronApplication): Promise<Page> {
  const open = app.windows().find(isViewer);
  return open ?? app.waitForEvent("window", { predicate: isViewer });
}

test("first launch: choose a backup, name it, import it, read it", async () => {
  const userData = tempDir();
  const app = await launch(userData);
  const welcome = await app.firstWindow();
  await expect(welcome.getByRole("heading", { name: "Welcome to Email Shoebox" })).toBeVisible();

  await nextOpenDialog(app, [takeoutFolder("Personal-takeout-20261008")]);
  await welcome.getByRole("button", { name: /Choose a folder/ }).click();
  await expect(welcome.getByText(/Found 1 mbox file/)).toBeVisible();
  const name = welcome.getByLabel("Name this collection");
  await expect(name).toHaveValue(/^me@example\.com \(\d{4}(–\d{4})?\)$/); // from the scan
  await name.fill("Personal");
  await welcome.getByLabel(/Skip Spam and Trash/).check();

  const viewerOpens = app.waitForEvent("window", { predicate: isViewer });
  await welcome.getByRole("button", { name: "Import", exact: true }).click();
  const viewer = await viewerOpens;
  await expect(viewer.locator(".collection-button")).toHaveText("Personal");
  await expect(viewer).toHaveTitle(/Personal - Email Shoebox/);
  await expect(viewer.locator(".thread-row").first()).toBeVisible();

  // The collection is in the app data folder, with its name inside the archive too.
  const reg = JSON.parse(fs.readFileSync(path.join(userData, "collections.json"), "utf8"));
  expect(reg.collections).toMatchObject([{ name: "Personal", incomplete: null, path: path.join(userData, "collections", "personal") }]);

  // Other programs can't read the mail from the local server: they don't have the token.
  const res = await fetch(new URL("/api/session", viewer.url()));
  expect(res.status).toBe(403);
  await app.close();

  // The next start opens the same collection at once.
  const again = await launch(userData);
  const v2 = await viewerWindow(again);
  await expect(v2.locator(".collection-button")).toHaveText("Personal");
  await again.close();
});

test("the collections menu: import another, switch, rename, delete", async () => {
  const userData = tempDir();
  const app = await launch(userData);
  const welcome = await app.firstWindow();
  await nextOpenDialog(app, [takeoutFolder()]);
  await welcome.getByRole("button", { name: /Choose a folder/ }).click();
  await welcome.getByLabel("Name this collection").fill("First");
  const viewerOpens = app.waitForEvent("window", { predicate: isViewer });
  await welcome.getByRole("button", { name: "Import", exact: true }).click();
  const viewer = await viewerOpens;
  await expect(viewer.locator(".collection-button")).toHaveText("First");

  // Import… from the menu opens the import page over the viewer.
  await viewer.locator(".collection-button").click();
  const importOpens = app.waitForEvent("window", { predicate: (p) => p.url().includes("#/import") });
  await viewer.getByRole("menuitem", { name: "Import…" }).click();
  const importPage = await importOpens;
  await nextOpenDialog(app, [path.join(takeoutFolder(), "Takeout", "Mail", "Inbox.mbox")]);
  await importPage.getByRole("button", { name: /Choose a file/ }).click();
  await expect(importPage.getByText(/messages in \d{4}/)).toBeVisible();
  await importPage.getByLabel("Name this collection").fill("Second");
  await importPage.getByRole("button", { name: "Import", exact: true }).click();
  await expect(viewer.locator(".collection-button")).toHaveText("Second"); // it switched to the new one

  // Switch back with the menu.
  await viewer.locator(".collection-button").click();
  await expect(viewer.getByRole("menuitem", { name: /Second/ })).toContainText("messages");
  await viewer.getByRole("menuitem", { name: /First/ }).click();
  await expect(viewer.locator(".collection-button")).toHaveText("First");
  await expect(viewer).toHaveTitle(/First - Email Shoebox/);

  // Manage: rename one, delete the other.
  await viewer.locator(".collection-button").click();
  const manageOpens = app.waitForEvent("window", { predicate: (p) => p.url().includes("#/manage") });
  await viewer.getByRole("menuitem", { name: "Manage collections…" }).click();
  const manage = await manageOpens;
  const rows = manage.getByTestId("collection");
  await expect(rows).toHaveCount(2);
  const second = rows.filter({ hasText: "Second" });
  await second.getByRole("button", { name: "Rename" }).click();
  await manage.getByLabel("New name").fill("Old letters");
  await manage.getByRole("button", { name: "Save" }).click();
  await expect(rows.filter({ hasText: "Old letters" })).toBeVisible();
  await viewer.locator(".collection-button").click();
  await expect(viewer.getByRole("menuitem", { name: /Old letters/ })).toBeVisible();
  await viewer.keyboard.press("Escape");

  const secondDir = JSON.parse(fs.readFileSync(path.join(userData, "collections.json"), "utf8")).collections[1].path;
  await nextMessageBox(app, 0); // "Delete"
  await rows.filter({ hasText: "Old letters" }).getByRole("button", { name: "Delete…" }).click();
  await expect(rows).toHaveCount(1);
  expect(fs.existsSync(secondDir)).toBe(false);
  await app.close();
});

test("deleting the open collection, the last one, goes back to the welcome page", async () => {
  const userData = tempDir();
  const app = await launch(userData);
  const welcome = await app.firstWindow();
  await nextOpenDialog(app, [takeoutFolder()]);
  await welcome.getByRole("button", { name: /Choose a folder/ }).click();
  await welcome.getByLabel("Name this collection").fill("Only");
  const viewerOpens = app.waitForEvent("window", { predicate: isViewer });
  await welcome.getByRole("button", { name: "Import", exact: true }).click();
  const viewer = await viewerOpens;

  await viewer.locator(".collection-button").click();
  const manageOpens = app.waitForEvent("window", { predicate: (p) => p.url().includes("#/manage") });
  await viewer.getByRole("menuitem", { name: "Manage collections…" }).click();
  const manage = await manageOpens;
  await nextMessageBox(app, 0);
  await manage.getByRole("button", { name: "Delete…" }).click();
  await expect(manage.getByRole("heading", { name: "Welcome to Email Shoebox" })).toBeVisible();
  expect(app.windows().some(isViewer)).toBe(false);
  await app.close();
});

test("a maintenance job runs in the app (the job workers are bundled)", async () => {
  const app = await launch(tempDir());
  const welcome = await app.firstWindow();
  await nextOpenDialog(app, [takeoutFolder()]);
  await welcome.getByRole("button", { name: /Choose a folder/ }).click();
  await welcome.getByLabel("Name this collection").fill("Jobs");
  const viewerOpens = app.waitForEvent("window", { predicate: isViewer });
  await welcome.getByRole("button", { name: "Import", exact: true }).click();
  const viewer = await viewerOpens;
  await viewer.goto(new URL("/#/admin/maintenance", viewer.url()).href);
  await viewer.getByRole("button", { name: "Compact database" }).click();
  await viewer.getByRole("alertdialog").getByRole("button", { name: "Compact" }).click();
  await expect(viewer.locator(".job-result")).toContainText("Done:");
  await app.close();
});
