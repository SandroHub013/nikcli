# EOT-11: Provider Streaming and Inference Pipeline

Status: proposed. Tier: 1. Phase: P2. Dependencies: EOT-01, EOT-02, EOT-10.
Owner: provider and session/llm maintainers, `@nikcli-ai/llm` core. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B20, B21, B22, B23 in the [register](../README.md): the new `@nikcli-ai/llm` package is a typed Effect Schema-first
core with `Protocol`/`Endpoint`/`Auth`/`Framing` composition and `LLMEvent` streams, but the production request path still
runs through `session/llm/*` and `provider/provider.ts` via Promises and AI SDK adapters. Streaming deltas currently travel
across two boundaries (AI SDK → `session/llm` adapters → bus → `Bus.publish` → SSE → TUI), and each boundary has its own
backpressure, error, and dedup rules. There is no single architectural spec unifying provider streaming, model selection,
cache policy, retry, failover, rate limit, and cancellation across all these layers.

The opportunity is to converge on `LLMClient.stream` / `LLMClient.generate` as the canonical model, keep the AI SDK route as
one adapter rather than two models, and use Effect `Stream` end-to-end without losing the existing Promise-SDK
compatibility or the Bus publish shape. No second LLM runtime; no replacement of the AI SDK by force.

## Scope and Non-Goals

Apply the Effect `Stream` model to provider streaming, model selection, and inference caching across the existing
`session/llm/*`, `provider/*`, and `@nikcli-ai/llm/*` packages. Keep the existing AI SDK providers (Anthropic, OpenAI,
Google, Bedrock, Azure, XAI, OpenRouter, Copilot, OpenAI-compatible) working without code changes for callers. Preserve
bus/SSE wire compatibility and the existing `SessionMessage` event timeline. Do not introduce a new provider abstraction,
a second AI SDK route, a global model router, distributed inference, or a fresh cache layer that competes with the existing
provider cache policy.

## Design and Requirements

1. Adopt `@nikcli-ai/llm`'s `LLMEvent` and `LLMRequest` as the canonical schema for new producer code. Existing AI SDK
   providers keep producing AI SDK streams; an adapter inside `provider/provider.ts` converts `LanguageModelV2` streams into
   `LLMEvent` streams, not into a third wire format. Wire schemas in `server/httpapi/session.ts` stay unchanged unless EOT-10
   requires them.
2. Use Effect `Stream.Stream` end-to-end in new code paths: `LLMClient.stream(request)` for incremental deltas,
   `LLMClient.generate(request)` for the collected response, `LLMClient.prepare<Body>(request)` for compiled bodies.
   Convert at the AI SDK boundary with `Stream.fromAsyncIterable` / `Stream.fromReadableStream` and `Effect.mapEffect`, not
   with manual async generators that lose backpressure. `provider/provider.ts` becomes an adapter, not a parallel schema.
3. Cancellation must reach the underlying provider request through the AI SDK `AbortSignal`, not just through the Promise
   wrapper. `LLMClient.stream` accepts `Stream.fromEffect` consumers with interruption that propagates into the adapter.
   Late events after cancellation are dropped before they reach the bus/SSE/TUI path; do not deliver them with a "done"
   marker that masks the cancellation.
4. Define a typed model-selection service that derives `ModelRef` from `(providerID, modelID)` plus config overrides,
   resolves `auth_provider` aliases through `Auth.Service`, applies variants/transforms, and returns a typed
   `LanguageModelV2 | LlmRoute`. Pure transforms remain pure functions; Effect only orchestrates and acquires.
5. Cache policy belongs to a `CachePolicy.Service` that composes the existing `cache-policy.ts`, `cache-diagnostics.ts`,
   and `models-macro.ts`. Pin a structured key (`providerID`, `modelID`, `route`, prompt-prefix hash, tool schema version,
   capability revision), not a string. Cache hits return cached frames through the same `LLMEvent` stream the producer
   would; do not fork a faster Promise-only path that breaks EOT-10 contract tests.
