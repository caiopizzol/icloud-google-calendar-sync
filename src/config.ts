// Configuration. Two sources, merged: a JSON file (pairs, window, auth) and
// environment variables. Any string value in the file may be "env:NAME" to
// pull a secret from the environment, so the file itself can be committed.
//
// {
//   "google": { "clientId": "…", "clientSecret": "env:GOOGLE_CLIENT_SECRET", "refreshToken": "env:GOOGLE_REFRESH_TOKEN" },
//   "icloud": { "username": "you@icloud.com", "appPassword": "env:ICLOUD_APP_PASSWORD" },
//   "pairs": [
//     { "name": "personal", "a": "google:primary", "b": "icloud:https://pNN-caldav.icloud.com/<id>/calendars/home/" }
//   ],
//   "window": { "pastDays": 30, "futureDays": 365 }
// }
//
// Without a file, the same settings come from env: GOOGLE_OAUTH_CLIENT_ID,
// GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN, ICLOUD_USERNAME,
// ICLOUD_APP_PASSWORD, CALENDAR_PAIRS (JSON array), CALENDAR_SYNC_PAST_DAYS,
// CALENDAR_SYNC_FUTURE_DAYS.

import type { CalDavAuth } from "./caldav.js";
import { googleCalendarUrl, scopedAuth, type RequestOptions } from "./caldav.js";
import { googleAccessToken, type GoogleOAuthEnv } from "./google.js";
import type { Pair, Side } from "./sync.js";

export type PairSpec = {
  name: string;
  a: string;
  b: string;
  propagateDeletes?: boolean;
  protectInvitations?: boolean;
  existingLinks?: boolean;
};
export type WindowDays = { pastDays: number; futureDays: number; allEvents?: boolean };

export type DedupeConfig = {
  provider: "gateway" | "typesafe";
  apiKey: string;
  rules: { prefer: string; over: string[]; mode: "review" | "delete" }[];
  maxComparisons: number;
  threshold: number;
};

export type Config = {
  dedupe?: DedupeConfig;
  google: GoogleOAuthEnv | null;
  icloud: { username: string; appPassword: string } | null;
  pairs: PairSpec[];
  window: WindowDays;
};

type Env = Record<string, string | undefined>;

/** "env:NAME" → process.env.NAME; anything else passes through. */
export function resolveValue(v: unknown, env: Env): string | undefined {
  if (typeof v !== "string") return undefined;
  if (v.startsWith("env:")) return env[v.slice(4)];
  return v;
}

export function parsePairSpecs(raw: unknown): PairSpec[] {
  if (raw == null) return [];
  const v: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(v)) throw new Error("pairs must be an array");
  return v.map((p, i) => {
    if (!p || typeof p !== "object") throw new Error(`pairs[${i}] must be an object`);
    const { name, a, b, propagateDeletes, protectInvitations, existingLinks } = p as Record<string, unknown>;
    if (typeof name !== "string" || typeof a !== "string" || typeof b !== "string") {
      throw new Error(`pairs[${i}] needs string name, a, b`);
    }
    if (propagateDeletes !== undefined && typeof propagateDeletes !== "boolean") {
      throw new Error(`pairs[${i}].propagateDeletes must be a boolean`);
    }
    if (protectInvitations !== undefined && typeof protectInvitations !== "boolean")
      throw new Error(`pairs[${i}].protectInvitations must be a boolean`);
    if (existingLinks !== undefined && typeof existingLinks !== "boolean")
      throw new Error(`pairs[${i}].existingLinks must be a boolean`);
    return {
      name,
      a,
      b,
      ...(existingLinks === undefined ? {} : { existingLinks }),
      ...(propagateDeletes === undefined ? {} : { propagateDeletes }),
      ...(protectInvitations === undefined ? {} : { protectInvitations }),
    };
  });
}

