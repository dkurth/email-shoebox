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
  await expect(page.locator(".sidebar .label-square").first()).toBeVisible(); // colors show,
  await expect(page.locator(".nav-options")).toHaveCount(0); // but can't be changed
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

test("starring shows no message; the star icon changes, in the list and in a conversation", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url);
  await expect(subjects(page)).toHaveCount(5);
  const rowStar = (i: number) => page.locator(".thread-row").nth(i).locator(".star");
  await page.keyboard.press("s");
  await expect(rowStar(0)).toHaveAttribute("aria-pressed", "true");
  await rowStar(0).click();
  await expect(rowStar(0)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".toast")).toHaveCount(0);

  // Clicking a row's star stars that row only, and keeps the checked rows checked.
  await page.locator(".thread-row").nth(2).getByRole("checkbox").check();
  await rowStar(1).click();
  await expect(rowStar(1)).toHaveAttribute("aria-pressed", "true");
  await expect(rowStar(2)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".thread-row").nth(2).getByRole("checkbox")).toBeChecked();

  // In a conversation: the title has a star; s and a click toggle it.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter"); // opens row 1 (the cursor moved there with the click), starred above
  const titleStar = page.locator(".thread-title .star");
  await expect(titleStar).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("s");
  await expect(titleStar).toHaveAttribute("aria-pressed", "false");
  await titleStar.click();
  await expect(titleStar).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("label colors: pick one in the sidebar menu; children follow; Default color resets", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/all");
  const navItem = (name: string) => page.locator(".sidebar .nav-item").filter({ has: page.getByText(name, { exact: true }) });
  const square = (name: string) => navItem(name).locator(".label-square");
  const chip = page.locator(".thread-row").filter({ hasText: "Quarterly report" }).locator(".chip", { hasText: "Work" });
  await expect(square("Work")).toHaveClass(/lc-blue/); // the default for "Work"
  await expect(chip).toHaveClass(/lc-blue/);

  await navItem("Work").hover();
  await navItem("Work").getByRole("button", { name: "Options for label Work" }).click();
  await page.getByRole("button", { name: "Teal" }).click();
  await expect(page.locator(".label-options")).toHaveCount(0);
  await expect(square("Work")).toHaveClass(/lc-teal/);
  await expect(square("Projects")).toHaveClass(/lc-teal/); // Work/Projects follows its parent
  await expect(chip).toHaveClass(/lc-teal/);

  await page.reload(); // stored in the archive
  await expect(square("Work")).toHaveClass(/lc-teal/);
  await navItem("Work").hover();
  await navItem("Work").getByRole("button", { name: "Options for label Work" }).click();
  await expect(page.getByRole("button", { name: "Teal" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".label-options")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/all$/); // Esc only closed the menu

  await navItem("Work").hover();
  await navItem("Work").getByRole("button", { name: "Options for label Work" }).click();
  await page.getByRole("button", { name: "Default color" }).click();
  await expect(square("Work")).toHaveClass(/lc-blue/);
  await expect(chip).toHaveClass(/lc-blue/);
  await navItem("Projects").hover();
  await navItem("Projects").getByRole("button", { name: "Options for label Work/Projects" }).click();
  await page.getByRole("button", { name: "Delete label…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText('Delete the label "Work/Projects"?');
  await page.getByRole("button", { name: "Delete label", exact: true }).click();
  await expect(navItem("Projects")).toHaveCount(0);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`label colors: swatch, sidebar square and chip are the same color (${colorScheme})`, async ({ page }) => {
    server = await startServer();
    await page.emulateMedia({ colorScheme });
    await page.goto(server.url + "#/all");
    const work = page.locator(".sidebar .nav-item").filter({ has: page.getByText("Work", { exact: true }) });
    const bg = (l: import("@playwright/test").Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
    await work.hover();
    await work.getByRole("button", { name: "Options for label Work" }).click();
    const swatch = await bg(page.locator(".swatch.current"));
    await page.keyboard.press("Escape");
    const chip = page.locator(".thread-row").filter({ hasText: "Quarterly report" }).locator(".chip", { hasText: "Work" });
    expect(await bg(work.locator(".label-square"))).toBe(swatch);
    expect(await bg(chip)).toBe(swatch);
  });
}

test("the moon button switches dark mode on and off, and the choice is remembered", async ({ page }) => {
  server = await startServer();
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(server.url);
  const moon = page.getByRole("button", { name: "Dark mode" });
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await expect(moon).toHaveAttribute("aria-pressed", "false"); // follows the system at first
  const light = await bodyBg();
  await moon.click();
  await expect(moon).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await bodyBg()).not.toBe(light);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark"); // remembered
  await expect(moon).toHaveAttribute("aria-pressed", "true");
  await moon.click();
  await expect(moon).toHaveAttribute("aria-pressed", "false");
  expect(await bodyBg()).toBe(light);
  await page.emulateMedia({ colorScheme: "dark" }); // a chosen theme ignores the system setting
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("shows image, audio and video attachments, and opens PDFs in a tab", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/label/Media");
  await page.locator(".thread-row", { hasText: "Holiday media" }).filter({ hasNotText: "Fwd" }).click();
  const cards = page.locator(".image-card");
  await expect(cards).toHaveCount(3); // sunset.jpg, beach.png, photo.png (sent as octet-stream); never the SVG
  await expect(cards.locator(".file-name")).toHaveText(["sunset.jpg", "beach.png", "photo.png"]);
  await expect(page.locator(".attachment", { hasText: "drawing.svg" }).locator("img")).toHaveCount(0);

  await cards.first().locator(".thumb").click();
  await expect(page.locator(".lightbox-name")).toHaveText("sunset.jpg");
  await expect(page.locator(".lightbox-meta")).toContainText("1 of 3");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".lightbox-name")).toHaveText("beach.png");
  await page.keyboard.press("Escape");
  await expect(page.locator(".lightbox")).toHaveCount(0);
  await expect(page.locator(".thread-title h1")).toHaveText("Holiday media"); // Esc closed only the lightbox

  await expect(page.locator(".attachment.audio audio")).toHaveCount(1);
  await expect(page.locator(".attachment.video video")).toHaveCount(1);

  const pdf = page.locator(".file-chip", { hasText: "minutes.pdf" });
  await expect(pdf).toHaveAttribute("target", "_blank");
  await expect(pdf).toHaveAttribute("href", /\/api\/attachments\/\d+\/inline$/);
  const res = await page.request.get(server.url + (await pdf.getAttribute("href"))!.slice(1));
  expect(res.headers()["content-type"]).toBe("application/pdf");
  expect(res.headers()["content-disposition"]).toMatch(/^inline;/);
});

test("notes: autosave, saved on leaving and on reload, cleared, read back", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/starred");
  await page.locator(".thread-row", { hasText: "Pancake recipe" }).click();
  const button = page.locator(".note-button");
  await expect(button).not.toHaveClass(/has-note/);
  await button.click();
  const text = page.locator(".note-text");
  await text.fill("Try it with buttermilk.");
  await expect(page.locator(".note-status")).toContainText("Saved");
  await expect(button).toHaveClass(/has-note/);
  await expect(button).toHaveAttribute("title", "Note: Try it with buttermilk.");

  // Reload: the panel stays open and shows the note.
  await page.reload();
  await expect(page.locator(".note-text")).toHaveValue("Try it with buttermilk.");

  // Leave the thread before the 1 s autosave: it saves at once.
  await page.locator(".note-text").fill("Changed, then left at once.");
  await page.locator('button[title="Back to list (u)"]').click();
  await expect(page.locator(".thread-row")).not.toHaveCount(0);
  await page.locator(".thread-row", { hasText: "Pancake recipe" }).click();
  await expect(page.locator(".note-text")).toHaveValue("Changed, then left at once.");

  // Reload right after typing: the keepalive save on pagehide keeps it.
  await page.locator(".note-text").fill("Typed just before the reload.");
  await page.reload();
  await expect(page.locator(".note-text")).toHaveValue("Typed just before the reload.");

  // Clearing the text deletes the note.
  await page.locator(".note-text").fill("");
  await expect(page.locator(".note-status")).toHaveText("Notes are saved automatically.");
  await expect(page.locator(".note-button")).not.toHaveClass(/has-note/);

  // The icon hides the panel.
  await page.locator(".note-button").click();
  await expect(page.locator(".note-panel")).toHaveCount(0);
});

