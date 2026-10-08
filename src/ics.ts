// iCalendar transport. We never interpret a calendar, we copy it: a mirror is
// the source VCALENDAR with the UID rewritten, ATTENDEE/ORGANIZER stripped (a
// mirror must never become an invitation) and two X-SYNC-* markers added.
import { createHash } from "node:crypto";

export const X_SOURCE = "X-SYNC-SOURCE";
export const X_FP = "X-SYNC-FP";
/** On an ORIGINAL: which sides currently hold a mirror of it (one line per side). */
export const X_MIRRORED = "X-SYNC-MIRRORED";

/** Undo RFC 5545 line folding. */
export function unfold(ics: string): string[] {
  const out: string[] = [];
  for (const raw of ics.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && out.length) out[out.length - 1] += raw.slice(1);
    else if (raw) out.push(raw);
  }
  return out;
}

/** Fold at 75 octets, CRLF terminated. */
export function fold(lines: string[]): string {
  const bytes = (s: string) => Buffer.byteLength(s);
  return (
    lines
      .flatMap((line) => {
        const parts: string[] = [];
        let cur = "";
        for (const ch of line) {
          if (bytes(cur + ch) > (parts.length ? 74 : 75)) {
            parts.push(cur);
            cur = "";
          }
          cur += ch;
        }
        return [...parts, cur].map((p, i) => (i ? " " + p : p));
      })
      .join("\r\n") + "\r\n"
  );
}

export const propName = (line: string): string => (/^[A-Za-z0-9-]+/.exec(line)?.[0] ?? "").toUpperCase();

function unquotedIndexOf(text: string, separator: string): number {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (!quoted && text[i] === separator) return i;
  }
  return -1;
}

function contentLine(line: string, legacy = false): { head: string; value: string } {
  const colon = legacy ? line.indexOf(":") : unquotedIndexOf(line, ":");
  return { head: line.slice(0, colon), value: line.slice(colon + 1) };
}

function parameterValue(head: string, name: string): string | undefined {
  let rest = head;
  while (rest) {
    const semicolon = unquotedIndexOf(rest, ";");
    const parameter = semicolon < 0 ? rest : rest.slice(0, semicolon);
    if (parameter.toUpperCase().startsWith(`${name}=`)) {
      return parameter.slice(name.length + 1).replace(/^"(.*)"$/, "$1");
    }
    if (semicolon < 0) break;
    rest = rest.slice(semicolon + 1);
  }
  return undefined;
}

export const propValue = (line: string): string => contentLine(line).value;

/** First VEVENT's value for a property, or null. */
export function eventProp(lines: string[], name: string): string | null {
  let depth = 0;
  for (const line of lines) {
    if (!depth) {
      if (line === "BEGIN:VEVENT") depth = 1;
      continue;
    }
    if (line.startsWith("BEGIN:")) depth++;
    else if (line.startsWith("END:")) {
      if (--depth === 0) return null;
    } else if (depth === 1 && propName(line) === name) return propValue(line);
  }
  return null;
}

export const uidOf = (lines: string[]) => eventProp(lines, "UID");

/** Sides listed in X-SYNC-MIRRORED lines of the first VEVENT. */
export function mirroredOn(lines: string[]): string[] {
  const start = lines.indexOf("BEGIN:VEVENT");
  const end = lines.indexOf("END:VEVENT", start);
  return lines
    .slice(start + 1, end)
    .filter((l) => propName(l) === X_MIRRORED)
    .map(propValue);
}

/** `X-SYNC-SOURCE:<side>:<uid>` on a mirror, null on an original. */
export function sourceRef(lines: string[]): { side: string; uid: string } | null {
  const m = /^([^:]+):(.+)$/.exec(eventProp(lines, X_SOURCE) ?? "");
  return m ? { side: m[1], uid: m[2] } : null;
}

const stampToMs = (v: string | null): number | null => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v?.trim() ?? "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};

export const lastModifiedMs = (lines: string[]): number =>
  stampToMs(eventProp(lines, "LAST-MODIFIED")) ?? stampToMs(eventProp(lines, "DTSTAMP")) ?? 0;

// --- fingerprint: what a human would notice --------------------------------
// Servers freely rewrite PRODID, DTSTAMP, SEQUENCE and VTIMEZONE, and Google
// pads events with empty DESCRIPTION/LOCATION and default STATUS/TRANSP, so
// none of that may count as a change. Times compare as instants.

const FP_PROPS = new Set([
  "SUMMARY",
  "DTSTART",
  "DTEND",
  "DURATION",
  "RRULE",
  "RDATE",
  "EXDATE",
  "RECURRENCE-ID",
  "LOCATION",
  "DESCRIPTION",
  "STATUS",
  "TRANSP",
  "URL",
]);
const DEFAULTS: Record<string, string> = { STATUS: "CONFIRMED", TRANSP: "OPAQUE" };

