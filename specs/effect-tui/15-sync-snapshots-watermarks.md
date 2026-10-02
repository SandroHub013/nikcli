# EOT-15: Sync Snapshots, Watermarks, and Multi-Device State

Status: proposed. Tier: 1. Phase: P2. Dependencies: EOT-04, EOT-05, EOT-09.
Owner: sync, session, mobile-bridge maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B06, B19 in the [register](../README.md): the durable sync journal has per-aggregate sequences and snapshots
machinery (`docs/sync-architecture.md`, `packages/nikcli/src/sync/index.ts`), and the server encodes events once with
bounded frame lag. EOT-04 covers delivery and recovery. The remaining gap is the **end-to-end replay/catch-up** protocol:
snapshot watermarks, sequence gaps, compaction cursors, multi-device state ordering, and the seam between aggregate-level
replay and global SSE. Without it, the recovery model in EOT-04 cannot safely promise lossless catch-up across a
disconnect, and the mobile companion (which depends on sync snapshots) inherits the gap.

## Scope and Non-Goals

Define the canonical snapshot/watermark contract for the sync subsystem, the recovery protocol that ties snapshot
acquisition to event replay, and the multi-device consistency model for the mobile companion. Preserve the existing
`docs/sync-architecture.md` semantics and the existing aggregate-level replay machinery. Do not introduce a second
journal, change existing aggregate sequence semantics, or invent a new global SSE cursor without the matching snapshot
watermark seam.

## Design and Requirements

1. Each aggregate (session, project, workspace, loop, mission) carries an opaque `watermark` (monotonic within the
   aggregate) and an `aggregateVersion` (a server-defined content version). The watermark is the **lowest** boundary
   after which the snapshot is authoritative; events with sequence `> watermark` must be replayed before the snapshot is
   usable.
2. A snapshot is delivered with `(aggregateID, aggregateVersion, watermark, payload)`. Consumers validate
   `aggregateVersion` against the local schema; an unknown version is treated as a contract change, not a corrupt frame.
   Snapshots are content-addressed; equal payloads share a content hash to enable dedup.
3. Subscription establishes a barrier: the consumer subscribes, captures the snapshot for the aggregate (or fetches it
   from the server), and only marks itself `subscribed` after **both** the subscription ack and the snapshot are received
   for every required aggregate. Late events after the barrier are applied in `sequence` order. The barrier is the seam
   that makes recovery lossless.
4. Sequence gaps: a gap between the snapshot's `watermark` and the next event's sequence is a contract violation. The
   consumer treats it as `SyncError.SequenceGap`, refreshes the snapshot, and continues; the recovery is bounded, not
   infinite. A repeated gap within the same generation is a fatal `SyncError.SequenceGapUnrecoverable` and surfaces as a
   visible stale state, never as silent catch-up.
5. Compaction: the server may compact old events away. A consumer whose `watermark` is below the server's compaction
   floor must refetch the snapshot atomically before replaying. The atomicity here is critical: the snapshot, the
   compaction cursor, and the replay position are delivered as one barrier; a partial fetch is treated as a failed
   barrier and retried.
6. Multi-device: the mobile companion, the CLI's TUI, and a remote TUI can attach the same account simultaneously. The
   server tags events with `originDeviceID`; the consumer can apply device-aware coalescing (drop events the local
   originator already applied). Conflict resolution is per-aggregate: sessions are additive (no destructive merge),
   settings are last-write-wins with a vector clock, and file edits use the existing snapshot-diff protocol.
7. Cursor types: each consumer maintains a per-aggregate cursor `(aggregateID, watermark)`. Global cursors are
   **derived** from the per-aggregate cursors; they are not authoritative. A consumer that needs a global cursor must
   reason about it as a fold over per-aggregate cursors, never as a stored global sequence.
8. Recovery readiness gate: a consumer may only mark itself `ready` after the barrier completes and after the
   per-aggregate cursors are validated against the snapshot. EOT-04's recovery readiness protocol consumes this gate;
   EOT-15 is the producer.
9. Read-after-write: a request that mutates a session returns the new `watermark`; the consumer can issue a follow-up
   read that includes `(watermark >= newWatermark)` to guarantee the mutation is visible. The guarantee is local to the
   consumer's connection; cross-device visibility is bounded by the multi-device ordering above.
10. Bootstrap from a fresh install: the consumer subscribes with `bootstrap=true` and the server delivers the full
    snapshot bundle plus the live stream. The barrier holds until every required aggregate is delivered. The consumer
    never operates on partial state.

## Snapshot Topology

