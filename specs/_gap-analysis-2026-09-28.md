# Spec Gap Analysis — 2026-09-28

A cross-reference of every spec under `specs/effect-tui/`, `specs/v2/`,
`specs/storage/`, and the top-level `specs/*.md` against the current nikcli
codebase (HEAD = `e4c37b0f18`, branch `live-main`, v1.406.0).

The premise this catalog operates under — stated explicitly in
[`specs/README.md`](README.md) and [`specs/ROADMAP.md`](ROADMAP.md) — is that
**the contracts are landed and gated, and what is missing is the consumer
side**. A structural gate that greps source cannot tell you the consumer
exists. This analysis reads both halves with that premise in mind.

A landed slice is not a passed release gate. A "✓ Shipped" row here means a
contract has its gate and its test; an "✗ Open" row means the spec either
explicitly lists it as remaining, or the source does not yet have it.

**Correction, 2026-09-30.** This report preserves the 2026-09-28 audit and its
recorded results; the staged production code and the 2026-09-29 corrections in
`ROADMAP.md` and `integration-plan.md` supersede the catch-up and plugin claims
called out below. No new checks were run for this documentation correction.

---

## Tier 1 — Shipped (contract landed, gate enforced)

These are the EOT-IDs whose acceptance gate is met, as far as the spec itself
admits a closed state. Each row quotes a hard piece of evidence in the
codebase rather than a prose claim.

| ID      | Spec                            | Evidence in tree                                                                                                               | Status                                                                                                  |
| ------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| EOT-00  | Startup hang — handshake fix    | `packages/tui/src/util/rpc.ts` (handshake), `c004b6ae8d` (`repro:startup-hang`), 603 starts @ hangRate 0 across 3 TERMs        | **✓ Shipped (gate open on Ghostty only)**                                                               |
| EOT-01  | Performance baseline            | `packages/nikcli/script/perf-baseline.ts`, `specs/perf-baseline.json`, `script/check-perf-baseline.ts`                         | **✓ P0 closed 2026-09-20** (artifact + gate; wall-clock intentionally not gated)                        |
| EOT-02  | Effect boundaries               | `runService` / `runPromiseWithLayer` typed; `test/effect/runtime.test.ts`, `test/effect/multi-instance-teardown.test.ts` green | **✓ Shipped (limit: defect vs interruption still indistinguishable on promise bridge)**                 |
| EOT-03  | TUI async lifecycle             | `useAbortOnCleanup`, `useAttempts`, `attempt.adopt` landed; `test/tui/dialog-lifecycle.test.ts`, `lifecycle-attempts.test.ts`  | **✓ Shipped (chaining-dialog primitive still missing — recorded as the gap)**                           |
| EOT-04  | Event delivery                  | `BYTE_BUDGET`, `LAG_BUDGET`, `EventFeed`, `reconnect-gate.test.ts`, eviction table driven as a table                           | **✓ Shipped (no-silent-loss invariant, EOF-wait)**                                                      |
| EOT-09  | Jobs / persistence              | `Semaphore`/`workMap` covered, durable recovery against real DB, `isTerminal`/`canTransition`                                  | **✓ Shipped (bounded concurrency + durable recovery gate)**                                             |
| EOT-10  | Contracts / errors / security   | Open-payload gate, empty-instance sweep (89 GETs), `script/check-open-payloads.ts`, `check:routes --strict`                    | **✓ Shipped**                                                                                           |
| EOT-12  | Identity / onboarding / auth    | State machine, verifier env read at call time, flag-capture gate (`check-flag-capture.ts`), PKCE no-downgrade test             | **✓ Shipped (account-guard intentionally has no call site — by design)**                                |
| EOT-13  | Observability pipeline          | Span schema gate, redaction fuzz, OTLP smoke, `HttpApiBridge` `TracerDisabledWhen`                                             | **✓ Shipped (HTTP server spans intentionally OFF — overhead measurement failed budget)**                |
| EOT-14  | Plugin v2                       | Manifest gate, autoload gate, hot reload, `check-plugin-v2.ts`, `plugin/autoload-safety.test.ts`                               | **✓ Shipped (v2 contract exists; legacy path still routes most plugins)**                               |
| EOT-15  | Sync snapshots / watermarks     | `detectSequenceGap`, cross-process seq uniqueness pinned, SSE documented as not replay                                         | **✓ Shipped (snapshot barrier producer exists; consumer side still missing)**                           |
| EOT-16  | Workspace isolation             | `wrk_` prefix gate, `WorkspaceRef` / `locallyWorkspace` exports, comment records open B31 gap                                  | **✓ Shipped (B31 — two workspaces on one directory share the instance scope — is OPEN)**                |
| EOT-17  | Sandbox / permission            | Network egress accounting (45 modules), coupling map, sandbox contract pinned by tests, headless fails closed                  | **✓ Shipped (network chokepoint intentionally absent — wrapping a layer nothing calls would be a lie)** |
| EOT-18  | CLI command architecture        | Parser on `effect/unstable/cli`, `Lifecycle` removed, headless posture first slice (`isHeadless`)                              | **✓ Partially shipped — exit-code mapping, plugin command scoping, daemon/attach open**                 |
| EOT-20  | Testing architecture            | Three-layer harness, `withFixture`, `preserveTestEnv`, barriers not sleeps                                                     | **✓ Shipped**                                                                                           |
| storage | Retire `src/storage/storage.ts` | `src/storage/storage.ts` and `effect.ts` deleted, 0 production imports                                                         | **✓ Shipped 2026-08-14**                                                                                |
| storage | Retire `Database.syncDb()`      | 0 callers in `src` (`wrapper-inventory.test.ts` gates at zero), 9 repositories converted                                       | **✓ Shipped 2026-09-15** (export deletion deferred — tests/tooling still call it)                       |
| cli-fw  | yargs → effect/unstable/cli     | `src/cli/framework/{spec,runtime,args}.ts`, 147 commands / 254 parameters                                                      | **✓ Shipped**                                                                                           |
| bg-svc  | Background service              | `BackgroundService.discover()`, per-channel port + password + registration, daemon watchdog                                    | **✓ Shipped (on by default)**                                                                           |
| tui-pkg | TUI package extraction          | `packages/tui` stands alone, `@tui/*` alias zeroed, `/user` / `/account` / `/tui/config` over the wire                         | **✓ Shipped**                                                                                           |

