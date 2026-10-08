import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(mode: "failure" | "deadline") {
  const root = mkdtempSync(join(tmpdir(), "calendar-runner-test-"));
  roots.push(root);
  for (const dir of ["scripts", "dist", "private/runs/2001-01-01T00-00-00.000Z", "private/backups"])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "private/backups/initial.json"), "{}");
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "scripts/run-local.mjs"), readFileSync("scripts/run-local.mjs"));
  writeFileSync(
    join(root, "dist/index.js"),
    `export const loadConfig = x => x;
export const pairsFor = x => x.pairs;
export const providerUrlPolicy = () => () => true;
export const googleCalendarRestPolicy = () => true;
export const listEvents = async () => [];
export const syncPair = async () => {
  ${mode === "failure" ? 'throw Error("Synthetic provider failure");' : "globalThis.expireDeadline();"}
  return {a:0,b:0,created:0,updated:0,deleted:0,skipped:0,errors:[]};
};`,
  );
  writeFileSync(
    join(root, "deadline.mjs"),
    `const controller = new AbortController();
globalThis.expireDeadline = () => controller.abort(new DOMException("Run deadline exceeded", "TimeoutError"));
AbortSignal.timeout = () => controller.signal;`,
  );
  const pairs = ["First", "Second"].map((name) => ({
    name,
    existingLinks: true,
    protectInvitations: true,
    a: { id: "google", url: `https://google.test/${name}` },
    b: { id: "icloud", url: `https://icloud.test/${name}` },
  }));
  writeFileSync(join(root, "private/config.json"), JSON.stringify({ window: { allEvents: true }, pairs }));
  for (const { name } of pairs) writeFileSync(join(root, `private/${name}.links.json`), "{}");
  const args = [
    "--import",
    join(root, "deadline.mjs"),
    join(root, "scripts/run-local.mjs"),
    join(root, "private/config.json"),
  ];
  const run = spawnSync(process.execPath, args, {
    env: { ...process.env, CALENDAR_SYNC_LOCKED: "1" },
    encoding: "utf8",
  });
  const result = JSON.parse(readFileSync(join(root, "private/last-run.json"), "utf8"));
  return { root, run, result };
}

it("records a failed run and prunes expired snapshots while retaining current and initial backups", () => {
  const { root, run, result } = fixture("failure");
  expect(run.status).toBe(1);
  expect(result).toMatchObject({ ok: false, message: "Synthetic provider failure" });
  expect(readdirSync(join(root, "private/runs"))).toHaveLength(1);
  expect(readdirSync(result.runDir)).toContain("First.before.json.gz");
  expect(readFileSync(join(root, "private/backups/initial.json"), "utf8")).toBe("{}");
});

it("records expiration of the overall deadline before starting another calendar pair", () => {
  const { run, result } = fixture("deadline");
  expect(run.status).toBe(1);
  expect(result).toMatchObject({ ok: false, message: "Run deadline exceeded" });
  expect(result.reports).toHaveLength(1);
  expect(readdirSync(result.runDir)).toContain("First.before.json.gz");
  expect(readdirSync(result.runDir)).not.toContain("Second.before.json.gz");
});