6. Retry only classified transient failures: HTTP 408/429/5xx with a `retry-after` header, network resets, provider rate
   limit responses with a documented backoff schedule. Never retry non-idempotent completions after partial output has
   been emitted; the bus/SSE contract publishes order, and a replay would scramble it. Authentication failures, validation
   failures, schema mismatches, and unknown errors do not retry without explicit user action.
7. Multi-provider failover for **idempotent** reads only (compaction summaries, embeddings, route warmup). Mark the route
   as idempotent in the `Protocol` definition; never enable failover by default for chat completions. A failed primary
   must not produce a partial response visible to the user.
8. Rate limit handling: provider signals (HTTP 429, `quota_exceeded`, `rate_limit_exceeded`) decode into
   `ProviderError.RateLimited` with `retryAfter`, surfaced to the user as a typed failure, never as a silent retry loop.
   Local quota (`nikcli-inference`) is checked synchronously before the request is constructed; a denied quota returns
   `ProviderError.QuotaDenied` without burning a request.
9. Streaming observability: every LLM call yields a span with `provider`, `model`, `route`, `stream.tokens.in`,
   `stream.tokens.out`, `stream.duration`, `stream.first_token_ms`, `stream.interruptions`. Cardinality is fixed; no
   prompts/tokens/URLs in dimensions. Truncation/resampling preserves the totals and the first/last N samples.
10. Token accounting is a `Usage.Service` that aggregates per-call and per-session tokens from `LLMEvent.usage` deltas.
    The TUI's existing usage panel reads from this service, not from a parallel accumulator. Missing `usage` chunks must
    not silently under-report; the aggregator either reconstructs from prior deltas or flags the gap explicitly.

## Streaming Topology

```text
LanguageModelV2.stream
  -> Stream.fromAsyncIterable / Stream.fromReadableStream
  -> ProviderError schema mapping (HTTP/code → tagged error)
  -> CachePolicy lookup (idempotent routes only)
  -> Token accumulator + span emission
  -> LLMEvent schema validation
  -> session/llm adapter -> existing bus publication
  -> SSE / event bus → SDK client → TUI delta consumer
```

The single seam that changes is the AI SDK → LLMEvent adapter inside `provider/provider.ts`. Everything downstream keeps
its existing shape; the bus/SSE wire schema does not change.

## Failure and Cancellation

Use `Schema.TaggedError` for `ProviderError.Transport`, `ProviderError.RateLimited`, `ProviderError.AuthExpired`,
`ProviderError.QuotaDenied`, `ProviderError.SchemaMismatch`, `ProviderError.Unsupported`, `ProviderError.Timeout`. Distinguish
defects internally and sanitize at the user boundary. Cancellation must interrupt the AI SDK request and the underlying
HTTP/WS connection, not just drop the consumer. A failed stream must not commit a "done" marker; downstream consumers
either see the failure or no terminal event. Provider partial outputs that never reached the bus are not user-visible; do
not invent partial-success.

## Acceptance and Verification

- An interrupted stream halts the AI SDK request within the EOT-01 cancellation budget; the bus publishes no terminal
  event; the SDK does not deliver post-cancel frames; the TUI shows no commit.
- A 429 response decodes to `ProviderError.RateLimited` with `retryAfter`; the failure path is exercised without retry; the
  user sees a typed failure, not a retry loop. A real `Retry-After` produces the same path.
- Cached and uncached runs produce identical `LLMEvent` shape; cache hit rate, byte savings, and invalidation rate are
  recorded per session; no model produces different user-visible output for the same cache key.
- Multi-provider failover is exercised only on idempotent routes (compaction/embeddings); chat completions do not failover;
  a failure on the primary stays a failure with a clear reason.
- Token accounting matches the provider's reported totals for at least three live providers (Anthropic, OpenAI, Google)
  on a fixed corpus. Missing `usage` chunks are flagged, not interpolated.
- Spans correlate with the session's parent span; trace ids are stable across provider/SDK/bus/SSE/TUI hops; no high-card
  dimensions appear.
