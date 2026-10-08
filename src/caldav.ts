// A CalDAV client small enough to read in one sitting. iCloud uses Basic with
// an app-specific password; Google's CalDAV v2 uses Bearer. Responses are
// fixed shapes, picked apart with regexes (no DOM parser in most runtimes).

import { uidOf, unfold, fold, withExplicitZeroDuration } from "./ics.js";

export type RequestOptions = {
  signal?: AbortSignal;
  /** Return true to allow a destination. Called before credentials are resolved or sent. */
  allowUrl?: (url: URL) => boolean;
};
export type CalDavAuth = RequestOptions &
  (
    { kind: "basic"; user: string; pass: string } | { kind: "bearer"; token: (signal?: AbortSignal) => Promise<string> }
  );

/** Optional strict policy for hosted iCloud/Google integrations. Custom CalDAV remains supported. */
export function providerUrlPolicy(provider: "icloud" | "google") {
  return (url: URL): boolean =>
    url.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    (provider === "google"
      ? url.hostname === "apidata.googleusercontent.com" && url.pathname.startsWith("/caldav/v2/")
      : url.hostname === "caldav.icloud.com" || /^p\d+-caldav\.icloud\.com$/.test(url.hostname));
}

/** Scope credentials to a run without mutating a shared auth object or weakening its policy. */
export function scopedAuth(auth: CalDavAuth, options: RequestOptions): CalDavAuth {
  if (!options.signal && !options.allowUrl) return auth;
  const signals = [auth.signal, options.signal].filter((s): s is AbortSignal => !!s);
  return {
    ...auth,
    signal: signals.length ? AbortSignal.any(signals) : undefined,
    allowUrl: (url) =>
      (!auth.allowUrl || auth.allowUrl(new URL(url))) && (!options.allowUrl || options.allowUrl(new URL(url))),
  };
}

function checkTarget(auth: CalDavAuth, url: string) {
  auth.signal?.throwIfAborted();
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password)
    throw new Error("CalDAV requires HTTPS without URL credentials");
  if (auth.allowUrl && !auth.allowUrl(new URL(target))) throw new Error("CalDAV destination rejected by URL policy");
}
export type CalDavEvent = { href: string; etag: string | null; ics: string };
export type CalendarInfo = { href: string; name: string; components: string[]; shared: boolean };

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"';
const XML = { "Content-Type": "application/xml" };

export class CalDavError extends Error {
  constructor(
    readonly status: number,
    method: string,
    url: string,
    _body: string,
  ) {
    super(`${method} ${new URL(url).origin} → ${status}`);
  }
}

export async function dav(
  auth: CalDavAuth,
  method: string,
  url: string,
  init: { body?: string; headers?: Record<string, string> } = {},
) {
  checkTarget(auth, url);
  const Authorization =
    auth.kind === "basic"
      ? "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")
      : "Bearer " + (await auth.token(auth.signal));
  auth.signal?.throwIfAborted();
  const res = await fetch(url, {
    method,
    body: init.body,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(15000), ...(auth.signal ? [auth.signal] : [])]),
    headers: { Authorization, "User-Agent": "icloud-google-calendar-sync", ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new CalDavError(res.status, method, url, text);
  return { status: res.status, text, headers: res.headers };
}

/** Unescape XML text (calendar-data arrives entity-escaped or in CDATA). */
export function xmlText(s: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1];
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

const tag = (xml: string, local: string): string | null =>
  new RegExp(`<(?:[\\w-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${local}>`, "i").exec(xml)?.[1] ?? null;

export const responses = (xml: string): string[] =>
  [...xml.matchAll(/<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)].map((m) => m[1]);

const resolveHref = (base: string, href: string) => {
  const from = new URL(base);
  const to = new URL(xmlText(href.trim()), from);
  const apple = (u: URL) =>
    u.protocol === "https:" && !u.port && (u.hostname === "icloud.com" || u.hostname.endsWith(".icloud.com"));
  if (to.username || to.password || (to.origin !== from.origin && !(apple(from) && apple(to))))
    throw new Error("CalDAV response contains an untrusted resource URL");
  return to.toString();
};
const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function propfind(auth: CalDavAuth, url: string, depth: 0 | 1, props: string): Promise<string> {
  return (
    await dav(auth, "PROPFIND", url, {
      headers: { Depth: String(depth), ...XML },
      body: `<d:propfind ${NS}><d:prop>${props}</d:prop></d:propfind>`,
    })
  ).text;
}

