import { expect, test, type Page } from "@playwright/test";
import { startServer, type Server } from "./server.ts";

let server: Server;
test.afterEach(() => server?.stop());

const subjects = (page: Page) => page.locator(".thread-row .subject");

test("opens on the Inbox, grouped by thread", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url);
  await expect(page).toHaveURL(/#\/inbox$/);
  await expect(subjects(page)).toHaveText(["Welcome to the archive", "Trip planning", "Big sale", "Grüße aus Köln ☕", "Mixed thread"]);
  await expect(page.locator(".thread-row").nth(1).locator(".participants")).toHaveText("Alice, me, Bob 3");
});

test("j j x j x # trashes exactly two threads, and Undo restores them", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url);
  await expect(subjects(page)).toHaveCount(5);
  for (const k of ["j", "j", "x", "j", "x"]) await page.keyboard.press(k);
  await page.keyboard.press("#");
  await expect(subjects(page)).toHaveText(["Welcome to the archive", "Trip planning", "Mixed thread"]);
  await expect(page.locator(".toast")).toContainText("2 conversations moved to Trash.");
  await page.locator(".toast-undo").click();
  await expect(subjects(page)).toHaveCount(5);
  await page.goto(server.url + "#/trash");
  await expect(subjects(page)).toHaveText(["Re: Mixed thread", "Old coupon"]);
});

test("Enter opens a thread and marks it read; y archives and returns to the list", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url);
  await expect(page.locator(".nav-item.active .nav-count")).toHaveText("2");
  await page.keyboard.press("Enter");
  await expect(page.locator(".thread-title h1")).toHaveText("Welcome to the archive");
  await expect(page.locator(".nav-item.active .nav-count")).toHaveText("1");
  await page.keyboard.press("y");
  await expect(page).toHaveURL(/#\/inbox$/);
  await expect(subjects(page)).toHaveCount(4);
  await expect(page.locator(".toast")).toContainText("Conversation archived.");
});

test("y in a label view removes only that label", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/label/Family");
  await expect(subjects(page)).toHaveText(["Grüße aus Köln ☕"]);
  await page.keyboard.press("y");
  await expect(page.locator(".empty-list")).toBeVisible();
  await page.goto(server.url + "#/inbox");
  await expect(subjects(page)).toContainText(["Grüße aus Köln ☕"]); // still in the Inbox
});

test("a sidebar label shows only its threads", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url);
  await page.locator(".sidebar").getByText("Work", { exact: true }).click();
  await expect(subjects(page)).toHaveText(["Quarterly report"]);
  await page.locator(".sidebar").getByText("Projects", { exact: true }).click();
  await expect(subjects(page)).toHaveText(["Project kickoff"]);
});

test("Empty Trash asks first, then deletes", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/trash");
  await expect(subjects(page)).toHaveCount(2);
  await page.getByText("Empty Trash now").click();
  await expect(page.getByRole("alertdialog")).toContainText("Permanently delete 2 messages in 2 conversations");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(subjects(page)).toHaveCount(2);
  await page.getByText("Empty Trash now").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete forever" }).click();
  await expect(page.locator(".empty-list")).toHaveText("No conversations here.");
  await expect(page.locator(".toast")).toContainText("2 messages deleted forever.");
});

test("HTML email: scripts never run, remote images wait for permission", async ({ page }) => {
  server = await startServer();
  const remote: string[] = [];
  await page.route("**/tracker.example/**", (route) => {
    remote.push(route.request().url());
    return route.fulfill({ status: 204 });
  });
  await page.goto(server.url);
  await page.getByText("Big sale", { exact: true }).click();
  const frame = page.frameLocator("iframe[title='Message body']");
  await expect(frame.getByText("See deal")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { hacked?: boolean }).hacked)).toBeUndefined();
  await expect(frame.getByText("bad link")).not.toHaveAttribute("href", /javascript/);
  await expect(frame.locator("img[alt=logo]")).toHaveAttribute("src", /\/api\/attachments\/\d+\/inline/);
  expect(remote).toEqual([]);
  await page.getByRole("button", { name: "Show images in this message" }).click();
  await expect.poll(() => remote.length).toBeGreaterThan(0);
});

test("clicking an attachment downloads it with its name", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/label/Work");
  await page.getByText("Quarterly report").first().click();
  await page.locator(".msg.collapsed").first().click();
  const download = page.waitForEvent("download");
  await page.getByText("report.xlsx").click();
  expect((await download).suggestedFilename()).toBe("report.xlsx");
});

test("read-only mode shows no write actions", async ({ page }) => {
  server = await startServer({ readOnly: true });
  await page.goto(server.url);
  await expect(page.locator(".badge")).toHaveText("read-only");
  await page.keyboard.press("x");
  await expect(page.locator(".actions")).toHaveCount(0);
  await page.keyboard.press("#");
  await expect(page.locator(".toast")).toContainText("read-only");
  await expect(subjects(page)).toHaveCount(5);
});

test("Expand all shows only when a message is collapsed", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url);
  await expect(subjects(page)).toHaveCount(5);
  await page.keyboard.press("Enter"); // "Welcome to the archive": one message
  await expect(page.locator(".msg.expanded")).toHaveCount(1);
  await expect(page.locator(".expand-all")).toHaveCount(0);
  await page.keyboard.press("u");
  await expect(subjects(page)).toHaveCount(5);
  await page.keyboard.press("j");
  await page.keyboard.press("Enter"); // "Trip planning": the read first message is collapsed
  await expect(page.locator(".msg.collapsed")).not.toHaveCount(0);
  await page.locator(".expand-all").click();
  await expect(page.locator(".msg.collapsed")).toHaveCount(0);
  await expect(page.locator(".expand-all")).toHaveCount(0);
});

test("starring offers no Undo, and z does not undo an older action", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url);
  await expect(subjects(page)).toHaveCount(5);
  await page.keyboard.press("#"); // trash "Welcome to the archive" (Undo offered)
  await expect(page.locator(".toast-undo")).toBeVisible();
  await page.keyboard.press("s");
  await expect(page.locator(".toast")).toContainText("Conversation starred.");
  await expect(page.locator(".toast-undo")).toHaveCount(0);
  await page.keyboard.press("z");
  await expect(subjects(page)).toHaveCount(4); // the trash was not undone
  await page.locator(".thread-row").first().locator(".star").click();
  await expect(page.locator(".toast")).toContainText("Conversation unstarred.");
  await expect(page.locator(".toast-undo")).toHaveCount(0);
});