```text
Server (publisher)
  - per-aggregate watermark
  - snapshot bundle (typed per aggregate)
  - live event stream with per-aggregate sequence
Consumer (TUI / mobile / remote)
  - subscribe -> snapshot barrier -> replay -> ready
  - per-aggregate cursor; global cursor is derived
  - gap -> refetch -> continue; repeated gap -> fatal stale
Multi-device
  - originDeviceID tags events
  - last-write-wins settings; additive sessions; snapshot-diff files
```

## Failure and Cancellation

Use `Schema.TaggedError`: `SyncError.SnapshotInvalid`, `SyncError.SequenceGap`, `SyncError.SequenceGapUnrecoverable`,
`SyncError.CompactedWatermark`, `SyncError.AggregateVersionUnknown`, `SyncError.BarrierFailed`,
`SyncError.BootstrapIncomplete`. Subscription cancellation aborts the barrier and the replay iterator; partial state is
discarded. The barrier does not leak resources across cancellation: an interrupted bootstrap re-runs from scratch, not
from the partial snapshot. A server-side snapshot failure during the barrier is reported as `SyncError.SnapshotInvalid`
with a typed retry; the retry budget is bounded. Compaction that occurs mid-barrier is detected by watermark validation
and forces a refetch.

## Acceptance and Verification

- A controlled subscriber/snapshot fixture exercises subscribe → snapshot → replay → ready; mutations between
  subscription ack and snapshot delivery are reflected in the final state; a watermark issued during the barrier matches
  the post-replay state.
- A sequence gap during replay forces a snapshot refetch and continues; a repeated gap in the same generation surfaces as
  `SyncError.SequenceGapUnrecoverable` and the consumer is visibly stale.
- A compacted watermark below the consumer's cursor forces a refetch before replay; partial fetches are detected and
  retried atomically.
- Two consumers on the same account (TUI + mobile) receive `originDeviceID`-tagged events; device-aware coalescing
  suppresses local-origin events; cross-device conflicts resolve per the documented rules.
- Bootstrap from a fresh install delivers the full snapshot bundle before the first live event; the consumer never sees
  partial state.
- Extend `packages/nikcli/test/sync/`, `packages/nikcli/test/mobile/` (sync tests in the mobile surface),
  `packages/nikcli/test/server/event-feed.test.ts`, `packages/nikcli/test/server/event-visibility.test.ts`, and
  `packages/nikcli/test/tui/streaming-store.test.ts`.
- From `packages/nikcli`: `bun test test/sync/ test/mobile/ test/server/event-feed.test.ts test/tui/streaming-store.test.ts`.
  Run with the existing isolated database (`withIsolatedDatabase`). One final root `bun run typecheck` after the slice.
- Meet EOT-01 budgets; recovery readiness gate measured end-to-end against the snapshot+replay fixture.

## Migration and Rollback

Phase by aggregate. Snapshot barrier lands on `session` first, then `project`, then `workspace`, then `loop`/`mission`.
Each phase flips a per-aggregate barrier flag; the legacy path stays until both directions are tested. The mobile
companion migrates after the server-side barrier is ratified. Roll back by toggling the per-aggregate flag to the legacy
path; never delete per-aggregate cursors or stored snapshots. Schema changes are additive (new optional fields); a v1
consumer can ignore a v2 snapshot's unknown fields without forcing a full re-bootstrap.

## Ordering and the Replay Contract — 2026-09-20

### Global SSE is not a replay protocol

Stated here because the plan asked for it explicitly, and because the two look alike from
the client's side. `/event` and `/global/event` carry **no sequence numbers**: a frame is a
notification that something happened, not a numbered position in a log. A client that
misses frames — evicted for lag, for an oversized producer, or by a network failure —
cannot resume from where it was, and nothing in the feed lets it discover that it missed
anything. It refetches, and the close reason
(`specs/effect-tui/04-event-delivery.md`) is what tells it to.

The sync journal is the replay protocol. It has per-aggregate `seq`, `detectSequenceGap`
to find a hole, and snapshots to bound the replay. Reaching for `detectSequenceGap` on the
SSE path would be reaching for a cursor that does not exist.

### `seq` is the order; `origin` is not

`reserveSeqAndAppend` assigns `seq` per aggregate, in the writer's database, inside one
transaction. A device's `origin` and `origin_seq` are provenance and idempotency — two
devices do not interleave their own counters into one stream, and a reader's order is the
server's, not any device's.

`test/sync/ordering.test.ts` pins the property: no duplicate `seq`, no holes,
per-aggregate independence, and cursor reads in order — in-process under a 40-write burst,
and across four contending processes, which is the production shape since the server runs
one per workspace.