### What `script/check-*` confirms vs what doesn't

These gates run in CI and are structurally enforceable. Every spec that
committed to a structural check has one in `packages/nikcli/script/`:

```
check-account-required.ts
check-flag-capture.ts
check-network-egress.ts
check-observability-schema.ts
check-open-payloads.ts
check-perf-baseline.ts
check-plugin-v2.ts
check-spec-commit-refs.ts
check-spec-paths.ts
check-workspace-isolation.ts
```

`specs/integration-plan.md` (2026-09-27) reinforces this read: the high-leverage
landed slices are these gates, the counter tests, and the contract tables. The
catalog has reached the point where its `OK / OPEN` story is the same as a
test runner's.

---

## Tier 2 — Real architecture, one PR each, not yet started

These are the spec slices that the integration plan explicitly names as
"highest value, large diff, deferred". Each is **open by its own admission**.

### 1. Snapshot / watermark barrier on the consumer (EOT-15)

- The producer side is complete: sync journal, `detectSequenceGap`,
  `/sync/snapshot/:aggregateID`.
- No consumer keeps a per-aggregate cursor. Reconnect recovery on the TUI
  side is still a blind refetch.
- The comment at `packages/tui/src/context/sync.tsx` states the gap outright.
- **This is the highest-value item in the catalog.** It is what turns
  reconnect from "refetch and hope" into a guarantee.

### 2. Workspace scope as a typed Effect scope (EOT-16 / B31)

- `locallyWorkspace` pins a value; it does not scope resources.
- Two workspaces on one directory currently share the instance scope.
- Tracked in the spec's register as the open B31 gap.
- Landed gate keeps the bridge comment that records the gap; a refactor that
  scopes the workspace must update the comment.

### 3. Adapter convergence (EOT-11)

- Native branch and AI SDK branch both ship, with `coverage.ts` emitting the
  six outcomes (unmapped / disabled / ineligible / ineligible-late / native /
  fallback).
- The three typed services the spec names — `CachePolicy.Service`,
  `Usage.Service`, the tagged `ProviderError` retry/failover service — do
  not exist yet.
