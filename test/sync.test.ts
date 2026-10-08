import { describe, expect, it } from "vitest";
import type { CalDavEvent } from "../src/caldav.js";
import { fingerprint, fold, toMirror, unfold } from "../src/ics.js";
import { parse, plan, planDirection, type Parsed, type Side } from "../src/sync.js";

const google: Side = {
  id: "google",
  auth: { kind: "basic", user: "u", pass: "p" },
  url: "https://g/events/",
};
const icloud: Side = {
  id: "icloud",
  auth: { kind: "basic", user: "u", pass: "p" },
  url: "https://i/cal/",
};

function ics(
  uid: string,
  summary: string,
  modified = "20260901T000000Z",
  extra: string[] = ["X-SYNC-MIRRORED:icloud"],
): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    "DTSTART:20260920T180000Z",
    "DTEND:20260920T190000Z",
    `LAST-MODIFIED:${modified}`,
    ...extra,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

const ev = (href: string, body: string): Parsed => parse({ href, etag: `"${href}"`, ics: body } as CalDavEvent)!;

function mirrorOf(
  src: Parsed,
  side: Side,
  opts: { fp?: string; edits?: (l: string) => string; modified?: string } = {},
): Parsed {
  let lines = toMirror(src.lines, {
    uid: src.uid + "-m",
    sourceSide: side.id,
    sourceUid: src.uid,
    fp: opts.fp ?? src.fp,
  });
  if (opts.edits) lines = lines.map(opts.edits);
  if (opts.modified) lines = lines.map((l) => (l.startsWith("LAST-MODIFIED") ? `LAST-MODIFIED:${opts.modified}` : l));
  return ev(`https://i/cal/${src.uid}-m.ics`, fold(lines));
}