/** Minutes east of UTC for an IANA zone at an instant; null if the zone is unknown. */
function zoneOffsetMin(tz: string, utcMs: number): number | null {
  try {
    const p: Record<string, number> = {};
    for (const part of new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMs))) {
      if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs) / 60_000);
  } catch {
    return null;
  }
}

/** DTSTART/DTEND/RECURRENCE-ID → comparable string (epoch ms, or the date, or the literal). */
export function normalizeDateLine(line: string): string {
  return normalizedDateLine(line, false);
}

function normalizedDateLine(line: string, legacy: boolean): string {
  const name = propName(line);
  const { head, value: rawValue } = contentLine(line, legacy);
  const value = rawValue.trim();
  const tz = legacy ? /;TZID="?([^;:"]+)/i.exec(line)?.[1] : parameterValue(head, "TZID");
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value);
  if (!m) return `${head}=${value}`;
  if (!m[4]) return `${name}=D${value}`;
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7] === "Z") return `${name}=${local}`;
  if (!tz) return `${name}=${local}F`;
  const fixed = !legacy && /^GMT([+-])(\d{2}):?(\d{2})$/i.exec(tz);
  if (fixed && +fixed[2] < 24 && +fixed[3] < 60) {
    const offset = (+fixed[2] * 60 + +fixed[3]) * (fixed[1] === "+" ? 1 : -1);
    return `${name}=${local - offset * 60_000}`;
  }
  const offsets = [local - 86400000, local, local + 86400000].map((at) => zoneOffsetMin(tz, at));
  if (offsets.some((offset) => offset === null)) return `${name}=${value}@${tz}`;
  const candidates = offsets
    .map((offset) => local - offset! * 60_000)
    .filter((at) => at + zoneOffsetMin(tz, at)! * 60_000 === local);
  // RFC 5545: first occurrence of an ambiguous time; pre-gap offset for a nonexistent time.
  return `${name}=${candidates.length ? Math.min(...candidates) : local - offsets[0]! * 60_000}`;
}

/** Recurrence dates are sets: providers may split, reorder, or rewrite their timezones. */
function normalizeRecurrenceDates(line: string, legacy: boolean): string[] {
  const { head, value } = contentLine(line, legacy);
  const name = propName(line);
  const period = /;VALUE=PERIOD(?:;|$)/i.test(head);
  return value.split(",").map((value) => {
    if (!period) return normalizedDateLine(`${head}:${value}`, legacy);
    const parts = value.split("/");
    if (parts.length !== 2) return `${head}=${value}`;
    const dateHead = head.replace(/;VALUE=PERIOD/i, "");
    const normalized = parts.map((part) =>
      /^[+-]?P/.test(part) ? part : normalizedDateLine(`${dateHead}:${part}`, legacy).slice(name.length + 1),
    );
    return `${name}=PERIOD:${normalized.join("/")}`;
  });
}

const normalizeText = (v: string) =>
  v
    .replace(/\\n/g, "\n")
    .replace(/\\([,;\\])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** Stable fingerprint of the human-visible content of every VEVENT in the file. */
export function fingerprint(lines: string[], legacyZeroDuration = false): string {
  return contentFingerprint(lines, legacyZeroDuration, false);
}

function contentFingerprint(lines: string[], legacyZeroDuration: boolean, legacyContentLines: boolean): string {
  let sig: string[] = [];
  const components: string[][] = [];
  let depth = 0; // 1 inside VEVENT, 2 inside a VALARM within it
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") {
      sig = ["|"];
      components.push(sig);
      depth = 1;
    } else if (l === "END:VEVENT") depth = 0;
    else if (l === "BEGIN:VALARM") depth = 2;
    else if (l === "END:VALARM") depth = 1;
    else if (depth === 1 && FP_PROPS.has(propName(l))) {
      const name = propName(l);
      if (/^(DTSTART|DTEND|RECURRENCE-ID)$/.test(name)) sig.push(normalizedDateLine(l, legacyContentLines));
      else if (name === "RDATE" || name === "EXDATE") sig.push(...normalizeRecurrenceDates(l, legacyContentLines));
      else {
        const value = normalizeText(contentLine(l, legacyContentLines).value);
        if (value && DEFAULTS[name] !== value) sig.push(`${name}=${value}`);
      }
    }
  }
  const signatures = components
    .map((properties) => {
      const start = properties.find((p) => p.startsWith("DTSTART="));
      if (!legacyZeroDuration && start && !start.startsWith("DTSTART=D"))
        properties = properties.filter(
          (p) => p !== `DTEND=${start.slice(8)}` && !/^DURATION=P(?=.*0)(?:0[WD])?(?:T(?:0H)?(?:0M)?(?:0S)?)?$/.test(p),
        );
      return properties.sort().join("\n");
    })
    .sort();
  const content = signatures.length <= 1 ? (signatures[0] ?? "") : JSON.stringify(signatures);
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}

