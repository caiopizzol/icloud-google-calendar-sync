import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprint, fold, toMirror } from "../src/ics.js";
import { parse, syncPair, type Pair, type Parsed } from "../src/sync.js";
import { reconcileLinks, validateLinks, type LinkState, type LinkStore } from "../src/links.js";
import { CalDavError, findByUid, putEvent, deleteEvent, listEvents } from "../src/caldav.js";
import { ActionObserverError } from "../src/execution.js";
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
  it("holds a linked edit that would introduce a Google conference", async () => {
    const x = setup();
    const source = event("a", "edited", "20260102T000000Z", ["DESCRIPTION:Join https://meet.google.com/aaa-bbbb-ccc"]);
    const guarded = { ...pair, b: { ...pair.b, id: "google" }, protectInvitations: true };
    const result = await reconcileLinks(guarded, [[source], [x.b]], x.store, {});
    expect(result.skipped).toBe(1);
    expect(putEvent).not.toHaveBeenCalled();
    expect(x.state().links[0].pending).toBeUndefined();
  });

  it("retains a pending conference introduction without retrying its native Google PUT", async () => {
    const x = setup();
    const source = event("a", "edited", "20260102T000000Z", ["DESCRIPTION:Join https://meet.google.com/aaa-bbbb-ccc"]);
    const pending = {
      target: "b" as const,
      etag: x.b.etag!,
      sourceFp: source.fp,
      expectedFp: source.fp,
      ics: source.ics,
    };
    x.state().links[0].pending = pending;
    const guarded = { ...pair, b: { ...pair.b, id: "google" }, protectInvitations: true };
    const result = await reconcileLinks(guarded, [[source], [x.b]], x.store, {});
    expect(result.skipped).toBe(1);
    expect(putEvent).not.toHaveBeenCalled();
    expect(x.state().links[0].pending).toEqual(pending);
  });

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
    const result = await reconcileLinks(
      pair,
      [[event("a", "edited")], [event("b", "someone else's edit")]],
      x.store,
      {},
    );
    expect(result.skipped).toBe(1);
    expect(result.warnings).toEqual([expect.stringMatching(/uncertain linked write/)]);
    expect(x.state().links[0].pending).toBeDefined();
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
  it("retains closed links and holds restored objects for review", async () => {
    const x = setup();
    vi.mocked(findByUid).mockResolvedValue(null);
    await reconcileLinks(pair, [[], []], x.store, {});
    expect(x.state().links[0].closed).toBe(true);
    const result = await reconcileLinks(pair, [[x.a], []], x.store, {});
    expect(result.skipped).toBe(1);
    expect(result.warnings).toEqual([expect.stringMatching(/reappeared/)]);
    expect(result.a).toEqual([]);
    expect(x.state().links[0].closed).toBe(true);
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
    const conflict = await reconcileLinks(pair, [[event("a", "edited")], []], x.store, {});
    expect(conflict.skipped).toBe(1);
    expect(conflict.warnings).toEqual([expect.stringMatching(/conflicts with an edit/)]);
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

describe("isolated existing-link failures", () => {
  const named = (original: Parsed, uid: string) =>
    parse({
      ...original,
      href: original.href.replace("shared.ics", `${uid}.ics`),
      ics: original.ics.replace("UID:shared", `UID:${uid}`),
    })!;
  const withHealthyLink = (x: ReturnType<typeof setup>) => {
    const a = named(event("a"), "healthy");
    const b = named(event("b"), "healthy");
    const changed = named(event("a", "Healthy edit"), "healthy");
    const verified = named(event("b", "Healthy edit"), "healthy");
    x.state().links.push({ aUid: a.uid, bUid: b.uid, aFp: a.fp, bFp: b.fp });
    vi.mocked(findByUid).mockImplementation(async (_auth, _url, uid) => (uid === "healthy" ? verified : null));
    return { a, b, changed };
  };
  const expectHealthyWrite = (b: Parsed) =>
    expect(putEvent).toHaveBeenCalledExactlyOnceWith(
      pair.b.auth,
      b.href,
      expect.stringContaining("SUMMARY:Healthy edit"),
      b.etag,
    );
  const setPending = (x: ReturnType<typeof setup>) => {
    const changed = event("a", "Pending edit");
    x.state().links[0].pending = {
      target: "b",
      etag: x.b.etag!,
      sourceFp: changed.fp,
      expectedFp: changed.fp,
      ics: changed.ics,
    };
    return changed;
  };

  it.each(["review", "invitation", "disabled"] as const)(
    "continues other links after a %s-held deletion's survivor changes",
    async (policy) => {
      const x = setup();
      x.state().links[0].reviewOnChange = policy === "review";
      const healthy = withHealthyLink(x);
      const before = structuredClone(x.state().links[0]);
      const survivor = event(
        "a",
        "New notes",
        undefined,
        policy === "invitation" ? ["ATTENDEE:mailto:guest@example.com"] : [],
      );
      const result = await reconcileLinks(
        { ...pair, propagateDeletes: policy !== "disabled", protectInvitations: policy === "invitation" },
        [[survivor, healthy.changed], [healthy.b]],
        x.store,
        {},
      );
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.warnings).toEqual([expect.stringMatching(/held by deletion\/invitation policy/)]);
      expect(x.state().links[0]).toEqual(before);
      expect(deleteEvent).not.toHaveBeenCalled();
      expectHealthyWrite(healthy.b);
      expect(result.a).toEqual([]);
      expect(result.b).toEqual([]);
    },
  );

  it.each([false, true])(
    "holds a deletion/edit conflict without blocking a healthy link (pending=%s)",
    async (pending) => {
      const x = setup();
      if (pending) setPending(x);
      const healthy = withHealthyLink(x);
      const before = structuredClone(x.state().links[0]);
      const result = await reconcileLinks(
        pair,
        [[pending ? x.a : event("a", "edited"), healthy.changed], [healthy.b]],
        x.store,
        {},
      );
      expect(result.warnings).toEqual([expect.stringMatching(/conflicts with an edit/)]);
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(1);
      expect(x.state().links[0]).toEqual(before);
      expect(deleteEvent).not.toHaveBeenCalled();
      expectHealthyWrite(healthy.b);
    },
  );

  it("keeps restored closed endpoints excluded while another link progresses", async () => {
    const x = setup();
    x.state().links[0].closed = true;
    const healthy = withHealthyLink(x);
    const before = structuredClone(x.state().links[0]);
    const result = await reconcileLinks(pair, [[x.a, healthy.changed], [healthy.b]], x.store, {});
    expect(result.warnings).toEqual([expect.stringMatching(/reappeared/)]);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.a).toEqual([]);
    expect(result.b).toEqual([]);
    expect(x.state().links[0]).toEqual(before);
    expectHealthyWrite(healthy.b);
    expect(() => validateLinks(pair, [[x.a, x.a], []], x.state())).toThrow(/ambiguous/);
    expect(() => validateLinks(pair, [[{ ...x.a, source: { side: "b", uid: "mirror" } }], []], x.state())).toThrow(
      /already a mirror/,
    );
  });

  it.each([403, 412])("clears a definitely rejected HTTP %s intent and continues other links", async (status) => {
    const x = setup();
    const healthy = withHealthyLink(x);
    const before = structuredClone(x.state().links[0]);
    const error = new CalDavError(status, "PUT", x.b.href, "");
    vi.mocked(putEvent).mockRejectedValueOnce(error);
    const onAction = vi.fn();
    const result = await reconcileLinks(
      pair,
      [
        [event("a", "edited"), healthy.changed],
        [x.b, healthy.b],
      ],
      x.store,
      { onAction },
    );
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.warnings).toEqual([expect.stringContaining(String(status))]);
    expect(x.state().links[0]).toEqual(before);
    expect(putEvent).toHaveBeenCalledTimes(2);
    expect(putEvent).toHaveBeenLastCalledWith(
      pair.b.auth,
      healthy.b.href,
      expect.stringContaining("SUMMARY:Healthy edit"),
      healthy.b.etag,
    );
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ href: x.b.href, status: "failed" }));
  });

  it("replans a rejected 412 update with the fresh destination ETag on the next run", async () => {
    const x = setup();
    const changed = event("a", "edited");
    vi.mocked(putEvent).mockRejectedValueOnce(new CalDavError(412, "PUT", x.b.href, ""));
    await reconcileLinks(pair, [[changed], [x.b]], x.store, {});
    expect(x.state().links[0].pending).toBeUndefined();
    vi.mocked(findByUid).mockResolvedValue(event("b", "edited"));
    await reconcileLinks(pair, [[changed], [{ ...x.b, etag: '"fresh"' }]], x.store, {});
    expect(putEvent).toHaveBeenLastCalledWith(
      pair.b.auth,
      x.b.href,
      expect.stringContaining("SUMMARY:edited"),
      '"fresh"',
    );
    expect(x.state().links[0].aFp).toBe(changed.fp);
    expect(x.state().links[0].bFp).toBe(changed.fp);
  });

  it("retains an older uncertain attempt when its retry is rejected, preserving a newer source edit", async () => {
    const x = setup();
    const copied = setPending(x);
    const before = structuredClone(x.state().links[0]);
    const healthy = withHealthyLink(x);
    const newer = event("a", "Newer source", "20260103T000000Z");
    vi.mocked(putEvent).mockRejectedValueOnce(new CalDavError(412, "PUT", x.b.href, ""));
    const result = await reconcileLinks(
      pair,
      [
        [newer, healthy.changed],
        [x.b, healthy.b],
      ],
      x.store,
      {},
    );
    expect(result.updated).toBe(1);
    expect(result.warnings).toEqual([expect.stringMatching(/prior uncertain intent retained/)]);
    expect(x.state().links[0]).toEqual(before);

    const committed = event("b", "Pending edit", "20260104T000000Z");
    expect(committed.fp).toBe(copied.fp);
    vi.mocked(putEvent).mockClear();
    vi.mocked(findByUid).mockResolvedValue(event("b", "Newer source"));
    await reconcileLinks(
      pair,
      [
        [newer, healthy.changed],
        [committed, named(event("b", "Healthy edit"), "healthy")],
      ],
      x.store,
      {},
    );
    expect(putEvent).toHaveBeenCalledExactlyOnceWith(
      pair.b.auth,
      x.b.href,
      expect.stringContaining("SUMMARY:Newer source"),
      committed.etag,
    );
    expect(x.state().links[0].pending).toBeUndefined();
    expect(x.state().links[0].aFp).toBe(newer.fp);
    expect(x.state().links[0].bFp).toBe(newer.fp);
  });

  it("clears a rejected fresh intent after recovering an earlier committed write", async () => {
    const x = setup();
    const copied = setPending(x);
    const healthy = withHealthyLink(x);
    vi.mocked(putEvent).mockRejectedValueOnce(new CalDavError(403, "PUT", x.b.href, ""));
    const result = await reconcileLinks(
      pair,
      [
        [event("a", "Newer source"), healthy.changed],
        [event("b", "Pending edit"), healthy.b],
      ],
      x.store,
      {},
    );
    expect(result.updated).toBe(1);
    expect(result.warnings).toEqual([expect.stringMatching(/retry from fresh state/)]);
    expect(x.state().links[0].pending).toBeUndefined();
    expect(x.state().links[0].aFp).toBe(copied.fp);
    expect(x.state().links[0].bFp).toBe(copied.fp);
  });

  it("retains conflicting uncertain intent while another link progresses", async () => {
    const x = setup();
    const changed = setPending(x);
    const healthy = withHealthyLink(x);
    const before = structuredClone(x.state().links[0]);
    const result = await reconcileLinks(
      pair,
      [
        [changed, healthy.changed],
        [event("b", "Independent edit"), healthy.b],
      ],
      x.store,
      {},
    );
    expect(result.warnings).toEqual([expect.stringMatching(/uncertain linked write/)]);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(x.state().links[0]).toEqual(before);
    expectHealthyWrite(healthy.b);
  });

  it.each([408, 503, "network"] as const)(
    "preserves intent and stops on an uncertain %s PUT failure",
    async (failure) => {
      const x = setup();
      const healthy = withHealthyLink(x);
      const error = failure === "network" ? Error("network failure") : new CalDavError(failure, "PUT", x.b.href, "");
      vi.mocked(putEvent).mockRejectedValueOnce(error);
      await expect(
        reconcileLinks(
          pair,
          [
            [event("a", "edited"), healthy.changed],
            [x.b, healthy.b],
          ],
          x.store,
          {},
        ),
      ).rejects.toBe(error);
      expect(x.state().links[0].pending).toBeDefined();
      expect(putEvent).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["before", "after"] as const)(
    "preserves pending intent when the %s observer fails with a 4xx-shaped error",
    async (phase) => {
      const x = setup();
      const healthy = withHealthyLink(x);
      const error = new CalDavError(403, "PUT", x.b.href, "");
      const fail = () => {
        throw error;
      };
      if (phase === "after") vi.mocked(putEvent).mockRejectedValueOnce(error);
      await expect(
        reconcileLinks(
          pair,
          [
            [event("a", "edited"), healthy.changed],
            [x.b, healthy.b],
          ],
          x.store,
          phase === "before" ? { beforeAction: fail } : { onAction: fail },
        ),
      ).rejects.toBeInstanceOf(ActionObserverError);
      expect(x.state().links[0].pending).toBeDefined();
      expect(putEvent).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
    },
  );

  it("stops and retains durable pending intent when saving rejection recovery fails", async () => {
    const x = setup();
    const healthy = withHealthyLink(x);
    const save = x.store.save;
    let calls = 0;
    x.store.save = async (state) => {
      if (++calls === 2) throw Error("disk full");
      await save(state);
    };
    vi.mocked(putEvent).mockRejectedValueOnce(new CalDavError(403, "PUT", x.b.href, ""));
    await expect(
      reconcileLinks(
        pair,
        [
          [event("a", "edited"), healthy.changed],
          [x.b, healthy.b],
        ],
        x.store,
        {},
      ),
    ).rejects.toThrow("disk full");
    expect(x.state().links[0].pending).toBeDefined();
    expect(putEvent).toHaveBeenCalledTimes(1);
  });
});
