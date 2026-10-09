import { expect, it } from "vitest";
import { fingerprint, fold, matchesFingerprint, normalizeDateLine, propValue, toMirror } from "../src/ics.js";
import { parse, planDirection, type Side } from "../src/sync.js";

it.each([
  ['DTSTART;TZID="GMT-03:00":20260101T090000', "20260101T090000"],
  ['ATTENDEE;CN="Team: planning; room A":mailto:team@example.com', "mailto:team@example.com"],
  ['DESCRIPTION;ALTREP="https://example.com:8443/a":Read this: details', "Read this: details"],
  ["DESCRIPTION:Read this: details", "Read this: details"],
])("reads the value after quoted parameters in %s", (line, value) => {
  expect(propValue(line)).toBe(value);
});

it("reads TZID from its own parameter without matching text inside another parameter", () => {
  expect(normalizeDateLine('DTSTART;X-NOTE="at:9;TZID=Asia/Tokyo";TZID=Europe/London:20260601T090000')).toBe(
    normalizeDateLine("DTSTART:20260601T080000Z"),
  );
  expect(normalizeDateLine('DTSTART;TZID="Custom:Zone":20260101T090000')).toBe("DTSTART=20260101T090000@Custom:Zone");
});

const source = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:quoted",
  "DTSTART:20261008T120000Z",
  "SUMMARY:Example",
  'DESCRIPTION;ALTREP="https://example.com/notes":Meeting notes',
  "LAST-MODIFIED:20261009T120000Z",
  "END:VEVENT",
  "END:VCALENDAR",
];
const saved = "05fb66548d2b5684"; // Fingerprint produced by v0.6.0.

it("fingerprints the actual description and recognizes its saved pre-fix baseline", () => {
  const plain = source.map((line) => line.replace(';ALTREP="https://example.com/notes"', ""));
  expect(fingerprint(source)).toBe(fingerprint(plain));
  expect(fingerprint(source)).not.toBe(saved);
  expect(matchesFingerprint(source, saved)).toBe(true);
  expect(
    matchesFingerprint(
      source.map((line) => line.replace("Meeting notes", "Changed notes")),
      saved,
    ),
  ).toBe(false);
});

it("preserves a mirror edit across the fingerprint correction even with an older modification timestamp", () => {
  const from: Side = { id: "a", url: "https://a.test/", auth: { kind: "basic", user: "u", pass: "p" } };
  const to = { ...from, id: "b", url: "https://b.test/" };
  const copy = toMirror(source, { uid: "copy", sourceSide: "a", sourceUid: "quoted", fp: saved }).map((line) =>
    line.replace("SUMMARY:Example", "SUMMARY:Edited copy").replace("20261009T120000Z", "20261008T120000Z"),
  );
  const original = parse({ href: from.url + "original.ics", etag: '"1"', ics: fold(source) })!;
  const mirror = parse({ href: to.url + "copy.ics", etag: '"2"', ics: fold(copy) })!;
  const actions = planDirection(from, to, [original], [mirror]);
  expect(actions[0]).toMatchObject({ kind: "put", on: "a", href: original.href });
  expect(actions[0].kind === "put" && actions[0].ics).toContain("SUMMARY:Edited copy");
});

it.each(["20261008T120000Z", "20261010T120000Z"])(
  "holds timezone edits hidden by a legacy fingerprint collision (mirror modified %s)",
  (modified) => {
    const from: Side = { id: "a", url: "https://a.test/", auth: { kind: "basic", user: "u", pass: "p" } };
    const to = { ...from, id: "b", url: "https://b.test/" };
    const lines = source.map((line) =>
      line.replace("DTSTART:20261008T120000Z", 'DTSTART;TZID="GMT-03:00":20260101T090000'),
    );
    const baseline = "f15102c71ee131c2"; // Both timezones produced this fingerprint in v0.6.0.
    const copy = toMirror(lines, { uid: "copy", sourceSide: "a", sourceUid: "quoted", fp: baseline }).map((line) =>
      line.replace("GMT-03:00", "GMT-04:00").replace("20261009T120000Z", modified),
    );
    expect(fingerprint(lines)).not.toBe(fingerprint(copy));
    expect(matchesFingerprint(lines, baseline)).toBe(true);
    expect(matchesFingerprint(copy, baseline)).toBe(true);
    const original = parse({ href: from.url + "original.ics", etag: '"1"', ics: fold(lines) })!;
    const mirror = parse({ href: to.url + "copy.ics", etag: '"2"', ics: fold(copy) })!;
    expect(() => planDirection(from, to, [original], [mirror])).toThrow(/Ambiguous legacy fingerprint/);
  },
);