**What it does not establish.** It pins the property, not the mechanism. Flipping the
transaction to `deferred` was tried both ways and nothing failed: in-process because the
drizzle driver is synchronous, so the read and the append cannot interleave at all, and
across processes because SQLite's own locking and retry appear to close the window first.
So the guarantee is more robust than the one line usually credited with it, a regression in
it would still be caught here, and `BEGIN IMMEDIATE` should not be cited as _proven_
load-bearing on the strength of this file.

Why the property matters beyond ordering: `detectSequenceGap` reads consecutiveness as
proof that nothing was deleted. Two appends colliding on one `seq` would leave the next
reader's gap check quietly wrong — no hole to find, and an event gone.

## The One Global Cursor Silently Dropped Every Quiet Aggregate's Events — 2026-09-28

**Correction, 2026-09-30.** The account below preserves the 2026-09-28
class-level fix attempt, not a completed production recovery guarantee.
`RemoteSyncClient` has no staged production caller; the active path is
`RemoteSync` (`src/sync/remote-sync.ts`) over `createHttpRemoteTransport`.

The minimum of **known** aggregate cursors is insufficient: an unknown
aggregate can have history below that minimum. Likewise, `hasMore && delivered

> 0` is not a sufficient paging bound: delivery need not advance the minimum,
> and a dedup-only page can stop replay before an unseen tail.

The staged active path subscribes with `readiness=1` before reading the journal
and starts each recovery enumeration at zero, paging by `(seq, aggregate, id)`
with the endpoint's `nextCursor`. That tuple is a page position, not an
authoritative global watermark; per-aggregate cursors advance only after apply.

Recovery rejects missing or non-advancing page cursors, has a 10,000-page
budget, and uses generation fencing across reconnect/token-refresh reopen and
cancellation. Stream notifications are journal-read wakeups, not applied events
or acknowledgements.

The TUI snapshot/watermark barrier remains open, consistent with the staged
`ROADMAP.md` and `integration-plan.md`; remote journal recovery does not close
this spec's end-to-end barrier requirements. No new checks were run for this
correction; the coverage account below is historical evidence only.

Requirement 7 says cursors are per aggregate and that "global cursors are
**derived** from the per-aggregate cursors; they are not authoritative". The
producer side already had the property. The one consumer that held a cursor held
a global one, and the two halves did not compose.

`RemoteSyncClient` (`src/sync/remote-client.ts`) kept a single
`lastSeq = max(event.seq)` across every aggregate and sent it as `?since=`. Two
facts make that wrong, and neither is a judgement call:

- **`seq` is per aggregate.** `Sync.reserveSeqAndAppend` reads its counter with
  `and(eq(projectId), eq(aggregate))`, so each aggregate counts from 1 and two
  aggregates' `seq` values are not comparable with one another.
- **`/sync/outbox` has no aggregate predicate.** It filters
  `projectId = ? AND seq > since`, so one `since` addresses every aggregate at
  once, ordered by `seq` across aggregates that each numbered themselves
  independently.

`max(seq)` is therefore a cursor for a stream that does not exist. The concrete
loss, and it is silent — no error, no gap, no log line:

|                                                  |                                              |
| ------------------------------------------------ | -------------------------------------------- |
| `session:busy` writes 60 events                  | `seq` 1..60                                  |
| `session:quiet` writes 5 events                  | `seq` 1..5                                   |
| client's global cursor                           | `lastSeq = 60`                               |
| `session:quiet` writes 3 more while disconnected | `seq` 6, 7, 8                                |
| reconnect asks `?since=60`                       | returns `seq > 60` for **the whole project** |
| result                                           | **B's 6, 7, 8 are never delivered. Ever.**   |

The activity imbalance is the trigger: the _less_ active an aggregate is, the
more certain it is to be skipped, and the quieter it is the longer the window
in which its events vanish. A project with one busy session and one quiet one
loses the quiet one's entire tail on every reconnect, forever.

**Fixed** with per-aggregate cursors and a derived `since`. The bound for a
query that cannot filter by aggregate is the **minimum** cursor, not the
maximum, and the per-aggregate cursors are what make that query's necessary
over-return recoverable: the client skips any event at or below its own cursor
for _that_ aggregate, so the events the project-wide query replays for an
already-current aggregate are dropped rather than re-applied.

The paging recursion gained a bound while it was in there. `if (body.hasMore)`
re-issued the same query, and with a `since` that only advances when something
new is delivered, a server that answered `hasMore` with nothing new would have
looped forever. It now recurses only when the page actually advanced a cursor.

