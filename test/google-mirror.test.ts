import { beforeEach, expect, it, vi } from "vitest";
import { CalDavError, googleCalendarUrl, providerUrlPolicy } from "../src/caldav.js";
import { actionNotice, performAction } from "../src/execution.js";
import { fingerprint, fold, propName, propValue, toMirror, unfold } from "../src/ics.js";
import {
  googleCalendarRestPolicy,
  putGoogleMirror,
  recoverGoogleMirrorWrite,
  type GoogleMirrorIntent,
  type GoogleMirrorStore,
} from "../src/google-mirror.js";
import { syncPair, type Side } from "../src/sync.js";

const transport = vi.hoisted(() => ({ dav: vi.fn(), putEvent: vi.fn(), listEvents: vi.fn() }));
vi.mock("../src/caldav.js", async (original) => ({
  ...(await original<typeof import("../src/caldav.js")>()),
  ...transport,
}));

const target: Side = {
  id: "google",
  url: googleCalendarUrl("calendar@example.com"),
  auth: {
    kind: "bearer",
    token: vi.fn(async () => "unused-token"),
    allowUrl: (url) => providerUrlPolicy("google")(url) || googleCalendarRestPolicy(url),
  },
};
const href = target.url + "mirror.ics";
const join = "https://meet.google.com/aaa-bbbb-ccc";
const rotated = "https://meet.google.com/ddd-eeee-fff";
const teams = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_123%40thread.v2/0?context=abc";
const boundary = "-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-";
const generated = [
  boundary,
  `Join with Google Meet: ${rotated}`,
  "",
  "The Google Meet link was automatically updated to keep the meeting private and secure. Learn more about Google Meet meeting codes at: ",
  "https://support.google.com/meet?p=meeting_codes",
  "",
  "Please do not edit this section.",
  boundary,
].join("\n");
const teamsFooter = [
  boundary,
  "Join Microsoft Teams Meeting",
  teams,
  "",
  "Please do not edit this section.",
  boundary,
].join("\n");
const encodeText = (text: string) =>
  text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(";", "\\;").replaceAll(",", "\\,");
const decodeText = (text: string) => text.replace(/\\([n,;\\])/g, (_, char: string) => (char === "n" ? "\n" : char));
const description = (text: string) => `DESCRIPTION:${encodeText(text)}`;

function intended(...properties: string[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:source",
    "DTSTART:20261008T120000Z",
    "SUMMARY:Example",
    ...properties,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return fold(toMirror(lines, { uid: "mirror", sourceSide: "icloud", sourceUid: "source", fp: fingerprint(lines) }));
}

function eventParts(ics: string): string[][] {
  const parts: string[][] = [];
  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") parts.push([]);
    else if (parts.length && !["END:VEVENT", "END:VCALENDAR"].includes(line)) parts.at(-1)!.push(line);
  }
  return parts;
}

function rewriteEvent(ics: string, index: number, text: string, location: string): string {
  let event = -1;
  return fold(
    unfold(ics).flatMap((line) => {
      if (line === "BEGIN:VEVENT") event++;
      if (event !== index) return [line];
      if (["DESCRIPTION", "LOCATION"].includes(propName(line))) return [];
      if (line === "END:VEVENT") return [description(text), `LOCATION:${encodeText(location)}`, line];
      return [line];
    }),
  );
}

type Remote = {
  id: string;
  etag: string;
  iCalUID: string;
  organizer: { self: boolean };
  description?: string;
  location?: string;
  conferenceData?: object | null;
  originalStartTime?: { dateTime?: string; date?: string };
  recurringEventId?: string;
};

