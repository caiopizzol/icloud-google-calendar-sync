import { afterEach, describe, expect, it, vi } from "vitest";
import { findByUid } from "../src/caldav.js";

const auth = { kind: "basic", user: "u", pass: "p" } as const;
const calendar = "https://calendar.example/events/";
const response = (uid: string, index: number) => `
  <d:response><d:href>/events/${index}.ics</d:href><d:propstat><d:prop>
  <d:getetag>"1"</d:getetag><c:calendar-data><![CDATA[BEGIN:VCALENDAR
BEGIN:VEVENT
UID:${uid}
DTSTART:20200101T120000Z
END:VEVENT
END:VCALENDAR]]></c:calendar-data>
  </d:prop></d:propstat></d:response>`;

afterEach(() => vi.unstubAllGlobals());

describe("findByUid", () => {
  it.each([
    { name: "unrelated events only", uids: ["unrelated", "wanted-mirror-google"], match: null },
    { name: "exact match after unrelated events", uids: ["unrelated", "wanted"], match: 1 },
    { name: "folded UID outside the sync window", uids: ["unrelated", "wan\r\n ted"], match: 1 },
    { name: "no events", uids: [], match: null },
  ])("handles $name", async ({ uids, match }) => {
    // Google may ignore the UID filter and return unrelated calendar resources.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${uids
              .map(response)
              .join("")}</d:multistatus>`,
            { status: 207 },
          ),
        ),
    );
    const event = await findByUid(auth, calendar, "wanted");
    expect(event?.href ?? null).toBe(match === null ? null : `${calendar}${match}.ics`);
  });

  it("throws on lookup failure instead of treating the event as absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(findByUid(auth, calendar, "wanted")).rejects.toThrow("503");
  });

  it.each(["wanted", "absent"])("finds an iCloud UID without an unsupported property filter: %s", async (uid) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${collectionResponse}${response("wanted", 0)}</d:multistatus>`,
          { status: 207 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const event = await findByUid(auth, "https://p44-caldav.icloud.com/events/", uid);
    expect(event?.href ?? null).toBe(uid === "wanted" ? "https://p44-caldav.icloud.com/events/0.ics" : null);
    expect(fetch.mock.calls[0][1].body).not.toContain("prop-filter");
    expect(fetch.mock.calls[0][1].body).not.toContain("time-range");
  });

  it("does not use the iCloud compatibility query on another host", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 }));
    vi.stubGlobal("fetch", fetch);
    await findByUid(auth, "https://p44-caldav.icloud.com.attacker.example/events/", "wanted");
    expect(fetch.mock.calls[0][1].body).toContain("prop-filter");
  });
});

const collectionResponse = `<d:response><d:href>/events/</d:href>
  <d:propstat><d:prop><d:getetag>"collection"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><c:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
</d:response>`;

it.each([
  collectionResponse.replace("404 Not Found", "403 Forbidden"),
  collectionResponse.replace("/events/", "/events/missing.ics"),
  collectionResponse.replace("<c:calendar-data/>", "<c:calendar-data/><d:getetag/>"),
])("does not turn failed calendar access or child properties into absence %#", async (body) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(`<d:multistatus>${body}</d:multistatus>`, { status: 207 })),
  );
  await expect(findByUid(auth, "https://p44-caldav.icloud.com/events/", "wanted")).rejects.toThrow();
});

it("requests expanded occurrences only for review", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 }));
  vi.stubGlobal("fetch", fetch);
  const { listOccurrences } = await import("../src/caldav.js");
  await listOccurrences(auth, calendar, { start: new Date("2026-09-01Z"), end: new Date("2026-10-01Z") });
  expect(fetch.mock.calls[0][1].method).toBe("REPORT");
  expect(fetch.mock.calls[0][1].body).toContain('<c:expand start="20260901T000000Z" end="20261001T000000Z"/>');
});

it.each([
  "<html>Login required</html>",
  "<d:multistatus><d:response><d:href>/events/x</d:href></d:multistatus>",
  "<d:multistatus><d:error>failed</d:error></d:multistatus>",
  "<d:multistatus><d:response><d:status>HTTP/1.1 403 Forbidden</d:status></d:response></d:multistatus>",
  "<d:multistatus><d:response><d:href>/events/x</d:href></d:response></d:multistatus>",
])("does not interpret an invalid or incomplete report as absence %#", async (body) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 207 })));
  await expect(findByUid(auth, calendar, "wanted")).rejects.toThrow();
});
it.each(["https://attacker.example/events/0.ics", "/other-calendar/0.ics"])(
  "rejects event URLs outside the collection: %s",
  async (href) => {
    const { parseEvents } = await import("../src/caldav.js");
    expect(() =>
      parseEvents(`<d:multistatus>${response("wanted", 0).replace("/events/0.ics", href)}</d:multistatus>`, calendar),
    ).toThrow();
  },
);
it("keeps entity-looking text inside CDATA unchanged", async () => {
  const { xmlText } = await import("../src/caldav.js");
  expect(xmlText("<![CDATA[SUMMARY:Literally &amp; and &#65;]]>")).toBe("SUMMARY:Literally &amp; and &#65;");
  expect(xmlText("SUMMARY:A &amp; B")).toBe("SUMMARY:A & B");
});
it("refuses unconditional deletion and prevents redirect following", async () => {
  const { deleteEvent, dav } = await import("../src/caldav.js");
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);
  await expect(deleteEvent(auth, calendar + "x.ics", null)).rejects.toThrow(/ETag/);
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValue(new Response(null, { status: 204 }));
  await dav(auth, "DELETE", calendar + "x.ics");
  expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
});