function num(v: unknown, fallback: number, min: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Build a Config from an optional parsed JSON file plus the environment. */
export function loadConfig(file: Record<string, unknown> | null, env: Env = process.env): Config {
  const g = (file?.google ?? {}) as Record<string, unknown>;
  const clientId = resolveValue(g.clientId, env) ?? env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = resolveValue(g.clientSecret, env) ?? env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = resolveValue(g.refreshToken, env) ?? env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const google = clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;

  const i = (file?.icloud ?? {}) as Record<string, unknown>;
  const username = resolveValue(i.username, env) ?? env.ICLOUD_USERNAME;
  const appPassword = resolveValue(i.appPassword, env) ?? env.ICLOUD_APP_PASSWORD;
  const icloud = username && appPassword ? { username, appPassword } : null;

  const pairs = parsePairSpecs(file?.pairs ?? env.CALENDAR_PAIRS);
  const w = (file?.window ?? {}) as Record<string, unknown>;
  if (w.allEvents !== undefined && typeof w.allEvents !== "boolean")
    throw new Error("window.allEvents must be a boolean");
  const window = {
    ...(w.allEvents === undefined ? {} : { allEvents: w.allEvents }),
    pastDays: num(w.pastDays ?? env.CALENDAR_SYNC_PAST_DAYS, 30, 0),
    futureDays: num(w.futureDays ?? env.CALENDAR_SYNC_FUTURE_DAYS, 365, 1),
  };
  const rawDedupe =
    file && Object.hasOwn(file, "dedupe")
      ? file.dedupe
      : env.CALENDAR_DEDUPE
        ? JSON.parse(env.CALENDAR_DEDUPE)
        : undefined;
  const dedupe = parseDedupe(rawDedupe, pairs, env);
  return { google, icloud, pairs, window, ...(dedupe ? { dedupe } : {}) };
}

export function authsFor(config: Config): { google: CalDavAuth | null; icloud: CalDavAuth | null } {
  const g = config.google;
  return {
    google: g ? { kind: "bearer", token: (signal) => googleAccessToken(g, fetch, signal) } : null,
    icloud: config.icloud ? { kind: "basic", user: config.icloud.username, pass: config.icloud.appPassword } : null,
  };
}

export function resolveSide(spec: string, auths: ReturnType<typeof authsFor>): Side {
  const i = spec.indexOf(":");
  const kind = spec.slice(0, i);
  const rest = spec.slice(i + 1);
  if (kind === "google") {
    if (!auths.google) throw new Error("google credentials missing (clientId / clientSecret / refreshToken)");
    return { id: "google", auth: auths.google, url: googleCalendarUrl(rest) };
  }
  if (kind === "icloud") {
    if (!auths.icloud) throw new Error("icloud credentials missing (username / appPassword)");
    return { id: "icloud", auth: auths.icloud, url: rest.endsWith("/") ? rest : rest + "/" };
  }
  throw new Error(`unknown calendar side "${kind}" in "${spec}" (use google:<calendarId> or icloud:<collection url>)`);
}

export function pairsFor(config: Config, options: RequestOptions = {}): Pair[] {
  const auths = authsFor(config);
  if (auths.google) auths.google = scopedAuth(auths.google, options);
  if (auths.icloud) auths.icloud = scopedAuth(auths.icloud, options);
  return config.pairs.map((p) => ({ ...p, a: resolveSide(p.a, auths), b: resolveSide(p.b, auths) }));
}

/** Validate priority rules before any calendar reads or model requests. */
export function parseDedupe(raw: unknown, pairs: PairSpec[], env: Env): DedupeConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("dedupe must be an object");
  const d = raw as Record<string, unknown>;
  if (d.provider !== "gateway" && d.provider !== "typesafe")
    throw new Error("dedupe.provider must be gateway or typesafe");
  const apiKey = resolveValue(d.apiKey, env);
  if (!apiKey?.trim()) throw new Error("dedupe.apiKey is missing");
  const threshold = d.threshold === undefined ? 0.95 : d.threshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error("dedupe.threshold must be a finite number from 0 to 1");
  const maxComparisons = d.maxComparisons ?? 100;
  if (
    typeof maxComparisons !== "number" ||
    !Number.isInteger(maxComparisons) ||
    maxComparisons < 1 ||
    maxComparisons > 1000
  )
    throw new Error("dedupe.maxComparisons must be an integer from 1 to 1000");
  const names = new Set(pairs.map((p) => p.name));
  if (names.size !== pairs.length) throw new Error("dedupe needs unique pair names");
  if (!Array.isArray(d.rules) || !d.rules.length) throw new Error("dedupe.rules must be a nonempty array");
  const losers = new Set<string>();
  const rules = d.rules.map((raw): DedupeConfig["rules"][number] => {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r.prefer !== "string" || !names.has(r.prefer))
      throw new Error("dedupe rule needs a known prefer pair");
    if (r.mode !== undefined && r.mode !== "review" && r.mode !== "delete")
      throw new Error("dedupe rule mode must be review or delete");
    if (
      !Array.isArray(r.over) ||
      !r.over.length ||
      !r.over.every((n) => typeof n === "string" && names.has(n) && n !== r.prefer)
    )
      throw new Error("dedupe rule over must name other configured pairs");
    for (const name of r.over) {
      if (losers.has(name)) throw new Error("Each over pair must have exactly one priority rule");
      losers.add(name);
    }
    return { prefer: r.prefer, over: r.over as string[], mode: r.mode === "delete" ? "delete" : "review" };
  });
  // A single winner per group avoids conflicting chains and circular preferences.
  if (rules.some((r) => losers.has(r.prefer))) throw new Error("A preferred pair cannot also appear in over");
  for (const rule of rules) {
    if (rule.mode === "delete" && pairs.some((p) => [rule.prefer, ...rule.over].includes(p.name) && p.propagateDeletes))
      throw new Error("Dedupe deletion requires propagateDeletes=false");
  }
  return { provider: d.provider, apiKey, rules, maxComparisons, threshold };
}
