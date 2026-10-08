import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprint, fold, toMirror } from "../src/ics.js";
import { parse, syncPair, type Pair, type Parsed } from "../src/sync.js";
import { reconcileLinks, validateLinks, type LinkState, type LinkStore } from "../src/links.js";
import { findByUid, putEvent, deleteEvent, listEvents } from "../src/caldav.js";
vi.mock("../src/caldav.js", async (original) => ({
  ...(await original<typeof import("../src/caldav.js")>()),
  findByUid: vi.fn(),
  putEvent: vi.fn(),
  deleteEvent: vi.fn(),
  listEvents: vi.fn(),
}));
const auth = { kind: "basic", user: "u", pass: "p" } as const;
const pair: Pair = {
  name: "linked",
  propagateDeletes: true,
  a: { id: "a", auth, url: "https://a.example/cal/" },
  b: { id: "b", auth, url: "https://b.example/cal/" },
};
const event = (side: "a" | "b", title = "old", modified = "20260101T000000Z", extras: string[] = []): Parsed =>
  parse({
    href: pair[side].url + "shared.ics",
    etag: '"' + title + '"',
    ics: fold([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:shared",
      "DTSTART:20261001T120000Z",
      `SUMMARY:${title}`,
      `LAST-MODIFIED:${modified}`,
      ...extras,
      "END:VEVENT",
      "END:VCALENDAR",
    ]),
  })!;
function setup(a = event("a"), b = event("b")) {
  let saved: LinkState = {
    version: 1,
    fingerprintVersion: 1,
    calendars: [pair.a.url, pair.b.url],
    links: [{ aUid: a.uid, bUid: b.uid, aFp: a.fp, bFp: b.fp }],
  };
  const store: LinkStore = {
    load: async () => structuredClone(saved),
    save: vi.fn(async (s) => {
      saved = structuredClone(s);
    }),
  };
  return { a, b, store, state: () => saved };
}
afterEach(() => vi.resetAllMocks());

