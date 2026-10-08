import { beforeEach, describe, expect, it, vi } from "vitest";

const syncPair = vi.fn();
const reviewDuplicates = vi.fn();
const consolidateDuplicates = vi.fn();
vi.mock("../src/consolidate.js", () => ({
  consolidateDuplicates: (...args: unknown[]) => consolidateDuplicates(...args),
}));
vi.mock("../src/dedupe.js", () => ({ reviewDuplicates: (...args: unknown[]) => reviewDuplicates(...args) }));
vi.mock("../src/sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sync.js")>()),
  syncPair: (...args: unknown[]) => syncPair(...args),
}));

import { createHandler } from "../src/handler.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig(
  {
    google: { clientId: "id", clientSecret: "s", refreshToken: "r" },
    icloud: { username: "u", appPassword: "p" },
    pairs: [{ name: "personal", a: "google:me@gmail.com", b: "icloud:https://x/cal/" }],
  },
  {},
);
const handler = createHandler({ config, secret: "shh" });
const get = (path: string, headers: Record<string, string> = {}) =>
  handler(new Request("http://h" + path, { headers }));

beforeEach(() => syncPair.mockReset());

describe("createHandler", () => {
  it("rejects anonymous callers", async () => {
    expect((await get("/")).status).toBe(401);
    expect(syncPair).not.toHaveBeenCalled();
  });

  it("accepts Bearer or x-api-key and reports per-pair results", async () => {
    syncPair.mockResolvedValue({
      pair: "personal",
      a: 3,
      b: 2,
      created: 1,
      updated: 0,
      deleted: 0,
      skipped: 0,
      errors: [],
    });
    const res = await get("/", { authorization: "Bearer shh" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.results[0].created).toBe(1);
    expect((await get("/", { "x-api-key": "shh" })).status).toBe(200);
  });

  it("dry-run and pair selection pass through; errors become 502", async () => {
    syncPair.mockResolvedValue({
      pair: "personal",
      a: 0,
      b: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      errors: ["boom"],
    });
    const res = await get("/?dry=1&pair=personal", { authorization: "Bearer shh" });
    expect(res.status).toBe(502);
    expect(syncPair.mock.calls[0][2]).toMatchObject({ dryRun: true, signal: expect.any(AbortSignal) });
    expect((await get("/?pair=nope", { authorization: "Bearer shh" })).status).toBe(400);
  });
});

describe("custom authorization", () => {
  it("accepts an asynchronous authorization hook without a secret", async () => {
    syncPair.mockResolvedValue({ errors: [] });
    const authorize = vi.fn(async () => true);
    const handler = createHandler({ config, authorize });
    const request = new Request("http://h/");
    expect((await handler(request)).status).toBe(200);
    expect(authorize).toHaveBeenCalledWith(request);
    expect(syncPair).toHaveBeenCalledOnce();
  });

  it("returns a custom denial response without syncing", async () => {
    const denied = new Response("Forbidden", { status: 403 });
    const handler = createHandler({ config, authorize: () => denied });
    expect(await handler(new Request("http://h/"))).toBe(denied);
    expect(syncPair).not.toHaveBeenCalled();
  });

  it("does not let a valid secret bypass a hook denial", async () => {
    const handler = createHandler({ config, secret: "shh", authorize: () => false });
    expect((await handler(new Request("http://h/", { headers: { authorization: "Bearer shh" } }))).status).toBe(401);
    expect(syncPair).not.toHaveBeenCalled();
  });

  it("does not sync if authorization throws", async () => {
    const handler = createHandler({
      config,
      authorize: () => {
        throw new Error("auth unavailable");
      },
    });
    await expect(handler(new Request("http://h/"))).rejects.toThrow("auth unavailable");
    expect(syncPair).not.toHaveBeenCalled();
  });

  it("requires an authentication method", () => {
    expect(() => createHandler({ config })).toThrow(/secret or authorize/);
  });
});

describe("duplicate review endpoint", () => {
  const cfg = {
    ...config,
    dedupe: {
      provider: "gateway" as const,
      apiKey: "test-key",
      maxComparisons: 100,
      threshold: 0.95,
      rules: [{ prefer: "shared", over: ["personal"], mode: "review" as const }],
    },
  };
  const handler = createHandler({ config: cfg, secret: "shh" });
  it("requires authentication before review", async () => {
    reviewDuplicates.mockReset();
    expect((await handler(new Request("http://h/?review=1"))).status).toBe(401);
    expect(reviewDuplicates).not.toHaveBeenCalled();
  });
  it("reviews without invoking sync, with no-store response headers", async () => {
    reviewDuplicates.mockResolvedValue({ errors: [], unavailable: 0, truncated: false, suggestions: [] });
    const response = await handler(new Request("http://h/?review=1", { headers: { "x-api-key": "shh" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(syncPair).not.toHaveBeenCalled();
  });
  it("rejects missing configuration and conflicting flags", async () => {
    expect((await get("/?review=1", { "x-api-key": "shh" })).status).toBe(400);
    expect(
      (await handler(new Request("http://h/?review=1&pair=personal", { headers: { "x-api-key": "shh" } }))).status,
    ).toBe(400);
    expect(syncPair).not.toHaveBeenCalled();
  });
  it("marks partial review as failure without leaking thrown errors", async () => {
    reviewDuplicates.mockResolvedValueOnce({ errors: [], unavailable: 1, truncated: false });
    const request = () => new Request("http://h/?review=1", { headers: { "x-api-key": "shh" } });
    expect((await handler(request())).status).toBe(502);
    reviewDuplicates.mockRejectedValueOnce(new Error("test-key"));
    const result = await handler(request());
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain("test-key");
    expect(syncPair).not.toHaveBeenCalled();
  });
});

describe("opt-in consolidation", () => {
  const deletionConfig = {
    ...config,
    dedupe: {
      provider: "gateway" as const,
      apiKey: "key",
      threshold: 0.95,
      maxComparisons: 100,
      rules: [{ prefer: "shared", over: ["personal"], mode: "delete" as const }],
    },
  };
  beforeEach(() => {
    consolidateDuplicates.mockReset().mockResolvedValue({ incomplete: false, results: [] });
    syncPair.mockResolvedValue({ errors: [] });
  });
  it("runs cleanup after a successful full sync and forwards the hook", async () => {
    const onDelete = vi.fn();
    const run = createHandler({ config: deletionConfig, secret: "key", onDelete });
    const response = await run(new Request("https://example.com", { headers: { "x-api-key": "key" } }));
    expect(response.status).toBe(200);
    expect(consolidateDuplicates).toHaveBeenCalledWith(
      deletionConfig,
      expect.objectContaining({ onDelete, signal: expect.any(AbortSignal) }),
    );
    expect((await response.json()).consolidation).toEqual({ incomplete: false, results: [] });
  });
  it.each(["?dry=1", "?pair=personal"])("does not consolidate %s", async (query) => {
    const run = createHandler({ config: deletionConfig, secret: "key" });
    await run(new Request("https://example.com/" + query, { headers: { "x-api-key": "key" } }));
    expect(consolidateDuplicates).not.toHaveBeenCalled();
  });
  it("does not consolidate after sync errors", async () => {
    syncPair.mockResolvedValue({ errors: ["failed"] });
    const run = createHandler({ config: deletionConfig, secret: "key" });
    expect((await run(new Request("https://example.com", { headers: { "x-api-key": "key" } }))).status).toBe(502);
    expect(consolidateDuplicates).not.toHaveBeenCalled();
  });
  it("rejects overlap and releases the guard after completion", async () => {
    let finish!: (value: { errors: string[] }) => void;
    syncPair.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const run = createHandler({ config, secret: "key" });
    const request = () => new Request("https://example.com", { headers: { "x-api-key": "key" } });
    const first = run(request());
    expect((await run(request())).status).toBe(409);
    finish({ errors: [] });
    expect((await first).status).toBe(200);
    expect((await run(request())).status).toBe(200);
  });
});

it("uses an unfiltered sync when allEvents is configured", async () => {
  syncPair.mockResolvedValue({ errors: [] });
  const handler = createHandler({
    config: { ...config, window: { ...config.window, allEvents: true } },
    secret: "shh",
  });
  expect((await handler(new Request("http://h/", { headers: { "x-api-key": "shh" } }))).status).toBe(200);
  expect(syncPair.mock.calls[0][1]).toBeUndefined();
});