- Worth doing last: the diff is large and the payoff is a performance number
  nobody has ratified.

---

## Tier 3 — Validation only, no code

These specs require a real matrix measurement that cannot be obtained from
source. They are unblocked by code work, not delayed by it.

| Spec   | What is owed                                                         | Why no code                                                                        |
| ------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| EOT-00 | Ghostty row in the 200-consecutive-start matrix                      | Ghostty cannot be driven from a headless PTY on this host; needs a real terminal   |
| EOT-01 | Budget ratification from a real-terminal measurement                 | The bench artifact is machine-scoped by design; wall-clock intentionally not gated |
| EOT-06 | Measured row heights and anchor-preserving scroll on a real terminal | Streaming virtualization stays behind the flag until measured, not just asserted   |

---

## Tier 4 — Open work, recorded as the gap

These are items the specs themselves name as **open / deferred / pending**.
Each is **a real decision**, not a hidden defect. They are listed in the
specs so a reviewer does not invent work that the spec already deferred.

### From `specs/v2/config.md` (status: **Proposed**, no field renamed)

The 68 fields split into three buckets. Per the 2026-09-21 tally:

- **17 `remove`** in two classes: 4 with zero readers (`logLevel`, `server`,
  `teleport`, and one verified 2026-09-21) can leave the published schema
  without behavior change. 13 read-but-superseded (already migrated into
  `tui.json`) must keep parsing.
- **16 `redesign`** are the public-contract work — `plugin` → `plugins`,
  `agent` → `agents`, `permission` → `permissions`, `provider` →
  `providers`, `snapshot` → `snapshots`, `attachment` → `attachments`. Each
  is a published-JSON-Schema break.
- **5 `pending`** are decisions: `teleport`, `command`, skill discovery
  array, tool output truncation, `experimental.memory` overlap with brain.

`specs/v2/todo.md` already records that the rename mechanism has one viable
precedent (accept-both-keys in the loader, 6 historical uses) and one
non-applicable precedent (file rewrite for a different document). The
two-mechanism concern in the todo is resolved at the spec level; what
remains is ratification by the published-schema owner.

### From `specs/v2/todo.md` (open decisions, not roadmap items)

| Item                                                                                                                                            | Status                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **No plugin hook surface for catalog mutation**                                                                                                 | `buildState` is one function with six literal steps; a plugin can't add a model without an auth loader. Decide whether that's a real constraint. |
| **No `AccountV2` abstraction**                                                                                                                  | Auth lives in `Auth.Info` keyed by provider id; the unified-auth work is the natural home.                                                       |
| **`Model.family` carried but unused**                                                                                                           | Either selection starts using it or it comes out.                                                                                                |
| **`experimental.nativeLlm` granularity**                                                                                                        | Binary global gate today; per-route/per-provider needs a schema decision before the soak.                                                        |
| **Two event envelopes, not one**                                                                                                                | `/event` `{type, properties}` vs `/global/event` `{payload: {directory, payload}}`. Adoption breaks every client that reads `data.type`.         |
| **Single-context TUI store**                                                                                                                    | Upstream partitions by `${workspaceID}:${directory}`; needed only for two-worktrees-in-one-window.                                               |
| **`Database.syncDb` export deletion**                                                                                                           | The export stays on the namespace for tests/tooling; 0 callers in `src` is gated but deletion is not.                                            |
| **Migration claiming is in-process only**                                                                                                       | Latent — single-server-per-data-dir is the common case.                                                                                          |
| **Post-commit effects are fire-and-forget**                                                                                                     | `Database.effect` logs and swallows; a dropped event publish is invisible to the caller.                                                         |
| **Project/worktree aggregation route**                                                                                                          | Data supports `/project/:projectID/session/*`; route decision not made.                                                                          |
| **Per-domain hot-reload granularity**                                                                                                           | Instance reload invalidates the whole provider state on one model change.                                                                        |
| **Server-plugin hook design (Immer drafts, etc.)**                                                                                              | Does not exist; "do not build a fraction of it for a single service."                                                                            |
| **Deferred hardening** (large aggregate paging, ripgrep bounds, websearch stream-cap, unresolved URL attachment sources, batched stream deltas) | Visible, not blocking; spend a slice only on a concrete failure.                                                                                 |

