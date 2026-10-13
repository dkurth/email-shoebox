// Stop other websites (and DNS-rebinding tricks) from talking to this local server.
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { timingSafeEqual } from "node:crypto";

export const WRITE_HEADER = "x-email-shoebox";

/** The desktop app sets this cookie in its window. With a token, every request (reads too) must carry it,
 *  so other programs on this computer can't read the mail. */
export const TOKEN_COOKIE = "shoebox_token";

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function guard(getPort: () => number, readOnly: boolean, extraOrigins: string[] = [], token?: string): MiddlewareHandler {
  return async (c, next) => {
    const port = getPort();
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const host = c.req.header("host") ?? "";
    if (!allowedHosts.includes(host)) {
      return c.text("Forbidden host", 403);
    }
    if (token !== undefined && !sameText(getCookie(c, TOKEN_COOKIE) ?? "", token)) {
      return c.text("Forbidden", 403);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin") ?? "";
      const allowedOrigins = [...allowedHosts.map((h) => `http://${h}`), ...extraOrigins];
      if (!allowedOrigins.includes(origin)) {
        return c.json({ error: "Forbidden origin" }, 403);
      }
      if (c.req.header(WRITE_HEADER) !== "1") {
        return c.json({ error: "Missing request header" }, 403);
      }
      if (readOnly) {
        return c.json({ error: "The viewer was started with --read-only" }, 403);
      }
    }
    await next();
  };
}
