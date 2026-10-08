import { readFile, writeFile, rename, mkdir, appendFile, readdir, rm, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { loadConfig, pairsFor, syncPair, listEvents, providerUrlPolicy } from "../dist/index.js";

const configPath = resolve(process.argv[2] ?? "");
const dryRun = process.argv.includes("--dry");
if (!process.argv[2] || process.env.CALENDAR_SYNC_LOCKED !== "1")
  throw Error("Run through scripts/run-local.py <private-config.json> [--dry]");
const dir = dirname(configPath);
const config = loadConfig(JSON.parse(await readFile(configPath, "utf8")));
if (!config.window.allEvents || config.dedupe) throw Error("Local runner requires allEvents and no AI deduplication");
const pairs = pairsFor(config, {
  allowUrl: (url) => providerUrlPolicy("google")(url) || providerUrlPolicy("icloud")(url),
});
if (!pairs.length) throw Error("No configured calendar pairs");
const urls = new Set();
for (const pair of pairs) {
  if (!/^[A-Za-z0-9_-]+$/.test(pair.name) || !pair.existingLinks || pair.protectInvitations !== true)
    throw Error("Each local pair needs a safe name, existingLinks and protectInvitations enabled");
  for (const side of [pair.a, pair.b]) {
    if (urls.has(side.url)) throw Error("A calendar cannot be used in multiple pairs");
    if (!providerUrlPolicy(side.id)(new URL(side.url))) throw Error("Unexpected provider calendar URL");
    urls.add(side.url);
  }
}
const atomicJson = async (path, data) => {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(data, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};
const runId = new Date().toISOString().replaceAll(":", "-");
const runDir = join(dir, "runs", runId);
await mkdir(runDir, { recursive: true, mode: 0o700 });
const journal = async (notice) =>
  appendFile(join(runDir, "actions.jsonl"), JSON.stringify({ time: new Date().toISOString(), ...notice }) + "\n", {
    mode: 0o600,
  });
const reports = [];
try {
  for (const pair of pairs) {
    const storePath = join(dir, `${pair.name}.links.json`);
    const linkStore = {
      load: async () => JSON.parse(await readFile(storePath, "utf8")),
      save: (state) => atomicJson(storePath, state),
    };
    await linkStore.load();
    if (!dryRun) {
      const snapshots = await Promise.all(
        [pair.a, pair.b].map(async (side) => ({ url: side.url, events: await listEvents(side.auth, side.url) })),
      );
      await writeFile(join(runDir, `${pair.name}.before.json.gz`), gzipSync(JSON.stringify(snapshots)), {
        mode: 0o600,
        flag: "wx",
      });
      await writeFile(join(runDir, `${pair.name}.links.before.json`), JSON.stringify(await linkStore.load()), {
        mode: 0o600,
        flag: "wx",
      });
    }
    const result = await syncPair(pair, undefined, {
      linkStore,
      dryRun,
      signal: AbortSignal.timeout(45 * 60_000),
      beforeAction: (notice) => journal({ phase: "before", ...notice }),
      onAction: (notice) => journal({ phase: "after", ...notice }),
    });
    await atomicJson(join(runDir, `${pair.name}.result.json`), result);
    reports.push({
      pair: pair.name,
      a: result.a,
      b: result.b,
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
      skipped: result.skipped,
      errors: result.errors.length,
      warnings: result.warnings,
      planned: result.actions?.length,
      linkedPlanned: result.linkedActions?.length,
    });
    console.log(JSON.stringify(reports.at(-1)));
    if (result.errors.length) throw Error(`Calendar pair ${pair.name} had write errors; inspect private run records`);
  }
  await atomicJson(join(dir, dryRun ? "last-dry-run.json" : "last-run.json"), {
    time: new Date().toISOString(),
    ok: true,
    reports,
    runDir,
  });
  // Retain a week of rolling recovery snapshots; the initial backup is separate.
  for (const name of await readdir(join(dir, "runs"))) {
    const date = Date.parse(name.replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3"));
    if (Number.isFinite(date) && date < Date.now() - 7 * 86400_000)
      await rm(join(dir, "runs", name), { recursive: true });
  }
} catch (error) {
  await atomicJson(join(dir, dryRun ? "last-dry-run.json" : "last-run.json"), {
    time: new Date().toISOString(),
    ok: false,
    message: error.message,
    reports,
    runDir,
  });
  console.error("Sync stopped; inspect private last-run/run records. No retry from stale state.");
  process.exitCode = 1;
}
