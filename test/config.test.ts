import { describe, expect, it } from "vitest";
import { loadConfig, pairsFor, resolveValue } from "../src/config.js";

const env = {
  GOOGLE_OAUTH_CLIENT_SECRET: "sec",
  GOOGLE_OAUTH_REFRESH_TOKEN: "rt",
  ICLOUD_APP_PASSWORD: "app-pw",
};

describe("loadConfig", () => {
  it("reads a file with env: indirection for secrets", () => {
    const cfg = loadConfig(
      {
        google: {
          clientId: "id",
          clientSecret: "env:GOOGLE_OAUTH_CLIENT_SECRET",
          refreshToken: "env:GOOGLE_OAUTH_REFRESH_TOKEN",
        },
        icloud: { username: "me@icloud.com", appPassword: "env:ICLOUD_APP_PASSWORD" },
        pairs: [{ name: "p", a: "google:me@gmail.com", b: "icloud:https://p1-caldav.icloud.com/1/calendars/home" }],
        window: { pastDays: 7 },
      },
      env,
    );
    expect(cfg.google).toEqual({ clientId: "id", clientSecret: "sec", refreshToken: "rt" });
    expect(cfg.icloud).toEqual({ username: "me@icloud.com", appPassword: "app-pw" });
    expect(cfg.window).toEqual({ pastDays: 7, futureDays: 365 });
    const [pair] = pairsFor(cfg);
    expect(pair.a.url).toBe("https://apidata.googleusercontent.com/caldav/v2/me%40gmail.com/events/");
    expect(pair.b.url).toBe("https://p1-caldav.icloud.com/1/calendars/home/");
  });

  it("falls back to plain env when there is no file", () => {
    const cfg = loadConfig(null, {
      ...env,
      GOOGLE_OAUTH_CLIENT_ID: "id",
      ICLOUD_USERNAME: "me@icloud.com",
      CALENDAR_PAIRS: JSON.stringify([{ name: "p", a: "google:primary", b: "icloud:https://x/" }]),
      CALENDAR_SYNC_FUTURE_DAYS: "90",
    });
    expect(cfg.google?.clientId).toBe("id");
    expect(cfg.pairs).toHaveLength(1);
    expect(cfg.window.futureDays).toBe(90);
  });

  it("a missing env: value leaves the credential null instead of a literal string", () => {
    const cfg = loadConfig({ icloud: { username: "u", appPassword: "env:NOPE" } }, {});
    expect(cfg.icloud).toBeNull();
    expect(resolveValue("plain", {})).toBe("plain");
  });

  it("rejects a side it does not understand", () => {
    const cfg = loadConfig({ pairs: [{ name: "p", a: "outlook:x", b: "icloud:https://x/" }] }, env);
    expect(() => pairsFor(cfg)).toThrow(/unknown calendar side/);
  });
});

describe("delete propagation config", () => {
  it.each([true, false])("preserves %s through file and environment config", (propagateDeletes) => {
    const pairs = [{ name: "example", a: "google:primary", b: "icloud:https://icloud.example/cal/", propagateDeletes }];
    const credentials = {
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "s",
      GOOGLE_OAUTH_REFRESH_TOKEN: "r",
      ICLOUD_USERNAME: "u",
      ICLOUD_APP_PASSWORD: "p",
    };
    for (const config of [
      loadConfig({ pairs }, credentials),
      loadConfig(null, { ...credentials, CALENDAR_PAIRS: JSON.stringify(pairs) }),
    ]) {
      expect(pairsFor(config)[0].propagateDeletes).toBe(propagateDeletes);
    }
  });

  it.each(["false", 0, null])("rejects an invalid delete propagation flag: %s", (propagateDeletes) => {
    expect(() =>
      loadConfig(
        {
          pairs: [{ name: "example", a: "google:primary", b: "icloud:https://icloud.example/cal/", propagateDeletes }],
        },
        {},
      ),
    ).toThrow(/propagateDeletes/);
  });
});

it("accepts true or false for complete-history synchronization and rejects ambiguous values", () => {
  for (const allEvents of [true, false])
    expect(loadConfig({ window: { allEvents } }, {}).window.allEvents).toBe(allEvents);
  for (const allEvents of ["true", 1, null])
    expect(() => loadConfig({ window: { allEvents } }, {})).toThrow(/allEvents/);
});

it("preserves and validates local adoption and invitation protection policies", () => {
  const credentials = {
    google: { clientId: "id", clientSecret: "s", refreshToken: "r" },
    icloud: { username: "u", appPassword: "p" },
  };
  const pair = {
    name: "Calendar",
    a: "google:primary",
    b: "icloud:https://p1-caldav.icloud.com/cal/",
    existingLinks: true,
    protectInvitations: true,
  };
  expect(pairsFor(loadConfig({ ...credentials, pairs: [pair] }, {}))[0]).toMatchObject({
    existingLinks: true,
    protectInvitations: true,
  });
  for (const key of ["existingLinks", "protectInvitations"])
    expect(() => loadConfig({ pairs: [{ ...pair, [key]: "true" }] }, {})).toThrow(key);
});
