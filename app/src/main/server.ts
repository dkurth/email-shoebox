// The viewer's HTTP server, inside the app. It listens on 127.0.0.1 on a free port and serves one collection
// at a time; opening another collection swaps in a new viewer app (the old archive is closed).
import { serve, type ServerType } from "@hono/node-server";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp, type WorkerName } from "../../../viewer/server/app.ts";
import { accountAddresses, openArchive, type Archive } from "../../../viewer/server/db.ts";
import { runningJob } from "../../../viewer/server/jobs.ts";
import type { Collection } from "../shared/api.ts";

export class SwitchError extends Error {}

export interface ServerOptions {
  staticDir: string; // the built viewer front end
  workerUrl?: (name: WorkerName) => URL;
}

export class ViewerServer {
  readonly token = crypto.randomBytes(32).toString("hex");
  port = 0;
  private server: ServerType | null = null;
  private current: { id: string; archive: Archive; fetch: (req: Request) => Response | Promise<Response> } | null = null;

  private opts: ServerOptions;

  constructor(opts: ServerOptions) {
    this.opts = opts;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get currentId(): string | null {
    return this.current?.id ?? null;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = serve({ fetch: (req) => this.fetch(req), hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) => {
        this.port = info.port;
        resolve(info.port);
      });
      server.once("error", reject);
      this.server = server;
    });
  }

  private fetch(req: Request): Response | Promise<Response> {
    if (!this.current) return new Response("No collection is open.", { status: 503 });
    return this.current.fetch(req);
  }

  /**
   * Serve this collection from now on. Throws (and keeps the old one) if a maintenance job is running or the
   * archive can't be opened.
   */
  open(c: Collection): void {
    const job = runningJob();
    if (job && this.current) {
      throw new SwitchError(
        `${job === "compact" ? "Compact database" : "Merge duplicate files"} is running in this collection. Wait for it to finish, then switch.`,
      );
    }
    const archive = openArchive(c.path);
    const app = createApp({
      archive,
      me: accountAddresses(archive),
      getPort: () => this.port,
      staticDir: this.opts.staticDir,
      token: this.token,
      collectionName: c.name,
      workerUrl: this.opts.workerUrl,
    });
    const old = this.current;
    this.current = { id: c.id, archive, fetch: app.fetch };
    old?.archive.db.close();
  }

  /** Stop serving the current collection (before deleting it, or when the last one is removed). */
  closeCollection(): void {
    const old = this.current;
    this.current = null;
    old?.archive.db.close();
  }

  stop(): void {
    this.closeCollection();
    this.server?.close();
  }
}