describe("existing links", () => {
  it.each([false, true])(
    "adopts existing equal or divergent objects without provider writes (divergent=%s)",
    async (divergent) => {
      const { a, b, store } = setup(event("a"), event("b", divergent ? "other" : "old"));
      vi.mocked(listEvents).mockImplementation(async (_auth, url) => (url === pair.a.url ? [a] : [b]));
      const r = await syncPair(pair, undefined, { linkStore: store });
      expect(r.created + r.updated + r.deleted).toBe(0);
      expect(putEvent).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
    },
  );
  it.each(["a", "b"] as const)("propagates edits from %s without changing the destination UID", async (side) => {
    const x = setup();
    const changed = event(side, "edited");
    const other = side === "a" ? "b" : "a";
    vi.mocked(findByUid).mockResolvedValue(event(other, "edited"));
    const r = await reconcileLinks(pair, side === "a" ? [[changed], [x.b]] : [[x.a], [changed]], x.store, {});
    expect(r.updated).toBe(1);
    expect(putEvent).toHaveBeenCalledWith(
      pair[other].auth,
      event(other).href,
      expect.stringContaining("UID:shared"),
      '"old"',
    );
    expect(x.state().links[0].aFp).toBe(changed.fp);
    expect(x.state().links[0].bFp).toBe(changed.fp);
  });
  it("does not acknowledge a source edit made during PUT", async () => {
    const x = setup();
    const copied = event("a", "copied");
    const later = event("a", "later", "20260103T000000Z");
    vi.mocked(findByUid).mockResolvedValue(event("b", "copied"));
    await reconcileLinks(pair, [[copied], [x.b]], x.store, {});
    expect(x.state().links[0].aFp).toBe(copied.fp);
    expect(x.state().links[0].aFp).not.toBe(later.fp);
    vi.mocked(findByUid).mockResolvedValue(event("b", "later", "20260103T000000Z"));
    await reconcileLinks(pair, [[later], [event("b", "copied")]], x.store, {});
    expect(putEvent).toHaveBeenCalledTimes(2);
  });
  it("retains pending intent if the destination changes before verification", async () => {
    const x = setup();
    vi.mocked(findByUid).mockResolvedValue(event("b", "someone else's edit"));
    await expect(reconcileLinks(pair, [[event("a", "edited")], [x.b]], x.store, {})).rejects.toThrow(/verification/);
    expect(x.state().links[0].aFp).toBe(x.a.fp);
    expect(x.state().links[0].pending).toBeDefined();
    await expect(
      reconcileLinks(pair, [[event("a", "edited")], [event("b", "someone else's edit")]], x.store, {}),
    ).rejects.toThrow(/uncertain linked write/);
  });
  it("recovers a committed PUT after a timeout without rewriting or acknowledging a later source edit", async () => {
    const x = setup();
    const copied = event("a", "copied");
    vi.mocked(putEvent).mockRejectedValueOnce(Error("timeout"));
    await expect(reconcileLinks(pair, [[copied], [x.b]], x.store, {})).rejects.toThrow("timeout");
    expect(x.state().links[0].pending).toBeDefined();
    vi.mocked(findByUid).mockResolvedValue(event("b", "newer"));
    await reconcileLinks(pair, [[event("a", "newer", "20260103T000000Z")], [event("b", "copied")]], x.store, {});
    expect(putEvent).toHaveBeenCalledTimes(2);
    expect(x.state().links[0].aFp).toBe(event("a", "newer").fp);
  });
  it("never writes if the pending-intent save fails", async () => {
    const x = setup();
    x.store.save = vi.fn().mockRejectedValue(Error("disk full"));
    await expect(reconcileLinks(pair, [[event("a", "edit")], [x.b]], x.store, {})).rejects.toThrow("disk full");
    expect(putEvent).not.toHaveBeenCalled();
  });
  it("dry run changes neither state nor calendars", async () => {
    const x = setup();
    const before = structuredClone(x.state());
    await reconcileLinks(pair, [[event("a", "edit")], [x.b]], x.store, { dryRun: true });
    expect(x.state()).toEqual(before);
    expect(x.store.save).not.toHaveBeenCalled();
    expect(putEvent).not.toHaveBeenCalled();
  });
  it("holds initially divergent notes for review on first edit", async () => {
    const x = setup(event("a"), event("b", "old", undefined, ["DESCRIPTION:Other notes"]));
    x.state().links[0].reviewOnChange = true;
    expect((await reconcileLinks(pair, [[event("a", "edit")], [x.b]], x.store, {})).warnings).toHaveLength(1);
    expect(putEvent).not.toHaveBeenCalled();
  });
  it("retains closed links and refuses silently restored objects", async () => {
    const x = setup();
    vi.mocked(findByUid).mockResolvedValue(null);
    await reconcileLinks(pair, [[], []], x.store, {});
    expect(x.state().links[0].closed).toBe(true);
    expect(() => validateLinks(pair, [[x.a], []], x.state())).toThrow(/reappeared/);
  });
  it("confirms absence and conditionally deletes an unchanged survivor", async () => {
    const x = setup();
    vi.mocked(findByUid).mockResolvedValue(null);
    const r = await reconcileLinks(pair, [[x.a], []], x.store, {});
    expect(r.deleted).toBe(1);
    expect(deleteEvent).toHaveBeenCalledWith(pair.a.auth, x.a.href, x.a.etag);
    expect(x.state().links[0].closed).toBe(true);
  });
  it("does not delete on lookup failure, delete/edit conflict or reappearance during a hook", async () => {
    const x = setup();
    vi.mocked(findByUid).mockRejectedValueOnce(Error("unavailable"));
    await expect(reconcileLinks(pair, [[x.a], []], x.store, {})).rejects.toThrow("unavailable");
    vi.mocked(findByUid).mockResolvedValue(null);
    await expect(reconcileLinks(pair, [[event("a", "edited")], []], x.store, {})).rejects.toThrow(
      /conflicts with an edit/,
    );
    vi.mocked(findByUid).mockResolvedValueOnce(null).mockResolvedValueOnce(x.b);
    expect((await reconcileLinks(pair, [[x.a], []], x.store, { beforeAction: async () => {} })).skipped).toBe(1);
    expect(deleteEvent).not.toHaveBeenCalled();
  });
  it("blocks mismatched state, duplicate links, mirrors and referenced originals", () => {
    const x = setup();
    const state = x.state();
    expect(() =>
      validateLinks({ ...pair, a: { ...pair.a, url: "https://different/" } }, [[x.a], [x.b]], state),
    ).toThrow(/match/);
    expect(() => validateLinks(pair, [[x.a], [x.b]], { ...state, links: [...state.links, ...state.links] })).toThrow(
      /duplicate/,
    );
    const mirror = parse({
      ...x.b,
      ics: fold(toMirror(x.b.lines, { uid: "mirror", sourceSide: "a", sourceUid: x.a.uid, fp: x.a.fp })),
    })!;
    expect(() => validateLinks(pair, [[x.a], [x.b, mirror]], state)).toThrow(/ordinary mirror/);
    expect(() => validateLinks(pair, [[{ ...x.a, source: { side: "b", uid: "x" } }], [x.b]], state)).toThrow(
      /already a mirror/,
    );
  });
  it("requires explicit adoption for a preexisting UID and refuses bounded queries with a store", async () => {
    const x = setup();
    vi.mocked(listEvents).mockImplementation(async (_auth, url) => (url === pair.a.url ? [x.a] : [x.b]));
    await expect(syncPair(pair, undefined)).rejects.toThrow(/adopt an existing link/);
    await expect(syncPair(pair, { start: new Date(), end: new Date() }, { linkStore: x.store })).rejects.toThrow(
      /all-history/,
    );
    expect(putEvent).not.toHaveBeenCalled();
  });
  it("protects invitation-bearing targets from updates and deletion", async () => {
    const x = setup(
      event("a", "old", undefined, ["ORGANIZER:mailto:owner@example.com"]),
      event("b", "old", undefined, ["ATTENDEE:mailto:guest@example.com"]),
    );
    const protectedPair = { ...pair, protectInvitations: true };
    expect((await reconcileLinks(protectedPair, [[event("a", "edited")], [x.b]], x.store, {})).skipped).toBe(1);
    vi.mocked(findByUid).mockResolvedValue(null);
    expect((await reconcileLinks(protectedPair, [[x.a], []], x.store, {})).skipped).toBe(1);
    expect(putEvent).not.toHaveBeenCalled();
    expect(deleteEvent).not.toHaveBeenCalled();
  });
});