test("notes: a change in another tab shows the conflict choice", async ({ page, context }) => {
  server = await startServer();
  const url = server.url + "#/starred";
  await page.goto(url);
  await page.locator(".thread-row", { hasText: "Pancake recipe" }).click();
  await page.locator(".note-button").click();
  const other = await context.newPage();
  await other.goto(page.url());
  await other.locator(".note-text").fill("From the other tab.");
  await expect(other.locator(".note-status")).toContainText("Saved");

  await page.locator(".note-text").fill("From this tab.");
  await expect(page.locator(".note-conflict")).toContainText("changed in another window");
  await page.getByRole("button", { name: "Use theirs" }).click();
  await expect(page.locator(".note-text")).toHaveValue("From the other tab.");
  await page.locator(".note-text").fill("From this tab, after all.");
  await expect(page.locator(".note-status")).toContainText("Saved");
});

test("notes: the list shows a note icon, and the Notes folder lists the thread", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/starred");
  await expect(page.locator(".nav-item", { hasText: "Notes" })).toHaveCount(0);
  await page.locator(".thread-row", { hasText: "Pancake recipe" }).click();
  await page.locator(".note-button").click();
  await page.locator(".note-text").fill("Ask Bob for the syrup.\nSecond line.");
  await expect(page.locator(".note-status")).toContainText("Saved");
  await page.keyboard.press("Escape"); // blur the text box
  await page.locator('button[title="Back to list (u)"]').click();

  const row = page.locator(".thread-row", { hasText: "Pancake recipe" });
  await expect(row.locator(".note-mark")).toHaveAttribute("title", "Note: Ask Bob for the syrup.");
  await page.locator(".nav-item", { hasText: "Notes" }).click();
  await expect(page).toHaveURL(/#\/notes$/);
  await expect(page.locator(".thread-row .subject")).toHaveText(["Pancake recipe"]);
  await expect(page.locator(".thread-row .note-snippet")).toHaveText(" — Ask Bob for the syrup.");
});