function fixture(ics = intended(description(`Notes\nVideo call: ${join}`))) {
  let saved: GoogleMirrorIntent | null = null;
  const records: (GoogleMirrorIntent | null)[] = [];
  const order: string[] = [];
  const store: GoogleMirrorStore = {
    load: vi.fn(async () => structuredClone(saved)),
    save: vi.fn(async (intent) => {
      saved = structuredClone(intent);
      records.push(structuredClone(intent));
      order.push(intent?.phase ?? "clear");
    }),
  };
  const state = { ics, etag: '"caldav-1"', missing: false, patchFailure: 0, failAfterPatch: false };
  const restEvents: Remote[] = eventParts(ics).map((properties, index) => ({
    id: index ? `override-${index}` : "master",
    etag: `"rest-${index}-1"`,
    iCalUID: "mirror",
    organizer: { self: true },
    description: decodeText(propValue(properties.find((line) => propName(line) === "DESCRIPTION") ?? "")),
    location: decodeText(propValue(properties.find((line) => propName(line) === "LOCATION") ?? "")),
    conferenceData: { conferenceId: "new-link" },
    ...(index ? { originalStartTime: { dateTime: "2026-10-09T09:00:00-03:00" }, recurringEventId: "master" } : {}),
  }));
  const patches: { id: string; etag: string; body: Record<string, unknown> }[] = [];
  transport.putEvent.mockImplementation(async () => {
    order.push("PUT");
  });
  transport.dav.mockImplementation(
    async (_auth, method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}) => {
      const parsed = new URL(url);
      order.push(method === "PATCH" ? "PATCH" : parsed.hostname === "www.googleapis.com" ? "REST GET" : "CalDAV GET");
      if (url === href) {
        if (state.missing) throw new CalDavError(404, method, url, "");
        if (state.failAfterPatch && patches.length) throw new CalDavError(401, method, url, "");
        return { status: 200, text: state.ics, headers: new Headers({ etag: state.etag }) };
      }
      expect(googleCalendarRestPolicy(parsed)).toBe(true);
      if (parsed.searchParams.has("iCalUID")) {
        expect(parsed.searchParams.get("iCalUID")).toBe("mirror");
        expect(parsed.searchParams.get("singleEvents")).toBe("false");
        return { status: 200, text: JSON.stringify({ items: restEvents }), headers: new Headers() };
      }
      const id = decodeURIComponent(parsed.pathname.split("/").at(-1)!);
      const index = restEvents.findIndex((event) => event.id === id);
      expect(index).toBeGreaterThanOrEqual(0);
      const event = restEvents[index];
      if (method === "PATCH") {
        if (state.patchFailure) throw new CalDavError(state.patchFailure, method, url, "");
        expect(init.headers?.["If-Match"]).toBe(event.etag);
        expect(parsed.searchParams.get("conferenceDataVersion")).toBe("1");
        expect(parsed.searchParams.get("sendUpdates")).toBe("none");
        const body = JSON.parse(init.body!);
        patches.push({ id, etag: event.etag, body });
        Object.assign(event, body, { etag: `"rest-${index}-patched"` });
        state.ics = rewriteEvent(state.ics, index, body.description, body.location);
        state.etag = '"caldav-patched"';
        if (index === 0) for (const override of restEvents.slice(1)) override.etag = '"changed-by-master"';
      }
      return { status: 200, text: JSON.stringify(event), headers: new Headers() };
    },
  );
  return {
    ics,
    state,
    store,
    records,
    order,
    patches,
    restEvents,
    pending: () => saved,
    seed: (phase: GoogleMirrorIntent["phase"] = "written", etag: string | null = null) => {
      saved = { version: 1, calendar: target.url, href, etag, ics, phase };
    },
    normalize: (human?: string, location = "", footer = generated) => {
      for (const [index, event] of restEvents.entries()) {
        const uri = /https:\/\/[^\s]+/.exec(footer)?.[0];
        event.conferenceData = { entryPoints: [{ entryPointType: "video", uri }] };
        state.ics = rewriteEvent(
          state.ics,
          index,
          [human ?? event.description, footer].filter(Boolean).join("\n\n"),
          location,
        );
      }
    },
  };
}

beforeEach(() => vi.resetAllMocks());

it.each([
  ["plain text", `Notes\nVideo call: ${join}`, "", `Notes\nVideo call: ${join}`],
  ["legacy Video Call", `----( Video Call )----\n${join}\n---===---`, "", ""],
  ["legacy Gmail", `----( Gmail )----\n${join}\n---===---`, "", ""],
  ["location only", "Notes", join, "Notes"],
])("repairs %s normalization and verifies exact intended content", async (_kind, text, location, human) => {
  const x = fixture(intended(description(text), `LOCATION:${location}`));
  x.normalize(human);
  await putGoogleMirror(target, href, x.ics, null, x.store);
  expect(x.order[0]).toBe("prepared");
  expect(x.order.indexOf("prepared")).toBeLessThan(x.order.indexOf("PUT"));
  expect(x.order.at(-1)).toBe("clear");
  expect(x.patches).toEqual([
    { id: "master", etag: '"rest-0-1"', body: { conferenceData: null, description: text, location } },
  ]);
  expect(fingerprint(unfold(x.state.ics))).toBe(fingerprint(unfold(x.ics)));
  expect(x.pending()).toBeNull();
});

