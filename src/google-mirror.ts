import {
  CalDavError,
  dav,
  providerUrlPolicy,
  putEvent,
  scopedAuth,
  type CalDavAuth,
  type CalDavEvent,
} from "./caldav.js";
import { actionNotice, performAction, type ActionHooks } from "./execution.js";
import {
  eventProp,
  fingerprint,
  matchesFingerprint,
  normalizeDateLine,
  propName,
  propValue,
  sourceRef,
  unfold,
  X_FP,
  X_SOURCE,
} from "./ics.js";

export type GoogleMirrorIntent = {
  version: 1;
  calendar: string;
  href: string;
  etag: string | null;
  ics: string;
  phase: "prepared" | "written";
};

/** save must durably replace the record before resolving; null clears it. */
export type GoogleMirrorStore = {
  load(): Promise<GoogleMirrorIntent | null>;
  save(intent: GoogleMirrorIntent | null): Promise<void>;
};

type Target = { id: string; url: string; auth: CalDavAuth };
const FOOTER_BOUNDARY = "-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-";
const CONFERENCE_PROPERTIES = new Set([
  "CONFERENCE",
  "X-GOOGLE-CONFERENCE",
  "X-RDCAL-CONFERENCEINFO",
  "X-MICROSOFT-ONLINEMEETINGCONFLINK",
  "X-MICROSOFT-ONLINEMEETINGEXTERNALLINK",
  "X-MICROSOFT-ONLINEMEETINGINFORMATION",
]);

export function googleCalendarRestPolicy(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === "www.googleapis.com" &&
    !url.port &&
    !url.username &&
    !url.password &&
    /^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/[^/]+)?$/.test(url.pathname)
  );
}

const textValue = (value: string) =>
  value.replace(/\\([nN,;\\])/g, (_, escaped: string) => (/[nN]/.test(escaped) ? "\n" : escaped));
const valueOf = (properties: string[], name: string) =>
  textValue(propValue(properties.find((line) => propName(line) === name) ?? ""));

function components(lines: string[]): string[][] {
  const events: string[][] = [];
  let depth = 0;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      events.push([]);
      depth = 1;
    } else if (depth && line.startsWith("BEGIN:")) depth++;
    else if (depth && line.startsWith("END:")) depth--;
    else if (depth === 1) events.at(-1)!.push(line);
  }
  return events;
}