### From `specs/effect-tui/07-input-interaction.md` (req. 2 cannot be wired)

> `packages/tui/src/util/input-precedence.ts` holds requirement 2's order as
> data and has no production call site. The attempt to give it one found
> 48 direct `useKeyboard` subscribers and an arbitration in `ui/dialog.tsx`
> that resolves against the flat table (Escape vs Ctrl+C diverge). The next
> slice here is therefore a decision, not a migration: rewrite requirement 2
> as a per-key precedence (Escape ≠ Ctrl+C) and only then decide whether a
> central dispatcher is worth building for the 48 direct subscribers.

The spec literally says: **land the test, not the table, until the
precedence rule is decided.**

### From `specs/effect-tui/03-tui-lifecycle.md` (chaining-dialog primitive)

> The primitive a chaining caller needs is not "is my owner alive" but "is
> the stack as I left it". It was written and then dropped rather than
> committed. `init()` in `ui/dialog.tsx` is not exported and calls
> `useRenderer()`, so the dialog host cannot be constructed in a test.

The precondition for this work is making the dialog host reachable from
`packages/tui/test/`. The discipline addendum records that the host **is**
testable after all (`testRender` + `DialogProvider` over `ToastProvider`), but
the primitive that bumps the stack counter on every mutation is still the
unfinished piece.

### From `specs/effect-tui/13-observability-pipeline.md` (HTTP server spans)

The measurement this section owed **fails EOT-01's 5% instrumentation
budget** by 3.5×–6×. Three open questions are recorded, none about speed:

1. Delivery class — `telemetry.record` is declared without one, takes the
   conservative `ordered` default; one record per request is a volume
   EOT-04's admission policy hasn't been asked to carry.
2. Instance-less routes — `Bus.publish` is per-instance, `/global/*` and
   `/user/*` have no instance bound.
3. Scope of the toggle — argument for the default being the other way round:
   HTTP server spans off unless an OTLP endpoint is set or a group is
   explicitly on.

### From `specs/effect-tui/18-cli-command-architecture.md`

Requirement 12's only consumer is the permission prompt in
`src/cli/handlers/run.ts`. `cli/effect/prompt.ts` does not consult `isHeadless`,
so every other interactive prompt in the CLI keeps its pre-existing non-TTY
behaviour. What remains:

- Route `cli/effect/prompt.ts` through `isHeadless`.
- Give a prompt with no default a typed failure.
- Map that failure onto requirement 9's exit codes (themselves unimplemented
  — every failure exits `1`).

### From `specs/effect-tui/19-mobile-companion-bridge.md` (capability gating)

The `read` / `write` capabilities are unclassified. The fix that was applied
in the existing slice scopes `cli-sync` tokens to their own allowlist of
routes. Classifying `read`/`write` for `mobile` and `studio` tokens remains
open.

### From `specs/effect-tui/14-plugin-v2-architecture.md` (consumer migration)

The v2 contract exists and the manifest is gated. What is not migrated yet
is the runtime side: legacy `TuiPlugin` / `TuiPluginModule` types still
route through `packages/tui/src/plugin/runtime.ts`. Each migration is its own
PR with a feature flag selecting v1 vs v2 loading; the legacy path is removed
only when no v1 plugins remain.

---

## Tier 5 — Elective, do not start blind

[`specs/integration-plan.md`](integration-plan.md) Tier 4 lists the items
that look like work but are not.

| Item                              | Why it isn't an item                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| EOT-13 HTTP spans                 | Two holes were closed before a tracer arrived (`4fe8d73926`). Wiring one is an L-effort migration that fails EOT-01's 5% budget by 3.5×–6×. |
| EOT-17 network chokepoint         | 45 modules call `fetch` directly; the egress inventory is accounting, not enforcement. Wrapping a layer nothing calls would be a lie.       |
| `specs/v2/config.md` renames      | The highest-risk change class for zero runtime value, until published-JSON-Schema governance signs off.                                     |
| Deleting `Database.syncDb` export | Gated at zero for `src` already; 24 test files still call it. Mechanical, cleanup not fix.                                                  |
| Per-suite `critical: false` flags | Rejected by `ci-pipeline-runtime-budgets.md` Invariants: "The pipeline ignores what is non-critical."                                       |

---

## Recommended next slices, in order