it("decodes intended text without collapsing whitespace, escapes, or literal backslashes", async () => {
  const text = `A, B; C \\ notes\n\n  Video call: ${join}`;
  const x = fixture(intended(description(text)));
  x.normalize();
  await putGoogleMirror(target, href, x.ics, null, x.store);
  expect(x.patches[0].body.description).toBe(text);
});

it("corrects a known Teams footer while retaining visible and encoded extension join information", async () => {
  const text = `Join: ${teams}`;
  const x = fixture(
    intended(
      description(text),
      `X-RDCAL-CONFERENCEINFO:${encodeURIComponent(JSON.stringify({ url: teams }))}`,
      "X-MICROSOFT-ONLINEMEETINGCONFLINK:conf:sip:meeting@example.com",
      "X-MICROSOFT-ONLINEMEETINGINFORMATION:{}",
    ),
  );
  x.normalize(text, "", teamsFooter);
  await putGoogleMirror(target, href, x.ics, null, x.store);
  expect(x.patches[0].body.description).toBe(text);
  expect(unfold(x.state.ics)).toContain("X-MICROSOFT-ONLINEMEETINGCONFLINK:conf:sip:meeting@example.com");
});

it("accepts Google's observed calendar support URL in the rotation notice", async () => {
  const x = fixture();
  x.normalize(
    undefined,
    "",
    generated.replace(
      "https://support.google.com/meet?p=meeting_codes",
      "https://support.google.com/calendar?p=meeting_code_reuse",
    ),
  );
  await putGoogleMirror(target, href, x.ics, null, x.store);
  expect(x.patches).toHaveLength(1);
  expect(x.pending()).toBeNull();
});

it.each(["zoom.us", "us02web.zoom.us", "us04web.zoom.us"])("accepts the exact Zoom footer for %s", async (host) => {
  const uri = `https://${host}/j/12345678?pwd=example`;
  const text = `Join: ${uri}`;
  const x = fixture(intended(description(text)));
  x.normalize(
    text,
    "",
    [boundary, "Join Zoom Meeting", uri, "", "Please do not edit this section.", boundary].join("\n"),
  );
  await putGoogleMirror(target, href, x.ics, null, x.store);
  expect(x.patches[0].body.description).toBe(text);
});

it("accepts a preserved legacy Teams wrapper before the generated footer", async () => {
  const text = `----( Video Call )----\n${teams}\n---===---`;
  const x = fixture(intended(description(text)));
  x.normalize(text, "", teamsFooter);
  await putGoogleMirror(target, href, x.ics, null, x.store);
  expect(x.patches[0].body.description).toBe(text);
});

