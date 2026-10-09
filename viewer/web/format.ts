import type { Address, Participant } from "../shared/types.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Gmail list dates: time today, "Mar 4" this year, "3/4/19" before. */
export function listDate(epoch: number | null, now = new Date()): string {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

export function fullDate(epoch: number | null): string {
  if (!epoch) return "";
  return new Date(epoch * 1000).toLocaleString([], { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function relative(epoch: number | null, now = Date.now()): string {
  if (!epoch) return "";
  const s = Math.round(now / 1000 - epoch);
  const units: [number, string][] = [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [n, name] of units) {
    if (s >= n) {
      const v = Math.floor(s / n);
      return `${v} ${name}${v === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Gmail's participant list: up to 3 names, else "first .. last two". */
export function participantParts(ps: Participant[]): (Participant | "..")[] {
  if (ps.length <= 3) return ps;
  return [ps[0], "..", ps[ps.length - 2], ps[ps.length - 1]];
}

export function displayName(a: Address, me: string[]): string {
  if (me.includes(a.addr)) return "me";
  return a.name || a.addr;
}

/** "to me, Bob, +2" */
export function recipientsLine(to: Address[], cc: Address[], bcc: Address[], me: string[]): string {
  const all = [...to, ...cc, ...bcc];
  if (!all.length) return "to (no recipients)";
  const names = all.map((a) => (me.includes(a.addr) ? "me" : a.name ? a.name.split(/\s+/)[0] : a.addr));
  const shown = names.slice(0, 3).join(", ");
  return `to ${shown}${names.length > 3 ? `, +${names.length - 3}` : ""}`;
}
