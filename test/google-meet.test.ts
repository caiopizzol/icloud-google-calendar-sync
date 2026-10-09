import { describe, expect, it } from "vitest";
import { fold, toMirror, unfold, withoutGoogleMeetFooter } from "../src/ics.js";
import { parse, planDirection, type Parsed, type Side } from "../src/sync.js";

const boundary = "-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-";
const join = "https://meet.google.com/aaa-bbbb-ccc";
const rotated = "https://meet.google.com/ddd-eeee-fff";
const description = `Notes\\nVideo call: ${join}`;
const footer = (url = rotated, support = "https://support.google.com/meet?p=meeting_codes") =>
  [
    boundary,
    `Join with Google Meet: ${url}`,
    "",
    ...(support
      ? [
          "The Google Meet link was automatically updated to keep the meeting private and secure. Learn more about Google Meet meeting codes at: ",
          support,
          "",
        ]
      : []),
    "Please do not edit this section.",
    boundary,
  ].join("\\n");
const appended = (text = description, block = footer()) => `${text}\\n\\n${block}`;

const google: Side = { id: "google", url: "https://g/events/", auth: { kind: "basic", user: "u", pass: "p" } };
const icloud: Side = { ...google, id: "icloud", url: "https://i/cal/" };
const event = (href: string, lines: string[]): Parsed => parse({ href, etag: '"1"', ics: fold(lines) })!;
const original = (text = description) =>
  event(icloud.url + "source.ics", [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:source",
    "DTSTART:20261008T120000Z",
    "SUMMARY:Meeting",
    "LAST-MODIFIED:20261001T000000Z",
    `DESCRIPTION:${text}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
const edit = (source: Parsed, name: string, value: string) =>
  event(
    source.href,
    source.lines.map((line) => (line.startsWith(name + ":") ? `${name}:${value}` : line)),
  );
const copy = (source: Parsed, side = icloud) =>
  event(
    google.url + "copy.ics",
    toMirror(source.lines, {
      uid: "copy",
      sourceSide: side.id,
      sourceUid: source.uid,
      fp: source.fp,
    }),
  );

describe("Google Meet footer recognition", () => {
  it.each([footer(), footer(join, "https://support.google.com/calendar?p=meeting_code_reuse"), footer(join, "")])(
    "removes an observed footer from DESCRIPTION only",
    (block) => {
      const lines = [`DESCRIPTION:${appended(description, block)}`, `LOCATION:${block}`, `SUMMARY:${block}`];
      expect(withoutGoogleMeetFooter(unfold(fold(lines)))).toEqual([`DESCRIPTION:${description}`, lines[1], lines[2]]);
      expect(withoutGoogleMeetFooter([`DESCRIPTION:${block}`])).toEqual(["DESCRIPTION:"]);
    },
  );

  it.each([
    appended() + "\\nMy note",
    appended(description, footer().replace("Please do not edit this section.", "Custom notes")),
    appended(description, footer("https://example.com/meeting")),
    description + footer(),
    description + "\\nJoin with Google Meet: " + rotated,
  ])("keeps human text and unrecognized blocks", (text) => {
    expect(withoutGoogleMeetFooter([`DESCRIPTION:${text}`])).toEqual([`DESCRIPTION:${text}`]);
  });
});

describe("Google Meet mirror planning", () => {
  it.each([footer(), footer(join, "")])("does nothing for a generated footer, without re-stamping", (block) => {
    const source = original();
    const mirror = edit(copy(source), "DESCRIPTION", appended(description, block));
    expect(planDirection(icloud, google, [source], [mirror])).toEqual([]);
  });

  it("refreshes a changed source despite Google's later timestamp, then settles after Google appends again", () => {
    const source = original();
    const mirror = edit(edit(copy(source), "DESCRIPTION", appended()), "LAST-MODIFIED", "20261003T000000Z");
    const changed = edit(edit(source, "SUMMARY", "New agenda"), "LAST-MODIFIED", "20261002T000000Z");
    const actions = planDirection(icloud, google, [changed], [mirror]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "put", on: "google", href: mirror.href });
    if (actions[0].kind !== "put") throw new Error("Expected mirror refresh");
    const refreshed = parse({ ...mirror, ics: actions[0].ics })!;
    expect(refreshed.fp).toBe(changed.fp);
    expect(refreshed.fpAtCopy).toBe(changed.fp);
    const stored = edit(refreshed, "DESCRIPTION", appended());
    expect(planDirection(icloud, google, [changed], [stored])).toEqual([]);
  });

  it("ignores replacement of a pasted footer when the original has not changed", () => {
    const source = original(appended(description, footer(join, "")));
    expect(planDirection(icloud, google, [source], [edit(copy(source), "DESCRIPTION", appended())])).toEqual([]);
  });

  it.each([description, appended(description, footer(join, ""))])(
    "refreshes a stale baseline from the source when only the footer differs",
    (text) => {
      const source = original(text);
      const mirror = edit(
        edit(edit(copy(source), "X-SYNC-FP", "old-fingerprint-rules"), "DESCRIPTION", appended()),
        "LAST-MODIFIED",
        "20261003T000000Z",
      );
      const actions = planDirection(icloud, google, [source], [mirror]);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ kind: "put", on: "google", href: mirror.href });
      if (actions[0].kind !== "put") throw new Error("Expected mirror refresh");
      const refreshed = parse({ ...mirror, ics: actions[0].ics })!;
      expect(refreshed.fpAtCopy).toBe(source.fp);
      expect(planDirection(icloud, google, [source], [edit(refreshed, "DESCRIPTION", appended())])).toEqual([]);
    },
  );

  it.each([
    ["SUMMARY", "Edited title"],
    ["DESCRIPTION", appended("Notes\\nVideo call: https://meet.google.com/xxx-yyyy-zzz")],
    ["DESCRIPTION", appended() + "\\nMy note"],
    ["DESCRIPTION", appended(description, footer("https://example.com/meeting"))],
    ["DESCRIPTION", appended(description, footer().replace("Please do not edit this section.", "Custom notes"))],
  ])("still pushes back a human edit to %s", (name, value) => {
    const source = original();
    const mirror = edit(edit(copy(source), "DESCRIPTION", appended()), name, value);
    const actions = planDirection(icloud, google, [source], [mirror]);
    expect(actions.map((a) => [a.kind, a.on])).toEqual([
      ["put", "icloud"],
      ["put", "google"],
    ]);
    if (actions[0].kind === "put") expect(unfold(actions[0].ics)).toContain(`${name}:${value}`);
  });

  it("still pushes back removal of a pasted footer", () => {
    const source = original(appended());
    const actions = planDirection(icloud, google, [source], [edit(copy(source), "DESCRIPTION", description)]);
    expect(actions[0]).toMatchObject({ kind: "put", on: "icloud" });
  });

  it("still refreshes iCloud when a Google original's meeting link changes", () => {
    const source = original(appended(description, footer(join, "")));
    const mirror = copy(source, google);
    const changed = edit(source, "DESCRIPTION", appended());
    expect(changed.fp).not.toBe(source.fp);
    const actions = planDirection(google, icloud, [changed], [mirror]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "put", on: "icloud" });
    if (actions[0].kind === "put") expect(unfold(actions[0].ics)).toContain(`DESCRIPTION:${appended()}`);
  });

  it("does not ignore an appended footer on an iCloud copy", () => {
    const source = original();
    const mirror = edit(copy(source, google), "DESCRIPTION", appended());
    expect(planDirection(google, icloud, [source], [mirror])[0]).toMatchObject({ kind: "put", on: "google" });
  });
});