These are the smallest changes that produce the largest gap-closure, in
priority order. Each is one PR with its matching test.

### Tier A — real defects, small diffs — **all three already landed**

**Correction, 2026-09-30.** The table below is historical, not proof that all
plugin lifecycle work is closed: the staged quota fix charges loaded files,
replacement bytes, watcher reloads, and concurrent-write reservations against
the existing 32 MiB bound. Quota rejection throws `Error`, not a typed domain
error; `removePluginEntry` does call `evictPluginStorage`, but removal eviction
does not establish eviction on every unload or shutdown.

The integration plan keeps broader unload eviction and shutdown-budget work
open; the storage change closes neither. Its historical "no quota/no unload"
wording is too broad: a quota and a removal-eviction call already existed.

`specs/integration-plan.md` (written 2026-09-27) lists three Tier 1 defects.
Re-checked against HEAD `e4c37b0f18`, **all three are fixed**. The plan is
stale on this row; the table below is what the code says.

| #   | Plan said                                                                                    | Code says                                                                                                                                                                                                                   | Evidence                                                                                         |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | `dispose()` computes `SHUTDOWN_BUDGET_MS` after the unbounded awaits                         | `const deadline = Date.now() + SHUTDOWN_BUDGET_MS` is the **first** statement; both `runCleanup` calls take `Math.max(0, deadline - Date.now())`                                                                            | `packages/tui/src/plugin/runtime.ts:1535,1540,1556`; docblock at 1520-1532 records the old shape |
| 2   | Session LRU is 25 entries / 30 min with no byte accounting; SDK batch has a meter but no cap | `MAX_RETAINED_ELEMENTS = 20_000` counts messages + parts across all unpinned sessions, with a coldest-first eviction pass; `EVENT_BATCH_CAP = 512` is a hard early-flush ceiling (dropping envelopes would be unacceptable) | `packages/tui/src/context/sync.tsx:1054,1092-1112`; `packages/tui/src/context/sdk.tsx:29`        |
| 3   | Plugin storage has no quota and no unload eviction                                           | `MAX_STORE_BYTES = 32 MiB`, refusing the write with a typed error rather than silently dropping; `evictPluginStorage(id)` on removal                                                                                        | `packages/tui/src/plugin/storage.ts:49,140-150,202`                                              |

`bun test test/tui/plugin-dispose.test.ts test/tui/plugin-data.test.ts` →
**16 pass, 0 fail**, exit 0. The tests include
`"a shared deadline bounds several wedged plugins together, not one budget each"`
and a source assertion that the deadline is computed once.

**What is still open from item 2** is the consequence the plan flagged: the
streaming-virtualization fallback in
`packages/tui/src/routes/session/index.tsx` stays until the bound is measured
on a real terminal. That is a Tier 3 item, not a defect.

### Tier B — architecture, one PR each

4. **Snapshot / watermark barrier on the consumer side (EOT-15).** Highest
   value in the catalog; what makes reconnect lossless.

5. **Workspace scope as a typed Effect scope (EOT-16 / B31).** Promote the
   workspace to its own owning `Scope`, update the bridge comment the
   workspace gate keeps honest.

6. **Adapter convergence (EOT-11).** Last of the L/High tiers because the
   payoff is a perf number nobody has ratified.

### Tier C — decisions, not work

7. **Per-key precedence in EOT-07.** Rewrite requirement 2 as
   Escape ≠ Ctrl+C; only then choose whether a central dispatcher is worth
   building for the 48 direct `useKeyboard` subscribers.

8. **Chaining-dialog primitive in EOT-03.** Make the dialog host reachable
   from `packages/tui/test/`, then land the stack-bump counter that is
   observable across `replace`/`clear`/`closeTop`/escape.

9. **Headless posture in EOT-18 — the plan named a dead module; the real
   defect was elsewhere and is now fixed.** See "Landed this session" below.

### Tier D — config review execution (must be sequenced)

10. **`specs/v2/config.md` renames, sequenced per the 2026-09-21 split:**
    - 4 `remove` with no readers first (no behavior change).
    - 13 `remove` that must keep parsing (TUI migration set).
    - 16 `redesign` as one PR per group, each adding a case to
      `test/config/legacy-keys.test.ts`.
    - 5 `pending` decided alongside the groups that touch them.

---

## Landed this session