test("search: / focuses the box, results are highlighted, y archives, Back returns", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url);
  await expect(subjects(page)).toHaveCount(5);
  await page.keyboard.press("/");
  await expect(page.locator(".search-box input")).toBeFocused();
  await page.keyboard.type("from:alice has:attachment");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/search\/from%3Aalice%20has%3Aattachment$/);
  await expect(subjects(page)).toHaveText(["Trip planning", "Quarterly report"]);

  await page.locator(".search-box input").fill("lisbon");
  await page.keyboard.press("Enter");
  await expect(subjects(page)).toHaveText(["Trip planning"]);
  await expect(page.locator(".thread-row mark.hl")).toHaveText(["Lisbon"]);
  await page.locator(".thread-row").first().click();
  await expect(page.locator(".plain-body mark.hl")).toHaveText(["Lisbon"]);
  await page.keyboard.press("y"); // Archive, as in Gmail's search results
  await expect(page.locator(".toast")).toContainText("archived");
  await expect(page).toHaveURL(/#\/search\/lisbon$/);
  await expect(subjects(page)).toHaveText(["Trip planning"]); // still matches; it just left the Inbox
  await page.goto(server.url + "#/inbox");
  await expect(subjects(page)).not.toContainText(["Trip planning"]);
});

test("search: highlights inside HTML email, and offers matches in Trash", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/search/" + encodeURIComponent("sale"));
  await page.locator(".thread-row", { hasText: "Big sale" }).click();
  const frame = page.frameLocator(".html-body iframe");
  await expect(frame.locator("mark.hl")).toHaveText(["sale"]);

  await page.goto(server.url + "#/search/coupon");
  await expect(page.locator(".empty-list")).toContainText("No messages matched your search.");
  await page.getByRole("button", { name: "View messages" }).click();
  await expect(page).toHaveURL(/#\/search\/in%3Aanywhere%20coupon$/);
  await expect(subjects(page)).toHaveText(["Old coupon"]);
});

test("search: the ⓘ button shows the search options", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url);
  await page.getByRole("button", { name: "Search options" }).click();
  const dialog = page.getByRole("dialog", { name: "Search options" });
  await expect(dialog).toContainText("has:attachment");
  await expect(dialog).toContainText("note:");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Search options" }).click();
  await page.locator(".search-help .example", { hasText: "is:starred" }).click();
  await expect(subjects(page)).toHaveText(["Pancake recipe"]);
});

test("search: the snippet shows the text around a match deep in a long message", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/search/lighthouse");
  const snippet = page.locator(".thread-row .snippet");
  await expect(snippet).toContainText("the old lighthouse on the cape");
  await expect(snippet.locator("mark.hl")).toHaveText(["lighthouse"]);
});

test("admin: opens from the top bar and with g z; tabs; a top sender runs a search", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url);
  await expect(subjects(page)).toHaveCount(5);
  await page.getByRole("button", { name: "Archive stats" }).click();
  await expect(page).toHaveURL(/#\/admin$/);
  await expect(page.locator(".stat", { hasText: "Messages" }).first().locator(".stat-value")).toHaveText("77");
  await page.getByRole("tab", { name: "Imports" }).click();
  await expect(page).toHaveURL(/#\/admin\/imports$/);
  await expect(page.locator(".admin-table tbody tr")).toHaveCount(1);
  await page.goBack();
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  await page.locator(".admin-table a", { hasText: "news@shop.example" }).click();
  await expect(page).toHaveURL(/#\/search\/from%3Anews%40shop\.example$/);
  await expect(page.locator(".pager")).toContainText("of 56");
  await page.keyboard.press("g");
  await page.keyboard.press("z");
  await expect(page).toHaveURL(/#\/admin$/);
  await page.locator(".admin-table a", { hasText: "Travel/2024" }).click();
  await expect(page).toHaveURL(/#\/label\/Travel%2F2024$/);
});
