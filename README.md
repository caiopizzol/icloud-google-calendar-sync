# icloud-google-calendar-sync

Two-way iCloud and Google Calendar sync. Creates and edits sync both ways;
automatic deletion is off by default. Requires Node.js 20.3+ or a runtime with
Node-compatible crypto, Buffer, and AbortSignal.any support.

[Overview and setup](https://jimbo.sh/icloud-google-calendar-sync) /
[npm](https://www.npmjs.com/package/icloud-google-calendar-sync)

## Why

Keep Google and iCloud calendars in sync, including shared calendars and events
created by agents. Google can serve as the automation layer while Apple Calendar
stays the interface for people.

In Apple Calendar, uncheck the mirrored Google calendars to hide duplicate views.

## How it works

Every event on either side is an **original** or a **mirror**. A mirror is a
copy of the original's VCALENDAR with three changes:

- the UID is rewritten (`<uid>-mirror-<side>`), so a re-run never makes a
  second copy
- every `ATTENDEE` and `ORGANIZER` is stripped, so a mirror can never turn into
  an invitation (iCloud will happily loop you into accepting your own event)
- two markers are added inside the event: `X-SYNC-SOURCE:<side>:<uid>` and
  `X-SYNC-FP:<fingerprint of the original when copied>`

No database or mapping table is required.
Each run lists both calendars over CalDAV for a time window and decides, per
original:

| situation                          | action                             |
| ---------------------------------- | ---------------------------------- |
| no mirror yet                      | create one                         |
| original changed, mirror untouched | refresh the mirror                 |
| mirror edited by a human           | push the edit back to the original |
| both changed                       | later `LAST-MODIFIED` wins         |
| mirror's original is gone          | keep the mirror                    |
| original's mirror is gone          | recreate the mirror                |

"Changed" is a fingerprint of what a human would notice (title, times, location,
notes, recurrence), normalized so that a server rewriting `DTSTAMP`, `SEQUENCE`,
`VTIMEZONE`, or padding an event with empty `DESCRIPTION:` (Google does this)
does not count as an edit. Times are compared as instants, so
`DTSTART;TZID=America/Chicago:…` and the same moment in UTC are equal.

**Automatic deletion is off by default.** Creates and edits still sync both ways.
Deleting an original leaves its mirror intact; deleting a mirror recreates it
on the next run while the original exists. To remove an event completely,
pause your scheduler, remove both copies, then resume it.

Set `"propagateDeletes": true` on a pair to opt into deletions in both directions.
In this mode, originals are stamped `X-SYNC-MIRRORED:<side>` after mirror creation.
A missing mirror deletes its stamped original; a missing original deletes its
mirror. Both require an exact UID lookup across all dates to confirm absence
and an ETag for a conditional deletion. Failed or incomplete CalDAV reports stop
the operation; they do not count as an empty calendar.
Omitting the option or setting `"propagateDeletes": false` disables both kinds
of deletion, including for events stamped by an earlier version.

**Upgrading from 0.2.x:** deletion is no longer automatic. Keep the option unset
for the new behavior, or explicitly set it to `true` to retain deletion propagation.

## Setup

1. **Google.** In [console.cloud.google.com](https://console.cloud.google.com)
   create a project, enable the **Google Calendar API** and the **CalDAV API**,
   and create an OAuth client of type **Desktop**. Then:

   ```
   npx icloud-google-calendar-sync auth google --client-id … --client-secret …
   ```

   Approve in the browser. It prints a refresh token. The callback listens only
   on loopback, checks OAuth state, and uses PKCE. `--out credentials.tokens.json`
   saves a new owner-readable file instead; it refuses to overwrite existing files.

2. **iCloud.** At [account.apple.com](https://account.apple.com) → Sign-In &
   Security → App-Specific Passwords, make one. Your username is your Apple ID's
   primary email.

3. **Find your calendars.**

   ```
   ICLOUD_USERNAME=… ICLOUD_APP_PASSWORD=… npx icloud-google-calendar-sync discover icloud
   GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… GOOGLE_OAUTH_REFRESH_TOKEN=… npx icloud-google-calendar-sync discover google
   ```

4. **Write `mirror.config.json`** (see `mirror.config.example.json`). Use `"env:NAME"`
   for credentials and keep personal calendar IDs and URLs out of git.

5. **Dry run, then run.**

   ```
   npx icloud-google-calendar-sync sync --dry
   npx icloud-google-calendar-sync sync
   ```

6. **Cron it.** Every 5 minutes is plenty. Any cron works; the CLI exits
   non-zero on errors.

## As an HTTP handler

```ts
// app/api/calendar/sync/route.ts (Next.js, Node runtime)
import { createHandler, loadConfig } from "icloud-google-calendar-sync";

export const GET = createHandler({
  config: loadConfig(null), // from env
  secret: process.env.CRON_SECRET!,
});
```

`GET /?dry=1` plans without writing. `GET /?pair=name` limits to one pair. Auth
is `Authorization: Bearer <secret>` or `x-api-key: <secret>`. Point
[cron-job.org](https://cron-job.org) (free) or anything else at it.

GitHub Actions schedules are not a good cron for this: on low-traffic repos
they fire hours late.

For custom authentication, pass `authorize(req)` instead of `secret`. Return
`true` to allow syncing, `false` to return 401, or a `Response` to return it
unchanged. Async hooks are supported. If both options are supplied, the hook
takes precedence.

A failed sync action stops that pair for the current run. Remaining actions
are reported as skipped and retried from fresh calendar state on the next run.
With deletion propagation enabled, the exception is the `X-SYNC-MIRRORED` stamp:
some originals reject writes, including Gmail-generated events and invitations
you don't organize.
A failed stamp is reported under `warnings`, the run is still `ok`, and the
pair carries on. That event still mirrors both ways; deleting its mirror just
brings the mirror back instead of deleting the original.

## Action hooks and cancellation

Library callers can observe individual writes without parsing console output:

```ts
import { pairsFor, syncPair, window, type SyncOptions } from "icloud-google-calendar-sync";

const options: SyncOptions = {
  signal: AbortSignal.timeout(90_000),
  beforeAction: async (action) => {
    // Persist intent in your own private log. Throwing prevents this write.
    await journal.start(action);
  },
  onAction: async (action) => {
    // completed, skipped, failed, or uncertain. Persist the actual status.
    await journal.finish(action);
  },
};

for (const pair of pairsFor(config, options)) {
  await syncPair(pair, window(30, 365), options);
}
```

`config` and `journal` above are supplied by your application; the package does
not add a datastore. The same options work with `createHandler` and
`consolidateDuplicates`. HTTP handlers also honor the incoming request's signal.
`reviewDuplicates` and `createJevMatcher` accept a signal for read-only work.

Hooks are awaited and receive detached copies. Each notice includes a deterministic
write ID, operation (`create`, `update`, or `delete`), pair, side, resource URL,
ETag, and available ICS. Internal metadata stamps have `internal: true` so a UI
can hide them. Consolidation emits one action per physical deletion, grouped by
`consolidationId`; the existing `onDelete` hook carries that same ID and the Jev
score. IDs identify intended writes, not globally unique runs: scope your journal
by customer and run as well.

Dry runs never invoke write hooks. A skipped outcome means a deletion's missing
counterpart reappeared while its before hook was running. Known client HTTP
rejections are failed; transport errors, timeouts, and server errors are uncertain
because a write may already have committed. A completed sync action means its
provider request succeeded; consolidation also checks that deleted resources are
absent. Unattempted actions do not receive outcomes.

A hook failure throws `ActionObserverError` and stops further work. Its `phase`
is `before` or `after`; `action.status` remains `completed` if the calendar write
succeeded but recording completion failed. Inspect that outcome and reconcile
with the calendar before retrying. The HTTP handler returns a generic failure;
retain outcomes in the hooks if you need a durable journal.

Cancellation prevents subsequent operations and aborts in-flight provider calls,
including Google token refresh and Jev requests. It cannot roll back an accepted
calendar write. Your own async hooks, injected transports, and custom token or
comparison functions must cooperate with cancellation too.

**Notices contain private calendar data.** Select only the fields you need for
logs. They are not intended as a public HTTP response. There is no built-in undo,
retention policy, distributed lock, or retry queue.

### Restrict credential destinations

Custom CalDAV servers still work by default. Hosted applications can restrict
credentials to known providers before any token is resolved or sent:

```ts
import { providerUrlPolicy, scopedAuth } from "icloud-google-calendar-sync";

const icloudAuth = scopedAuth(auth, {
  allowUrl: providerUrlPolicy("icloud"),
  signal: AbortSignal.timeout(30_000),
});
```

The iCloud policy allows `caldav.icloud.com` and `p<number>-caldav.icloud.com` over
HTTPS on the default port. The Google policy allows
`apidata.googleusercontent.com/caldav/v2/`. Discovery destinations are checked as
well. Attach the appropriate policy to each side's auth for provider-specific
restrictions, or pass an application policy as `allowUrl` in the run options.
Run policies intersect with existing auth policies; they cannot weaken them.
The callback must return `true` to allow a destination and receives a detached
URL. These checks do not establish calendar ownership: a hosted app must still
validate selected calendars against the customer's own discovery results.

## Pairs

A pair is two calendars mirrored into each other. Typical setup:

```json
"pairs": [
  { "name": "personal", "a": "google:you@gmail.com",                       "b": "icloud:<your main iCloud calendar>" },
  { "name": "shared",   "a": "google:<a calendar you made for agents>",  "b": "icloud:<a calendar shared with your partner>" }
]
```

`google:<calendarId>` is a Google calendar id (the email for the primary).
`icloud:<url>` is a CalDAV collection URL from `discover icloud`. Shared iCloud
calendars work as long as you have write access. Each sync pair must have distinct
side IDs (the config loader uses `google` and `icloud`).

## Notes

- CalDAV requests require HTTPS, reject redirects, and time out after 15 seconds.
  Event URLs returned by the server must stay inside the requested collection.
- Edits from a mirror preserve the original's attendees and organizer; those
  fields remain absent from the mirror.
- Recurring-event fingerprints keep each occurrence's fields together. Updating
  from an earlier version can cause a one-time fingerprint refresh on recurring
  resources. Use a dry run when upgrading.
- Colliding resource or mirror UIDs stop the pair before writes. Existing mirror
  UID formats are preserved so an upgrade does not create replacement copies.

- **Never mirror attendees.** An event on a shared iCloud calendar with the
  owner as an invitee becomes an invitation to yourself, and every device will
  ask you to accept it forever.
- **Google pads stored events** with `DESCRIPTION:`, `LOCATION:`,
  `STATUS:CONFIRMED`, `TRANSP:OPAQUE`. If your change detection is naive, every
  Google-side mirror looks edited on the next run and ping-pongs.
- **Google CalDAV needs the CalDAV API enabled** separately from the Calendar
  API, in the same Cloud project.

## Development

```
pnpm install
pnpm verify   # typecheck, tests, prettier, build
```

MIT.

## Optional Jev deduplication

Set a priority rule using your existing pair names:

```json
{
  "dedupe": {
    "provider": "gateway",
    "apiKey": "env:AI_GATEWAY_API_KEY",
    "threshold": 0.95,
    "rules": [{ "prefer": "shared", "over": ["personal"], "mode": "review" }]
  }
}
```

Add this block to `mirror.config.json`, or set `CALENDAR_DEDUPE` to the same
inner object as JSON. Direct TypeSafe users choose `"provider": "typesafe"` and
`"apiKey": "env:TYPESAFE_API_KEY"`. Each lower-priority pair can belong to only one
rule. Preferred pairs cannot also be lower-priority pairs.

Run a review explicitly:

```sh
npx icloud-google-calendar-sync review --config mirror.config.json
```

With `createHandler`, use an authenticated `GET /?review=1`. This is a separate,
read-only operation. Review cannot be combined with pair selection. Rules default
to `review`; normal sync only calls Jev when a rule explicitly uses `delete`.
Dry runs and single-pair syncs never run deduplication.

The report lists suggested `keep` and `duplicate` occurrences, with pair names,
event titles, resource URLs, UIDs, recurrence IDs, and the match probability.
Calendar priority comes from your rule, not the model. Unrelated personal events
stay personal. The report contains private event data; store it accordingly.

Review reads originals from both sides of each named pair and ignores marked
mirrors and cancelled events. It asks CalDAV to expand recurring events within
the configured sync window. Unexpanded recurrences, floating or unknown-zone
times, duration-only timed events, and invalid or oversized fields are skipped
and counted. All-day dates use UTC midnight as a comparison convention; mixed
all-day/timed matches near a date boundary can be missed. Server expansion
failures are reported, not treated as an empty calendar.

Only overlapping occurrences are compared, and only when they share a title word
(three or more letters or digits, ignoring "and", "the", "for", "with", "from") or
start at the same instant. Overlap alone would pair a hotel stay with every event
during it. Other pairs are counted in `unlikelyPairs` and never sent to Jev, so a
duplicate with an unrelated title and a different start time is missed. Reviews stop at 100 comparisons
(configurable with `dedupe.maxComparisons`, up to 1000), or before starting another
comparison after 20 seconds of model work. An in-flight request can take another
5 seconds; calendar reads are outside that budget. `truncated`, `skippedEvents`,
`unavailable`, and `errors` describe incomplete coverage. Read failures, model
failures, and truncation produce CLI exit code 1 or HTTP 502 while preserving any
suggestions already collected. Skipped unsupported events are counted separately.
The review command never performs cleanup, including with delete rules configured.
Reviewed decisions are not persisted unless you pass a `store` (see below).

For library use, import `reviewDuplicates` from
`icloud-google-calendar-sync/dedupe` and pass the result of `loadConfig`.

### Opt-in deletion

Set a rule to `"mode": "delete"` to remove matching originals from lower-priority
pairs and their linked mirrors after a successful full sync:

```json
{ "prefer": "shared", "over": ["personal"], "mode": "delete" }
```

**Deletion has no built-in backups, history, or undo. Add application logging
before enabling it; save recovery copies if you need restoration.** The preferred
event is unchanged. This removes duplicates; it does not combine event fields.

Both involved pairs must have `propagateDeletes` disabled. Cleanup checks fresh
resource contents and strong ETags, skips independently edited mirrors, and uses
conditional deletion. Recurrences, cancellations, and invitations (including
Gmail reservations with organizer fields) are not eligible. Incomplete reviews
never start cleanup. Review-only rules never authorize deletion.

The mirror is deleted first, then the original, with exact resource lookups to
verify removal. If interrupted after the mirror disappears, the original remains.
The next normal sync may recreate its mirror before another fresh review retries
cleanup. No completed decision is cached. This is not a transaction across two
providers: failures may leave one copy, and a later review can reach a different
decision. Results report confirmed `deletedCopies`, `status`, and a safe `reason`.
Unknown outcomes require a fresh calendar read.

**Serialize all writers to these calendars**, including CLI runs and other app
instances. The handler rejects overlapping requests to that handler instance;
it cannot coordinate across processes or serverless instances. Use your scheduler
or host's locking mechanism there. No storage adapter or database is bundled.

Library calls can use an awaited hook for logs or backups:

```ts
import { consolidateDuplicates } from "icloud-google-calendar-sync/dedupe";

const result = await consolidateDuplicates(config, {
  async onDelete(notice) {
    // phase: "before" or "completed". Contains private event and recovery data.
    await saveAuditRecord(notice); // Your application's implementation.
  },
});
```

The `before` hook runs before any delete and receives the original and mirror ICS
copies, URLs, ETags, and match probability. Throwing aborts that cleanup. Event
contents are rechecked after the hook. A failed `completed` hook is reported without
mislabeling a verified deletion as undone. Use the same `onDelete` option on
`createHandler`. The CLI prints structured results but does not persist backups.
`syncPair` remains a model-free mirror primitive; use the full CLI/handler sync or
call `consolidateDuplicates` separately under the same writer lock.

### Compare individual events

The separate `icloud-google-calendar-sync/jev` module compares two occurrences
through Vercel AI Gateway or TypeSafe directly. No extra dependencies are required.

```ts
import { createJevMatcher } from "icloud-google-calendar-sync/jev";

const matcher = createJevMatcher({
  provider: "gateway",
  apiKey: process.env.AI_GATEWAY_API_KEY!,
});
// Or: createJevMatcher({ provider: "typesafe", apiKey: process.env.TYPESAFE_API_KEY! });
const result = await matcher.compare(
  {
    title: "Hotel reservation",
    start: Date.parse("2026-10-10T15:00:00-05:00"),
    end: Date.parse("2026-10-12T11:00:00-05:00"),
    location: "Example Hotel",
  },
  {
    title: "Stay at Example Hotel",
    start: Date.parse("2026-10-10T15:00:00-05:00"),
    end: Date.parse("2026-10-12T11:00:00-05:00"),
  },
);

if (result.status === "classified" && result.suggestedDuplicate) {
  // Show the pair for review. Keep calendar writes outside this module.
  console.log("Possible duplicate", result.probability);
}
```

Choose the provider explicitly; keys are not auto-detected or tried against other
services. `gateway` uses [Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev)
with model `typesafe-ai/jev`. `typesafe` uses the
[direct TypeSafe API](https://docs.typesafe.ai/introduction/quickstart) with
`jev-latest`. Gateway's evaluation protocol is experimental. Both transports use
native `fetch`, with no SDK install required. Future providers can be added to the
transport map without changing matching logic. Library callers using Vercel OIDC
can pass a fresh request-scoped token as `apiKey` with `gatewayAuth: "oidc"` to
`createJevMatcher`. Token retrieval stays in the hosting application.

Calling `compare` sends only the two titles, start/end times, all-day flags, and
optional locations through the selected provider to Jev. IDs, descriptions, attendees, and other properties are excluded. Titles
and locations may still contain personal information. Importing the module makes
no requests; the regular sync never needs this key.

Pass one expanded occurrence at a time, with resolved epoch-millisecond start/end
values and an exclusive end. Resolve all-day boundaries in the calendar's time
zone. Recurrence expansion and iCalendar parsing belong to the caller. Empty
intervals and text fields over 500 characters are rejected. Only overlapping
intervals are sent, so events with incorrect or shifted times can be missed.

Results are `skipped` (no overlap), `unavailable` (request or response failure),
or `classified`, with a single `probability` that the occurrences describe the same
real-world event or reservation. The request supplies named `eventA` and `eventB`
objects and asks one yes/no question. It uses TypeSafe's Noul primitive directly,
or Gateway's equivalent boolean primitive.
Suggestions require a probability at least equal to `dedupe.threshold` (default
`0.95`). Set it in the config file or `CALENDAR_DEDUPE` JSON, or pass `threshold`
to `createJevMatcher`. It must be a finite number from 0 to 1, inclusive. Lower
values surface more candidates; higher values require stronger matches. The
review runner uses the config threshold even when given a custom matcher.
The threshold is not measured calendar-matching accuracy. A classification alone
does not authorize changes; deletion requires an explicit priority rule in delete mode.
An unavailable or low-probability result leaves normal syncing alone.

The matcher result replaces the earlier four-way `choice`, `probabilities`, and
`confidence` fields with `probability`. The review report format is unchanged.

Requests time out after 5 seconds and are not retried. `timeoutMs` can be set from
1 to 60000. Successful results are cached by the compared fields, including edits,
for the lifetime of the matcher. The default cache holds 500 pairs; set `cacheSize`
to 0 to disable it, or call `matcher.clearCache()`. Reuse the matcher to reuse its
cache. Simultaneous identical requests are not coalesced.

The in-memory cache ends with the process, so a scheduled review pays for the same
pairs every run. Pass a `store` to `createJevMatcher` or `reviewDuplicates` to keep
results between runs:

```ts
const store = {
  get: async (key: string) => (await db.get("SELECT p FROM jev_cache WHERE key = ?", key))?.p,
  set: async (key: string, p: number) => db.run("INSERT OR REPLACE INTO jev_cache (key, p) VALUES (?, ?)", key, p),
};
```

Keys are SHA-256 hashes of the provider and the compared fields, so editing either
event produces a new key. Only probabilities are stored; the current threshold is
applied on read. Store errors and invalid stored values count as cache misses.
Unavailable results are never stored. Old keys are never deleted; prune the table
if it matters. Keep caller-side scanning bounded when comparing calendars.

### Complete history

Set `"window": { "allEvents": true }` in the configuration to synchronize all
stored event resources, including old events and recurring series with no end date.
This omits the CalDAV time filter; it does not expand infinite recurrences. The HTTP
response reports `window: null`. Without this option, the existing `pastDays` and
`futureDays` defaults apply. Duplicate occurrence review still uses those bounded
day settings.

Use distinct calendars for every pair. Never reuse a destination calendar in multiple
pairs. With a finite window, edits that move a linked event outside the window may
leave its counterpart stale; use `allEvents` for complete two-way reconciliation.

### Existing originals and the guarded local runner

If an original UID is already present on both calendars, ordinary sync stops before
creating duplicate mirrors. Explicitly adopted originals can instead be linked with
an application-provided `LinkStore`. Its state binds both calendar URLs and UIDs,
records each side's baseline fingerprint, and preserves the existing objects. No
provider writes are needed to initialize links. Initialize from complete snapshots
only, after reviewing the proposed one-to-one matches.

The link store is durable state, not a disposable cache. Keep it with the credentials
and backups. A pending write is saved before the provider request and acknowledged
only after verification. Missing or mismatched state must stop synchronization. Set
`existingLinks: true` on adopted pairs to reject calls without their store. Initially
divergent links can use `reviewOnChange: true`; later edits and deletions are held for
review instead of overwriting provider-specific notes.

For a local installation, `python3 scripts/run-local.py /private/config.json` uses an
OS lock, atomic state files, private action records, and a week of compressed recovery
snapshots. Each configured pair must use `allEvents`, `existingLinks: true` and
`protectInvitations: true`, with a `<pair-name>.links.json` beside the config. The
ordinary CLI and HTTP handler cannot supply this private filesystem state. Use
`--dry` with the guarded runner to inspect both mirror and linked actions. Sample
systemd user units are in `deploy/`; install only one active runner.

The runner verifies Google mirror writes and keeps a durable
`<pair-name>.google-mirror-write.json` until they finish. Google CalDAV can generate
new conference details or replace a joining link during import. For recognized
Meet, Teams and Zoom transformations, the runner conditionally restores the intended
notes/location through the Calendar REST API and clears generated conference data
on its own copies. Recurring masters and explicit exceptions are checked separately.
An unfinished correction is recovered before planning another sync. Unknown formats
or conflicting edits stop the run with the intent retained; do not delete that file
to bypass recovery.

An individual original and its marked mirror can be held using a pair's
`heldOriginals: [{ "side": "icloud", "uid": "exact-original-uid", "reason": "review reason" }]`.
Both endpoints are excluded together, including deletion propagation. Holds are
reported on every run. Use `reviewOnChange` for existing links instead.

By default, `syncPair` refuses deletions when either full calendar snapshot is empty
and stops plans exceeding ten deletions per pair. The limit also applies during
execution if provider state changes after the preview. Dry runs remain available for
inspection. Library callers can explicitly set `maxDeletes` or `allowEmptyDeletes`
after reviewing the state; the guarded runner keeps the defaults.

`protectInvitations` allows invitation-bearing originals to be copied out, but holds
writes back to those originals and does not stamp them for mirror-deletion propagation.
Changes made directly on their provider still refresh their mirrors. This avoids
incidental invitation updates during synchronization. This protection also covers native Google
conferences: edit those originals in Google, because a CalDAV write can change
conference details even when it only adds a synchronization marker. This also holds
edits that introduce a conference into a previously plain Google original; add that
joining link in Google instead. Reminder-only edits are not
tracked by the event fingerprint. Simultaneous edits use a whole-event winner rather
than combining fields. Review these limits before enabling automatic synchronization.