describe("planDirection", () => {
  it("holds both endpoints without treating either exclusion as a deletion", () => {
    const src = ev("https://g/events/held.ics", ics("held", "Held"));
    const copy = mirrorOf(src, google, { edits: (line) => (line === "SUMMARY:Held" ? "SUMMARY:Changed" : line) });
    const pair = {
      name: "test",
      a: google,
      b: icloud,
      propagateDeletes: true,
      heldOriginals: [{ side: "google", uid: src.uid, reason: "Unsupported time semantics" }],
    };
    expect(plan(pair, [src], [copy])).toEqual([]);
    expect(plan(pair, [], [copy])).toEqual([]);
    expect(plan(pair, [src], [])).toEqual([]);
    const unrelated = ev("https://g/events/other.ics", ics("other", "Other", undefined, []));
    expect(plan(pair, [src, unrelated], [copy])).toHaveLength(2);
  });

  it("copies native Google conferences without stamping or editing their originals", () => {
    const src = ev(
      "https://g/events/conference.ics",
      ics("conference", "Meeting", "20260901T000000Z", ["LOCATION:https://meet.google.com/aaa-bbbb-ccc"]),
    );
    const options = { propagateDeletes: true, protectInvitations: true };
    const created = planDirection(google, icloud, [src], [], options);
    expect(created.map((action) => action.on)).toEqual(["icloud"]);
    const edited = mirrorOf(src, google, {
      edits: (line) => (line === "SUMMARY:Meeting" ? "SUMMARY:Edited copy" : line),
      modified: "20260909T000000Z",
    });
    expect(planDirection(google, icloud, [src], [edited], options)).toEqual([]);
    const stamped = ev(src.href, src.ics.replace("END:VEVENT", "X-SYNC-MIRRORED:icloud\r\nEND:VEVENT"));
    expect(
      planDirection(google, icloud, [stamped], [], options).every(
        (action) => action.kind === "put" && action.on === "icloud",
      ),
    ).toBe(true);
  });

  it("holds an edit that introduces a conference into a plain Google original", () => {
    const original = ev("https://g/events/plain.ics", ics("plain", "Plain event"));
    const copy = mirrorOf(original, google, {
      edits: (line) =>
        line === "END:VEVENT" ? "DESCRIPTION:Join https://meet.google.com/aaa-bbbb-ccc\r\nEND:VEVENT" : line,
      modified: "20260909T000000Z",
    });
    expect(
      planDirection(google, icloud, [original], [copy], { propagateDeletes: true, protectInvitations: true }),
    ).toEqual([]);
  });

  it("creates a mirror for a new original, with no attendees, and stamps the original", () => {
    const flight = ev("https://g/events/f.ics", ics("f", "Flight", "20260901T000000Z", ["ATTENDEE:mailto:x@y.z"]));
    const actions = planDirection(google, icloud, [flight], [], { propagateDeletes: true });
    expect(actions.map((a) => [a.kind, a.on])).toEqual([
      ["put", "icloud"],
      ["put", "google"],
    ]);
    if (actions[1].kind === "put") {
      expect(actions[1].ics).toContain("X-SYNC-MIRRORED:icloud");
      expect(actions[1].ics).toContain("ATTENDEE:mailto:x@y.z");
    }
    expect(actions[0].kind).toBe("put");
    if (actions[0].kind === "put") expect(actions[0].etag).toBeNull();
    expect(actions[0].on).toBe("icloud");
    expect(actions[0].href).toBe("https://i/cal/f-mirror-google.ics");
    if (actions[0].kind === "put") {
      expect(actions[0].ics).not.toContain("ATTENDEE");
      expect(actions[0].ics).toContain("X-SYNC-SOURCE:google:f");
    }
  });

  it("does nothing when source and mirror both match the stamp", () => {
    const src = ev("https://g/events/f.ics", ics("f", "Flight"));
    expect(planDirection(google, icloud, [src], [mirrorOf(src, google)])).toEqual([]);
  });

  it("only re-stamps when the content already matches but the stamp is stale", () => {
    const src = ev("https://g/events/f.ics", ics("f", "Flight"));
    const stale = mirrorOf(src, google, {
      fp: "old-fingerprint-rules",
      modified: "20260909T000000Z",
    });
    const actions = planDirection(google, icloud, [src], [stale]);
    expect(actions.map((a) => [a.kind, a.on])).toEqual([["put", "icloud"]]);
    if (actions[0].kind === "put") expect(unfold(actions[0].ics)).toContain("X-SYNC-FP:" + src.fp);
  });

  it("only re-stamps when the content already matches but the stamp is stale", () => {
    const src = ev("https://g/events/f.ics", ics("f", "Flight"));
    const stale = mirrorOf(src, google, {
      fp: "old-fingerprint-rules",
      modified: "20260909T000000Z",
    });
    const actions = planDirection(google, icloud, [src], [stale]);
    expect(actions.map((a) => [a.kind, a.on])).toEqual([["put", "icloud"]]);
    if (actions[0].kind === "put") expect(unfold(actions[0].ics)).toContain("X-SYNC-FP:" + src.fp);
  });

  it("refreshes the mirror when the original changed", () => {
    const old = ev("https://g/events/f.ics", ics("f", "Flight"));
    const mirror = mirrorOf(old, google);
    const changed = ev("https://g/events/f.ics", ics("f", "Flight (delayed)", "20260902T000000Z"));
    const actions = planDirection(google, icloud, [changed], [mirror]);
    expect(actions.map((a) => [a.kind, a.on])).toEqual([["put", "icloud"]]);
    if (actions[0].kind === "put") expect(actions[0].ics).toContain("SUMMARY:Flight (delayed)");
  });

  it("pushes a human edit on the mirror back to the original and re-stamps", () => {
    const src = ev("https://g/events/f.ics", ics("f", "Flight"));
    const edited = mirrorOf(src, google, {
      edits: (l) => (l.startsWith("SUMMARY") ? "SUMMARY:Flight w/ partner" : l),
      modified: "20260903T000000Z",
    });
    const actions = planDirection(google, icloud, [src], [edited]);
    expect(actions.map((a) => [a.kind, a.on])).toEqual([
      ["put", "google"],
      ["put", "icloud"],
    ]);
    if (actions[0].kind === "put") {
      expect(actions[0].href).toBe("https://g/events/f.ics");
      expect(actions[0].ics).toContain("UID:f\r\n");
      expect(actions[0].ics).toContain("SUMMARY:Flight w/ partner");
      expect(actions[0].ics).not.toContain("X-SYNC-SOURCE");
      expect(actions[0].ics).not.toContain("X-SYNC-FP");
      expect(actions[0].ics).toContain("X-SYNC-MIRRORED:icloud"); // the original keeps its stamp
    }
    if (actions[1].kind === "put") {
      const stamped = unfold(actions[1].ics);
      expect(stamped.find((l) => l.startsWith("X-SYNC-FP"))).toBe("X-SYNC-FP:" + fingerprint(edited.lines));
    }
  });

  it("when both changed, the later LAST-MODIFIED wins", () => {
    const old = ev("https://g/events/f.ics", ics("f", "Flight"));
    const mirrorEditedEarly = mirrorOf(old, google, {
      edits: (l) => (l.startsWith("SUMMARY") ? "SUMMARY:mirror edit" : l),
      modified: "20260902T000000Z",
    });
    const srcEditedLater = ev("https://g/events/f.ics", ics("f", "source edit", "20260905T000000Z"));
    const actions = planDirection(google, icloud, [srcEditedLater], [mirrorEditedEarly]);
    expect(actions.map((a) => [a.kind, a.on])).toEqual([["put", "icloud"]]);
    if (actions[0].kind === "put") expect(actions[0].ics).toContain("SUMMARY:source edit");
  });

  it("preserves a mirror edit with an older timestamp when only the original's fingerprint format changed", () => {
    const original = ev(
      "https://g/events/zero.ics",
      ics("zero", "Original", "20260903T000000Z").replace("DTEND:20260920T190000Z", "DTEND:20260920T180000Z"),
    );
    const mirror = mirrorOf(original, google, {
      fp: fingerprint(original.lines, true),
      edits: (l) => (l.startsWith("SUMMARY:") ? "SUMMARY:Mirror edit" : l),
      modified: "20260902T000000Z",
    });
    const actions = planDirection(google, icloud, [original], [mirror]);
    expect(actions.map((a) => [a.kind, a.on])).toEqual([
      ["put", "google"],
      ["put", "icloud"],
    ]);
    if (actions[0].kind === "put") expect(actions[0].ics).toContain("SUMMARY:Mirror edit");
    if (actions[1].kind === "put") expect(actions[1].ics).toContain(`X-SYNC-FP:${mirror.fp}`);
  });

  it("preserves an original edit when an unchanged mirror has a legacy zero-duration stamp and newer timestamp", () => {
    const before = ev(
      "https://g/events/zero.ics",
      ics("zero", "Original").replace("DTEND:20260920T190000Z", "DTEND:20260920T180000Z"),
    );
    const mirror = mirrorOf(before, google, { fp: fingerprint(before.lines, true), modified: "20260903T000000Z" });
    const changed = ev(before.href, before.ics.replace("SUMMARY:Original", "SUMMARY:Original edit"));
    const actions = planDirection(google, icloud, [changed], [mirror]);
    expect(actions.map((a) => [a.kind, a.on])).toEqual([["put", "icloud"]]);
    if (actions[0].kind === "put") {
      expect(actions[0].ics).toContain("SUMMARY:Original edit");
      expect(actions[0].ics).toContain(`X-SYNC-FP:${changed.fp}`);
    }
  });

  it.each([
    ['"GMT-03:00"', "68778d652c833a10"],
    ["GMT-0300", "ec77dd98a141eff4"],
  ])("preserves real edits on either side of an old %s fingerprint", (zone, saved) => {
    const before = ev(
      "https://g/events/fixed.ics",
      fold([
        "BEGIN:VEVENT",
        "UID:fixed",
        `DTSTART;TZID=${zone}:20260101T090000`,
        `DTEND;TZID=${zone}:20260101T100000`,
        "SUMMARY:Fixed offset",
        "LAST-MODIFIED:20260903T000000Z",
        "END:VEVENT",
      ]),
    );
    const editedMirror = mirrorOf(before, google, {
      fp: saved,
      edits: (line) => line.replace("SUMMARY:Fixed offset", "SUMMARY:Mirror edit"),
      modified: "20260902T000000Z",
    });
    const mirrorActions = planDirection(google, icloud, [before], [editedMirror]);
    expect(mirrorActions.map((action) => [action.kind, action.on])).toEqual([
      ["put", "google"],
      ["put", "icloud"],
    ]);
    if (mirrorActions[0].kind === "put") expect(mirrorActions[0].ics).toContain("SUMMARY:Mirror edit");

    const unchangedMirror = mirrorOf(before, google, { fp: saved, modified: "20260904T000000Z" });
    const editedOriginal = ev(before.href, before.ics.replace("SUMMARY:Fixed offset", "SUMMARY:Original edit"));
    const originalActions = planDirection(google, icloud, [editedOriginal], [unchangedMirror]);
    expect(originalActions.map((action) => [action.kind, action.on])).toEqual([["put", "icloud"]]);
    if (originalActions[0].kind === "put") expect(originalActions[0].ics).toContain("SUMMARY:Original edit");
  });

  it("flags a mirror whose original is missing for orphan check, never blind delete", () => {
    const src = ev("https://g/events/f.ics", ics("f", "Flight"));
    const mirror = mirrorOf(src, google);
    const actions = planDirection(google, icloud, [], [mirror], { propagateDeletes: true });
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("delete-if-orphan");
    if (actions[0].kind === "delete-if-orphan") expect(actions[0].sourceUid).toBe("f");
  });

  it("ignores mirrors that belong to the other direction", () => {
    const icloudOrig = ev("https://i/cal/d.ics", ics("d", "Dinner", "20260901T000000Z", ["X-SYNC-MIRRORED:google"]));
    const itsMirrorOnGoogle = mirrorOf(icloudOrig, icloud);
    // Planning google→icloud must not treat the icloud-sourced mirror on google as an original.
    expect(planDirection(google, icloud, [itsMirrorOnGoogle], [icloudOrig])).toEqual([]);
  });

  it("deletes an original whose mirror a human removed, but only via a confirmed lookup", () => {
    const stamped = ev("https://g/events/f.ics", ics("f", "Flight")); // carries X-SYNC-MIRRORED:icloud
    const actions = planDirection(google, icloud, [stamped], [], { propagateDeletes: true });
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("delete-if-mirror-gone");
    if (actions[0].kind === "delete-if-mirror-gone") {
      expect(actions[0].on).toBe("google");
      expect(actions[0].mirrorUid).toBe("f-mirror-google");
    }
  });

  it("stamps a pre-existing original that has a mirror but no stamp (migration)", () => {
    const unstamped = ev("https://g/events/f.ics", ics("f", "Flight", "20260901T000000Z", []));
    const mirror = mirrorOf(unstamped, google);
    const actions = planDirection(google, icloud, [unstamped], [mirror], { propagateDeletes: true });
    expect(actions.map((a) => [a.kind, a.on, a.why.split(" ")[0]])).toEqual([["put", "google", "stamp"]]);
  });

  it("propagateDeletes: false recreates a deleted mirror", () => {
    const stamped = ev("https://g/events/f.ics", ics("f", "Flight"));
    const actions = planDirection(google, icloud, [stamped], [], { propagateDeletes: false });
    expect(actions.map((a) => a.kind)).toEqual(["put"]);
  });
});