it.each(["description", "location", "conferenceData"])(
  "does not overwrite a newer REST %s while CalDAV still shows the earlier version",
  async (field) => {
    const x = fixture();
    x.normalize();
    Object.assign(x.restEvents[0], {
      [field]:
        field === "conferenceData"
          ? { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/ggg-hhhh-iii" }] }
          : "A human edit",
    });
    await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toThrow(/remains pending/);
    expect(x.patches).toEqual([]);
    expect(x.pending()).not.toBeNull();
  },
);

it("stops if the REST version changes across the CalDAV read", async () => {
  const x = fixture();
  x.normalize();
  const request = transport.dav.getMockImplementation()!;
  let reads = 0;
  transport.dav.mockImplementation(async (...args: unknown[]) => {
    const response = await request(...args);
    if (args[1] === "GET" && String(args[2]).endsWith("/master") && ++reads === 1)
      x.restEvents[0].etag = '"concurrent-edit"';
    return response;
  });
  await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toThrow(/remains pending/);
  expect(x.patches).toEqual([]);
});

it.each(["X-GOOGLE-CONFERENCE", "CONFERENCE", "X-RDCAL-CONFERENCEINFO"])(
  "holds extension-only %s joining information before PUT",
  async (name) => {
    const x = fixture(intended(`${name}:${join}`));
    await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toThrow(/only in an extension/);
    expect(transport.putEvent).not.toHaveBeenCalled();
    expect(x.pending()).toBeNull();
  },
);

it.each([
  ["description", (body: string) => body.replace("Notes", "A human edit")],
  ["location", (body: string) => body.replace("LOCATION:", "LOCATION:New room")],
  ["summary", (body: string) => body.replace("SUMMARY:Example", "SUMMARY:Edited")],
  ["time", (body: string) => body.replace("20261008T120000Z", "20261008T130000Z")],
  ["source marker", (body: string) => body.replace("X-SYNC-SOURCE:icloud:source", "X-SYNC-SOURCE:icloud:other")],
  ["copy marker", (body: string) => body.replace(/X-SYNC-FP:[a-f0-9]+/, "X-SYNC-FP:0000000000000000")],
  ["UID", (body: string) => body.replace("UID:mirror", "UID:other")],
  ["attendees", (body: string) => body.replace("END:VEVENT", "ATTENDEE:mailto:guest@example.com\r\nEND:VEVENT")],
  ["unknown footer", (body: string) => body.replace("Please do not edit this section.", "Other information")],
])("holds changed %s instead of patching over it", async (_field, change) => {
  const x = fixture();
  x.normalize();
  x.state.ics = change(x.state.ics);
  await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toThrow(/remains pending/);
  expect(x.patches).toEqual([]);
  expect(x.pending()?.phase).toBe("written");
});

it("does not treat an incomplete legacy wrapper as discarded boilerplate", async () => {
  const x = fixture(intended(description(`----( Video Call )----\n${join}\nImportant human notes`)));
  x.normalize("");
  await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toThrow(/remains pending/);
  expect(x.patches).toEqual([]);
});

it.each([400, 401, 412, 429])("clears a definitely rejected initial PUT (%s)", async (status) => {
  const x = fixture();
  transport.putEvent.mockRejectedValueOnce(new CalDavError(status, "PUT", href, ""));
  await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toMatchObject({ status });
  expect(x.pending()).toBeNull();
  expect(transport.dav).not.toHaveBeenCalled();
});

it.each([408, 500])("retains an uncertain initial PUT (%s)", async (status) => {
  const x = fixture();
  transport.putEvent.mockRejectedValueOnce(new CalDavError(status, "PUT", href, ""));
  await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toThrow(/remains pending/);
  expect(x.pending()?.phase).toBe("prepared");
});

it.each([400, 401, 412, 429, 500])("retains intent and reports uncertain after REST %s", async (status) => {
  const x = fixture();
  x.normalize();
  x.state.patchFailure = status;
  const onAction = vi.fn();
  const notice = actionNotice({
    pair: "test",
    side: "google",
    href,
    etag: null,
    ics: x.ics,
    operation: "create",
    internal: false,
  });
  await expect(
    performAction(notice, () => putGoogleMirror(target, href, x.ics, null, x.store), { onAction }),
  ).rejects.toThrow(/remains pending/);
  expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ status: "uncertain" }));
  expect(x.pending()?.phase).toBe("written");
  expect(x.patches).toEqual([]);
});

it("retains intent when verification fails after a successful PATCH", async () => {
  const x = fixture();
  x.normalize();
  x.state.failAfterPatch = true;
  await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toThrow(/remains pending/);
  expect(x.patches).toHaveLength(1);
  expect(x.pending()).not.toBeNull();
  x.state.failAfterPatch = false;
  await recoverGoogleMirrorWrite([target], x.store, { pair: "test" });
  expect(x.patches).toHaveLength(1);
  expect(x.pending()).toBeNull();
});

it("recovers the saved write without repeating a committed CalDAV PUT", async () => {
  const x = fixture();
  x.normalize();
  x.seed("prepared");
  await recoverGoogleMirrorWrite([target], x.store, { pair: "test" });
  expect(transport.putEvent).not.toHaveBeenCalled();
  expect(x.patches).toHaveLength(1);
  expect(x.pending()).toBeNull();
});