### What this does and does not establish

**Fixed:** the silent cross-aggregate loss, and the class of it. The client is
now correct against the endpoint as the endpoint exists today.

**Not fixed, and named here so it is not mistaken for done:** this is the
_remote hub_ client's cursor. It is not the TUI reconnect path, which has no
cursor at all and is still a blind refetch — `packages/tui/src/context/sync.tsx`
says so in its own comment: "Until there is a snapshot/watermark seam to resume
against, the honest recovery is the one EOT-04 prescribes: refetch". That is
the consumer barrier this document's "Snapshot Topology" section describes, and
it is still open.

**Also still open:** `/sync/outbox` answering a project-wide `since` for a
per-aggregate `seq` is the underlying mismatch, and it costs the client a
re-fetch of everything above the minimum cursor. Adding an optional
`aggregate` filter to the endpoint is the producer-side half of requirement 7
and is additive; it is not done here.

### `/sync/outbox` can now be asked for one aggregate — 2026-10-02

**Landed.** `OutboxQuery` gained an optional `aggregate` parameter
(`packages/nikcli/src/server/httpapi/sync.ts:48`) and the handler adds
`eq(syncEvent.aggregate, onlyAggregate)` to the `where` clause only when it is
present (`sync.ts:338`). Absent means no predicate at all, so every existing
caller keeps the exact project-wide page it had — which is what "additive" has to
mean here, because the client already derives a correct `since` from its
per-aggregate cursors and this only removes the over-fetch those cursors force.

The test is the spec's own loss table, run against the real endpoint: a busy
aggregate at `seq` 1..60 and a quiet one at 1..5, then a read at `since=5`. The
project-wide read returns the busy aggregate's 55 remaining events and nothing of
the quiet one — the over-return the client had to discard. The same read scoped to
`aggregate=session:quiet` returns that aggregate's own tail (`seq` 4, 5) and
nothing else. Omitting the parameter still returns all 65; an unknown aggregate is
an empty page, not an error.

This closes the producer-side half of requirement 7. It does **not** close the
spec: the consumer barrier is still open — `packages/tui/src/context/sync.tsx`
resumes by blind refetch, and the snapshot/watermark barrier the "Snapshot
Topology" section describes does not exist.

Verified in this session: `bun test test/sync/ test/server/httpapi-sync.test.ts
test/server/event-feed.test.ts` reported **143 pass, 0 fail**, `bun run
check:routes --strict` and `check:account-required` exited 0, `bun run typecheck`
exited 0, and the regenerated client trees carry the new parameter
(`api.ts`: `readonly aggregate?: Endpoint25_1Request["query"]["aggregate"]`). The
whole suite, run with nothing else on the machine, reported **5377 pass, 4 fail**
— the same four pre-existing failures recorded under EOT-11, one more passing test
than the 5376 measured before this slice, which is the one this slice adds.

### The readiness gate and the watermark are one slice, not two — 2026-10-03

The two open items were tracked separately here (a "readiness gate" and a
"barrier"). They are not separable, and the spec text is why. Requirement 8
reads: "a consumer may only mark itself `ready` after the barrier completes and
after **the per-aggregate cursors are validated against the snapshot**". The
gate is _defined_ by the cursors the barrier produces, so there is no version of
it that can land first. A `barrierReady` flag set from anything the TUI has today
— bootstrap settled, a stream opened, `status !== "loading"` — would be a field
whose name promises a validation that never happened, and the next author would
reasonably read it as requirement 8 satisfied.

So the slice is: extend the snapshot with a per-aggregate `watermark` and
`aggregateVersion` (requirements 1 and 2), regenerate both client trees, have
the consumer validate its cursors against it, and only then expose the gate.
The spec's own "Migration and Rollback" already sequences it that way —
"Snapshot barrier lands on `session` first, then `project`, then `workspace`,
then `loop`/`mission`", each phase flipping a per-aggregate flag with the legacy
path retained — which is a further sign this is one piece of work with four
stages, not two independent tickets.

The producer that already exists and should be reused is
`/sync/stream?readiness=1`: the greeting is an explicit `ready` event emitted
before the feed subscribes, so no event can fall between subscribe and ready
(`packages/nikcli/src/server/httpapi/sync.ts:550-573`), and `RemoteSync` already
consumes it via `lifecycle.ready()` (`packages/nikcli/src/sync/transport.ts:186`).
The TUI does not: it reads `/global/event` unfenced. That gap is part of this
slice, not a separate one.

