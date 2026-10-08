import { CalDavError, deleteEvent, findByUid, putEvent } from "./caldav.js";
import { actionNotice, performAction, type ActionNotice } from "./execution.js";
import { fingerprint, fold, matchesFingerprint, toOriginal, unfold, uidOf } from "./ics.js";
import { parse, type Pair, type Parsed, type SyncOptions } from "./sync.js";

export type ExistingLink = {
  aUid: string;
  bUid: string;
  aFp: string;
  bFp: string;
  reviewOnChange?: boolean;
  closed?: boolean;
  pending?: {
    target: "a" | "b";
    etag: string;
    sourceFp: string;
    expectedFp: string;
    ics: string;
  };
};
export type LinkState = {
  version: 1;
  fingerprintVersion: 1;
  calendars: [string, string];
  links: ExistingLink[];
};
export type LinkStore = {
  load(): Promise<LinkState>;
  save(state: LinkState): Promise<void>;
};

export const hasInvitations = (event: Parsed) => event.lines.some((l) => /^(ATTENDEE|ORGANIZER)[;:]/i.test(l));

/** Google CalDAV can replace conference details even on a metadata-only PUT. */
export const protectedOriginal = (event: Parsed, side: string) =>
  hasInvitations(event) ||
  (side === "google" &&
    event.lines.some(
      (line) =>
        /^(CONFERENCE|X-GOOGLE-CONFERENCE|X-RDCAL-CONFERENCEINFO|X-MICROSOFT-ONLINEMEETING[^;:]*)[;:]/i.test(line) ||
        /^(DESCRIPTION|LOCATION|URL)[;:].*https?:\/\/(?:meet\.google\.com|teams\.microsoft\.com|(?:[^/]+\.)?zoom\.us)\//i.test(
          line,
        ),
    ));

/** Links are explicitly adopted originals, never an unchecked event exclusion list. */
export function validateLinks(pair: Pair, snapshots: [Parsed[], Parsed[]], state: LinkState): void {
  if (
    state.version !== 1 ||
    state.fingerprintVersion !== 1 ||
    JSON.stringify(state.calendars) !== JSON.stringify([pair.a.url, pair.b.url]) ||
    !Array.isArray(state.links)
  )
    throw new Error("Existing-link state does not match this calendar pair");
  const endpoints = [new Set<string>(), new Set<string>()];
  for (const link of state.links) {
    if (
      pair.heldOriginals?.some(
        (hold) =>
          (hold.side === pair.a.id && hold.uid === link.aUid) || (hold.side === pair.b.id && hold.uid === link.bUid),
      )
    )
      throw new Error("Use reviewOnChange to hold an existing link");
    for (const [i, side] of ["a", "b"].entries()) {
      const uid = side === "a" ? link.aUid : link.bUid;
      const fp = side === "a" ? link.aFp : link.bFp;
      if (typeof uid !== "string" || !uid || !/^[0-9a-f]{16}$/.test(fp) || endpoints[i].has(uid))
        throw new Error("Invalid or duplicate existing-link endpoint");
      endpoints[i].add(uid);
      const matches = snapshots[i].filter((e) => e.uid === uid);
      if (matches.length > 1 || matches.some((e) => e.source))
        throw new Error("Existing-link endpoint is ambiguous or already a mirror");
      if (snapshots[1 - i].some((e) => e.source?.side === (i === 0 ? pair.a.id : pair.b.id) && e.source.uid === uid))
        throw new Error("An ordinary mirror refers to an existing-link endpoint");
    }
    if (
      link.pending &&
      (!["a", "b"].includes(link.pending.target) ||
        !link.pending.etag ||
        !/^[0-9a-f]{16}$/.test(link.pending.sourceFp) ||
        !/^[0-9a-f]{16}$/.test(link.pending.expectedFp) ||
        uidOf(unfold(link.pending.ics)) !== (link.pending.target === "a" ? link.aUid : link.bUid) ||
        !matchesFingerprint(unfold(link.pending.ics), link.pending.expectedFp))
    )
      throw new Error("Invalid pending existing-link operation");
  }
  if (
    snapshots[0].some(
      (a) =>
        !a.source &&
        !endpoints[0].has(a.uid) &&
        snapshots[1].some((b) => !b.source && !endpoints[1].has(b.uid) && b.uid === a.uid),
    )
  )
    throw new Error("An original UID already exists in both calendars; adopt an existing link before syncing");
}