Two changes, both found by auditing the _live_ surface rather than the surface
each spec named.

### 1. `nikcli upgrade` installed over a package-manager binary when the prompt was cancelled

**Severity: high.** `src/cli/handlers/upgrade.ts` asked "Install anyways?" with
`initialValue: false` and guarded only `if (!install)`.

`@clack/core` answers a cancelled prompt with `Symbol("clack:cancel")` —
verified in `node_modules/@clack/core/dist/index.mjs`:
`cancelSymbol = Symbol("clack:cancel")`, `isCancel(x) { return x === cancelSymbol }`.
**Every symbol is truthy**, so `!install` is `false` on cancel, the guard is
skipped, and the handler falls through to `installation.upgrade(...)` —
replacing a binary the user declined to replace, on a package-manager-owned
path. Escape, Ctrl+C, and a non-TTY stdin all reach it.

That is the exact inverse of EOT-18 requirement 12: _"Headless mode never
silently picks 'yes'."_

Fixed with the idiom already used in `routine/delete.ts`:
`if (prompts.isCancel(install) || !install)`.

**Why it survived review:** clack cannot be driven without a TTY — its
`createInterface` throws on a non-TTY stdin, so the prompt is invisible to
`bun test`. 24 of the 25 handler modules that prompt directly already guarded
correctly; this one did not, and nothing could see it.

**Also found, and worth recording as its own finding:** EOT-18's plan says
requirement 12's remaining work is to "route `cli/effect/prompt.ts` through
`isHeadless`". **That module has zero importers** — `cli/effect/` contains only
that file, and nothing in `src`, `test`, or `script` imports it. Landing the
guard there would have been a guard on dead code, the same finding class as the
dead `Lifecycle<T>` wrapper this spec already removed. The real surface is 25
handler modules importing `@clack/prompts` directly.

New gate: `test/cli/prompt-cancel-guards.test.ts` fails any module under
`src/cli/handlers/` that calls an interactive prompt without checking
`isCancel`, and asserts the population is ≥ 20 files so the gate cannot pass by
measuring nothing.

### 2. `RemoteSyncClient` silently dropped every quiet aggregate's events — historical fix attempt

**Correction, 2026-09-30.** `RemoteSyncClient` has no staged production caller;
the active path is `RemoteSync` in `src/sync/remote-sync.ts` over
`createHttpRemoteTransport`. The minimum of known aggregate cursors misses
previously unknown aggregates with lower sequences, and `delivered > 0` neither
proves page-position progress nor prevents a dedup-only page from hiding a tail.

The staged active path fences subscription with `readiness=1` before replay,
enumerates from zero using the endpoint's `(seq, aggregate, id)` keyset and
`nextCursor`, and advances each aggregate cursor only after successful apply.
It rejects non-advancing pagination, caps recovery at 10,000 pages, and uses
generation fencing for reconnect/token-refresh recovery and cancellation.

The TUI snapshot/watermark barrier remains open, as recorded in `ROADMAP.md`;
this remote journal-recovery slice does not close EOT-15. The account below and
its three-case test evidence describe the earlier class-level attempt, not
proof of complete catch-up or of the current staged endpoint contract.

`src/sync/remote-client.ts` held one `lastSeq = max(event.seq)` across all
aggregates and sent it as `?since=` to `/sync/outbox`. That is EOT-15
requirement 7's exact prohibition, and two facts make it wrong rather than
merely untidy:

- `seq` is **per aggregate** — `Sync.reserveSeqAndAppend` keys its counter on
  `and(eq(projectId), eq(aggregate))`, so each aggregate counts from 1.
- `/sync/outbox` filters `projectId = ? AND seq > since` with **no aggregate
  predicate** (`src/server/httpapi/sync.ts:299`).

So `since=60` when one aggregate is at 60 and another at 5 means the quiet
aggregate's events 6, 7, 8 are never delivered — silently, permanently. The
_less_ active an aggregate is, the more certain the loss.

Fixed with per-aggregate cursors and a `since` derived as their **minimum**,
plus per-aggregate dedup so the project-wide query's necessary over-return is
dropped rather than re-applied. The paging recursion also gained a bound
(`hasMore && delivered > 0`); the old `if (hasMore)` would have become an
infinite loop now that `since` only advances when a page delivers something new.

