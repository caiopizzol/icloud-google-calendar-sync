import { describe, expect, it } from "vitest";
import {
  eventProp,
  fingerprint,
  fold,
  matchesFingerprint,
  mirrorUid,
  normalizeDateLine,
  propValue,
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

it.each([
  ['DTSTART;TZID="GMT-03:00":20260101T090000', "20260101T090000"],
  ['ATTENDEE;CN="Team: planning; room A":mailto:team@example.com', "mailto:team@example.com"],
  ['DESCRIPTION;ALTREP="https://example.com:8443/a":Read this: details', "Read this: details"],
])("reads the value after quoted parameters in %s", (line, value) => {
  expect(propValue(line)).toBe(value);
});

it.each([
  ["GMT-0300", "2026-01-01T12:00:00Z"],
  ['"GMT-03:00"', "2026-01-01T12:00:00Z"],
  ["GMT+0530", "2026-01-01T03:30:00Z"],
  ['"GMT+05:30"', "2026-01-01T03:30:00Z"],
  ['"GMT-03:30"', "2026-01-01T12:30:00Z"],
  ['"GMT+00:00"', "2026-01-01T09:00:00Z"],
])("normalizes fixed offset %s", (zone, utc) => {
  for (const property of ["DTSTART", "DTEND", "RECURRENCE-ID"])
    expect(normalizeDateLine(`${property};TZID=${zone}:20260101T090000`)).toBe(`${property}=${Date.parse(utc)}`);
});

it("reads TZID only from its own parameter and keeps floating times distinct", () => {
  const anchored = normalizeDateLine('DTSTART;X-NOTE="at:9;TZID=GMT+0100";TZID="GMT-03:00":20260101T090000');
  expect(anchored).toBe(normalizeDateLine("DTSTART:20260101T120000Z"));
  expect(normalizeDateLine('DTSTART;X-NOTE="at:9;TZID=GMT+0100":20260101T090000')).toBe(
    normalizeDateLine("DTSTART:20260101T090000"),
  );
  expect(normalizeDateLine("DTSTART:20260101T090000")).not.toBe(normalizeDateLine("DTSTART:20260101T090000Z"));
  expect(normalizeDateLine("DTSTART:20260101T090000")).not.toBe(anchored);
});

it.each(["GMT+2400", "GMT+0360", "GMT+030", "GMT-03:00-extra", "Unknown/Zone"])(
  "preserves unsupported timezone %s as a literal",
  (zone) => {
    expect(normalizeDateLine(`DTSTART;TZID="${zone}":20260101T090000`)).toBe(`DTSTART=20260101T090000@${zone}`);
  },
);

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

it.each(["EXDATE", "RDATE"])("normalizes quoted GMT offsets in %s lists", (property) => {
  const fp = (...dates: string[]) => fingerprint(["BEGIN:VEVENT", "UID:dates", ...dates, "END:VEVENT"]);
  const local = `${property};TZID="GMT-03:00":20260102T090000,20260103T090000`;
  const utc = [`${property}:20260103T120000Z`, `${property}:20260102T120000Z`];
  expect(fp(local)).toBe(fp(...utc));
  expect(fp(local)).toBe(fp(local.replace('"GMT-03:00"', "GMT-0300")));
  expect(fp(local)).not.toBe(fp(local.replace("-03:00", "-03:30")));
  expect(fp(local)).not.toBe(fp(local.replace("20260103T090000", "20260103T100000")));
});

it("normalizes quoted GMT offsets in RDATE periods while preserving durations", () => {
  const fp = (date: string) => fingerprint(["BEGIN:VEVENT", "UID:period", date, "END:VEVENT"]);
  expect(fp('RDATE;VALUE=PERIOD;TZID="GMT-03:00":20260101T090000/20260101T100000')).toBe(
    fp("RDATE;VALUE=PERIOD:20260101T120000Z/20260101T130000Z"),
  );
  expect(fp('RDATE;TZID="GMT+05:30";VALUE=PERIOD:20260101T090000/PT1H')).toBe(
    fp("RDATE;VALUE=PERIOD:20260101T033000Z/PT1H"),
  );
  expect(fp('RDATE;TZID="GMT+05:30";VALUE=PERIOD:20260101T090000/PT1H')).not.toBe(
    fp('RDATE;TZID="GMT+05:30";VALUE=PERIOD:20260101T090000/PT2H'),
  );
});

it.each([
  ['"GMT-03:00"', "20260101T100000", "68778d652c833a10"],
  ["GMT-0300", "20260101T100000", "ec77dd98a141eff4"],
  ['"GMT-03:00"', "20260101T090000", "1c85d67233ce788e"],
  ["GMT-0300", "20260101T090000", "873b54544fbc1ff0"],
  ["GMT-0300", "20260101T090000", "a9eb6b764fa1c910"],
])("recognizes old GMT fingerprints without accepting edits (%s, %s, %s)", (zone, end, saved) => {
  const lines = [
    "BEGIN:VEVENT",
    "UID:fixed",
    `DTSTART;TZID=${zone}:20260101T090000`,
    `DTEND;TZID=${zone}:${end}`,
    "SUMMARY:Fixed offset",
    "END:VEVENT",
  ];
  expect(fingerprint(lines)).not.toBe(saved);
  expect(matchesFingerprint(lines, saved)).toBe(true);
  expect(matchesFingerprint(lines, fingerprint(lines))).toBe(true);
  for (const [before, after] of [
    ["SUMMARY:Fixed offset", "SUMMARY:Edited"],
    ["20260101T090000", "20260101T090100"],
    ["GMT-03", "GMT-04"],
  ])
    expect(
      matchesFingerprint(
        lines.map((line) => line.replace(before, after)),
        saved,
      ),
    ).toBe(false);
});

it("recognizes old quoted text and recurrence fingerprints without accepting edits", () => {
  const lines = [
    "BEGIN:VEVENT",
    "UID:quoted",
    "DTSTART:20260101T120000Z",
    'DESCRIPTION;ALTREP="https://example.com:8443/a":Read this: details',
    'RDATE;TZID="GMT-03:00":20260102T090000,20260103T090000',
    "END:VEVENT",
  ];
  const saved = "a177e2cb6dd38e2a";
  expect(matchesFingerprint(lines, saved)).toBe(true);
  expect(fingerprint(lines)).toBe(
    fingerprint(lines.map((line) => line.replace(';ALTREP="https://example.com:8443/a"', ""))),
  );
  for (const [before, after] of [
    ["Read this: details", "Read this: changed"],
    ["20260103T090000", "20260103T100000"],
  ])
    expect(
      matchesFingerprint(
        lines.map((line) => line.replace(before, after)),
        saved,
      ),
    ).toBe(false);
});

describe("monthly recurrence defaults", () => {
  const event = (rule: string, start = "DTSTART:20260108T090000Z") => [
    "BEGIN:VEVENT",
    "UID:monthly",
    `RRULE:${rule}`,
    start,
    "SUMMARY:Monthly",
    "END:VEVENT",
  ];

  it.each([
    "DTSTART:20260108T090000Z",
    "DTSTART:20260108T090000",
    "DTSTART;VALUE=DATE:20260108",
    'DTSTART;TZID="GMT-03:00":20260108T230000',
  ])("equates implicit and explicit local month-day for %s", (start) => {
    expect(fingerprint(event("FREQ=MONTHLY", start))).toBe(fingerprint(event("FREQ=MONTHLY;BYMONTHDAY=8", start)));
  });

  it.each(["COUNT=6", "UNTIL=20261208T090000Z", "INTERVAL=2;WKST=SU"])(
    "preserves %s while normalizing the default day and clause order",
    (modifier) => {
      expect(fingerprint(event(`FREQ=MONTHLY;${modifier}`))).toBe(
        fingerprint(event(`BYMONTHDAY=8;${modifier};FREQ=MONTHLY`)),
      );
    },
  );

  it.each(["BYMONTHDAY=9", "BYMONTHDAY=-1", "BYMONTHDAY=8,9", "BYMONTHDAY=8;BYMONTHDAY=9"])(
    "keeps %s distinct from the implicit monthly day",
    (day) => {
      expect(fingerprint(event(`FREQ=MONTHLY;${day}`))).not.toBe(fingerprint(event("FREQ=MONTHLY")));
      expect(matchesFingerprint(event(`FREQ=MONTHLY;${day}`), fingerprint(event("FREQ=MONTHLY")))).toBe(false);
    },
  );

  it("keeps day 31 distinct from the last day of each month", () => {
    const start = "DTSTART;VALUE=DATE:20260131";
    expect(fingerprint(event("FREQ=MONTHLY", start))).toBe(fingerprint(event("FREQ=MONTHLY;BYMONTHDAY=31", start)));
    expect(fingerprint(event("FREQ=MONTHLY", start))).not.toBe(fingerprint(event("FREQ=MONTHLY;BYMONTHDAY=-1", start)));
  });

  it.each([
    "BYDAY=MO",
    "BYDAY=-1MO",
    "BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    "BYSETPOS=1",
    "BYMONTH=1,3",
    "BYHOUR=9,10",
    "X-UNKNOWN=1",
    "COUNT=6;COUNT=12",
    "COUNT=6;UNTIL=20261231T090000Z",
  ])("does not remove a month-day constraint alongside %s", (other) => {
    const start = "DTSTART:20260831T090000Z";
    const implicit = event(`FREQ=MONTHLY;${other}`, start);
    const explicit = event(`FREQ=MONTHLY;${other};BYMONTHDAY=31`, start);
    expect(fingerprint(explicit)).not.toBe(fingerprint(implicit));
    expect(matchesFingerprint(explicit, fingerprint(implicit))).toBe(false);
  });

  it("preserves different monthly schedules across a local month boundary", () => {
    const local = event("FREQ=MONTHLY", 'DTSTART;TZID="GMT-03:00":20260131T230000');
    const utc = event("FREQ=MONTHLY;BYMONTHDAY=1", "DTSTART:20260201T020000Z");
    expect(fingerprint(local)).not.toBe(fingerprint(utc));
    expect(fingerprint(local)).toBe(
      fingerprint(event("FREQ=MONTHLY;BYMONTHDAY=31", 'DTSTART;TZID="GMT-03:00":20260131T230000')),
    );
  });

  it("leaves rules with missing, invalid, or multiple DTSTART values literal", () => {
    for (const starts of [[], ["DTSTART:20260231T090000Z"], ["DTSTART:20260108T090000Z", "DTSTART:20260109T090000Z"]]) {
      const base = ["BEGIN:VEVENT", ...starts, "RRULE:FREQ=MONTHLY", "END:VEVENT"];
      const explicit = base.map((line) => line.replace("FREQ=MONTHLY", "FREQ=MONTHLY;BYMONTHDAY=8"));
      expect(fingerprint(explicit)).not.toBe(fingerprint(base));
    }
  });

  it("accepts saved pre-normalization hashes without accepting edits", () => {
    const implicit = event("FREQ=MONTHLY;COUNT=6");
    const explicit = event("FREQ=MONTHLY;COUNT=6;BYMONTHDAY=8");
    const oldImplicit = "e389bf19fefaee72";
    const oldExplicit = "a15ba6974d1765ee";
    expect(fingerprint(implicit)).not.toBe(oldImplicit);
    expect(matchesFingerprint(implicit, oldImplicit)).toBe(true);
    expect(matchesFingerprint(explicit, oldExplicit)).toBe(true);
    expect(matchesFingerprint(explicit, oldImplicit)).toBe(true);
    const zero = explicit.map((line) =>
      line.replace("DTSTART:20260108T090000Z", 'DTSTART;TZID="GMT-03:00":20260108T060000'),
    );
    zero.splice(-1, 0, 'DTEND;TZID="GMT-03:00":20260108T060000');
    expect(matchesFingerprint(zero, "24b367b0caffa8f6")).toBe(true);
    for (const [before, after] of [
      ["COUNT=6", "COUNT=7"],
      ["BYMONTHDAY=8", "BYMONTHDAY=9"],
      ["SUMMARY:Monthly", "SUMMARY:Edited"],
      ["20260108T090000Z", "20260108T100000Z"],
    ]) {
      const edited = explicit.map((line) => line.replace(before, after));
      expect(matchesFingerprint(edited, oldImplicit)).toBe(false);
      expect(matchesFingerprint(edited, oldExplicit)).toBe(false);
    }
  });

  it("normalizes the master within a recurrence set and retains exception edits", () => {
    const master = event("FREQ=MONTHLY;COUNT=6");
    master.splice(-1, 0, "EXDATE:20260208T090000Z", "RDATE:20260115T090000Z");
    const exception = [
      "BEGIN:VEVENT",
      "UID:monthly",
      "RECURRENCE-ID:20260308T090000Z",
      "DTSTART:20260309T100000Z",
      "SUMMARY:Moved occurrence",
      "END:VEVENT",
    ];
    const source = [...master, ...exception];
    const target = [
      ...exception,
      ...master.map((line) => line.replace("FREQ=MONTHLY;COUNT=6", "FREQ=MONTHLY;COUNT=6;BYMONTHDAY=8")),
    ];
    expect(fingerprint(target)).toBe(fingerprint(source));
    for (const [before, after] of [
      ["20260309T100000Z", "20260309T110000Z"],
      ["20260308T090000Z", "20260408T090000Z"],
      ["EXDATE:20260208T090000Z", "EXDATE:20260408T090000Z"],
      ["RDATE:20260115T090000Z", "RDATE:20260116T090000Z"],
    ])
      expect(fingerprint(target.map((line) => line.replace(before, after)))).not.toBe(fingerprint(source));
  });
});

it("preserves occurrence invitations when a fixed GMT timezone is rewritten as UTC", () => {
  const original = [
    "BEGIN:VEVENT",
    "UID:fixed",
    'RECURRENCE-ID;TZID="GMT-03:00":20260101T090000',
    "ATTENDEE:mailto:guest@example.com",
    "END:VEVENT",
  ];
  const mirror = toMirror(original, {
    uid: "mirror",
    sourceSide: "a",
    sourceUid: "fixed",
    fp: fingerprint(original),
  }).map((line) => (line.startsWith("RECURRENCE-ID") ? "RECURRENCE-ID:20260101T120000Z" : line));
  expect(toOriginal(mirror, "fixed", [], original)).toContain("ATTENDEE:mailto:guest@example.com");
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