Note for whoever picks it up: `test/restart-reload-command.test.ts:97` pins
`bootstrap()` appearing exactly once in `sync.tsx`, so any reconnect rework
breaks that test by design and the pin must be updated deliberately, not
quietly.

### Requirement 8's readiness gate must not reuse `ready` — 2026-10-03

**Not attempted, on purpose, after checking the call sites.** The obvious
one-line move is to tighten `get ready()` (`packages/tui/src/context/sync.tsx`)
from "bootstrap left `loading`" into requirement 8's "the barrier completed and
the per-aggregate cursors validated against the snapshot". Doing that regresses
a bug this file already records.

`ready` is consumed as a **data-availability** signal, not a bootstrap one:
`dialog-analytics.tsx:212` and `dialog-command-center.tsx:65` both read
`sync.ready && sync.data.session.length > 0` to decide they can stop polling.
Requirement 8's gate is a **bootstrap-completeness** signal. A session list that
cannot load because a provider is down leaves the TUI permanently not-ready
under the new definition, so those dialogs poll forever — the exact failure the
`status` docblock at `sync.tsx:105-112` describes being fixed, where folding one
optional endpoint's failure into the status pinned a machine at `partial`
forever and gated the empty-provider prompt, which needs none of it.

So the two signals have to be separate. The honest shape is a new barrier
readiness alongside `ready`, fed by the cursors the snapshot delivers — which
does not exist yet, and whose absence is the previous section's point. A second
field with no producer would be a placeholder, so nothing was added.

This is also why the gap cannot be closed by wiring: the TUI holds no cursor
today, so there is nothing to validate. Requirement 8 is downstream of
requirements 1 and 2, which need the snapshot to carry a `watermark` per
aggregate. `SnapshotResponse` is `{lastSeq, state}` (`httpapi/sync.ts:66-69`),
and `SyncProjection.session` (`projection.ts:39-44`) projects only
`{id, projectID, title, lastTouchedAt}` — there is no per-aggregate boundary to
report even if a field were added to the envelope.

### Coverage

`test/sync/remote-client-cursor.test.ts` drives the real class end to end with
`fetch` replaced by a replica of the endpoint's exact predicate and
`EventSource` by a controllable double, so the loss is observed rather than
asserted from the source. Three cases: the quiet aggregate's events survive a
reconnect, the `since` sent is the lowest cursor rather than the highest `seq`,
and the over-return is deduped so no event is applied twice. Reverting the
cursor to a global maximum fails the first two, which is how the test was
validated.

This file is the client's first test. `RemoteSyncClient` had no test at all
before it, which is consistent with EOT-14's audit finding about abstractions
whose docblocks claim a guarantee nothing checks.

### The TUI is not a journal consumer, so the barrier does not map onto it — 2026-10-03

The previous section proposes the two open items as one slice, and assumes the
TUI is the consumer that would validate cursors against a snapshot. It is not,
and that assumption is what makes the slice look arbitrarily large.

`bootstrap()` in `packages/tui/src/context/sync.tsx:767` recovers by calling
typed REST endpoints — `client.session.list({start})` and one request per
resource — and the reconnect path (`refetchAfterReconnect`, `sync.tsx:1015`)
calls the same function. Nothing on that path reads `/sync/outbox`: the TUI's
only mentions of "outbox" are a help-dialog string (`ui/dialog-help.tsx:26`) and
`context/remote-sync.tsx`, which reads the **local DB** outbox for a status
widget. The endpoint with the `aggregate` filter serves `RemoteSyncClient`
(`src/sync/remote-client.ts`), which is a different consumer with actual
per-aggregate cursors.

So the TUI is a snapshot consumer, not a journal consumer. Its recovery is
already "the snapshot is authoritative", which is requirement 2's model, minus
the watermark. The cursor, gap-detection and replay machinery in requirements 3,
4, 7 and 8 has nothing to attach to: there is no cursor and no replay, so there
is no sequence gap to detect and no late event to order.

That reframes the cost honestly. Making requirement 8 true for the TUI means
either (a) converting it to a journal consumer first — a rewrite of its recovery
path, with all the losslessness risk that carries — or (b) putting a per-aggregate
`watermark` on the REST responses and having requirement 9's read-after-write
(`watermark >= newWatermark`) applied to every mutating endpoint. (b) is
cross-cutting: it touches the write path of every resource, not one endpoint.

Neither is a slice. Until one is chosen, the TUI consumer barrier is not
schedulable work, and the aggregate filter stays correctly used by the one
consumer that has cursors.