- Extend `packages/nikcli/test/provider/`, `packages/nikcli/test/session/`, `packages/nikcli/test/llm/` (or
  `packages/llm/test/`), `packages/nikcli/test/server/event-feed.test.ts`, and `packages/nikcli/test/tui/streaming-cost.test.ts`.
- From `packages/nikcli`: `bun test test/provider/ test/session/ test/server/event-feed.test.ts test/tui/streaming-cost.test.ts`.
  One final root `bun run typecheck` after the slice, not per-file.
- Meet EOT-01 budgets; target at least 30% reduction in per-token cost for the workloads that hit cache, with at least 95%
  cache hit rate on the second identical request in the test fixture.

## Migration and Rollback

Start with one provider and one session path; capture the existing AI SDK event order as a recorded fixture, then introduce
the adapter. Verify byte-identical user-visible output for the recorded fixture before/after the adapter. Only then extend
to other providers and to the live route. Roll back the adapter behind the existing `provider/provider.ts` facade; never
delete the AI SDK route until every caller uses the new seam. Cache invalidation must be additive; never delete
user-visible cache state as part of a streaming refactor.

Retain the partial-output safety guard during rollback: never restore retries over published text, reasoning, tool or
billed step output. Removing persisted parts cannot retract Bus publication or undo tool effects.

## Coverage Before Convergence — 2026-09-21

The plan for this spec was per-route granularity on `experimental.nativeLlm`, then a soak. Reading
the runtime says that is the wrong order, and that `specs/v2/todo.md` describes the gate worse than
it is. The flag is not binary and global in effect:

- `LLMNativeRuntime.status()` already returns a **typed** verdict with a reason, before anything is
  sent (`session/llm.ts`, the `nativeLlmEnabled && modelRef` block).
- A non-cancellation native setup failure can fall back to the AI SDK before an iterable is returned.
  Midstream failures arise during lazy iteration, outside that setup catch; they do not fall back mid-turn.
- With the flag **off**, the native request is still compiled in shadow — the block commented
  "Debug-only route compile".

So the setup fallback exists, and so does the shadow path a measurement would ride on. What was
missing is that every one of those verdicts went to `l.debug` and was discarded. Nothing aggregated
them, which is exactly the invisibility the todo names: `mapToModelRef` returns `undefined` for what
it cannot map, and no one is told which models took the AI SDK path because of it.

`session/llm/coverage.ts` keeps them. Six outcomes, each with exactly one call site in
`session/llm.ts`:

| Outcome           | Branch                                                            |
| ----------------- | ----------------------------------------------------------------- |
| `unmapped`        | `getModelRef` produced nothing                                    |
| `disabled`        | flag off, `ModelRef` present — this turn _would_ have gone native |
| `ineligible`      | flag on, pre-flight `status()` refused — a configuration verdict  |
| `ineligible-late` | flag on, `streamRequestOnly` refused — a protocol verdict         |
| `native`          | native iterable returned; iteration may still fail                |
| `fallback`        | native setup threw before returning an iterable; AI SDK selected  |

Three things about the shape, each a rule this catalogue has already paid for:

1. **`disabled` is the point.** It is readable with the flag down, so the soak the todo asks for runs
   today, on real traffic, without turning anything on. The decision this spec is blocked on needs
   numbers, not a finer flag; a finer flag is what the numbers will specify.
2. **The two ineligible outcomes are kept apart deliberately.** They produce the same user-visible
   result and have different causes — one is credentials or catalog, the other is the route refusing
   after it compiled. Collapsing them would produce a number nobody can act on, which is the mistake
   `04-event-delivery.md` records for eviction reasons.
3. **Cardinality is fixed** (EOT-01 requirement 6): the counter key is `providerID:outcome`, both
   bounded. Model ids are not keys — refused pairs go in a set capped at 64 with the overflow counted,
   and refusal reasons cap at 32 with the rest under `other`, so the totals never disagree with the
   counters. No session ids, prompts, tokens or paths.

