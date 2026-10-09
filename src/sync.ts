// Two-way mirror between a pair of CalDAV calendars, stateless by design.
//
// Every event is an ORIGINAL or a MIRROR (our copy on the other side, marked
// X-SYNC-SOURCE:<side>:<uid> and X-SYNC-FP:<fingerprint at copy time>). Per
// original: no mirror → create; original changed → refresh mirror; mirror
// changed → push the edit back (both changed → later LAST-MODIFIED wins);
// No automatic deletions by default. With propagateDeletes explicitly enabled,
// missing originals or mirrors propagate deletion after an exact UID lookup.
// Originals are stamped only after mirror creation when deletion is enabled.

import type { CalDavAuth, CalDavEvent } from "./caldav.js";
import { deleteEvent, findByUid, listEvents, putEvent, scopedAuth, type RequestOptions } from "./caldav.js";
import {
  eventProp,
  fingerprint,
  fold,
  lastModifiedMs,
  mirroredOn,
  mirrorUid,
  sourceRef,
  toMirror,
  toOriginal,
  uidOf,
  unfold,
  withMirrored,
  X_FP,
} from "./ics.js";

import { actionNotice, performAction, ActionObserverError, type ActionHooks } from "./execution.js";

export type SyncOptions = RequestOptions &
  ActionHooks & {
    dryRun?: boolean;
    maxDeletes?: number;
    allowEmptyDeletes?: boolean;
  };

export type Side = { id: string; auth: CalDavAuth; url: string };
export type Pair = { name: string; a: Side; b: Side; propagateDeletes?: boolean };
export type Window = { start: Date; end: Date };

export type Parsed = CalDavEvent & {
  uid: string;
  lines: string[];
  fp: string;
  modified: number;
  source: { side: string; uid: string } | null;
  fpAtCopy: string | null;
  mirroredOn: string[];
};

export function parse(ev: CalDavEvent): Parsed | null {
  const lines = unfold(ev.ics);
  const uid = uidOf(lines);
  return uid
    ? {
        ...ev,
        uid,
        lines,
        fp: fingerprint(lines),
        modified: lastModifiedMs(lines),
        source: sourceRef(lines),
        fpAtCopy: eventProp(lines, X_FP),
        mirroredOn: mirroredOn(lines),
      }
    : null;
}

/** `etag: null` on a put means create. `stamp: true` marks a write that only adds
 *  X-SYNC-MIRRORED to an original; nothing else in the run depends on it. */
export type Action =
  | { kind: "put"; on: string; href: string; etag: string | null; ics: string; why: string; stamp?: true }
  | {
      kind: "delete-if-orphan";
      on: string;
      href: string;
      etag: string | null;
      sourceSide: string;
      sourceUid: string;
      why: string;
    }
  | {
      kind: "delete-if-mirror-gone";
      on: string;
      href: string;
      etag: string | null;
      mirrorSide: string;
      mirrorUid: string;
      why: string;
    };

type Put = Extract<Action, { kind: "put" }>;

