import { describe, expect, it } from "vitest";
import {
  eventProp,
  fingerprint,
  fold,
  mirrorUid,
  sourceRef,
  toMirror,
  toOriginal,
  uidOf,
  unfold,
  withMirrored,
  X_FP,
  X_SOURCE,
} from "../src/ics.js";

const GOOGLE_FLIGHT = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:America/Chicago",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Chicago:20240624T193500",
  "DTEND;TZID=America/Chicago:20240624T232500",
  "DTSTAMP:20240611T120000Z",
  "UID:abc123@google.com",
  "ORGANIZER;CN=Organizer:mailto:organizer@example.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Partner;X-NUM-GUESTS=0:mailto:partner@",
  " example.com",
  "LAST-MODIFIED:20240611T120000Z",
  "SUMMARY:Example event",
  "LOCATION:Example location",
  "BEGIN:VALARM",
  "TRIGGER:-PT30M",
  "ACTION:DISPLAY",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("unfold/fold", () => {
  it("joins continuation lines and folds back under 75 octets", () => {
    const lines = unfold(GOOGLE_FLIGHT);
    expect(lines.find((l) => l.startsWith("ATTENDEE"))).toContain("mailto:partner@example.com");
    const long = "DESCRIPTION:" + "x".repeat(200);
    const folded = fold([long]);
    for (const l of folded.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(unfold(folded)[0]).toBe(long);
  });
});

describe("toMirror", () => {
  const lines = unfold(GOOGLE_FLIGHT);
  const mirror = toMirror(lines, {
    uid: "m-1",
    sourceSide: "google",
    sourceUid: "abc123@google.com",
    fp: "deadbeef",
  });

  it("rewrites the UID and strips every attendee and organizer", () => {
    expect(uidOf(mirror)).toBe("m-1");
    expect(mirror.some((l) => l.startsWith("ATTENDEE"))).toBe(false);
    expect(mirror.some((l) => l.startsWith("ORGANIZER"))).toBe(false);
  });

  it("stamps the source and fingerprint markers", () => {
    expect(sourceRef(mirror)).toEqual({ side: "google", uid: "abc123@google.com" });
    expect(eventProp(mirror, X_FP)).toBe("deadbeef");
  });

  it("keeps timezone, alarm, summary and location verbatim", () => {
    expect(mirror).toContain("TZID:America/Chicago");
    expect(mirror).toContain("TRIGGER:-PT30M");
    expect(mirror).toContain("SUMMARY:Example event");
    expect(mirror).toContain("LOCATION:Example location");
  });

  it("round-trips back to an original with the source UID and no markers", () => {
    const back = toOriginal(mirror, "abc123@google.com", ["icloud"]);
    expect(back).toContain("X-SYNC-MIRRORED:icloud");
    expect(uidOf(back)).toBe("abc123@google.com");
    expect(back.some((l) => l.startsWith(X_SOURCE) || l.startsWith(X_FP))).toBe(false);
    const stamped = withMirrored(lines, "icloud");
    expect(stamped.filter((l) => l.startsWith("X-SYNC-MIRRORED"))).toEqual(["X-SYNC-MIRRORED:icloud"]);
    expect(stamped.some((l) => l.startsWith("ATTENDEE"))).toBe(true); // originals keep their attendees
    expect(withMirrored(stamped, "icloud").filter((l) => l.startsWith("X-SYNC-MIRRORED"))).toHaveLength(1);
  });

  it("mirror UID is deterministic and safe", () => {
    expect(mirrorUid("google", "abc123@google.com")).toBe("abc123@google.com-mirror-google");
    expect(mirrorUid("icloud", "we!rd uid")).toBe("we_rd_uid-mirror-icloud");
  });
});

describe("fingerprint", () => {
  const base = unfold(GOOGLE_FLIGHT);
  it("ignores server-rewritten noise", () => {
    const noisy = base.map((l) =>
      l.startsWith("DTSTAMP") ? "DTSTAMP:20240612T000000Z" : l.startsWith("PRODID") ? "PRODID:-//Apple//EN" : l,
    );
    noisy.splice(noisy.indexOf("END:VEVENT"), 0, "SEQUENCE:3");
    expect(fingerprint(noisy)).toBe(fingerprint(base));
  });
  it("ignores attendees and sync markers, so a mirror fingerprints like its source", () => {
    const mirror = toMirror(base, { uid: "m", sourceSide: "google", sourceUid: "abc", fp: "x" });
    expect(fingerprint(mirror)).toBe(fingerprint(base));
  });
  it("changes when a human would notice", () => {
    const moved = base.map((l) => (l.startsWith("DTSTART") ? "DTSTART;TZID=America/Chicago:20240624T200000" : l));
    expect(fingerprint(moved)).not.toBe(fingerprint(base));
    const renamed = base.map((l) => (l.startsWith("SUMMARY") ? "SUMMARY:Updated event" : l));
    expect(fingerprint(renamed)).not.toBe(fingerprint(base));
  });
  it("ignores Google's padding: empty DESCRIPTION/LOCATION and default STATUS/TRANSP", () => {
    const apple = unfold(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:a",
        "DTSTART;VALUE=DATE:20240623",
        "DTEND;VALUE=DATE:20240625",
        "SUMMARY:All-day event",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const google = unfold(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:a-mirror-icloud",
        "DTSTART;VALUE=DATE:20240623",
        "DTEND;VALUE=DATE:20240625",
        "DESCRIPTION:",
        "LOCATION:",
        "SEQUENCE:1",
        "STATUS:CONFIRMED",
        "SUMMARY:All-day event",
        "TRANSP:OPAQUE",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(fingerprint(google)).toBe(fingerprint(apple));
    const cancelled = google.map((l) => (l === "STATUS:CONFIRMED" ? "STATUS:CANCELLED" : l));
    expect(fingerprint(cancelled)).not.toBe(fingerprint(apple));
  });
  it("treats the same instant in UTC and in a zone as equal", () => {
    const utc = base.map((l) =>
      l.startsWith("DTSTART") ? "DTSTART:20240625T003500Z" : l.startsWith("DTEND") ? "DTEND:20240625T042500Z" : l,
    );
    expect(fingerprint(utc)).toBe(fingerprint(base));
  });
});

it("ignores alarm properties when reading event identity", () => {
  expect(eventProp(["BEGIN:VEVENT", "BEGIN:VALARM", "UID:alarm", "END:VALARM", "UID:event", "END:VEVENT"], "UID")).toBe(
    "event",
  );
  expect(eventProp(["UID:outside"], "UID")).toBeNull();
});
it("preserves invitations per occurrence when writing an edited mirror back", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:x",
    "ORGANIZER:mailto:owner@example.com",
    "ATTENDEE:mailto:first@example.com",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:x",
    "RECURRENCE-ID:20261101T120000Z",
    "ATTENDEE:mailto:second@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const mirror = toMirror(source, { uid: "m", sourceSide: "a", sourceUid: "x", fp: "x" });
  const restored = toOriginal(mirror, "x", [], source);
  expect(restored).toEqual(source);
  expect(mirror.some((l) => l.startsWith("ATTENDEE") || l.startsWith("ORGANIZER"))).toBe(false);
});
it("detects fields swapped between recurring occurrences and ignores component order", () => {
  const occurrence = (date: string, title: string) => [
    "BEGIN:VEVENT",
    "UID:x",
    `RECURRENCE-ID:${date}`,
    `SUMMARY:${title}`,
    "END:VEVENT",
  ];
  const a = occurrence("20261101T120000Z", "One"),
    b = occurrence("20261102T120000Z", "Two");
  expect(fingerprint([...a, ...b])).toBe(fingerprint([...b, ...a]));
  expect(fingerprint([...a, ...b])).not.toBe(
    fingerprint([...occurrence("20261101T120000Z", "Two"), ...occurrence("20261102T120000Z", "One")]),
  );
});
it.each([
  ["20260308T033000", "2026-03-08T08:30:00Z"],
  ["20261101T023000", "2026-11-01T08:30:00Z"],
  ["20261101T013000", "2026-11-01T06:30:00Z"],
  ["20260308T023000", "2026-03-08T08:30:00Z"],
])("normalizes Chicago DST time %s", async (local, utc) => {
  const { normalizeDateLine } = await import("../src/ics.js");
  expect(normalizeDateLine(`DTSTART;TZID=America/Chicago:${local}`)).toBe(`DTSTART=${Date.parse(utc)}`);
});

it.each(["EXDATE", "RDATE"])("detects %s timezone edits and ignores equivalent list formatting", (property) => {
  const fp = (...dates: string[]) =>
    fingerprint(["BEGIN:VEVENT", "UID:dates", "DTSTART:20261001T130000Z", ...dates, "END:VEVENT"]);
  const ny = `${property};TZID=America/New_York:20261008T090000,20261009T090000`;
  expect(fp(ny)).not.toBe(fp(ny.replace("New_York", "Los_Angeles")));
  expect(fp(ny)).toBe(fp(`${property}:20261009T130000Z`, `${property}:20261008T130000Z`));
  expect(fp(`${property};VALUE=DATE:20261008,20261009`)).toBe(
    fp(`${property};VALUE=DATE:20261009`, `${property};VALUE=DATE:20261008`),
  );
  expect(fp(`${property};VALUE=DATE:20261008`)).not.toBe(fp(`${property}:20261008T000000Z`));
  expect(fp(`${property}:20261008T090000`)).not.toBe(fp(`${property}:20261008T090000Z`));
});

it("preserves period semantics and timezones in RDATE", () => {
  const fp = (date: string) => fingerprint(["BEGIN:VEVENT", "UID:period", date, "END:VEVENT"]);
  expect(fp("RDATE;VALUE=PERIOD;TZID=America/New_York:20261008T090000/20261008T100000")).toBe(
    fp("RDATE;VALUE=PERIOD:20261008T130000Z/20261008T140000Z"),
  );
  expect(fp("RDATE;VALUE=PERIOD;TZID=America/New_York:20261008T090000/PT1H")).not.toBe(
    fp("RDATE;VALUE=PERIOD;TZID=America/Los_Angeles:20261008T090000/PT1H"),
  );
});

it("preserves implicit zero-duration timed events through Apple's explicit duration/end", async () => {
  const { withExplicitZeroDuration } = await import("../src/ics.js");
  const base = ["BEGIN:VEVENT", "UID:zero", "DTSTART;TZID=America/Sao_Paulo:20190807T110000", "END:VEVENT"];
  const explicit = withExplicitZeroDuration(base);
  expect(explicit).toContain("DURATION:PT0S");
  expect(fingerprint(explicit)).toBe(fingerprint(base));
  expect(fingerprint([...base.slice(0, -1), "DTEND;TZID=America/Sao_Paulo:20190807T110000", "END:VEVENT"])).toBe(
    fingerprint(base),
  );
  expect(fingerprint([...base.slice(0, -1), "DTEND;TZID=America/Sao_Paulo:20190807T110100", "END:VEVENT"])).not.toBe(
    fingerprint(base),
  );
  for (const invalid of ["P", "PT"])
    expect(fingerprint([...base.slice(0, -1), `DURATION:${invalid}`, "END:VEVENT"])).not.toBe(fingerprint(base));
  const allDay = base.map((l) => (l.startsWith("DTSTART") ? "DTSTART;VALUE=DATE:20190807" : l));
  expect(withExplicitZeroDuration(allDay)).toEqual(allDay);
  expect(withExplicitZeroDuration(explicit)).toEqual(explicit);
});

it("recognizes fingerprints saved before zero-duration normalization without accepting real edits", async () => {
  const { matchesFingerprint } = await import("../src/ics.js");
  const lines = [
    "BEGIN:VEVENT",
    "UID:zero",
    "DTSTART:20261008T120000Z",
    "DTEND:20261008T120000Z",
    "SUMMARY:Zero",
    "END:VEVENT",
  ];
  const saved = "fdcfdeb0098afe57";
  expect(fingerprint(lines, true)).toBe(saved);
  expect(fingerprint(lines)).not.toBe(saved);
  expect(matchesFingerprint(lines, saved)).toBe(true);
  expect(matchesFingerprint(lines, fingerprint(lines))).toBe(true);
  expect(matchesFingerprint(lines, null)).toBe(false);
  expect(
    matchesFingerprint(
      lines.map((l) => l.replace("SUMMARY:Zero", "SUMMARY:Edited")),
      saved,
    ),
  ).toBe(false);
  expect(
    matchesFingerprint(
      lines.map((l) => l.replace("DTEND:20261008T120000Z", "DTEND:20261008T130000Z")),
      saved,
    ),
  ).toBe(false);
});