// --- discovery (once, from the CLI) ------------------------------------------

export async function currentUserPrincipal(auth: CalDavAuth, base: string): Promise<string> {
  const href = tag(
    tag(await propfind(auth, base, 0, "<d:current-user-principal/>"), "current-user-principal") ?? "",
    "href",
  );
  if (!href) throw new Error("no current-user-principal at " + base);
  const resolved = resolveHref(base, href);
  checkTarget(auth, resolved);
  return resolved;
}

export async function calendarHome(auth: CalDavAuth, principal: string): Promise<string> {
  const href = tag(
    tag(await propfind(auth, principal, 0, "<c:calendar-home-set/>"), "calendar-home-set") ?? "",
    "href",
  );
  if (!href) throw new Error("no calendar-home-set at " + principal);
  const resolved = resolveHref(principal, href);
  checkTarget(auth, resolved);
  return resolved;
}

export async function listCalendars(auth: CalDavAuth, home: string): Promise<CalendarInfo[]> {
  const xml = await propfind(
    auth,
    home,
    1,
    "<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><cs:shared-url/>",
  );
  return responses(xml).flatMap((r) => {
    const rt = tag(r, "resourcetype") ?? "";
    const href = tag(r, "href");
    if (!href || !/<(?:[\w-]+:)?calendar\b/i.test(rt)) return [];
    const components = [...(tag(r, "supported-calendar-component-set") ?? "").matchAll(/name="([A-Z]+)"/g)].map(
      (m) => m[1],
    );
    const resolved = resolveHref(home, href);
    checkTarget(auth, resolved);
    return [
      {
        href: resolved,
        name: xmlText(tag(r, "displayname") ?? ""),
        components,
        shared: /shared/i.test(rt) || tag(r, "shared-url") != null,
      },
    ];
  });
}

// --- events ------------------------------------------------------------------