/** Pure: originals on `from`, mirrors on `to`. */
export function planDirection(
  from: Side,
  to: Side,
  fromEvents: Parsed[],
  toEvents: Parsed[],
  opts: { propagateDeletes?: boolean } = {},
): Action[] {
  const propagate = opts.propagateDeletes === true;
  const originals = new Map(fromEvents.filter((e) => !e.source).map((e) => [e.uid, e]));
  const mirrors = new Map(toEvents.filter((e) => e.source?.side === from.id).map((e) => [e.source!.uid, e]));
  const put = (on: string, ev: { href: string; etag: string | null }, ics: string[], why: string): Put => ({
    kind: "put",
    on,
    href: ev.href,
    etag: ev.etag,
    ics: fold(ics),
    why,
  });
  const mirrorOf = (src: Parsed, uid: string, fp: string) =>
    toMirror(src.lines, { uid, sourceSide: from.id, sourceUid: src.uid, fp });
  const actions: Action[] = [];

  for (const [uid, orig] of originals) {
    const mirror = mirrors.get(uid);
    const mUid = mirrorUid(from.id, uid);
    const stamped = orig.mirroredOn.includes(to.id);
    if (!mirror && stamped && propagate) {
      // The stamp says a mirror existed; it is gone → a human deleted it → delete the original too.
      actions.push({
        kind: "delete-if-mirror-gone",
        on: from.id,
        href: orig.href,
        etag: orig.etag,
        mirrorSide: to.id,
        mirrorUid: mUid,
        why: `mirror of ${uid} deleted on ${to.id}`,
      });
      continue;
    }
    if (!mirror) {
      actions.push(
        put(
          to.id,
          { href: to.url + encodeURIComponent(mUid) + ".ics", etag: null },
          mirrorOf(orig, mUid, orig.fp),
          `new original ${uid} on ${from.id}`,
        ),
      );
    }
    const mirrorEdited =
      mirror &&
      orig.fp !== mirror.fp &&
      mirror.fp !== mirror.fpAtCopy &&
      (orig.fp === mirror.fpAtCopy || mirror.modified > orig.modified);
    if (propagate && !stamped && !mirrorEdited) {
      actions.push({
        ...put(from.id, orig, withMirrored(orig.lines, to.id), `stamp ${uid} as mirrored on ${to.id}`),
        stamp: true,
      });
    }
    if (!mirror) {
      continue;
    } else if (orig.fp === mirror.fpAtCopy && mirror.fp === mirror.fpAtCopy) {
      continue;
    } else if (orig.fp === mirror.fp) {
      // Same content, stale stamp (e.g. fingerprint rules changed): fix the stamp only.
      actions.push(
        put(
          to.id,
          mirror,
          toMirror(mirror.lines, { uid: mirror.uid, sourceSide: from.id, sourceUid: uid, fp: mirror.fp }),
          `re-stamp ${mirror.uid} (content already equal)`,
        ),
      );
    } else if (mirrorEdited) {
      // A human edited the copy: push it back, then re-stamp the copy.
      actions.push(
        put(
          from.id,
          orig,
          toOriginal(mirror.lines, uid, [...new Set([...orig.mirroredOn, ...(propagate ? [to.id] : [])])], orig.lines),
          `mirror ${mirror.uid} edited on ${to.id}`,
        ),
      );
      actions.push(
        put(
          to.id,
          mirror,
          toMirror(mirror.lines, { uid: mirror.uid, sourceSide: from.id, sourceUid: uid, fp: mirror.fp }),
          `re-stamp ${mirror.uid}`,
        ),
      );
    } else {
      actions.push(put(to.id, mirror, mirrorOf(orig, mirror.uid, orig.fp), `original ${uid} changed on ${from.id}`));
    }
  }
  for (const [uid, mirror] of mirrors) {
    if (propagate && !originals.has(uid))
      actions.push({
        kind: "delete-if-orphan",
        on: to.id,
        href: mirror.href,
        etag: mirror.etag,
        sourceSide: from.id,
        sourceUid: uid,
        why: `source ${uid} not in window on ${from.id}`,
      });
  }
  return actions;
}

export const plan = (pair: Pair, a: Parsed[], b: Parsed[]): Action[] => [
  ...planDirection(pair.a, pair.b, a, b, pair),
  ...planDirection(pair.b, pair.a, b, a, pair),
];

export type PairResult = {
  pair: string;
  a: number;
  b: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  errors: string[];
  /** Stamp writes that failed. The original keeps syncing; deletes of its mirror will not propagate. */
  warnings?: string[];
  actions?: Action[];
};

export const window = (pastDays: number, futureDays: number, now = new Date()): Window => ({
  start: new Date(now.getTime() - pastDays * 86400_000),
  end: new Date(now.getTime() + futureDays * 86400_000),
});