export async function reconcileLinks(pair: Pair, snapshots: [Parsed[], Parsed[]], store: LinkStore, opts: SyncOptions) {
  const state = structuredClone(await store.load());
  validateLinks(pair, snapshots, state);
  const result = { updated: 0, deleted: 0, skipped: 0, warnings: [] as string[], actions: [] as ActionNotice[] };
  const persist = async () => {
    if (!opts.dryRun) await store.save(structuredClone(state));
  };
  for (const link of state.links) {
    opts.signal?.throwIfAborted();
    let a = snapshots[0].find((e) => e.uid === link.aUid);
    let b = snapshots[1].find((e) => e.uid === link.bUid);
    if (link.closed) {
      if (a || b) {
        result.skipped++;
        result.warnings.push("A closed existing link has reappeared; review its restoration");
      }
      continue;
    }
    const loadedPending = link.pending;
    if (link.pending) {
      // Upgrade the saved intent, never a newer source snapshot.
      const lines = unfold(link.pending.ics);
      const canonicalFp = fingerprint(lines);
      if (matchesFingerprint(lines, link.pending.sourceFp)) link.pending.sourceFp = canonicalFp;
      link.pending.expectedFp = canonicalFp;
    }
    // Full-list snapshots are required. Confirm absence independently before deleting.
    if (!a) a = parseOrUndefined(await findByUid(pair.a.auth, pair.a.url, link.aUid));
    if (!b) b = parseOrUndefined(await findByUid(pair.b.auth, pair.b.url, link.bUid));
    if (a?.source || b?.source) throw new Error("Existing-link endpoint changed into a mirror");
    if (!a && !b) {
      link.closed = true;
      delete link.pending;
      await persist();
      continue;
    }
    if (!a || !b) {
      const survivor = a ?? b!;
      const side = a ? pair.a : pair.b;
      const missingSide = a ? pair.b : pair.a;
      const missingUid = a ? link.bUid : link.aUid;
      if (
        link.reviewOnChange ||
        !pair.propagateDeletes ||
        (pair.protectInvitations && protectedOriginal(survivor, side.id))
      ) {
        result.skipped++;
        result.warnings.push("Existing-link deletion held by deletion/invitation policy");
        continue;
      }
      if (link.pending || !matchesFingerprint(survivor.lines, a ? link.aFp : link.bFp)) {
        result.skipped++;
        result.warnings.push("Existing-link deletion conflicts with an edit; review before reconciling");
        continue;
      }
      const notice = actionNotice({
        operation: "delete",
        pair: pair.name,
        side: side.id,
        href: survivor.href,
        etag: survivor.etag,
        ics: survivor.ics,
        internal: false,
      });
      result.actions.push(notice);
      if (opts.dryRun) {
        result.skipped++;
        continue;
      }
      const outcome = await performAction(
        notice,
        async () => {
          if (await findByUid(missingSide.auth, missingSide.url, missingUid)) return "skipped";
          await deleteEvent(side.auth, survivor.href, survivor.etag);
        },
        opts,
      );
      if (outcome === "skipped") {
        result.skipped++;
        continue;
      }
      result.deleted++;
      link.closed = true;
      await persist();
      continue;
    }
    const events = { a, b };
    if (link.pending) {
      const pending = link.pending;
      const target = events[pending.target];
      if (target.fp === pending.expectedFp) {
        if (pending.target === "b") {
          link.aFp = pending.sourceFp;
          link.bFp = pending.expectedFp;
        } else {
          link.bFp = pending.sourceFp;
          link.aFp = pending.expectedFp;
        }
        delete link.pending;
        await persist();
      } else if (target.etag !== pending.etag) {
        result.skipped++;
        result.warnings.push(
          "An uncertain linked write conflicts with a new destination version; pending intent retained",
        );
        continue;
      }
    }
    if (!link.pending) {
      const aChanged = !matchesFingerprint(a.lines, link.aFp);
      const bChanged = !matchesFingerprint(b.lines, link.bFp);
      if (!aChanged && !bChanged) continue;
      if (a.fp === b.fp) {
        link.aFp = a.fp;
        link.bFp = b.fp;
        await persist();
        continue;
      }
      if (link.reviewOnChange) {
        result.skipped++;
        result.warnings.push("A previously divergent existing link changed; review its notes before reconciling");
        continue;
      }
      if (aChanged && bChanged && (!a.modified || !b.modified || a.modified === b.modified))
        throw new Error("Simultaneous existing-link edits have no reliable timestamp winner");
      const targetKey = aChanged && (!bChanged || a.modified > b.modified) ? "b" : "a";
      const source = targetKey === "b" ? a : b;
      const target = events[targetKey];
      if (link.reviewOnChange || (pair.protectInvitations && protectedOriginal(target, pair[targetKey].id))) {
        result.skipped++;
        result.warnings.push("Existing-link edit held to protect an invitation or native Google conference");
        continue;
      }
      if (!target.etag) throw new Error("Existing-link update requires an ETag");
      const ics = fold(toOriginal(source.lines, target.uid, target.mirroredOn, target.lines));
      link.pending = {
        target: targetKey,
        etag: target.etag,
        sourceFp: source.fp,
        expectedFp: fingerprint(unfold(ics)),
        ics,
      };
      await persist();
    }
    const pending = link.pending;
    const target = events[pending.target];
    const side = pair[pending.target];
    if (link.reviewOnChange || (pair.protectInvitations && protectedOriginal(target, side.id))) {
      result.skipped++;
      result.warnings.push("Pending existing-link edit held by invitation policy");
      continue;
    }
    const notice = actionNotice({
      operation: "update",
      pair: pair.name,
      side: side.id,
      href: target.href,
      etag: pending.etag,
      ics: pending.ics,
      internal: false,
    });
    result.actions.push(notice);
    if (opts.dryRun) {
      result.skipped++;
      continue;
    }
    try {
      await performAction(notice, () => putEvent(side.auth, target.href, pending.ics, pending.etag), opts);
    } catch (error) {
      if (!(error instanceof CalDavError) || error.status < 400 || error.status >= 500 || error.status === 408)
        throw error;
      // A rejected retry does not resolve an earlier attempt's uncertain outcome.
      if (pending === loadedPending) {
        result.skipped++;
        result.warnings.push(`Existing-link retry rejected (HTTP ${error.status}); prior uncertain intent retained`);
        continue;
      }
      delete link.pending;
      await persist();
      result.skipped++;
      result.warnings.push(`Existing-link PUT rejected (HTTP ${error.status}); retry from fresh state`);
      continue;
    }
    result.updated++;
    const verified = parseOrUndefined(await findByUid(side.auth, side.url, target.uid));
    if (!verified || verified.fp !== pending.expectedFp)
      throw new Error("Linked write changed before verification; pending operation retained");
    if (pending.target === "b") {
      link.aFp = pending.sourceFp;
      link.bFp = pending.expectedFp;
    } else {
      link.bFp = pending.sourceFp;
      link.aFp = pending.expectedFp;
    }
    delete link.pending;
    await persist();
  }
  const aUids = new Set(state.links.map((l) => l.aUid));
  const bUids = new Set(state.links.map((l) => l.bUid));
  return {
    ...result,
    a: snapshots[0].filter((e) => !aUids.has(e.uid)),
    b: snapshots[1].filter((e) => !bUids.has(e.uid)),
  };
}

function parseOrUndefined(event: Parameters<typeof parse>[0] | null): Parsed | undefined {
  return event ? (parse(event) ?? undefined) : undefined;
}
