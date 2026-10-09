import { describe, expect, it } from "vitest";
import { preview, previewKind } from "../shared/preview.ts";

describe("previewKind", () => {
  it("knows images, audio, video, PDF and text", () => {
    expect(previewKind("image/jpeg", "a.jpg")).toBe("image");
    expect(previewKind("image/PJPEG", null)).toBe("image");
    expect(previewKind("audio/mpeg", "a.mp3")).toBe("audio");
    expect(previewKind("audio/x-m4a", null)).toBe("audio");
    expect(previewKind("video/quicktime", "a.mov")).toBe("video");
    expect(previewKind("application/pdf", "a.pdf")).toBe("pdf");
    expect(previewKind("text/plain; charset=utf-8", "a.txt")).toBe("text");
    expect(previewKind("text/csv", "a.csv")).toBe("text");
  });

  it("normalizes odd type names", () => {
    expect(preview("image/jpg", null)!.type).toBe("image/jpeg");
    expect(preview("audio/mp3", null)!.type).toBe("audio/mpeg");
    expect(preview("text/csv", null)!.type).toBe("text/plain; charset=utf-8");
  });

  it("uses the file extension when the type is missing or octet-stream", () => {
    expect(preview("application/octet-stream", "Photo.JPG")).toEqual({ kind: "image", type: "image/jpeg" });
    expect(preview(null, "song.m4a")).toEqual({ kind: "audio", type: "audio/mp4" });
    expect(preview("", "notes.log")!.kind).toBe("text");
    expect(previewKind("application/octet-stream", "setup.exe")).toBeNull();
  });

  it("never previews SVG, HTML, XML or attached emails", () => {
    for (const t of ["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "message/rfc822", "image/tiff", "video/x-ms-wmv"]) {
      expect(previewKind(t, null)).toBeNull();
    }
    expect(previewKind("application/octet-stream", "x.svg")).toBeNull();
    expect(previewKind("application/octet-stream", "x.html")).toBeNull();
    expect(previewKind("text/html", "x.txt")).toBeNull(); // a declared type wins over the extension
  });
});