it("holds deletion of an initially divergent link for review", async () => {
  const x = setup(event("a"), event("b", "different"));
  x.state().links[0].reviewOnChange = true;
  vi.mocked(findByUid).mockResolvedValue(null);
  expect((await reconcileLinks(pair, [[x.a], []], x.store, {})).skipped).toBe(1);
  expect(deleteEvent).not.toHaveBeenCalled();
});
it("rechecks invitation policy before retrying a pending PUT", async () => {
  const x = setup(event("a"), event("b", "old", undefined, ["ORGANIZER:mailto:owner@example.com"]));
  vi.mocked(putEvent).mockRejectedValueOnce(Error("timeout"));
  await expect(reconcileLinks(pair, [[event("a", "edited")], [x.b]], x.store, {})).rejects.toThrow("timeout");
  vi.mocked(putEvent).mockClear();
  expect(
    (await reconcileLinks({ ...pair, protectInvitations: true }, [[event("a", "edited")], [x.b]], x.store, {})).skipped,
  ).toBe(1);
  expect(putEvent).not.toHaveBeenCalled();
});
it("resolves simultaneous edits by latest modification and holds ties", async () => {
  const x = setup();
  const newer = event("a", "newer", "20260103T000000Z");
  vi.mocked(findByUid).mockResolvedValue(event("b", "newer"));
  await reconcileLinks(pair, [[newer], [event("b", "older", "20260102T000000Z")]], x.store, {});
  expect(x.state().links[0].aFp).toBe(newer.fp);
  await expect(reconcileLinks(pair, [[event("a", "A")], [event("b", "B")]], x.store, {})).rejects.toThrow(
    /timestamp winner/,
  );
});
it("keeps the pending operation if committing the verified state fails, then recovers without another PUT", async () => {
  const x = setup();
  const save = x.store.save;
  let calls = 0;
  x.store.save = async (s) => {
    if (++calls === 2) throw Error("disk full");
    await save(s);
  };
  vi.mocked(findByUid).mockResolvedValue(event("b", "edit"));
  await expect(reconcileLinks(pair, [[event("a", "edit")], [x.b]], x.store, {})).rejects.toThrow("disk full");
  expect(x.state().links[0].pending).toBeDefined();
  await reconcileLinks(pair, [[event("a", "edit")], [event("b", "edit")]], x.store, {});
  expect(putEvent).toHaveBeenCalledTimes(1);
  expect(x.state().links[0].pending).toBeUndefined();
});
it("requires a LinkStore even after one adopted endpoint disappears", async () => {
  await expect(syncPair({ ...pair, existingLinks: true }, undefined)).rejects.toThrow(
    /requires its existing-link store/,
  );
  expect(listEvents).not.toHaveBeenCalled();
});
it("includes proposed linked writes in the dry-run result", async () => {
  const x = setup();
  vi.mocked(listEvents).mockImplementation(async (_auth, url) => (url === pair.a.url ? [event("a", "edited")] : [x.b]));
  const r = await syncPair({ ...pair, existingLinks: true }, undefined, { linkStore: x.store, dryRun: true });
  expect(r.actions).toEqual([]);
  expect(r.linkedActions).toHaveLength(1);
  expect(r.linkedActions?.[0]).toMatchObject({ operation: "update", side: "b", href: x.b.href });
  expect(putEvent).not.toHaveBeenCalled();
});