/** Existing stamps and link baselines may predate parser or zero-duration corrections. */
export const matchesFingerprint = (lines: string[], baseline: string | null): boolean =>
  baseline !== null &&
  (fingerprint(lines) === baseline ||
    fingerprint(lines, true) === baseline ||
    contentFingerprint(lines, false, true) === baseline ||
    contentFingerprint(lines, true, true) === baseline);

// --- mirror construction ---------------------------------------------------

const STRIP = new Set(["ATTENDEE", "ORGANIZER", X_SOURCE, X_FP, X_MIRRORED]);

/** Copy `lines`, giving every VEVENT the new UID, no attendees, and `markers` (if any) before END:VEVENT. */
function rewrite(lines: string[], uid: string, markers: string[], strip: Set<string> = STRIP): string[] {
  let inEvent = false;
  return lines.flatMap((l) => {
    if (l === "BEGIN:VEVENT") inEvent = true;
    if (l === "END:VEVENT") return ((inEvent = false), [...markers, l]);
    if (!inEvent) return [l];
    const name = propName(l);
    return name === "UID" ? [`UID:${uid}`] : strip.has(name) ? [] : [l];
  });
}
const STRIP_MARKERS_ONLY = new Set([X_MIRRORED]);

export const toMirror = (source: string[], o: { uid: string; sourceSide: string; sourceUid: string; fp: string }) =>
  rewrite(source, o.uid, [`${X_SOURCE}:${o.sourceSide}:${o.sourceUid}`, `${X_FP}:${o.fp}`]);

/** Rebuild an original from an edited mirror, keeping the original's X-SYNC-MIRRORED lines. */
export function toOriginal(mirror: string[], sourceUid: string, mirroredOnSides: string[], original: string[] = []) {
  const invitations = new Map<string, string[]>();
  let component: string[] = [];
  let depth = 0;
  for (const line of original) {
    if (line === "BEGIN:VEVENT") {
      component = [line];
      depth = 1;
    } else if (line === "END:VEVENT") {
      component.push(line);
      const recurrence = component.find((l) => propName(l) === "RECURRENCE-ID");
      invitations.set(
        recurrence ? normalizeDateLine(recurrence) : "",
        component.filter((l) => ["ATTENDEE", "ORGANIZER"].includes(propName(l))),
      );
      depth = 0;
    } else if (depth) {
      if (line.startsWith("BEGIN:")) depth++;
      else if (line.startsWith("END:")) depth--;
      else if (depth === 1) component.push(line);
    }
  }
  let recurrence = "";
  return rewrite(
    mirror,
    sourceUid,
    mirroredOnSides.map((side) => `${X_MIRRORED}:${side}`),
  ).flatMap((line) => {
    if (line === "BEGIN:VEVENT") recurrence = "";
    if (propName(line) === "RECURRENCE-ID") recurrence = normalizeDateLine(line);
    return line === "END:VEVENT" ? [...(invitations.get(recurrence) ?? []), line] : [line];
  });
}

/** The original with `side` recorded as holding a mirror. */
export const withMirrored = (original: string[], side: string) =>
  rewrite(
    original,
    uidOf(original) ?? "",
    [...new Set([...mirroredOn(original), side])].map((s) => `${X_MIRRORED}:${s}`),
    STRIP_MARKERS_ONLY,
  );

/** Deterministic mirror UID so a re-run never creates a second copy. */
export const mirrorUid = (sourceSide: string, sourceUid: string) =>
  `${sourceUid.replace(/[^A-Za-z0-9@._-]/g, "_")}-mirror-${sourceSide}`;

/** Apple requires an explicit end/duration for a timed event with its implicit zero duration. */
export function withExplicitZeroDuration(lines: string[]): string[] {
  const result: string[] = [];
  let depth = 0;
  let timed = false;
  let hasEnd = false;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      depth = 1;
      timed = false;
      hasEnd = false;
    } else if (depth && line.startsWith("BEGIN:")) depth++;
    else if (line === "END:VEVENT") {
      if (timed && !hasEnd) result.push("DURATION:PT0S");
      depth = 0;
    } else if (depth && line.startsWith("END:")) depth--;
    else if (depth === 1) {
      if (propName(line) === "DTSTART") timed = /T\d{6}Z?$/.test(propValue(line));
      if (["DTEND", "DURATION"].includes(propName(line))) hasEnd = true;
    }
    result.push(line);
  }
  return result;
}
