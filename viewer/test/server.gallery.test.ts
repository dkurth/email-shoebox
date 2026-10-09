import { describe, expect, it } from "vitest";
import type { GalleryPage } from "../shared/types.ts";
import { setup } from "./helpers.ts";

const gal = async (ctx: ReturnType<typeof setup>, qs: string) => (await ctx.get(`/api/admin/images?${qs}`)).body as GalleryPage;

describe("image gallery", () => {
  it("hides small images by default (the test images are all small)", async () => {
    const ctx = setup();
    expect((await gal(ctx, "")).total).toBe(0);
  });

  it("shows only images, newest first, one per file content, never SVG", async () => {
    const ctx = setup();
    const g = await gal(ctx, "small=1");
    // sunset.jpg (two copies → one), beach.png, and the 1×1 PNG (photo.png = coupon.png: the newer one shows)
    expect(g.images.map((i) => i.filename)).toEqual(["coupon.png", "sunset.jpg", "beach.png"]);
    expect(g.images[0].subject).toBe("Old coupon");
    const sunset = g.images.find((i) => i.filename === "sunset.jpg")!;
    expect(sunset.subject).toBe("Fwd: Holiday media"); // the newest copy
    expect(g.images.map((i) => i.filename)).not.toContain("drawing.svg");
    expect(g.years).toEqual([2024]);
    expect(g.senders).toContain("carol@example.com");
  });

  it("filters by sender and year", async () => {
    const ctx = setup();
    expect((await gal(ctx, "small=1&from=carol@example.com")).images.map((i) => i.filename).sort()).toEqual(["beach.png", "photo.png", "sunset.jpg"]);
    expect((await gal(ctx, "small=1&year=2023")).total).toBe(0);
    expect((await gal(ctx, "small=1&year=2024")).total).toBe(3);
    expect((await ctx.get("/api/admin/images?year=24")).status).toBe(400);
  });

  it("leaves out deleted images", async () => {
    const ctx = setup();
    ctx.db.prepare("UPDATE attachments SET deleted_at = 1 WHERE filename = 'beach.png'").run();
    expect((await gal(ctx, "small=1")).images.map((i) => i.filename)).not.toContain("beach.png");
  });
});
