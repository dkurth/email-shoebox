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

test("search: the info button shows the search options", async ({ page }) => {
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

test("admin People: tables, group by domain, a person's page, a mailing list", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/admin/people");
  await expect(page.getByRole("tab", { name: "People I sent to" })).toHaveAttribute("aria-selected", "true"); // the first time
  const sentHeaders = page.locator(".people-table thead th");
  await expect(sentHeaders).toHaveText(["Address", "Name", "Total", "To", "Cc", "Bcc", "Last"]);
  await expect(sentHeaders.nth(2)).toHaveAttribute("aria-sort", "descending");
  await page.getByRole("button", { name: "To", exact: true }).click(); // sort by To
  await expect(sentHeaders.nth(3)).toHaveAttribute("aria-sort", "descending");
  await page.getByRole("tab", { name: "People I received from" }).click();
  await expect(page).toHaveURL(/dir=received/);
  await expect(page.locator(".people-table")).toHaveCount(1); // one table at a time, full width
  const received = page.locator(".people-table");
  await expect(received.locator("tbody tr").first()).toContainText("news@shop.example");
  await received.getByRole("textbox").fill("chen");
  await expect(received.locator("tbody tr")).toHaveCount(1);
  await received.locator("a", { hasText: "Carol Chen" }).click();
  await expect(page).toHaveURL(/#\/admin\/person\?addr=carol%40example\.com$/);
  await expect(page.locator(".person-page h1")).toHaveText("Carol Chen");
  await expect(page.getByRole("tab", { name: "People" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Mail you sent them" }).click();
  await expect(subjects(page)).toHaveText(["Question about the invoice"]);

  await page.goto(server.url + "#/admin/people"); // no dir in the URL: the tab used last time
  await expect(page.getByRole("tab", { name: "People I received from" })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Group by domain").click(); // the URL changes, then the box shows the change
  await expect(page.getByLabel("Group by domain")).toBeChecked();
  await expect(page).toHaveURL(/domain=1/);
  const rows = page.locator(".people-table tbody tr");
  await expect(rows.first()).toContainText("@shop.example");
  await expect(rows.filter({ hasText: "@example.com" })).toContainText("3 addresses");
  await page.locator("section", { hasText: "Mailing lists" }).locator("a", { hasText: "Hike Club Announcements" }).click();
  await expect(subjects(page)).toHaveText(["Trail report", "Saturday hike"]);
});

test("admin Attachments: summary, biggest first, filters, preview, open email", async ({ page }) => {
  server = await startServer();
  await page.setViewportSize({ width: 1280, height: 480 }); // the list starts below the fold
  await page.goto(server.url + "#/admin/attachments");
  await expect(page.locator(".summary-total")).toContainText("14 attachments");
  const rows = page.locator(".admin-table.report tbody tr");
  await expect(rows.first()).toContainText("voice-memo.mp3");
  await page.locator(".attachment-summary a", { hasText: "Images" }).click();
  await expect(page).toHaveURL(/type=Images/);
  await expect(rows).toHaveCount(6);
  // The click brings the list into view, and the summary marks what it is filtered by.
  await expect(page.getByRole("heading", { name: "All attachments" })).toBeInViewport();
  await expect(page.locator(".attachment-summary tr.picked")).toContainText("Images");
  await rows.filter({ hasText: "beach.png" }).getByRole("button", { name: "Preview" }).click();
  await expect(page.locator(".lightbox-name")).toHaveText("beach.png");
  await expect(page.locator(".lightbox-details")).toContainText("Holiday media");
  await page.keyboard.press("Escape");
  await page.getByLabel("Larger than (MB)").fill("0.0002");
  await page.getByLabel("Larger than (MB)").press("Enter");
  await expect(page).toHaveURL(/min=210/);
  await expect(rows).toHaveCount(2); // sunset.jpg twice (242 B)
  await page.getByRole("button", { name: "Show types" }).first().click(); // page state not kept in the URL
  const scrolled = await page.locator(".admin-body").evaluate((e) => (e.scrollTop = e.scrollHeight, e.scrollTop));
  expect(scrolled).toBeGreaterThan(0);
  await rows.first().getByRole("link", { name: "Open email" }).click();
  await expect(page.locator(".thread-title h1")).toHaveText(/Holiday media/);
  // Back returns to the report as it was: filters, scroll position, expanded rows.
  await page.getByTitle("Back to Archive stats (u)").click();
  await expect(page).toHaveURL(/#\/admin\/attachments\?type=Images&min=210/);
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Hide types" })).toHaveCount(1);
  expect(await page.locator(".admin-body").evaluate((e) => e.scrollTop)).toBe(scrolled);
  // u does the same, and a list view's Back still goes to the list.
  await rows.first().getByRole("link", { name: "Open email" }).click();
  await expect(page.locator(".thread-title h1")).toHaveText(/Holiday media/);
  await page.keyboard.press("u");
  await expect(page).toHaveURL(/#\/admin\/attachments\?type=Images&min=210/);
  await page.goto(server.url + "#/inbox");
  await page.keyboard.press("Enter");
  await page.getByTitle("Back to list (u)").click();
  await expect(page).toHaveURL(/#\/inbox$/);
});

test("deleting attachments: from a message, then from the report", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/label/Media");
  await page.locator(".thread-row", { hasText: "Holiday media" }).filter({ hasNotText: "Fwd" }).click();
  const pdf = page.locator(".attachment", { hasText: "minutes.pdf" });
  await pdf.hover();
  await pdf.getByRole("button", { name: "Delete minutes.pdf" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText('Delete "minutes.pdf" (392 B) from the archive? The email will be kept.');
  await dialog.getByRole("button", { name: "Delete attachment" }).click();
  await expect(page.locator(".toast")).toContainText("Attachment deleted.");
  const deleted = page.locator(".file-chip.deleted", { hasText: "minutes.pdf" });
  await expect(deleted).toContainText("(deleted)");
  await deleted.click();
  await expect(page.getByRole("alertdialog")).toContainText("The attached file was deleted from the archive, but the email thread was preserved.");
  await page.getByRole("button", { name: "OK" }).click();

  await page.goto(server.url + "#/admin/attachments");
  const rows = page.locator(".admin-table.report tbody tr");
  await expect(rows.first()).toContainText("voice-memo.mp3");
  await rows.first().getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete attachment" }).click();
  await expect(page.locator(".info-banner")).toContainText("1 attachment deleted");
  await expect(rows.first()).toContainText("clip.mp4");
});

test("read-only: no delete buttons", async ({ page }) => {
  server = await startServer({ readOnly: true });
  await page.goto(server.url + "#/label/Media");
  await page.locator(".thread-row", { hasText: "Holiday media" }).filter({ hasNotText: "Fwd" }).click();
  await expect(page.locator(".image-card")).toHaveCount(3);
  await expect(page.locator(".attachment-delete")).toHaveCount(0);
  await page.goto(server.url + "#/admin/attachments");
  await expect(page.locator(".admin-table.report tbody tr").first()).toContainText("voice-memo.mp3");
  await expect(page.locator(".admin-table.report").getByRole("button", { name: "Delete" })).toHaveCount(0);
});

test("deleting many: checkboxes in the report, the page checkbox, a whole thread", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/admin/attachments");
  const rows = page.locator(".admin-table.report tbody tr");
  await rows.filter({ hasText: "report.xlsx" }).getByRole("checkbox").check();
  await rows.filter({ hasText: "itinerary.pdf" }).getByRole("checkbox").check();
  await page.getByRole("button", { name: /Delete selected \(2 files, 22 B\)/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Delete 2 attachments (22 B)");
  await expect(dialog.locator(".confirm-list li")).toHaveText(["itinerary.pdf", "report.xlsx"]);
  await dialog.getByRole("button", { name: "Delete 2 attachments" }).click();
  await expect(page.locator(".info-banner")).toContainText("2 attachments deleted");
  await expect(rows.filter({ hasText: "report.xlsx" })).toHaveCount(0);

  // The page checkbox. ("Select all N that match" needs more than one page of attachments;
  // server.attachmentDelete.test.ts covers deleting by filter.)
  await page.goto(server.url + "#/admin/attachments?type=Images");
  await page.getByLabel("Select every attachment on this page").check();
  await page.getByRole("button", { name: /Delete selected \(6 files/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete 6 attachments" }).click();
  await expect(page.locator(".report-bar")).toContainText("No attachments match.");

  await page.goto(server.url + "#/label/Media");
  await page.locator(".thread-row", { hasText: "Holiday media" }).filter({ hasNotText: "Fwd" }).click();
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: /Delete all attachments/ }).click();
  const d2 = page.getByRole("alertdialog", { name: "Delete attachments" });
  await expect(d2).toContainText("Delete 4 attachments");
  await d2.getByRole("button", { name: "Delete attachments" }).click();
  await expect(page.locator(".toast")).toContainText("4 attachments deleted.");
  await expect(page.locator(".file-chip.deleted")).toHaveCount(8);
  await expect(page.getByRole("button", { name: "More" })).toHaveCount(0);
});

test("delete all in a thread can include images inside the email text", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/inbox");
  await page.locator(".thread-row", { hasText: "Big sale" }).click();
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: /Delete all attachments/ }).click();
  const d = page.getByRole("alertdialog", { name: "Delete attachments" });
  await expect(d.getByRole("button", { name: "Delete attachments" })).toBeDisabled(); // only the logo, inside the text
  await d.getByRole("checkbox").check();
  await expect(d).toContainText("Delete 1 attachment (70 B)");
  await d.getByRole("button", { name: "Delete attachments" }).click();
  await expect(page.locator(".toast")).toContainText("1 attachment deleted.");
  await expect(page.frameLocator(".html-body iframe").locator('img[alt="logo"]')).toHaveAttribute("src", /^data:image\/svg\+xml/);
});

test("duplicates: the badge, Duplicates only, Show copies, Delete all copies", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/admin/attachments");
  const rows = page.locator(".admin-table.report tbody tr");
  await rows.filter({ hasText: "sunset.jpg" }).first().getByRole("button", { name: "2 copies" }).click();
  await expect(page).toHaveURL(/dupes=1/);
  await expect(page).toHaveURL(/sha256=/);
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "Show all duplicates" }).click();
  await expect(page.locator(".dupe-banner")).toContainText("2 files are stored more than once");
  const group = page.locator(".admin-table.report tbody").filter({ hasText: "sunset.jpg" });
  await group.getByRole("button", { name: "Show copies" }).click();
  await expect(group.locator(".copy-row")).toHaveCount(2);
  await group.getByRole("button", { name: "Delete all copies" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Delete 2 attachments (484 B)");
  await expect(dialog.locator(".confirm-list li")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Delete 2 attachments" }).click();
  await expect(page.locator(".info-banner")).toContainText("2 attachments deleted");
  await expect(page.locator(".dupe-banner")).toContainText("1 file is stored more than once");
});

test("duplicates: Merge duplicate files shows progress and the space freed", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/admin/attachments?dupes=1");
  await page.getByRole("button", { name: "Merge duplicate files" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("rsync -aH");
  await dialog.getByRole("button", { name: "Merge duplicate files" }).click();
  await expect(page.locator(".job-result")).toContainText("Done: 382 B freed.");
  // The files stay listed as duplicates (each email still has its attachment).
  await expect(page.locator(".dupe-banner")).toContainText("2 files are stored more than once");
});

test("Images tab: the grid, the lightbox moves between images, Delete removes one", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/admin/images");
  await expect(page.locator(".pager")).toContainText("No images match."); // every test image is under 20 KB
  await page.getByLabel("Hide images under 20 KB").click();
  await expect(page.locator(".gallery li")).toHaveCount(3);
  await expect(page.locator(".gallery-footer .pager")).toContainText("1–3 of 3"); // the same pager below the grid
  await page.locator(".gallery .tile").first().click();
  await expect(page.locator(".lightbox-name")).toHaveText("coupon.png");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".lightbox-name")).toHaveText("sunset.jpg");
  await expect(page.locator(".lightbox-details")).toContainText("Fwd: Holiday media");
  await page.locator(".lightbox-top").getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete attachment" }).click();
  await expect(page.locator(".lightbox-name")).toHaveText("beach.png"); // the next image
  await page.keyboard.press("Escape");
  await expect(page.locator(".gallery li")).toHaveCount(3); // the other sunset.jpg copy shows now
});

test("Maintenance: Compact database runs and reports the sizes", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/admin/maintenance");
  await expect(page.locator(".maintenance")).toContainText("free space inside it");
  await page.getByRole("button", { name: "Compact database" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Compact" }).click();
  await expect(page.locator(".job-result")).toContainText("Done:");
});

test("deleting an attachment leaves the open messages as they are", async ({ page }) => {
  server = await startServer();
  await page.goto(server.url + "#/label/Work");
  await page.locator(".thread-row", { hasText: "Quarterly report" }).click();
  // Two messages: the first (with the attachments) is read, so it starts collapsed. Open it.
  await page.locator(".msg.collapsed").first().click();
  await expect(page.locator(".msg.expanded")).toHaveCount(2);
  const xlsx = page.locator(".attachment", { hasText: "report.xlsx" });
  await xlsx.hover();
  await xlsx.getByRole("button", { name: "Delete report.xlsx" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete attachment" }).click();
  await expect(page.locator(".file-chip.deleted", { hasText: "report.xlsx" })).toContainText("(deleted)");
  await expect(page.locator(".msg.expanded")).toHaveCount(2); // still open
});