Nothing here changes production behaviour, and that is the argument for landing it before any part of
the convergence: it is the only slice of this spec that can go in without a soak, because it _is_ the
soak.

`test/session/llm-coverage.test.ts` drives the counters and, in its second half, asserts that every
declared outcome appears as a call site in `session/llm.ts` and that no call site records an outcome
the union does not declare. A seventh outcome added without its branch fails there — the
"counter with no emitter is anti-evidence" rule from `01-performance-baseline.md`, applied to the
one module that was about to repeat it.

**What this is not.** It is not the adapter convergence. The AI SDK path and the native path are
still two pipelines, and this spec's release gate still asks for one.

---

## Rate limits and missing usage

2026-10-02: the header-handling and missing-usage items from the previous section, again a slice rather than promotion.
Status stays proposed, Tier 1/P2 and dependencies unchanged; EOT-00's real Ghostty/tmux gate remains open.

Both items started as a measurement rather than an assumption, and the measurement changed the shape of the work.

**`Retry-After` (requirement 6, acceptance line "a real `Retry-After` produces the same path").** Serving an actual
429 with `retry-after: 7` from a local server showed three things. The native runtime honours the header on its own
retries — with `retry-after: 7` the turn sat idle past a 5s test timeout, and with `retry-after: 1` it landed three
times before giving up. When it gave up it threw `LLMError` whose `reason` was a fully populated `RateLimit`: `status`,
`retryAfterMs` and redacted response headers, all present. And that error crossed into `MessageV2.fromError` as
**`UnknownError`**, which classifies as non-retryable. So a throttled turn showed an untyped failure, and
`SessionRetry.delay` never saw the header the provider had sent — the opposite of what requirement 6 asks for.

`packages/nikcli/src/session/llm/llm-event-adapter.ts` now maps a thrown native `LLMError` to `APICallError` at the one
seam every native failure crosses, preserving `statusCode`, the response headers, the parsed `retryAfterMs` under the
`retry-after-ms` key `SessionRetry.delay` reads first, and the runtime's own `retryable` verdict. The gate for applying
it is "an HTTP response actually exists", with `Transport` and `NoRoute` excluded on purpose: a network reset carries a
request-only context, and mapping it would invent a status for a request that never got an answer. Auth, quota, invalid
request, content policy and 5xx reasons all come back as `APIError` with their status intact, so a 400 stays terminal
and a 429 stays retryable.

- `packages/nikcli/test/session/native-retry-after.test.ts` serves real 429 and 400 responses through the native route
  and asserts `APIError`, `statusCode`, the `Retry-After` header surviving as `retry-after-ms: 1000`,
  `SessionRetry.retryable` returning a reason for the 429 and `undefined` for the 400, `SessionRetry.delay(1, …)`
  returning exactly 1000, and exactly three server hits so the runtime's retries stay its own business.
- Removing the mapping turns both cases red with `Received: "UnknownError"`, which is how the test was confirmed to be
  load-bearing rather than decorative.

**Missing usage (requirement 10, acceptance line "flagged, not interpolated").** The flag half now exists in the same
module: a finish event that arrives without `usage` increments a gap counter and warns with the running totals, instead
of leaving a zero-billed turn looking like a free request. Nothing is reconstructed — `Session.getUsage` still
substitutes zeros, and the counter exists precisely so that the result is counted rather than invisible. Two integers,
no provider or model ids, because the observation happens below the model reference.

- `packages/nikcli/test/session/llm-event-adapter.test.ts` replaces the "currently reports no gap" characterization with
  assertions that the gap is counted and warned while `usage` stays `undefined`, that a finish carrying usage counts no
  gap, and that a turn finishing twice is counted once — a gap tally that disagreed with the turns would be its own lie.

After both changes, `bun test` over the nine session suites above reported **175 pass, 0 fail, exit 0**;
`bun run format:check` and `bun run lint` exited 0 (0 lint errors).