it.each([
  { maxDeletes: 0, allowEmptyDeletes: true },
  { maxDeletes: 10, allowEmptyDeletes: false },
])("blocks a linked deletion discovered only after preview (%j)", async (guards) => {
  const x = setup();
  vi.mocked(listEvents).mockImplementation(async (_auth, url) => (url === pair.a.url ? [x.a] : []));
  vi.mocked(findByUid).mockResolvedValueOnce(x.b).mockResolvedValue(null);
  await expect(syncPair(pair, undefined, { linkStore: x.store, ...guards })).rejects.toThrow(/observer failed/);
  expect(deleteEvent).not.toHaveBeenCalled();
  expect(putEvent).not.toHaveBeenCalled();
  expect(x.state().links[0].closed).toBeUndefined();
});

describe("legacy zero-duration link fingerprints", () => {
  const zero = (side: "a" | "b", title = "old", modified = "20260103T000000Z", end = "DTEND:20261001T120000Z") =>
    event(side, title, modified, [end]);
  const legacySetup = () => {
    const x = setup(zero("a"), zero("b"));
    x.state().links[0].aFp = fingerprint(x.a.lines, true);
    x.state().links[0].bFp = fingerprint(x.b.lines, true);
    return x;
  };
  const addPending = (x: ReturnType<typeof setup>, copied: Parsed) => {
    const fp = fingerprint(copied.lines, true);
    x.state().links[0].pending = {
      target: "b",
      etag: x.b.etag!,
      sourceFp: fp,
      expectedFp: fp,
      ics: copied.ics,
    };
  };

  it("leaves unchanged adopted events alone, including links held for review", async () => {
    const x = legacySetup();
    x.state().links[0].reviewOnChange = true;
    const result = await reconcileLinks(pair, [[x.a], [x.b]], x.store, {});
    expect(result.actions).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(putEvent).not.toHaveBeenCalled();
    expect(deleteEvent).not.toHaveBeenCalled();
    expect(x.store.save).not.toHaveBeenCalled();
  });

  it.each(["a", "b"] as const)("propagates a single edit on %s despite its older timestamp", async (side) => {
    const x = legacySetup();
    const changed = zero(side, "edited", "20260102T000000Z");
    const other = side === "a" ? "b" : "a";
    vi.mocked(findByUid).mockResolvedValue(zero(other, "edited"));
    await reconcileLinks(pair, side === "a" ? [[changed], [x.b]] : [[x.a], [changed]], x.store, {});
    expect(putEvent).toHaveBeenCalledExactlyOnceWith(
      pair[other].auth,
      x[other].href,
      expect.any(String),
      x[other].etag,
    );
    expect(x.state().links[0].aFp).toBe(changed.fp);
    expect(x.state().links[0].bFp).toBe(changed.fp);
  });

  it("does not mistake an unchanged survivor's legacy fingerprint for a deletion/edit conflict", async () => {
    const x = legacySetup();
    vi.mocked(findByUid).mockResolvedValue(null);
    const result = await reconcileLinks(pair, [[x.a], []], x.store, {});
    expect(result.deleted).toBe(1);
    expect(deleteEvent).toHaveBeenCalledExactlyOnceWith(pair.a.auth, x.a.href, x.a.etag);
  });

  it.each([false, true])(
    "recovers an old pending intent across an equivalent server representation (committed=%s)",
    async (committed) => {
      const x = legacySetup();
      const copied = zero("a", "copied");
      addPending(x, copied);
      const stored = zero("b", "copied", undefined, "DURATION:PT0S");
      vi.mocked(findByUid).mockResolvedValue(stored);
      const result = await reconcileLinks(pair, [[copied], [committed ? stored : x.b]], x.store, {});
      expect(result.updated).toBe(committed ? 0 : 1);
      expect(putEvent).toHaveBeenCalledTimes(committed ? 0 : 1);
      expect(x.state().links[0].pending).toBeUndefined();
      expect(x.state().links[0].aFp).toBe(copied.fp);
      expect(x.state().links[0].bFp).toBe(copied.fp);
    },
  );

  it("does not acknowledge a newer source edit while upgrading a committed legacy intent", async () => {
    const x = legacySetup();
    addPending(x, zero("a", "copied"));
    const newer = zero("a", "newer", "20260104T000000Z");
    vi.mocked(findByUid).mockResolvedValue(zero("b", "newer", undefined, "DURATION:PT0S"));
    await reconcileLinks(pair, [[newer], [zero("b", "copied", undefined, "DURATION:PT0S")]], x.store, {});
    expect(putEvent).toHaveBeenCalledExactlyOnceWith(
      pair.b.auth,
      x.b.href,
      expect.stringContaining("SUMMARY:newer"),
      '"copied"',
    );
    expect(x.state().links[0].aFp).toBe(newer.fp);
    expect(x.state().links[0].bFp).toBe(newer.fp);
  });
});