const googleTombstone = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Google Inc//Google Calendar//EN",
  "BEGIN:VTIMEZONE",
  "TZID:America/Sao_Paulo",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0300",
  "TZOFFSETTO:-0300",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
  "END:VCALENDAR",
].join("\r\n");
const googleCollection = "https://apidata.googleusercontent.com/caldav/v2/test/events/";
const googleReport = (ics: string) =>
  `<d:multistatus><d:response><d:href>${googleCollection}cancelled.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data><![CDATA[${ics}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

it("ignores the timezone-only payload Google returns for a cancelled series", async () => {
  const { parseEvents } = await import("../src/caldav.js");
  expect(parseEvents(googleReport(googleTombstone), googleCollection)).toEqual([]);
});

it.each([
  googleTombstone.replace("END:VCALENDAR", ""),
  googleTombstone.replace("END:STANDARD", "END:DAYLIGHT"),
  googleTombstone.replace("END:VCALENDAR", "BEGIN:VEVENT\r\nSUMMARY:Missing UID\r\nEND:VEVENT\r\nEND:VCALENDAR"),
])("rejects malformed Google payloads instead of mistaking them for deleted events %#", async (ics) => {
  const { parseEvents } = await import("../src/caldav.js");
  expect(() => parseEvents(googleReport(ics), googleCollection)).toThrow();
});

it("lists all resources without a time-range when no window is supplied", async () => {
  const { listEvents } = await import("../src/caldav.js");
  const fetch = vi.fn().mockResolvedValue(new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 }));
  vi.stubGlobal("fetch", fetch);
  await listEvents(auth, calendar);
  expect(fetch.mock.calls[0][1].body).not.toContain("time-range");
  expect(fetch.mock.calls[0][1].body).not.toContain("expand");
});

it.each([
  googleTombstone.replace("END:VCALENDAR", "begin:vevent\r\nUID:live\r\nend:vevent\r\nEND:VCALENDAR"),
  googleTombstone.replace("END:VCALENDAR", "BEGIN:VTODO\r\nEND:VTODO\r\nEND:VCALENDAR"),
  googleTombstone.replace("END:VTIMEZONE", ""),
  googleTombstone + "\r\nSUMMARY:trailing",
])("rejects non-timezone content in a Google empty resource %#", async (ics) => {
  const { parseEvents } = await import("../src/caldav.js");
  expect(() => parseEvents(googleReport(ics), googleCollection)).toThrow();
});

it.each(["", "HTTP/1.1 403 Forbidden"])(
  "requires successful calendar-data before ignoring a tombstone: %s",
  async (status) => {
    const { parseEvents } = await import("../src/caldav.js");
    expect(() =>
      parseEvents(googleReport(googleTombstone).replace("HTTP/1.1 200 OK", status), googleCollection),
    ).toThrow();
  },
);

it("rejects timezone-only resources from other providers", async () => {
  const { parseEvents } = await import("../src/caldav.js");
  expect(() => parseEvents(googleReport(googleTombstone).replaceAll(googleCollection, calendar), calendar)).toThrow();
});

it.each([false, true])("looks up the exact UID with a Google tombstone present (live=%s)", async (live) => {
  const xml = googleReport(googleTombstone).replace(
    "</d:multistatus>",
    `${live ? response("wanted", 0).replace("/events/0.ics", googleCollection + "live.ics") : ""}</d:multistatus>`,
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(xml, { status: 207 })));
  expect((await findByUid(auth, googleCollection, "wanted"))?.href ?? null).toBe(
    live ? googleCollection + "live.ics" : null,
  );
});

it.each([
  collectionResponse.replace("404 Not Found", "507 Insufficient Storage"),
  collectionResponse.replace("<c:calendar-data/>", "<c:calendar-data>incomplete</c:calendar-data>"),
  collectionResponse.replace("/events/", "https://p45-caldav.icloud.com/events/"),
  collectionResponse.replace("/events/", "/events"),
])("rejects incomplete or nonmatching collection responses %#", async (xml) => {
  const { parseEvents } = await import("../src/caldav.js");
  expect(() => parseEvents(`<d:multistatus>${xml}</d:multistatus>`, "https://p44-caldav.icloud.com/events/")).toThrow();
});
