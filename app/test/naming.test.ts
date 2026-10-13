import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultName, nameFromPaths } from "../src/main/naming.ts";

const y = (year: number) => Date.UTC(year, 5, 1) / 1000;

describe("default collection names", () => {
  it("uses the owner's address and the years", () => {
    expect(defaultName({ owner: "me@example.com", first_date: y(2004), last_date: y(2024) }, [])).toBe("me@example.com (2004–2024)");
    expect(defaultName({ owner: "me@example.com", first_date: y(2024), last_date: y(2024) }, [])).toBe("me@example.com (2024)");
    expect(defaultName({ owner: "me@example.com", first_date: null, last_date: null }, [])).toBe("me@example.com");
  });

  it("falls back to the folder or file name", () => {
    const p = path.posix;
    const name = (x: string[]) => nameFromPaths(x, p, "/Users/me");
    expect(name(["/Users/me/Downloads/Firebrand-takeout-small-20261008"])).toBe("Firebrand takeout small 20261008");
    expect(name(["/Users/me/Downloads/takeout-20240425T000000Z-001.zip"])).toBe("takeout 20240425T000000Z 001");
    expect(name(["/Users/me/Downloads/personal_backup.mbox"])).toBe("personal backup");
    expect(name(["/Users/me/Personal 2024/Takeout/Mail/Inbox.mbox"])).toBe("Personal 2024");
    expect(name(["/Users/me/Work/All mail Including Spam and Trash-002.mbox"])).toBe("Work");
    expect(name(["/Users/me/Work/Mail/Inbox.mbox", "/Users/me/Work/Mail/Sent.mbox"])).toBe("Work");
    expect(name(["/Users/me/Downloads/Takeout"])).toBe("Mail"); // not "me"
    expect(name(["/Inbox.mbox"])).toBe("Mail");
    expect(name([])).toBe("Mail");
    expect(defaultName({ owner: null, first_date: null, last_date: null }, ["/x/Work mail/Inbox.mbox"])).toBe("Work mail");
  });
});