Next: full adapter convergence remains open. `CachePolicy.Service` and `Usage.Service` are still absent — the gap
counter is a stopgap standing in for the second, not an implementation of it.

---

## Review the evidence

2026-09-30: test-only characterization, not production implementation or promotion. Status remains proposed,
Tier 1/P2 and dependencies unchanged; EOT-00's real Ghostty/tmux matrix remains open.

- `packages/nikcli/test/session/processor-retry.test.ts` pins transient recovery, exhaustion, non-retryable failures
  and backoff cancellation; cancellation leaves terminal persistence to the caller.
- The same processor tests pin partial text/reasoning published to Bus, then removed before retry output appears.
  Removal does not undo publication: this is a requirement 6 gap, not compliance.
- `packages/nikcli/test/session/session.test.ts` pins cache normalization, metadata precedence and pricing.
  Missing usage fields default to zero, but Anthropic/Bedrock recompute zero totals while OpenAI/Google leave absent totals undefined.
- `packages/nikcli/test/session/llm-event-adapter.test.ts` pins step billing without double-counting request totals,
  cache-write metadata, failure propagation without finish events and early iterator release.
- Those adapter tests also pin absent native finish usage as undefined, without a gap signal, and dropped
  `Retry-After` metadata at the API error boundary; neither satisfies the missing-usage or header requirements.
- `packages/nikcli/test/session/retry.test.ts` and `packages/nikcli/test/session/retry-precise.test.ts` pin classification,
  backoff, header delays and abort cleanup, not a partial-output safety guard.

User-supplied verified result from `packages/nikcli`: **120 pass, 0 fail, exit 0** across
`test/session/{session,llm-event-adapter,retry,retry-precise}.test.ts`; not a new run here.
Processor tests were inspected without a confirmed run count.

---

## Guard partial output

2026-10-02: partial-output safety slice, not full spec promotion. Status remains proposed, Tier 1/P2 and dependencies
unchanged; EOT-00's real Ghostty/tmux gate remains open.

`packages/nikcli/src/session/processor.ts` now stops retries after published text, reasoning, tool or billed step output.
It preserves partial content and the terminal `APIError`; deleting a part is no longer treated as undoing publication.

- `packages/nikcli/test/session/processor-retry.test.ts` asserts one provider call, no backoff or part removal, preserved
  partial text/reasoning and a persisted `APIError`, including native provider errors through the adapter.
- The same suite covers published pending tools and retains pre-output transient retries, empty unpublished starts/deltas,
  retry exhaustion and cancellation persistence; billed step output is guarded by the processor's non-`step-start` updates.
- `packages/nikcli/test/session/native-runtime.test.ts` asserts lazy iteration after `LLM.stream` returns, propagation of
  failures after text/reasoning/tool events, iterator closure, no synthetic finish and no AI SDK fallback.
- Native safety tests also cover cancellation and preserve preflight/late refusal and non-cancellation setup fallback.
  Iteration failures never enter the setup fallback catch; this is not a new midstream fallback mechanism.
- `packages/nikcli/test/session/llm-event-adapter.test.ts` retains failure propagation without finish events and the
  existing missing-usage and `Retry-After` gap characterizations.

Baseline before changes, from `packages/nikcli`:
`bun test test/session/processor-retry.test.ts test/session/native-runtime.test.ts test/session/llm-event-adapter.test.ts`
reported **49 pass, 0 fail, exit 0**. After the slice,
`bun test test/session/processor-retry.test.ts test/session/native-runtime.test.ts test/session/llm-event-adapter.test.ts test/session/processor-effect-service.test.ts test/session/retry.test.ts test/session/retry-precise.test.ts`
reported **108 pass, 0 fail, exit 0**, and `bun run format:check` plus `bun run lint` both exited 0 (0 lint errors).