`test/sync/remote-client-cursor.test.ts` — the client's first test — drives the
real class against a replica of the endpoint's exact predicate. Reverting to a
global maximum fails 2 of 3.

**Still open, and not to be mistaken for done:** this is the _remote hub_
client. The TUI reconnect path still has no cursor and is still a blind refetch
(`packages/tui/src/context/sync.tsx:982`), and `/sync/outbox` still answers a
project-wide `since` for a per-aggregate `seq`.

### 3. `auto-mode` was registered but undocumented — a red test on HEAD

`test/cli/command-surface.test.ts` gates
`specs/v2/cli-command-surface.md` against the registered command tree. Commit
`05b4b7c59e` ("feat(permission): auto mode") added the `auto-mode` command with
subcommands `defaults`, `config`, `critique`, `reset` and did not add the table
row, so the gate failed on `missingFromDoc: ["auto-mode"]` **before any of this
session's changes**. Root `AGENTS.md` rule 6 makes a red pipeline never
acceptable, so the row is added and the gate is green.

The gate working as intended is the evidence: it caught a real drift between
shipped code and the documented surface, and it reported the exact command.

### Verification

Historical results recorded on 2026-09-28, retained as evidence of that pass.
They are not new runs or verification of the later staged production recovery.

| Check                | Command                                                                 | Result                                              |
| -------------------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| New gate, before fix | `bun test test/cli/prompt-cancel-guards.test.ts`                        | **1 pass, 3 fail, exit 1**                          |
| New gate, after fix  | same                                                                    | **4 pass, 0 fail, exit 0**                          |
| Gate discriminates   | revert `isCancel` → re-run                                              | **2 fail, exit 1**; restore → exit 0                |
| Full CLI suite       | `bun test test/cli/`                                                    | **254 pass, 0 fail**, 4859 assertions, exit 0       |
| Plugin suites        | `bun test test/tui/plugin-dispose.test.ts test/tui/plugin-data.test.ts` | **16 pass, 0 fail**, exit 0                         |
| Cursor test, before  | `bun test test/sync/remote-client-cursor.test.ts`                       | **2 fail, exit 1** — `Expected: <= 5, Received: 60` |
| Cursor test, after   | same                                                                    | **3 pass, 0 fail, exit 0**                          |
| Cursor discriminates | revert to global max + drop dedup → re-run                              | **2 fail, exit 1**; restore → exit 0                |
| Sync suite           | `bun test test/sync/`                                                   | **70 pass, 0 fail**, 361 assertions, exit 0         |
| Sync + server route  | `bun test test/server/httpapi-sync.test.ts test/sync/`                  | **83 pass, 0 fail**, 512 assertions, exit 0         |
| Typecheck            | `bun run typecheck`                                                     | **exit 0** — `Tasks: 38 successful, 38 total`       |
| Lint                 | `bunx oxlint` on both changed files                                     | **0 warnings, 0 errors**                            |
| Formatting           | `bunx prettier` (repo config `semi: false`)                             | clean — 76 stray semicolons normalised to 0         |
| Spec gates           | `check:spec-paths`, `check:spec-commit-refs`                            | exit 0 — 21 explained, 54 refs, 0 orphaned          |

---

## How to read this report

- **Tier 1** is the catalog's `OK` row. The gates are real, the tests are
  committed, and the source matches the spec.
- **Tier 2** is the catalog's "highest-value, deferred" row. Each is named
  by its own spec; none is hidden.
- **Tier 3** waits for a real terminal. Not a defect.
- **Tier 4** is the catalog's "open work, recorded" row. The specs flag
  every item; nothing here is a missing piece of evidence.
- **Tier 5** is "do not invent work that the spec already deferred."

The structural truth this catalog now states: **every spec has at least one
landed slice and at least one test that fails if its contract changes**. The
gates are in `script/check-*`. What is left is consumer-side migration,
real-terminal measurement, and a small number of explicit decisions. None of
those is a missing piece of the catalog.

**The recurring lesson of this pass.** Twice now, a spec's stated remediation
target turned out not to exist or not to be where the defect was:
`cli/effect/prompt.ts` is dead, and `integration-plan.md`'s Tier 1 was stale on
all three items. A spec that names a file is a claim about a file, and the file
is the thing to check first.