function conferenceUri(value: string): boolean {
  if (!/^https:\/\/[^\s<>"\\]+$/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.port &&
      ((url.hostname === "meet.google.com" && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname)) ||
        (url.hostname === "teams.microsoft.com" && /^\/l\/meetup-join\/.+/.test(url.pathname)) ||
        ((url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us")) && /^\/(?:j|my)\/.+/.test(url.pathname)))
    );
  } catch {
    return false;
  }
}

const conferenceUris = (value: string): string[] => (value.match(/https:\/\/[^\s<>"]+/g) ?? []).filter(conferenceUri);

function footer(value: string): { human: string; uri: string; rotated: boolean } | null {
  if (!value.endsWith(FOOTER_BOUNDARY)) return null;
  const start = value.lastIndexOf(FOOTER_BOUNDARY, value.length - FOOTER_BOUNDARY.length - 1);
  if (start < 0 || (start > 0 && value.slice(start - 2, start) !== "\n\n")) return null;
  const lines = value.slice(start).split("\n");
  if (
    lines[0] !== FOOTER_BOUNDARY ||
    lines.at(-1) !== FOOTER_BOUNDARY ||
    lines.at(-2) !== "Please do not edit this section."
  )
    return null;
  const human = start === 0 ? "" : value.slice(0, start - 2);
  if (
    lines.length === 6 &&
    lines[3] === "" &&
    conferenceUri(lines[2]) &&
    ((lines[1] === "Join Microsoft Teams Meeting" && new URL(lines[2]).hostname === "teams.microsoft.com") ||
      (lines[1] === "Join Zoom Meeting" && /(?:^|\.)zoom\.us$/.test(new URL(lines[2]).hostname)))
  )
    return { human, uri: lines[2], rotated: false };
  const uri = /^Join with Google Meet: (https:\/\/\S+)$/.exec(lines[1] ?? "")?.[1];
  if (!uri || !conferenceUri(uri) || new URL(uri).hostname !== "meet.google.com" || lines[2] !== "") return null;
  if (lines.length === 5) return { human, uri, rotated: false };
  if (
    lines.length === 8 &&
    lines[3] ===
      "The Google Meet link was automatically updated to keep the meeting private and secure. Learn more about Google Meet meeting codes at: " &&
    /^https:\/\/support\.google\.com\/(?:meet\?p=[A-Za-z0-9_=&%.-]+|calendar\?p=meeting_code_reuse)$/.test(lines[4]) &&
    lines[5] === ""
  )
    return { human, uri, rotated: true };
  return null;
}

function legacyDescription(value: string): { human: string; uri: string } | null {
  const match = /(?:^|\n\n)----\( (?:Video Call|Gmail) \)----\n(https:\/\/[^\n]+)\n---===---$/.exec(value);
  return match && conferenceUri(match[1]) ? { human: value.slice(0, match.index), uri: match[1] } : null;
}

function mirror(ics: string) {
  const lines = unfold(ics);
  const events = components(lines);
  if (!events.length || !sourceRef(lines)) throw new Error("Google correction requires a marked mirror");
  const markers = events
    .map((properties) => {
      for (const name of ["UID", X_SOURCE, X_FP])
        if (properties.filter((line) => propName(line) === name).length !== 1)
          throw new Error("Ambiguous Google mirror identity");
      if (properties.some((line) => propName(line) === "ATTENDEE"))
        throw new Error("Google mirror has attendees; correction held");
      const recurrence = properties.find((line) => propName(line) === "RECURRENCE-ID");
      return JSON.stringify([
        valueOf(properties, "UID"),
        valueOf(properties, X_SOURCE),
        valueOf(properties, X_FP),
        recurrence ? normalizeDateLine(recurrence) : "",
      ]);
    })
    .sort();
  const hasConference = events.some((properties) =>
    properties.some(
      (line) =>
        (CONFERENCE_PROPERTIES.has(propName(line)) && !!propValue(line)) ||
        (["DESCRIPTION", "LOCATION"].includes(propName(line)) && conferenceUris(textValue(propValue(line))).length > 0),
    ),
  );
  return {
    lines,
    events,
    markers: JSON.stringify(markers),
    uid: valueOf(events[0], "UID"),
    fp: fingerprint(lines),
    hasConference,
    description: valueOf(events[0], "DESCRIPTION"),
    location: valueOf(events[0], "LOCATION"),
  };
}
type Mirror = ReturnType<typeof mirror>;

function assertSupported(expected: Mirror) {
  if (!matchesFingerprint(expected.lines, eventProp(expected.lines, X_FP)))
    throw new Error("Google mirror copy fingerprint does not match its intended content");
  for (const properties of expected.events) {
    const visible = new Set(
      conferenceUris(valueOf(properties, "DESCRIPTION") + "\n" + valueOf(properties, "LOCATION")),
    );
    for (const line of properties.filter((line) => CONFERENCE_PROPERTIES.has(propName(line)) && !!propValue(line))) {
      let metadata = textValue(propValue(line));
      if (/^%7B/i.test(metadata)) metadata = decodeURIComponent(metadata);
      const uris = conferenceUris(metadata.replace(/\\\//g, "/"));
      const visibleTeams = [...visible].some((uri) => new URL(uri).hostname === "teams.microsoft.com");
      if (
        !uris.length &&
        visibleTeams &&
        propName(line).startsWith("X-MICROSOFT-") &&
        (metadata.startsWith("conf:sip:") || propName(line) === "X-MICROSOFT-ONLINEMEETINGINFORMATION")
      )
        continue;
      if (!uris.length || uris.some((uri) => !visible.has(uri)))
        throw new Error("Conference join information exists only in an extension; Google correction held");
    }
  }
}

function componentKey(properties: string[]): string {
  const recurrence = properties.find((line) => propName(line) === "RECURRENCE-ID");
  return recurrence ? normalizeDateLine(recurrence).slice("RECURRENCE-ID=".length) : "";
}

function componentMap(event: Mirror): Map<string, Mirror> {
  const result = new Map<string, Mirror>();
  for (const properties of event.events) {
    const key = componentKey(properties);
    if (result.has(key)) throw new Error("Duplicate Google mirror recurrence identity");
    result.set(key, mirror(["BEGIN:VEVENT", ...properties, "END:VEVENT"].join("\r\n")));
  }
  return result;
}

function assertCompatible(expected: Mirror, actual: Mirror) {
  if (expected.markers !== actual.markers)
    throw new Error("Google mirror identity or copy markers changed; correction held");
  if (expected.fp === actual.fp) return;
  const otherFields = (event: Mirror) =>
    fingerprint(event.lines.filter((line) => !["DESCRIPTION", "LOCATION"].includes(propName(line))));
  if (otherFields(expected) !== otherFields(actual))
    throw new Error("Google mirror content changed outside conference fields");
  const actualComponents = componentMap(actual);
  for (const [key, intended] of componentMap(expected)) {
    const observed = actualComponents.get(key);
    if (!observed) throw new Error("Google mirror recurrence identity changed");
    if (intended.fp !== observed.fp) assertTextCompatible(intended, observed);
  }
}

/** Read-only preflight for a saved or proposed mirror correction. */
export function validateGoogleMirrorReadback(intendedIcs: string, actualIcs: string): void {
  const expected = mirror(intendedIcs);
  assertSupported(expected);
  assertCompatible(expected, mirror(actualIcs));
}

function assertTextCompatible(expected: Mirror, actual: Mirror) {
  const generated = footer(actual.description);
  if (!generated) throw new Error("Unrecognized Google conference normalization; correction held");
  const intendedUris = conferenceUris(expected.description + "\n" + expected.location);
  const uriMatches = (uri: string) =>
    generated.uri === uri || (generated.rotated && new URL(uri).hostname === "meet.google.com");
  if (!intendedUris.some(uriMatches)) throw new Error("Unexpected conference URI in Google mirror");
  const originalFooter = footer(expected.description);
  const originalLegacy = legacyDescription(expected.description);
  const humanForms = [expected.description, originalFooter?.human, originalLegacy?.human];
  if (!humanForms.some((human) => human !== undefined && human.trim() === generated.human.trim()))
    throw new Error("Google mirror description contains a user edit");
  if (
    actual.location !== expected.location &&
    !(actual.location === "" && conferenceUri(expected.location) && uriMatches(expected.location))
  )
    throw new Error("Google mirror location contains a user edit");
}

function binding(target: Target, href: string): string {
  const calendar = new URL(target.url),
    resource = new URL(href);
  const match = /^\/caldav\/v2\/([^/]+)\/events\/$/.exec(calendar.pathname);
  if (
    target.id !== "google" ||
    target.auth.kind !== "bearer" ||
    !providerUrlPolicy("google")(calendar) ||
    !match ||
    calendar.search ||
    calendar.hash ||
    resource.username ||
    resource.password ||
    resource.origin !== calendar.origin ||
    resource.search ||
    resource.hash ||
    !resource.pathname.startsWith(calendar.pathname) ||
    !/^[^/]+$/.test(resource.pathname.slice(calendar.pathname.length))
  )
    throw new Error("Google mirror destination is not an explicit Google calendar resource");
  return `https://www.googleapis.com/calendar/v3/calendars/${match[1]}/events`;
}

export const isGoogleMirrorWrite = (target: Target, ics: string): boolean =>
  target.id === "google" && providerUrlPolicy("google")(new URL(target.url)) && sourceRef(unfold(ics)) !== null;

async function readMirror(target: Target, href: string): Promise<CalDavEvent | null> {
  try {
    const response = await dav(target.auth, "GET", href);
    return { href, etag: response.headers.get("etag"), ics: response.text };
  } catch (error) {
    if (error instanceof CalDavError && error.status === 404) return null;
    throw error;
  }
}

type RestEvent = {
  id: string;
  etag: string;
  iCalUID: string;
  status?: string;
  organizer?: { self?: boolean };
  attendees?: unknown[];
  recurrence?: unknown;
  originalStartTime?: { date?: string; dateTime?: string };
  recurringEventId?: string;
  conferenceData?: unknown;
  description?: string;
  location?: string;
};

async function rest(
  target: Target,
  method: string,
  url: string,
  body?: object,
  etag?: string,
): Promise<Record<string, unknown>> {
  if (!googleCalendarRestPolicy(new URL(url))) throw new Error("Google Calendar REST destination rejected");
  const response = await dav(target.auth, method, url, {
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
  });
  const parsed: unknown = JSON.parse(response.text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid Google Calendar REST response");
  return parsed as Record<string, unknown>;
}

function restEvent(value: unknown, expected: Mirror): RestEvent {
  const event = value as RestEvent | null;
  if (
    !event ||
    typeof event.id !== "string" ||
    !event.id ||
    typeof event.etag !== "string" ||
    !event.etag ||
    event.iCalUID !== expected.uid ||
    event.organizer?.self !== true ||
    event.status === "cancelled" ||
    (event.attendees !== undefined && (!Array.isArray(event.attendees) || event.attendees.length))
  )
    throw new Error("Google REST event is ambiguous or invitation-bearing; correction held");
  return event;
}

function restKey(event: RestEvent): string {
  if (!event.originalStartTime) {
    if (event.recurringEventId) throw new Error("Google recurrence is missing its original start time");
    return "";
  }
  const { date, dateTime } = event.originalStartTime;
  if (date && !dateTime && /^\d{4}-\d{2}-\d{2}$/.test(date)) return `D${date.replaceAll("-", "")}`;
  if (
    dateTime &&
    !date &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(dateTime) &&
    Number.isFinite(Date.parse(dateTime))
  )
    return String(Date.parse(dateTime));
  throw new Error("Unsupported Google recurrence identity; correction held");
}

function assertRestCompatible(expected: Mirror, observed: Mirror, event: RestEvent) {
  const descriptions = [
    expected.description,
    observed.description,
    footer(expected.description)?.human,
    legacyDescription(expected.description)?.human,
    footer(observed.description)?.human,
  ];
  if (typeof event.description !== "string" && event.description !== undefined)
    throw new Error("Invalid Google REST description");
  if (!descriptions.some((value) => value !== undefined && value.trim() === (event.description ?? "").trim()))
    throw new Error("Google REST description contains a user edit; correction held");
  if (![expected.location, observed.location].includes(event.location ?? ""))
    throw new Error("Google REST location contains a user edit; correction held");
  if (event.conferenceData != null) {
    const data = event.conferenceData as { entryPoints?: { entryPointType?: string; uri?: string }[] };
    const video = Array.isArray(data.entryPoints)
      ? data.entryPoints.filter((point) => point?.entryPointType === "video")
      : [];
    const uris = new Set(conferenceUris(expected.description + "\n" + expected.location));
    const generated = footer(observed.description);
    if (generated) uris.add(generated.uri);
    if (!video.length || video.some((point) => !point.uri || !uris.has(point.uri)))
      throw new Error("Google REST conference differs from the verified calendar content; correction held");
  }
}

async function finish(target: Target, intent: GoogleMirrorIntent, store: GoogleMirrorStore) {
  const expected = mirror(intent.ics);
  assertSupported(expected);
  const collection = binding(target, intent.href);
  const current = await readMirror(target, intent.href);
  if (!current) throw new Error("Pending Google mirror is missing; correction held");
  const actual = mirror(current.ics);
  assertCompatible(expected, actual);
  if (!expected.hasConference && !actual.hasConference && expected.fp === actual.fp) {
    await store.save(null);
    return;
  }
  const expectedComponents = componentMap(expected);
  const query = new URL(collection);
  query.searchParams.set("iCalUID", expected.uid);
  query.searchParams.set("singleEvents", "false");
  query.searchParams.set("showDeleted", "false");
  const list = await rest(target, "GET", query.href);
  if (list.nextPageToken || !Array.isArray(list.items) || list.items.length !== expectedComponents.size)
    throw new Error("Google REST mirror components are missing or ambiguous");
  const identities = new Map<string, string>();
  const listed = list.items.map((item) => restEvent(item, expected));
  for (const event of listed) {
    const key = restKey(event);
    if (!expectedComponents.has(key) || identities.has(key) || [...identities.values()].includes(event.id))
      throw new Error("Google REST has an unknown or duplicate recurrence override");
    identities.set(key, event.id);
  }
  for (const event of listed)
    if (restKey(event) && event.recurringEventId !== identities.get(""))
      throw new Error("Google recurrence override belongs to a different master");
  const receipts = new Map<string, RestEvent>();
  // A master PATCH changes inherited overrides, so acquire each ETag immediately before its own PATCH.
  for (const key of [...identities.keys()].sort()) {
    const id = identities.get(key)!;
    const intended = expectedComponents.get(key)!;
    const resource = `${collection}/${encodeURIComponent(id)}`;
    const validate = (value: unknown) => {
      const event = restEvent(value, expected);
      if (event.id !== id || restKey(event) !== key || (key && event.recurringEventId !== identities.get("")))
        throw new Error("Google REST component identity changed");
      return event;
    };
    const first = validate(await rest(target, "GET", resource));
    const observed = await readMirror(target, intent.href);
    if (!observed) throw new Error("Google mirror disappeared before correction");
    const observedMirror = mirror(observed.ics);
    assertCompatible(expected, observedMirror);
    const observedComponent = componentMap(observedMirror).get(key)!;
    const before = validate(await rest(target, "GET", resource));
    if (before.etag !== first.etag) throw new Error("Google mirror changed during correction checks");
    assertRestCompatible(intended, observedComponent, before);
    let receipt = before;
    if (before.conferenceData != null || observedComponent.fp !== intended.fp) {
      const patchUrl = new URL(resource);
      patchUrl.searchParams.set("conferenceDataVersion", "1");
      patchUrl.searchParams.set("sendUpdates", "none");
      receipt = validate(
        await rest(
          target,
          "PATCH",
          patchUrl.href,
          {
            conferenceData: null,
            description: intended.description,
            location: intended.location,
          },
          before.etag,
        ),
      );
      if (
        receipt.conferenceData != null ||
        (receipt.description ?? "") !== intended.description ||
        (receipt.location ?? "") !== intended.location
      )
        throw new Error("Google conference correction response did not preserve intended text");
    }
    receipts.set(key, receipt);
  }
  const verified = await readMirror(target, intent.href);
  if (!verified) throw new Error("Google mirror disappeared during verification");
  const result = mirror(verified.ics);
  if (result.fp !== expected.fp || result.markers !== expected.markers)
    throw new Error("Google mirror does not match its intended content after correction");
  for (const [key, receipt] of receipts) {
    const final = restEvent(await rest(target, "GET", `${collection}/${encodeURIComponent(receipt.id)}`), expected);
    if (
      final.id !== receipt.id ||
      restKey(final) !== key ||
      final.etag !== receipt.etag ||
      final.conferenceData != null
    )
      throw new Error("Google mirror changed after conference correction");
  }
  await store.save(null);
}

function partial(error: unknown): Error {
  return new Error("Google mirror write remains pending; recover before synchronization", { cause: error });
}

/** Composite write: any failure after the initial PUT keeps the durable intent. */
export async function putGoogleMirror(
  target: Target,
  href: string,
  ics: string,
  etag: string | null,
  store: GoogleMirrorStore,
): Promise<void> {
  const restUrl = binding(target, href);
  const expected = mirror(ics);
  assertSupported(expected);
  if (expected.hasConference && target.auth.allowUrl && !target.auth.allowUrl(new URL(restUrl)))
    throw new Error("Google REST correction is not allowed by the destination policy");
  if ((await store.load()) !== null) throw new Error("An unfinished Google mirror write must be recovered first");
  const intent: GoogleMirrorIntent = { version: 1, calendar: target.url, href, etag, ics, phase: "prepared" };
  await store.save(intent);
  try {
    await putEvent(target.auth, href, ics, etag);
  } catch (error) {
    if (error instanceof CalDavError && error.status >= 400 && error.status < 500 && error.status !== 408) {
      await store.save(null);
      throw error;
    }
    throw partial(error);
  }
  try {
    intent.phase = "written";
    await store.save(intent);
    await finish(target, intent, store);
  } catch (error) {
    throw partial(error);
  }
}

/** Resolve saved intent before snapshots/planning can mistake normalization for a human edit. */
export async function recoverGoogleMirrorWrite(
  targets: Target[],
  store: GoogleMirrorStore,
  options: ActionHooks & {
    pair: string;
    dryRun?: boolean;
    signal?: AbortSignal;
    heldOriginals?: { side: string; uid: string }[];
  },
): Promise<void> {
  const intent = await store.load();
  if (intent === null) return;
  if (
    !intent ||
    typeof intent !== "object" ||
    intent.version !== 1 ||
    !["prepared", "written"].includes(intent.phase) ||
    typeof intent.calendar !== "string" ||
    typeof intent.href !== "string" ||
    typeof intent.ics !== "string" ||
    !(intent.etag === null || (typeof intent.etag === "string" && intent.etag))
  )
    throw new Error("Invalid pending Google mirror intent");
  const found = targets.find((side) => side.url === intent.calendar);
  if (!found) throw new Error("Pending Google mirror belongs to a different calendar");
  const target = { ...found, auth: scopedAuth(found.auth, { signal: options.signal }) };
  binding(target, intent.href);
  assertSupported(mirror(intent.ics));
  const source = sourceRef(unfold(intent.ics))!;
  if (options.heldOriginals?.some((hold) => hold.side === source.side && hold.uid === source.uid))
    throw new Error("Pending Google mirror belongs to an explicitly held original; recovery stopped");
  if (options.dryRun) throw new Error("Unfinished Google mirror write requires recovery before dry-run planning");
  const notice = actionNotice({
    pair: options.pair,
    side: target.id,
    href: intent.href,
    etag: intent.etag,
    ics: intent.ics,
    operation: intent.etag ? "update" : "create",
    internal: false,
  });
  await performAction(
    notice,
    async () => {
      try {
        const current = await readMirror(target, intent.href);
        if (
          intent.phase === "prepared" &&
          (current ? intent.etag !== null && current.etag === intent.etag : intent.etag === null)
        ) {
          await putEvent(target.auth, intent.href, intent.ics, intent.etag);
          intent.phase = "written";
          await store.save(intent);
        }
        await finish(target, intent, store);
      } catch (error) {
        throw partial(error);
      }
    },
    options,
  );
}
