// A framework-free HTTP handler: (Request) => Response. Drop it into a Next.js
// route, a Cloudflare Worker, Bun.serve, Deno, or anything else that speaks
// the Fetch API. Point a cron at it every few minutes.
//
//   GET /?dry=1        plan only, return the actions, write nothing
//   GET /?pair=<name>  just one pair
//
// Auth: `Authorization: Bearer <secret>` or `x-api-key: <secret>`.

import { pairsFor, type Config } from "./config.js";
import { syncPair, window, type PairResult, type SyncOptions } from "./sync.js";

import { ActionObserverError } from "./execution.js";
import type { DeleteOptions } from "./consolidate.js";

export type HandlerOptions = Omit<SyncOptions, "dryRun"> & {
  onDelete?: DeleteOptions["onDelete"];
  config: Config;
  secret?: string;
  authorize?: (req: Request) => boolean | Response | Promise<boolean | Response>;
};

export function createHandler({
  config,
  secret,
  authorize,
  onDelete,
  signal,
  allowUrl,
  beforeAction,
  onAction,
}: HandlerOptions): (req: Request) => Promise<Response> {
  if (!secret && !authorize) throw new Error("createHandler: a secret or authorize hook is required");
  const handle = async (req: Request): Promise<Response> => {
    if (authorize) {
      const allowed = await authorize(req);
      if (allowed instanceof Response) return allowed;
      if (allowed !== true) return json({ error: "unauthorized" }, 401);
    } else {
      const auth = req.headers.get("authorization");
      const key = req.headers.get("x-api-key");
      if (auth !== `Bearer ${secret}` && key !== secret) return json({ error: "unauthorized" }, 401);
    }

    const options = {
      signal: AbortSignal.any([req.signal, ...(signal ? [signal] : [])]),
      allowUrl,
      beforeAction,
      onAction,
    };
    const url = new URL(req.url);
    const only = url.searchParams.get("pair");
    const dryRun = url.searchParams.get("dry") === "1";
    if (url.searchParams.get("review") === "1") {
      if (only || dryRun) return json({ error: "review cannot be combined with pair or dry" }, 400);
      if (!config.dedupe) return json({ error: "Configure dedupe before running review" }, 400);
      try {
        const { reviewDuplicates } = await import("./dedupe.js");
        const review = await reviewDuplicates(config, options);
        const ok = !review.errors.length && !review.unavailable && !review.truncated;
        return json({ ok, review }, ok ? 200 : 502);
      } catch {
        return json({ error: "Duplicate review failed; no calendar writes were attempted" }, 502);
      }
    }

    let pairs;
    try {
      pairs = pairsFor(config, options);
    } catch (e) {
      return json({ error: message(e) }, 500);
    }
    const selected = only ? pairs.filter((p) => p.name === only) : pairs;
    if (!selected.length) return json({ error: "no calendar pairs configured" }, 400);

    const win = config.window.allEvents ? undefined : window(config.window.pastDays, config.window.futureDays);
    const results: PairResult[] = [];
    for (const pair of selected) {
      try {
        results.push(await syncPair(pair, win, { ...options, dryRun }));
      } catch (e) {
        if (e instanceof ActionObserverError || options.signal.aborted)
          return json(
            { ok: false, results, error: "Sync interrupted; reconcile action outcomes before retrying" },
            502,
          );
        results.push({
          pair: pair.name,
          a: 0,
          b: 0,
          created: 0,
          updated: 0,
          deleted: 0,
          skipped: 0,
          errors: [message(e)],
        });
      }
    }
    let failed = results.some((r) => r.errors.length);
    let consolidation;
    if (!failed && !dryRun && !only && config.dedupe?.rules.some((r) => r.mode === "delete")) {
      try {
        const { consolidateDuplicates } = await import("./consolidate.js");
        consolidation = await consolidateDuplicates(config, { ...options, onDelete });
        failed = consolidation.incomplete || consolidation.results.some((r) => r.status === "failed");
      } catch {
        return json({ ok: false, results, error: "Consolidation failed; inspect calendars before retrying" }, 502);
      }
    }
    return json(
      {
        ok: !failed,
        dryRun,
        window: win ? { start: win.start.toISOString(), end: win.end.toISOString() } : null,
        results,
        ...(consolidation ? { consolidation } : {}),
      },
      failed ? 502 : 200,
    );
  };
  let running = false;
  return async (req) => {
    if (running) return json({ error: "Calendar run already active" }, 409);
    running = true;
    try {
      return await handle(req);
    } finally {
      running = false;
    }
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
