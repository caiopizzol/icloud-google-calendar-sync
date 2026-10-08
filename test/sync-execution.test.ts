import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CalDavEvent } from "../src/caldav.js";
import { fold, mirrorUid, toMirror, unfold } from "../src/ics.js";
import { parse, syncPair, type Pair } from "../src/sync.js";

const dav = vi.hoisted(() => ({ listEvents: vi.fn(), findByUid: vi.fn(), putEvent: vi.fn(), deleteEvent: vi.fn() }));
vi.mock("../src/caldav.js", async (original) => ({
  ...(await original<typeof import("../src/caldav.js")>()),
  ...dav,
}));

const pair: Pair = {
  name: "example",
  propagateDeletes: true,
  a: { id: "google", url: "https://google.example/cal/", auth: { kind: "basic", user: "u", pass: "p" } },
  b: { id: "icloud", url: "https://icloud.example/cal/", auth: { kind: "basic", user: "u", pass: "p" } },
};
const win = { start: new Date("2024-06-01"), end: new Date("2024-07-01") };
let events: Map<string, CalDavEvent>;
const original = (href: string): CalDavEvent => ({
  href,
  etag: '"1"',
  ics: [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:example",
    "DTSTART:20240620T180000Z",
    "DTEND:20240620T190000Z",
    "SUMMARY:Example",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n"),
});

beforeEach(() => {
  vi.resetAllMocks();
  events = new Map();
  dav.listEvents.mockImplementation(async (_auth, url: string) =>
    [...events.values()].filter((e) => e.href.startsWith(url)),
  );
  dav.findByUid.mockImplementation(
    async (_auth, url: string, uid: string) =>
      [...events.values()].find((e) => e.href.startsWith(url) && parse(e)?.uid === uid) ?? null,
  );
  dav.putEvent.mockImplementation(async (_auth, href: string, ics: string, etag: string | null) => {
    const current = events.get(href);
    if (current ? current.etag !== etag : etag !== null) throw new Error("412 precondition failed");
    events.set(href, { href, ics, etag: '"' + (Number(current?.etag?.replaceAll('"', "") ?? 0) + 1) + '"' });
  });
  dav.deleteEvent.mockImplementation(async (_auth, href: string, etag: string) => {
    if (events.get(href)?.etag !== etag) throw new Error("412 precondition failed");
    events.delete(href);
  });
});

describe("sync execution", () => {
  it("syncs creates and edits in both directions without deletion stamps by default", async () => {
    const safePair = { ...pair, propagateDeletes: undefined };
    const src = original(pair.a.url + "example.ics");
    events.set(src.href, src);
    const created = await syncPair(safePair, win);
    expect(created.errors).toEqual([]);
    expect(created.created).toBe(1);
    expect(events.get(src.href)!.ics).toBe(src.ics);
    const href = pair.b.url + mirrorUid(pair.a.id, "example") + ".ics";

    events.set(src.href, { ...src, ics: src.ics.replace("SUMMARY:Example", "SUMMARY:Source edit") });
    expect((await syncPair(safePair, win)).errors).toEqual([]);
    expect(events.get(href)!.ics).toContain("SUMMARY:Source edit");

    const mirror = events.get(href)!;
    events.set(href, { ...mirror, ics: mirror.ics.replace("SUMMARY:Source edit", "SUMMARY:Mirror edit") });
    expect((await syncPair(safePair, win)).errors).toEqual([]);
    expect(events.get(src.href)!.ics).toContain("SUMMARY:Mirror edit");
    expect(events.get(src.href)!.ics).not.toContain("X-SYNC-MIRRORED");
    const settled = await syncPair(safePair, win);
    expect(settled.created + settled.updated + settled.deleted).toBe(0);
    expect(dav.deleteEvent).not.toHaveBeenCalled();
  });

  it.each([undefined, false])(
    "never deletes with propagateDeletes=%s, including previously stamped events",
    async (propagateDeletes) => {
      for (const side of ["a", "b"] as const) {
        events.clear();
        const src = original(pair[side].url + "example.ics");
        events.set(src.href, src);
        // Simulate upgrading a pair that previously had deletion enabled.
        await syncPair(pair, win);
        const other = side === "a" ? "b" : "a";
        const mirrorHref = pair[other].url + mirrorUid(pair[side].id, "example") + ".ics";
        events.delete(mirrorHref);
        const safePair = { ...pair, propagateDeletes };
        const restored = await syncPair(safePair, win);
        expect(restored.errors).toEqual([]);
        expect(restored.created).toBe(1);
        expect(events.has(src.href)).toBe(true);
        expect(events.has(mirrorHref)).toBe(true);

        events.delete(src.href);
        const orphan = events.get(mirrorHref)!.ics;
        const kept = await syncPair(safePair, win);
        expect(kept.errors).toEqual([]);
        expect(kept.created + kept.updated + kept.deleted).toBe(0);
        expect(events.get(mirrorHref)!.ics).toBe(orphan);
        expect(dav.deleteEvent).not.toHaveBeenCalled();
        expect(dav.findByUid).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["a", "b"] as const)(
    "preserves an original on %s when mirror creation fails, then retries safely",
    async (side) => {
      const src = original(pair[side].url + "example.ics");
      events.set(src.href, src);
      dav.putEvent.mockRejectedValueOnce(new Error("503 unavailable"));
      const failed = await syncPair(pair, win);
      expect(failed.errors).toHaveLength(1);
      expect(events.get(src.href)?.ics).not.toContain("X-SYNC-MIRRORED");
      expect(dav.putEvent).toHaveBeenCalledTimes(1);
      const retried = await syncPair(pair, win);
      expect(retried.errors).toEqual([]);
      expect(retried.created).toBe(1);
      expect(retried.deleted).toBe(0);
      expect(events.size).toBe(2);
      expect(events.get(src.href)?.ics).toContain("X-SYNC-MIRRORED");
    },
  );

  it("keeps syncing the pair when an original cannot be stamped", async () => {
    // A Google event generated from Gmail (or any invitation you don't organize)
    // rejects writes. Its mirror is already current; only the stamp fails.
    const readOnly = original(pair.a.url + "readonly.ics");
    events.set(readOnly.href, readOnly);
    const mirrorHref = pair.b.url + mirrorUid(pair.a.id, "example") + ".ics";
    events.set(mirrorHref, {
      href: mirrorHref,
      etag: '"1"',
      ics: fold(
        toMirror(unfold(readOnly.ics), {
          uid: mirrorUid(pair.a.id, "example"),
          sourceSide: pair.a.id,
          sourceUid: "example",
          fp: parse(readOnly)!.fp,
        }),
      ),
    });
    const fresh = original(pair.a.url + "fresh.ics");
    fresh.ics = fresh.ics.replace("UID:example", "UID:fresh");
    events.set(fresh.href, fresh);
    const write = dav.putEvent.getMockImplementation()!;
    dav.putEvent.mockImplementation(async (auth, href: string, ics: string, etag: string | null) => {
      if (href === readOnly.href) throw new Error("PUT → 403: forbidden");
      return write(auth, href, ics, etag);
    });

    const result = await syncPair(pair, win);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain("403");
    expect(result.skipped).toBe(0);
    expect(result.created).toBe(1);
    expect(events.get(readOnly.href)!.ics).toBe(readOnly.ics);
    expect(events.get(fresh.href)!.ics).toContain("X-SYNC-MIRRORED:icloud");
    expect(events.has(pair.b.url + mirrorUid(pair.a.id, "fresh") + ".ics")).toBe(true);

    // Stateless: the stamp is retried and warns again, and nothing else changes.
    const again = await syncPair(pair, win);
    expect(again.errors).toEqual([]);
    expect(again.warnings).toHaveLength(1);
    expect(again.created + again.updated + again.deleted).toBe(0);
  });

  it("propagates a real mirror deletion after successful creation and stamping", async () => {
    const src = original(pair.a.url + "example.ics");
    events.set(src.href, src);
    expect((await syncPair(pair, win)).errors).toEqual([]);
    events.delete(pair.b.url + mirrorUid(pair.a.id, "example") + ".ics");
    const result = await syncPair(pair, win, { allowEmptyDeletes: true });
    expect(result.deleted).toBe(1);
    expect(events.size).toBe(0);
    expect(dav.findByUid).toHaveBeenCalledWith(pair.b.auth, pair.b.url, mirrorUid(pair.a.id, "example"));
  });

  it("preserves the original when the mirror lookup fails", async () => {
    const src = original(pair.a.url + "example.ics");
    events.set(src.href, src);
    await syncPair(pair, win);
    events.delete(pair.b.url + mirrorUid(pair.a.id, "example") + ".ics");
    dav.findByUid.mockRejectedValueOnce(new Error("503 unavailable"));
    expect((await syncPair(pair, win, { allowEmptyDeletes: true })).errors).toHaveLength(1);
    expect(events.has(src.href)).toBe(true);
    expect(dav.deleteEvent).not.toHaveBeenCalled();
  });

  it("does not acknowledge a mirror edit when writing it back fails", async () => {
    const src = original(pair.a.url + "example.ics");
    events.set(src.href, src);
    await syncPair(pair, win);
    const href = pair.b.url + mirrorUid(pair.a.id, "example") + ".ics";
    const mirror = events.get(href)!;
    events.set(href, { ...mirror, ics: mirror.ics.replace("SUMMARY:Example", "SUMMARY:Edited") });
    const editedMirror = events.get(href)!.ics;
    dav.putEvent.mockRejectedValueOnce(new Error("412 precondition failed"));
    expect((await syncPair(pair, win)).errors).toHaveLength(1);
    expect(events.get(href)!.ics).toBe(editedMirror);
    expect(events.get(src.href)!.ics).toContain("SUMMARY:Example");
    expect((await syncPair(pair, win)).errors).toEqual([]);
    expect(events.get(src.href)!.ics).toContain("SUMMARY:Edited");
  });

  it("stamps an unstamped original when its matching mirror has an outdated fingerprint", async () => {
    const src = original(pair.a.url + "example.ics");
    events.set(src.href, src);
    const href = pair.b.url + mirrorUid(pair.a.id, "example") + ".ics";
    events.set(href, {
      href,
      etag: '\"1\"',
      ics: fold(
        toMirror(unfold(src.ics.replace("END:VEVENT", "LAST-MODIFIED:20240621T000000Z\r\nEND:VEVENT")), {
          uid: mirrorUid(pair.a.id, "example"),
          sourceSide: pair.a.id,
          sourceUid: "example",
          fp: "outdated",
        }),
      ),
    });
    expect((await syncPair(pair, win)).errors).toEqual([]);
    expect(events.get(src.href)!.ics).toContain("X-SYNC-MIRRORED:icloud");
    expect((await syncPair(pair, win)).updated).toBe(0);
  });

  it("migrates an unstamped original and applies a pending mirror edit with one conditional write", async () => {
    const src = original(pair.a.url + "example.ics");
    const parsed = parse(src)!;
    const mirror = {
      href: pair.b.url + mirrorUid(pair.a.id, "example") + ".ics",
      etag: '"1"',
      ics: fold(
        toMirror(unfold(src.ics), {
          uid: mirrorUid(pair.a.id, "example"),
          sourceSide: pair.a.id,
          sourceUid: "example",
          fp: parsed.fp,
        }),
      ).replace("SUMMARY:Example", "SUMMARY:Edited"),
    };
    events.set(src.href, src);
    events.set(mirror.href, mirror);
    const result = await syncPair(pair, win);
    expect(result.errors).toEqual([]);
    expect(events.get(src.href)?.ics).toContain("SUMMARY:Edited");
    expect(events.get(src.href)?.ics).toContain("X-SYNC-MIRRORED:icloud");
    expect((await syncPair(pair, win)).updated).toBe(0);
  });
});

it("rejects colliding side IDs before any reads or writes", async () => {
  await expect(syncPair({ ...pair, b: { ...pair.b, id: pair.a.id } }, win)).rejects.toThrow(/distinct IDs/);
  expect(dav.listEvents).not.toHaveBeenCalled();
  expect(dav.putEvent).not.toHaveBeenCalled();
});
it("preserves the original invitation when a mirror is edited", async () => {
  const src = original(pair.a.url + "invitation.ics");
  src.ics = src.ics.replace(
    "END:VEVENT",
    "ORGANIZER:mailto:owner@example.com\r\nATTENDEE:mailto:guest@example.com\r\nEND:VEVENT",
  );
  events.set(src.href, src);
  const safePair = { ...pair, propagateDeletes: false };
  await syncPair(safePair, win);
  const href = pair.b.url + mirrorUid(pair.a.id, "example") + ".ics";
  const mirror = events.get(href)!;
  events.set(href, { ...mirror, ics: mirror.ics.replace("SUMMARY:Example", "SUMMARY:Edited") });
  const result = await syncPair(safePair, win);
  expect(result.errors).toEqual([]);
  expect(events.get(src.href)!.ics).toContain("SUMMARY:Edited");
  expect(events.get(src.href)!.ics).toContain("ORGANIZER:mailto:owner@example.com");
  expect(events.get(src.href)!.ics).toContain("ATTENDEE:mailto:guest@example.com");
  expect(events.get(href)!.ics).not.toContain("ATTENDEE");
});
it("rejects sanitized UID collisions before any writes", async () => {
  for (const [i, uid] of ["one!", "one?"].entries()) {
    const ev = original(pair.a.url + i + ".ics");
    ev.ics = ev.ics.replace("UID:example", `UID:${uid}`);
    events.set(ev.href, ev);
  }
  await expect(syncPair(pair, win)).rejects.toThrow(/colliding mirror UIDs/);
  expect(dav.putEvent).not.toHaveBeenCalled();
});

it("logs creation and internal stamps separately; dry-run never invokes write hooks", async () => {
  const src = original(pair.a.url + "example.ics");
  events.set(src.href, src);
  const beforeAction = vi.fn(),
    onAction = vi.fn();
  await syncPair(pair, win, { dryRun: true, beforeAction, onAction });
  expect(beforeAction).not.toHaveBeenCalled();
  expect(onAction).not.toHaveBeenCalled();
  await syncPair(pair, win, { beforeAction, onAction });
  expect(onAction.mock.calls.map(([a]) => [a.operation, a.internal, a.status])).toEqual([
    ["create", false, "completed"],
    ["update", true, "completed"],
  ]);
});
it("stops dependent writes after a completion observer fails", async () => {
  const src = original(pair.a.url + "example.ics");
  events.set(src.href, src);
  await expect(
    syncPair(pair, win, {
      onAction: () => {
        throw new Error("db down");
      },
    }),
  ).rejects.toMatchObject({ action: { operation: "create", status: "completed" } });
  expect(dav.putEvent).toHaveBeenCalledTimes(1);
  expect(events.get(src.href)?.ics).toBe(src.ics);
});
it("cancels a sync before reads", async () => {
  await expect(syncPair(pair, win, { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(dav.listEvents).not.toHaveBeenCalled();
});
it("skips a deletion if the missing counterpart reappears during its before hook", async () => {
  const src = original(pair.a.url + "example.ics");
  events.set(src.href, src);
  await syncPair(pair, win);
  const mirrorHref = pair.b.url + mirrorUid(pair.a.id, "example") + ".ics";
  const mirror = events.get(mirrorHref)!;
  events.delete(mirrorHref);
  const onAction = vi.fn();
  const result = await syncPair(pair, win, {
    allowEmptyDeletes: true,
    beforeAction: () => {
      events.set(mirrorHref, mirror);
    },
    onAction,
  });
  expect(result.deleted).toBe(0);
  expect(result.skipped).toBe(1);
  expect(events.has(src.href)).toBe(true);
  expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ operation: "delete", status: "skipped" }));
});

it("holds deletion when one provider reports an empty calendar, preventing a later cascade", async () => {
  const src = original(pair.a.url + "example.ics");
  events.set(src.href, src);
  await syncPair(pair, win);
  const before = new Map(events);
  dav.listEvents.mockImplementation(async (_auth, url: string) =>
    url === pair.b.url ? [] : [...events.values()].filter((e) => e.href.startsWith(url)),
  );
  dav.findByUid.mockResolvedValue(null);
  await expect(syncPair(pair, win)).rejects.toThrow(/calendar is empty/);
  expect(events).toEqual(before);
  expect(dav.deleteEvent).not.toHaveBeenCalled();
  dav.listEvents.mockImplementation(async (_auth, url: string) =>
    [...events.values()].filter((e) => e.href.startsWith(url)),
  );
  expect((await syncPair(pair, win)).deleted).toBe(0);
  expect(events).toEqual(before);
});
it("holds a large deletion plan before making any write, while keeping the dry run inspectable", async () => {
  const src = original(pair.a.url + "keep.ics");
  events.set(src.href, src);
  for (let i = 0; i < 11; i++) {
    const lines = unfold(original(pair.a.url + "x.ics").ics).map((l) => (l === "UID:example" ? `UID:orphan-${i}` : l));
    const parsed = parse({ href: "https://x/", etag: '"1"', ics: fold(lines) })!;
    const uid = mirrorUid("google", parsed.uid);
    const href = pair.b.url + uid + ".ics";
    events.set(href, {
      href,
      etag: '"1"',
      ics: fold(toMirror(lines, { uid, sourceSide: "google", sourceUid: parsed.uid, fp: parsed.fp })),
    });
  }
  expect((await syncPair(pair, win, { dryRun: true })).actions?.filter((a) => a.kind !== "put")).toHaveLength(11);
  await expect(syncPair(pair, win)).rejects.toThrow(/Deletion limit exceeded/);
  expect(dav.putEvent).not.toHaveBeenCalled();
  expect(dav.deleteEvent).not.toHaveBeenCalled();
});