it("retries a prepared update only while its original CalDAV version remains current", async () => {
  const x = fixture();
  x.normalize();
  x.seed("prepared", x.state.etag);
  await recoverGoogleMirrorWrite([target], x.store, { pair: "test" });
  expect(transport.putEvent).toHaveBeenCalledWith(target.auth, href, x.ics, '"caldav-1"');
  expect(x.pending()).toBeNull();
});

it("retains older uncertain intent when a conditional retry is rejected", async () => {
  const x = fixture();
  x.seed("prepared", x.state.etag);
  transport.putEvent.mockRejectedValueOnce(new CalDavError(412, "PUT", href, ""));
  await expect(recoverGoogleMirrorWrite([target], x.store, { pair: "test" })).rejects.toThrow(/remains pending/);
  expect(x.pending()?.phase).toBe("prepared");
});

it("blocks sync planning and all further writes while correction remains unresolved", async () => {
  const x = fixture();
  x.normalize();
  x.seed();
  x.state.patchFailure = 412;
  await expect(
    syncPair(
      {
        name: "test",
        a: target,
        b: { id: "icloud", url: "https://p01-caldav.icloud.com/cal/", auth: { kind: "basic", user: "u", pass: "p" } },
      },
      undefined,
      { googleMirrorStore: x.store },
    ),
  ).rejects.toThrow(/remains pending/);
  expect(transport.listEvents).not.toHaveBeenCalled();
  expect(transport.putEvent).not.toHaveBeenCalled();
  expect(x.pending()).not.toBeNull();
});

it("dry runs quarantine unfinished intent without network access", async () => {
  const x = fixture();
  x.seed();
  await expect(recoverGoogleMirrorWrite([target], x.store, { pair: "test", dryRun: true })).rejects.toThrow(
    /before dry-run planning/,
  );
  expect(transport.dav).not.toHaveBeenCalled();
  expect(transport.putEvent).not.toHaveBeenCalled();
});

it("honors an explicit source hold before recovering a pending mirror", async () => {
  const x = fixture();
  x.seed();
  await expect(
    recoverGoogleMirrorWrite([target], x.store, {
      pair: "test",
      heldOriginals: [{ side: "icloud", uid: "source" }],
    }),
  ).rejects.toThrow(/explicitly held original/);
  expect(transport.dav).not.toHaveBeenCalled();
  expect(transport.putEvent).not.toHaveBeenCalled();
  expect(x.pending()).not.toBeNull();
});

it("requires durable preparation before any PUT", async () => {
  const x = fixture();
  vi.mocked(x.store.save).mockRejectedValueOnce(new Error("disk full"));
  await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toThrow("disk full");
  expect(transport.putEvent).not.toHaveBeenCalled();
});

it("retains written intent if clearing durable state fails after successful correction", async () => {
  const x = fixture();
  x.normalize();
  const save = x.store.save;
  x.store.save = async (value) => {
    if (value === null) throw new Error("disk full");
    await save(value);
  };
  await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toThrow(/remains pending/);
  expect(x.pending()?.phase).toBe("written");
  expect(x.patches).toHaveLength(1);
});

it.each([
  "https://example.com/calendar/v3/calendars/a/events",
  "https://www.googleapis.com/calendar/v3/calendars/a/acl",
  "https://user@www.googleapis.com/calendar/v3/calendars/a/events",
  "https://www.googleapis.com:8443/calendar/v3/calendars/a/events",
])("rejects REST destination %s", (url) => expect(googleCalendarRestPolicy(new URL(url))).toBe(false));

it("does not bypass a caller policy that disallows Calendar REST", async () => {
  const x = fixture();
  const scoped = { ...target, auth: { ...target.auth, allowUrl: providerUrlPolicy("google") } };
  await expect(putGoogleMirror(scoped, href, x.ics, null, x.store)).rejects.toThrow(/not allowed/);
  expect(transport.putEvent).not.toHaveBeenCalled();
});

it("rejects native originals and unrelated destination calendars before writing", async () => {
  const x = fixture();
  const native = fold(unfold(x.ics).filter((line) => !["X-SYNC-SOURCE", "X-SYNC-FP"].includes(propName(line))));
  await expect(putGoogleMirror(target, href, native, null, x.store)).rejects.toThrow(/marked mirror/);
  await expect(putGoogleMirror(target, "https://example.com/mirror.ics", x.ics, null, x.store)).rejects.toThrow(
    /destination/,
  );
  expect(transport.putEvent).not.toHaveBeenCalled();
});