The whole suite was then run through `bun run script/test-ci.ts` (487 files, 21 ignored, 20 batches). The only figure
worth quoting is one taken with nothing else running: **5377 pass, 4 fail**. Both surviving failures reproduce with this
slice stashed, at pristine `live-main`, so neither is a regression: three in `test/auth/pkce-no-downgrade.test.ts`
(`spawnSync("rg")` returns a null `stdout` because ripgrep is not installed on this machine) and one in
`test/release/automation.test.ts`, whose committed expectation still spells `macos/ADE.app.tar.gz` while
`ade-release.yml` uses `macos/$NAME.app.tar.gz`. Every session suite passed. The count moved from 5376 to 5377 when the
later EOT-15 outbox slice added its test; the four failures did not change.

**All four fixed 2026-10-03**, so this baseline is no longer the whole story — the suite's only failures were two environment
and expectation problems, not product defects, and both are now gone rather than tolerated.

The three PKCE failures were a test defect, not a missing dependency. `test/auth/pkce-no-downgrade.test.ts` shelled out to
`rg`, which this repository treats as an *optional* accelerator: production resolves it with `Bun.which("rg")` and disables the
tier when it is absent (`packages/nikcli/src/file/ripgrep.ts:41-49`). Requiring the binary in a test made an optional tool
mandatory and pushed the fix toward "install ripgrep in CI" instead of "the test needs no external tool". The helper is now a
native `readdirSync` walk, matching the existing precedent in `test/plugin/autoload-safety.test.ts`. That also closed a silent
hole: the old helper mapped **both** exit 1 (no match) and exit 2 (bad pattern) to "no offenders", so a pattern that failed to
compile turned a security assertion into a vacuous pass. It now throws instead. Revert-verified: planting
`code_challenge_method="plain"` under `packages/nikcli/src` turns the file red (2 fail, 2 pass) and removing it returns
4 pass.

The `automation.test.ts` failure was stale expectation, not a broken workflow. Commit `0384786e75` (ADE 0.9.0) migrated
`ade-release.yml` to derive every bundle name from `brand.json` via `NAME="$(jq -r .name packages/ade/brand.json)"` and never
touched the test, which still spelled the old literal `macos/ADE.app.tar.gz`. The test was the wrong side. Its two assertions
now follow `$NAME`. The second one was masked: line 300 threw first, so the `entry windows-aarch64 "ADE_..."` expectation at
line 301 never ran — it was stale too, and the workflow at line 451 already read `"${NAME}_${VERSION}_arm64-setup.exe"`.
Signal preserved: the indentation, the `ATTACH_ONLY` guard and the manifest key are all still asserted.

Worth recording as a method note, because the numbers look alarming and are not. Three runs of the same suite in one
session reported 13 fail, 5 fail, and 4 fail with the extra failures landing in a _different_ file each time —
`check-spec-paths`, `docker-versions`, then `Session HttpApi bridge`, and a codemode failure that disappeared again when
it had failed in the run before. Every one of those was a 30s test timeout caused by work running alongside the suite,
not by the code: each passes standalone (`test/codemode/parity.test.ts` alone reports **54 pass, 0 fail**), and the swap
pattern — a failure appearing in one file and vanishing from another across runs — is what contention looks like, not
what a regression looks like. A suite number gathered under contention measures the contention.

Next, address missing-usage signals and header handling: absent native finish usage still has no gap signal, and native
`Retry-After` metadata is still dropped at the API error boundary.

`CachePolicy.Service`, `Usage.Service` and the tagged `ProviderError` service remain absent.
Existing cache, usage and error helper modules are not these services, and passing characterization tests do not close this spec.

Typecheck note: `bun run typecheck` from the repository root exits 0 (`Tasks: 39 successful, 39 total`). Two runs earlier in
this session failed for reasons that had nothing to do with this work — twelve errors in
`src/provider/sdk/copilot/chat/openai-compatible-chat-language-model.ts` from a duplicated `@ai-sdk/provider` in the
installed tree, and `@nikcli-ai/identity`'s `wrangler types --check`. `bun install --frozen-lockfile` cleared both, which
is worth recording because the two look like code faults and are install drift.