export async function syncPair(pair: Pair, win: Window, opts: SyncOptions = {}): Promise<PairResult> {
  opts.signal?.throwIfAborted();
  pair = {
    ...pair,
    a: { ...pair.a, auth: scopedAuth(pair.a.auth, opts) },
    b: { ...pair.b, auth: scopedAuth(pair.b.auth, opts) },
  };
  if (pair.a.id === pair.b.id) throw new Error("Sync sides must have distinct IDs");
  const load = async (s: Side) =>
    (await listEvents(s.auth, s.url, win)).map(parse).filter((e): e is Parsed => e != null);
  const [a, b] = await Promise.all([load(pair.a), load(pair.b)]);
  opts.signal?.throwIfAborted();
  // Reject ambiguous identities before planning any writes. Keep existing mirror UIDs stable.
  for (const [side, events] of [
    [pair.a, a],
    [pair.b, b],
  ] as const) {
    const uids = new Set<string>();
    const mirrorUids = new Set<string>();
    for (const event of events) {
      if (uids.has(event.uid)) throw new Error("Calendar contains duplicate resource UIDs");
      uids.add(event.uid);
      if (event.source) continue;
      const uid = mirrorUid(side.id, event.uid);
      if (mirrorUids.has(uid)) throw new Error("Original UIDs produce colliding mirror UIDs");
      mirrorUids.add(uid);
    }
  }
  const actions = plan(pair, a, b);
  const maxDeletes = opts.maxDeletes ?? 10;
  if (!Number.isInteger(maxDeletes) || maxDeletes < 0) throw new Error("maxDeletes must be a nonnegative integer");
  const deleteCount = actions.filter((action) => action.kind !== "put").length;
  if (!opts.dryRun && deleteCount > maxDeletes)
    throw new Error(`Deletion limit exceeded: ${deleteCount} proposed, limit ${maxDeletes}`);
  if (!opts.dryRun && deleteCount && (!a.length || !b.length) && opts.allowEmptyDeletes !== true)
    throw new Error("Refusing deletions while a calendar is empty; inspect a dry run before explicitly overriding");
  const result: PairResult = {
    pair: pair.name,
    a: a.length,
    b: b.length,
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    errors: [],
    warnings: [],
  };
  if (opts.dryRun) return { ...result, actions };

  const sides = new Map([pair.a, pair.b].map((s) => [s.id, s]));
  for (const [index, act] of actions.entries()) {
    opts.signal?.throwIfAborted();
    const side = sides.get(act.on)!;
    const notice = actionNotice({
      operation: act.kind === "put" ? (act.etag ? "update" : "create") : "delete",
      pair: pair.name,
      side: side.id,
      href: act.href,
      etag: act.etag,
      internal: act.kind === "put" && !!act.stamp,
      ics: act.kind === "put" ? act.ics : [...a, ...b].find((event) => event.href === act.href)?.ics,
    });
    try {
      if (act.kind === "put") {
        await performAction(notice, () => putEvent(side.auth, act.href, act.ics, act.etag), opts);
        act.etag ? result.updated++ : result.created++;
      } else {
        const other = sides.get(act.kind === "delete-if-orphan" ? act.sourceSide : act.mirrorSide)!;
        const uid = act.kind === "delete-if-orphan" ? act.sourceUid : act.mirrorUid;
        if (await findByUid(other.auth, other.url, uid)) result.skipped++;
        else {
          const status = await performAction(
            notice,
            async () => {
              // An awaited hook can let the counterpart reappear. Never delete based on its old absence.
              if (opts.beforeAction && (await findByUid(other.auth, other.url, uid))) return "skipped";
              await deleteEvent(side.auth, act.href, act.etag);
            },
            opts,
          );
          if (status === "skipped") result.skipped++;
          else result.deleted++;
        }
      }
    } catch (e) {
      if (e instanceof ActionObserverError) throw e;
      opts.signal?.throwIfAborted();
      const msg = `${act.kind} ${act.href}: ${e instanceof Error ? e.message : String(e)}`;
      if (act.kind === "put" && act.stamp) {
        // Some originals cannot be written at all (Google events generated from
        // Gmail, invitations you don't organize). Their mirrors still sync; only
        // delete propagation for that event is lost. Don't let one block the pair.
        result.warnings!.push(msg);
        continue;
      }
      result.errors.push(msg);
      // Later actions may depend on this write (creation -> stamp, edit -> re-stamp).
      // Retry from fresh server state on the next run instead of recording a false success.
      result.skipped += actions.length - index - 1;
      break;
    }
  }
  return result;
}