function recurring(allDay = false): string {
  const date = allDay ? "DTSTART;VALUE=DATE:20261008" : "DTSTART:20261008T120000Z";
  const recurrence = allDay ? "RECURRENCE-ID;VALUE=DATE:20261009" : 'RECURRENCE-ID;TZID="GMT-03:00":20261009T090000';
  const lines = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:source",
    date,
    "RRULE:FREQ=DAILY;COUNT=2",
    "SUMMARY:Master",
    description(`Master ${join}`),
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:source",
    recurrence,
    allDay ? "DTSTART;VALUE=DATE:20261010" : "DTSTART:20261009T130000Z",
    "SUMMARY:Override",
    description(`Override ${join}`),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return fold(toMirror(lines, { uid: "mirror", sourceSide: "icloud", sourceUid: "source", fp: fingerprint(lines) }));
}

it.each([false, true])("corrects a master and explicit override with fresh ETags (allDay=%s)", async (allDay) => {
  const x = fixture(recurring(allDay));
  if (allDay) x.restEvents[1].originalStartTime = { date: "2026-10-09" };
  x.normalize();
  await putGoogleMirror(target, href, x.ics, null, x.store);
  expect(x.patches.map((patch) => [patch.id, patch.etag])).toEqual([
    ["master", '"rest-0-1"'],
    ["override-1", '"changed-by-master"'],
  ]);
  expect(x.patches.map((patch) => patch.body.description)).toEqual([`Master ${join}`, `Override ${join}`]);
  expect(fingerprint(unfold(x.state.ics))).toBe(fingerprint(unfold(x.ics)));
  expect(x.pending()).toBeNull();
});

it("holds an unknown recurrence override without patching the master", async () => {
  const x = fixture(recurring());
  x.normalize();
  x.restEvents[1].originalStartTime = { dateTime: "2026-10-10T12:00:00Z" };
  await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toThrow(/remains pending/);
  expect(x.patches).toEqual([]);
  expect(x.pending()).not.toBeNull();
});

it("recovers a partially corrected series without repeating its successful master PATCH", async () => {
  const x = fixture(recurring());
  x.normalize();
  const request = transport.dav.getMockImplementation()!;
  let rejected = false;
  transport.dav.mockImplementation(async (...args: unknown[]) => {
    if (!rejected && args[1] === "PATCH" && String(args[2]).includes("/override-1?")) {
      rejected = true;
      throw new CalDavError(412, "PATCH", String(args[2]), "");
    }
    return request(...args);
  });
  await expect(putGoogleMirror(target, href, x.ics, null, x.store)).rejects.toThrow(/remains pending/);
  expect(x.patches.map((patch) => patch.id)).toEqual(["master"]);
  expect(x.pending()?.phase).toBe("written");
  await recoverGoogleMirrorWrite([target], x.store, { pair: "test" });
  expect(x.patches.map((patch) => patch.id)).toEqual(["master", "override-1"]);
  expect(transport.putEvent).toHaveBeenCalledTimes(1);
  expect(x.pending()).toBeNull();
});

it("rejects corrupted pending state instead of treating it as absent", async () => {
  const x = fixture();
  vi.mocked(x.store.load).mockResolvedValue(false as unknown as GoogleMirrorIntent);
  await expect(recoverGoogleMirrorWrite([target], x.store, { pair: "test" })).rejects.toThrow(/Invalid pending/);
  expect(transport.dav).not.toHaveBeenCalled();
});

it("preserves ordinary recurring writes without using Calendar REST", async () => {
  const base = recurring().replaceAll(join, "in person");
  const lines = unfold(base).filter((line) => propName(line) !== "X-SYNC-FP");
  const ics = fold(
    lines.flatMap((line) => (line === "END:VEVENT" ? [`X-SYNC-FP:${fingerprint(lines)}`, line] : [line])),
  );
  const x = fixture(ics);
  await putGoogleMirror(target, href, x.ics, null, x.store);
  expect(transport.putEvent).toHaveBeenCalledTimes(1);
  expect(x.order).not.toContain("REST GET");
  expect(x.pending()).toBeNull();
});