async function query(auth: CalDavAuth, calendar: string, filter: string, expand = ""): Promise<CalDavEvent[]> {
  const body = `<c:calendar-query ${NS}><d:prop><d:getetag/>${expand ? `<c:calendar-data>${expand}</c:calendar-data>` : "<c:calendar-data/>"}</d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${filter}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const result = await dav(auth, "REPORT", calendar, { headers: { Depth: "1", ...XML }, body });
  if (result.status !== 207) throw new Error("CalDAV query did not return multistatus");
  return parseEvents(result.text, calendar);
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");

/** Every VEVENT resource; optionally restricted to those overlapping [start, end). */
export const listEvents = (auth: CalDavAuth, calendar: string, range?: { start: Date; end: Date }) =>
  query(auth, calendar, range ? `<c:time-range start="${stamp(range.start)}" end="${stamp(range.end)}"/>` : "");

/** Read-only expanded occurrences for duplicate review, never for mirror writes. */
export const listOccurrences = (auth: CalDavAuth, calendar: string, range: { start: Date; end: Date }) =>
  query(
    auth,
    calendar,
    `<c:time-range start="${stamp(range.start)}" end="${stamp(range.end)}"/>`,
    `<c:expand start="${stamp(range.start)}" end="${stamp(range.end)}"/>`,
  );

/** One event by exact UID, regardless of time range. */
export const findByUid = async (auth: CalDavAuth, calendar: string, uid: string) =>
  (
    await query(
      auth,
      calendar,
      providerUrlPolicy("icloud")(new URL(calendar))
        ? ""
        : `<c:prop-filter name="UID"><c:text-match collation="i;octet">${escapeXml(uid)}</c:text-match></c:prop-filter>`,
    )
  ).find((event) => uidOf(unfold(event.ics)) === uid) ?? null;

function collectionWithoutEventData(response: string): boolean {
  const propstats = [...response.matchAll(/<(?:[\w-]+:)?propstat(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/gi)];
  const statuses = propstats.map(([, propstat]) => /\s(\d{3})\b/.exec(tag(propstat, "status") ?? "")?.[1]);
  return (
    [...response.matchAll(/<(?:[\w-]+:)?status(?:\s|>)/g)].length === propstats.length &&
    tag(response, "getetag") !== null &&
    statuses.includes("200") &&
    statuses.includes("404") &&
    propstats.every(([, propstat], i) =>
      statuses[i] === "200"
        ? true
        : statuses[i] === "404" &&
          /^<(?:[\w-]+:)?calendar-data(?:\s[^>]*)?\s*\/>$/.test((tag(propstat, "prop") ?? "").trim()),
    )
  );
}

function timezoneOnlyCalendar(lines: string[]): boolean {
  if (lines[0] !== "BEGIN:VCALENDAR" || lines.at(-1) !== "END:VCALENDAR") return false;
  const stack: string[] = [];
  for (const [index, line] of lines.entries()) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      const component = upper.slice(6);
      const parent = stack.at(-1);
      const allowed =
        (index === 0 && component === "VCALENDAR") ||
        (parent === "VCALENDAR" && component === "VTIMEZONE") ||
        (parent === "VTIMEZONE" && (component === "STANDARD" || component === "DAYLIGHT"));
      if (!allowed) return false;
      stack.push(component);
    } else if (upper.startsWith("END:")) {
      if (stack.pop() !== upper.slice(4)) return false;
      if (!stack.length && index !== lines.length - 1) return false;
    } else if (!stack.length || !line.includes(":")) return false;
  }
  return stack.length === 0;
}

export function parseEvents(multistatus: string, base: string): CalDavEvent[] {
  if (
    !/<(?:[\w-]+:)?multistatus(?:\s|>|\/)/i.test(multistatus) ||
    (!/<\/(?:[\w-]+:)?multistatus\s*>/i.test(multistatus) &&
      !/<(?:[\w-]+:)?multistatus\b[^>]*\/\s*>/i.test(multistatus))
  )
    throw new Error("Invalid CalDAV multistatus response");
  const entries = responses(multistatus);
  const opened = [...multistatus.matchAll(/<(?:[\w-]+:)?response(?:\s|>)/gi)].length;
  if (opened !== entries.length) throw new Error("Incomplete CalDAV resource response");
  const content = tag(multistatus, "multistatus");
  if (!entries.length && content?.trim()) throw new Error("Unexpected CalDAV multistatus content");
  return entries.flatMap((r) => {
    const statuses = [...r.matchAll(/<(?:[\w-]+:)?status[^>]*>[^<]*?\s(\d{3})\b/gi)];
    const href = tag(r, "href");
    const data = tag(r, "calendar-data");
    if (!href) throw new Error("CalDAV query is missing resource data");
    const resolved = resolveHref(base, href);
    const collection = new URL(base);
    const resource = new URL(resolved);
    // iCloud reports calendar-data as missing on the collection itself.
    if (resource.href === collection.href && data == null && collectionWithoutEventData(r)) return [];
    if (statuses.some((s) => Number(s[1]) >= 400)) throw new Error("CalDAV query contains failed resource properties");
    if (data == null) throw new Error("CalDAV query is missing resource data");
    if (
      resource.origin !== collection.origin ||
      !resource.pathname.startsWith(collection.pathname.endsWith("/") ? collection.pathname : collection.pathname + "/")
    )
      throw new Error("CalDAV event is outside the requested collection");
    const lines = unfold(xmlText(data));
    if (!uidOf(lines)) {
      // Google can return a timezone-only calendar for a cancelled series.
      const successfulData = [
        ...r.matchAll(/<(?:[\w-]+:)?propstat(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?propstat>/gi),
      ].some(
        ([, propstat]) => tag(propstat, "calendar-data") !== null && /\s200\b/.test(tag(propstat, "status") ?? ""),
      );
      if (providerUrlPolicy("google")(collection) && successfulData && timezoneOnlyCalendar(lines)) return [];
      throw new Error("CalDAV query contains invalid event data");
    }
    const etag = tag(r, "getetag");
    return [{ href: resolved, etag: etag ? xmlText(etag).trim() : null, ics: xmlText(data) }];
  });
}

/** PUT an event; `etag: null` means create (If-None-Match: *). */
export async function putEvent(auth: CalDavAuth, href: string, ics: string, etag: string | null): Promise<void> {
  const headers = {
    "Content-Type": "text/calendar; charset=utf-8",
    ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
  };
  const body = providerUrlPolicy("icloud")(new URL(href)) ? fold(withExplicitZeroDuration(unfold(ics))) : ics;
  await dav(auth, "PUT", href, { body, headers });
}

export async function deleteEvent(auth: CalDavAuth, href: string, etag: string | null): Promise<void> {
  if (!etag) throw new Error("Refusing to delete an event without an ETag");
  await dav(auth, "DELETE", href, { headers: { "If-Match": etag } });
}

export const googleCalendarUrl = (calendarId: string) =>
  `https://apidata.googleusercontent.com/caldav/v2/${encodeURIComponent(calendarId)}/events/`;
export const ICLOUD_BASE = "https://caldav.icloud.com/";
