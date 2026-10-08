#!/usr/bin/env node
// icloud-google-calendar-sync: the command line.
//
//   auth google        mint a Google refresh token with your own Desktop OAuth client
//   discover icloud    list iCloud calendar collection URLs (for the config file)
//   discover google    list Google calendar ids
//   sync [--dry] [--pair NAME]   run the mirror once
//
// Config: --config <path> (default ./mirror.config.json if present), plus env.

import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { calendarHome, currentUserPrincipal, ICLOUD_BASE, listCalendars } from "./caldav.js";
import { authsFor, loadConfig, pairsFor, type Config } from "./config.js";
import { googleAccessToken } from "./google.js";
import { syncPair, window } from "./sync.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);

function readConfig(): Config {
  const path = flag("--config") ?? (existsSync("mirror.config.json") ? "mirror.config.json" : null);
  const file = path ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : null;
  return loadConfig(file);
}

async function discoverIcloud(config: Config): Promise<void> {
  const { icloud } = authsFor(config);
  if (!icloud) throw new Error("icloud username / appPassword missing");
  const principal = await currentUserPrincipal(icloud, ICLOUD_BASE);
  const home = await calendarHome(icloud, principal);
  const cals = await listCalendars(icloud, home);
  console.log(`# ${cals.length} collection(s) under ${home}`);
  for (const c of cals) {
    const tag = c.shared ? " (shared)" : "";
    console.log(`${JSON.stringify(c.name)}${tag}\n  icloud:${c.href}`);
  }
}

async function discoverGoogle(config: Config): Promise<void> {
  if (!config.google) throw new Error("google credentials missing");
  const token = await googleAccessToken(config.google);
  const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as {
    items?: { id: string; summary: string; accessRole: string; primary?: boolean }[];
    error?: unknown;
  };
  if (!res.ok || !body.items) throw new Error(`calendarList failed: ${JSON.stringify(body.error ?? body)}`);
  for (const c of body.items) {
    console.log(`${JSON.stringify(c.summary)} (${c.accessRole}${c.primary ? ", primary" : ""})\n  google:${c.id}`);
  }
}

/** Loopback OAuth flow for a Desktop-type client. Prints a refresh token. */
async function authGoogle(): Promise<void> {
  const clientId = flag("--client-id") ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = flag("--client-secret") ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "need --client-id and --client-secret (a Desktop OAuth client from console.cloud.google.com, with the Calendar API and CalDAV API enabled)",
    );
  }
  const port = Number(flag("--port") ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid callback port");
  const redirect = `http://127.0.0.1:${port}/`;
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar",
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
  console.log("Open this in a browser and approve:\n\n  " + url + "\n");
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const q = new URL(req.url ?? "/", redirect).searchParams;
      if (req.method !== "GET" || q.get("state") !== state) {
        res.writeHead(400).end("Invalid OAuth callback");
        return;
      }
      clearTimeout(timer);
      res.end("<h2>Done. You can close this tab.</h2>");
      server.close();
      const c = q.get("code");
      c ? resolve(c) : reject(new Error(q.get("error") ?? "no code"));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out"));
    }, 300000);
    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(port, "127.0.0.1");
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const tok = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || typeof tok.refresh_token !== "string" || !tok.refresh_token.trim())
    throw new Error(`token exchange failed (HTTP ${res.status})`);
  const out = flag("--out");
  if (out) {
    writeFileSync(out, JSON.stringify({ clientId, clientSecret, refreshToken: tok.refresh_token }, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(`saved ${out}`);
  } else {
    console.log("GOOGLE_OAUTH_REFRESH_TOKEN=" + tok.refresh_token);
  }
}

async function sync(config: Config): Promise<void> {
  const dryRun = has("--dry");
  const only = flag("--pair");
  const pairs = pairsFor(config).filter((p) => !only || p.name === only);
  if (!pairs.length) throw new Error("no pairs configured" + (only ? ` named ${only}` : ""));
  const win = config.window.allEvents ? undefined : window(config.window.pastDays, config.window.futureDays);
  let failed = false;
  for (const pair of pairs) {
    const r = await syncPair(pair, win, { dryRun });
    failed ||= r.errors.length > 0;
    console.log(
      `${r.pair}: a=${r.a} b=${r.b} created=${r.created} updated=${r.updated} deleted=${r.deleted} skipped=${r.skipped}${dryRun ? " (dry)" : ""}`,
    );
    for (const a of r.actions ?? []) console.log(`  ${a.kind} → ${a.on}: ${a.why}`);
    for (const w of r.warnings ?? []) console.log(`  WARN ${w}`);
    for (const e of r.errors) console.log(`  ERROR ${e}`);
  }
  if (!failed && !dryRun && !only && config.dedupe?.rules.some((r) => r.mode === "delete")) {
    console.error(
      "WARNING: dedupe deletion enabled. No built-in backups or undo; configure application logging if needed.",
    );
    const { consolidateDuplicates } = await import("./consolidate.js");
    const result = await consolidateDuplicates(config);
    console.log(JSON.stringify(result));
    failed = result.incomplete || result.results.some((r) => r.status === "failed");
  }
  if (failed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [cmd, sub] = args;
  if (cmd === "auth" && sub === "google") return authGoogle();
  if (cmd === "discover" && sub === "icloud") return discoverIcloud(readConfig());
  if (cmd === "discover" && sub === "google") return discoverGoogle(readConfig());
  if (cmd === "sync") return sync(readConfig());
  if (cmd === "review") {
    if (has("--pair")) throw new Error("review uses dedupe rules; --pair is only supported by sync");
    const { reviewDuplicates } = await import("./dedupe.js");
    const report = await reviewDuplicates(readConfig());
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length || report.unavailable || report.truncated) process.exitCode = 1;
    return;
  }
  console.log(
    "usage: icloud-google-calendar-sync <auth google | discover icloud | discover google | review | sync [--dry] [--pair NAME]> [--config path]",
  );
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
