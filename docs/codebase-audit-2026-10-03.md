# nikcli codebase audit — 2026-10-03

Commit `f42415fad4` (v1.423.0), branch `live-main`, working tree clean.
All numbers below come from commands run in this session. Claims I could not verify
are marked UNVERIFIED; two subagent reports were lost to supervisor timeouts and one
published claim was wrong on re-check (see "Corrections").

## Summary

This is an unusually disciplined codebase. Typecheck is clean across all 39 packages
(4m17s, exit 0). The architecture spec program is honest about its own state — 20 of 21
specs still declare `proposed` and the roadmap keeps a dated ledger separating landed
slices from open gates. The HTTP contract is a real single source of truth with generated
clients and 1,605 lines of custom static gates. Test skips are near-zero (9 `test.skip`
across 1,069 files).

The problems are concentrated, not diffuse: one arbitrary-file-write hole in the HTTP
layer, a release process that silently absorbs uncommitted work into tagged commits, a
typecheck cache key that excludes test files, and one architecture program that has
shipped zero ratified gates while 149 releases went out in 90 days.

| Dimension           | Verdict                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| Type safety         | Strong — 39/39 packages clean, `FIXME` count is 0                       |
| Contract discipline | Strong — Effect HttpApi + generated clients + 11 `check:*` gates        |
| Spec honesty        | Strong — statuses are pessimistic and dated, not aspirational           |
| Test discipline     | Mixed — dense in nikcli/ade/tui, near-absent in identity/mobile/console |
| Security            | One High finding, verified at source; rest of auth surface checks out   |
| Release hygiene     | Weak — tags do not map to logical changes                               |
| Repo hygiene        | Weak — 2.6 GB `.git`, 89 MB of tracked binaries                         |

## Findings

### F1 — Arbitrary file write via HTTP `file.write` (High)

`packages/nikcli/src/server/httpapi/file.ts:195-203`

```ts
const absolutePath = path.isAbsolute(requestedPath) ? requestedPath : path.join(ctx.directory, requestedPath)
const normalizedPath = path.normalize(absolutePath)
yield * Effect.promise(() => Bun.write(normalizedPath, payload.content))
```

`path.normalize` is not a containment check — it leaves `/etc/passwd` untouched and
resolves `../../` without rejecting it. The sibling handlers `content` (`:186`) and
`list` (`:177`) both route through `File.Service`, which enforces
`containsPath` → `Filesystem.realpathInside` (`packages/nikcli/src/file/index.ts:327`,
`:476`). That guard is well built — it resolves symlinks, walks ancestors for
non-existent write targets, and rejects cross-drive paths on Windows. The `write`
handler is the single HTTP path that bypasses it, and it also skips the permission
system. Any authenticated caller can write outside the project root.

Fix: route through `File.Service.write` like the siblings do. The containment
primitive already exists; this is a wiring omission, not a design gap.

### F2 — Release tags absorb uncommitted work (High, process)

`script/release-github.ts:64-66` does `git add <dist tarballs>` then
`git commit --allow-empty`. `packages/nikcli/dist` is gitignored (`git ls-files` → 0
tracked files), so the `git add` stages nothing and the commit takes only whatever was
already staged. The last release, `f42415fad4`, is 58 files / 2,797 insertions /
2,696 deletions — it carries the entire plugin-runtime feature
(`packages/tui/src/plugin/runtime.ts` +656, `packages/tui/src/app.tsx` +555,
`packages/plugin/src/tui.ts` +405) plus a 44-package version bump.

There is also no version-bump automation: nothing under `script/` writes the 44
`package.json` versions. A release tag therefore marks "whatever was staged at that
moment", which makes `git bisect` and release notes unreliable.

Fix: make the release script fail on a dirty tree, or bump + commit versions itself.

### F3 — Typecheck cache key excludes test files (Medium)

`turbo.json:6` — `"typecheck": { "inputs": ["$TURBO_DEFAULT$", "!**/test/**"] }`

Editing a test file does not invalidate the typecheck cache. `packages/nikcli` runs
`tsc --noEmit` over a tree that includes `test/`, so a cached green result can mask a
type error introduced in a test. Since the full suite does not run in CI, this is the
only thing that would have caught it.

Fix: drop the `!**/test/**` negation, or gate test typechecking separately.

### F4 — The EOT program has shipped zero ratified gates (Medium, strategic)

`specs/effect-tui/*.md` — 20 of 21 specs declare `Status: proposed`; only EOT-18 is
`partially landed`. `specs/ROADMAP.md` keeps a dated execution ledger that is honest
about this, and `specs/README.md` states outright that specs are "not claims that the
proposed changes or performance targets have shipped."

The blocker is EOT-00, which gates every other promotion. Per the ledger it is open
because "Still no real Ghostty leg, and the tmux leg is an emulated environment. No
promotion, no ratified budgets." `packages/nikcli/script/tui-startup.ts:428-436`
confirms the harness can only report `realTerminalCoverage: "unverified"` unless a real
Ghostty or tmux process is the parent — it detects them, it cannot manufacture them.

So the entire program is gated on physical-terminal measurement while 149 releases ship
in 90 days. Either fund the hardware legs or explicitly descope EOT-00 — leaving it
permanently open makes "gates every other promotion" a dead clause.

### F5 — Test density is bimodal (Medium)

1,069 test files total: 599 under `test/`, 463 colocated in `src/`. Skips are
negligible (9 `test.skip`, 3 `describe.skip`, 4 `it.skip`, 4 `.todo`, 5 `test.failing`).

Density is not the problem in `tui` — its 83k LOC has 0 colocated tests, but 95 test
files in `packages/nikcli/test/tui/` (88 importing `@nikcli-ai/tui`) cover it from
outside. Naive per-package density misreads this.

The genuinely thin areas:

| Package    | SRCLOC  | Test files | Files/1k LOC | Risk                                    |
| ---------- | ------- | ---------- | ------------ | --------------------------------------- |
| `console`  | 28,923  | 1          | 0.03         | Medium                                  |
| `sdk`      | 15,475  | 1          | 0.06         | Low (generated)                         |
| `mobile`   | 43,200  | 7          | 0.16         | High — Expo app, QR pairing, deep links |
| `web`      | 18,559  | 3          | 0.16         | Medium                                  |
| `identity` | 18,378  | 4          | 0.22         | **High — auth-critical**                |
| `desktop`  | 3,732   | 1          | 0.27         | Low                                     |
| `devhub`   | 7,862   | 3          | 0.38         | Low                                     |
| `app`      | 53,645  | 46         | 0.86         | Medium                                  |
| `llm`      | 10,104  | 23         | 2.28         | OK                                      |
| `ade`      | 152,957 | 342        | 2.24         | OK                                      |
| `nikcli`   | 166,560 | 518        | 3.11         | OK                                      |

`identity` is the one to worry about: it holds PKCE, device-code, passkeys, token
issuance and rate limiting, and it is where the second confirmed bug lives (below).
Four test files across 18k LOC of security-critical code is the coverage gap that let
F6 through.

### F6 — Non-atomic authorization-code redemption (Medium)

`packages/identity/src/index.ts:320-332` — `STATE.get` (`:321`), validation
(`:324-330`), then `STATE.delete` (`:331`) are separate awaits with no atomic claim.
Two concurrent redemptions of one code can both reach `issueTokenPair` at `:332` and
both receive a token pair.

Exploitability is limited: PKCE is enforced with `secureEqual` on the challenge
(`:327`), so a racing attacker still needs the verifier. That makes it a correctness
and single-use-semantics bug rather than a straight account takeover, which is why it
ranks below F1.

Fix: delete-and-return in one operation (DO conditional put, or delete first and treat
a miss as already-redeemed).

### F7 — Concentration risk in two files (Medium)

| File                                          | Lines | Note                                  |
| --------------------------------------------- | ----- | ------------------------------------- |
| `packages/ade/src/surface/workbench.tsx`      | 9,519 | Largest hand-written file in the repo |
| `packages/web/src/app/AppShell.tsx`           | 2,771 |                                       |
| `packages/ade/src/bots/bots.tsx`              | 2,502 |                                       |
| `packages/tui/src/component/prompt/index.tsx` | 2,486 |                                       |
| `packages/nikcli/src/provider/provider.ts`    | 2,445 |                                       |
| `packages/nikcli/src/config/config.ts`        | 2,429 |                                       |

`workbench.tsx` at 9,519 lines is the outlier — over 3x the next ade file. Note that
`specs/README.md` evidence row B18 explicitly anticipates this: "Large coordination
modules deserve responsibility-based extraction, not arbitrary file-size targets." So
this is a known, accepted position, not an oversight. It is on this list because 9.5k
lines in one TSX file is a merge-conflict and reviewability problem regardless.

(`identity/worker-configuration.d.ts` at 15,603 and `sdk/js/src/httpapi/generated/types.ts`
at 9,270 are generated and excluded from judgement.)

### F8 — Repo bloat (Low)

`.git` is 2.6 GB. The tracked tree is 175 MB, of which ~89 MB is binary assets:

- `packages/console/app/src/asset/lander/nikcli-comparison-min.mp4` — 16.5 MB
- `packages/console/app/src/asset/lander/nikcli-min.mp4` — 10.1 MB
- 3 x `packages/ade/design/*.html` at ~3.5 MB each (self-contained design exports)
- 2 x `artifacts/tui/*/screen.json` at ~1.7 MB each

Two videos alone are ~26 MB and lander videos do not belong in git history. Consider
Git LFS or an external asset host. Low severity — it costs clone time, not correctness.

## What is genuinely strong

Worth stating plainly, because these are the parts a future change could easily break:

- **Typecheck is green.** 39/39 packages, exit 0. `FIXME` count is 0.
- **The HttpApi contract is a real single source of truth.** 45 contract files under
  `packages/nikcli/src/server/httpapi/`, a 100-line `inventory.ts` that all
  `check:routes` assertions flow through, and generated clients committed.
- **1,605 lines of custom static gates** across 11 `check:*` scripts (network egress,
  workspace isolation, account-required, open payloads, plugin v2, observability
  schema, spec commit refs, spec paths, flag capture, perf baseline, route coverage).
  This is unusual and it is the strongest structural signal in the repo.
- **Spec documentation is honest.** `specs/README.md` carries a 25-row Evidence
  Register with `path:line` citations, and explicitly refuses to claim shipped status
  for landed slices. `check:route-coverage.ts` is a 23-line wrapper, and `--strict` is
  a documented no-op (`console.log("(strict mode)")` at `:17`) — AGENTS.md describes
  this accurately rather than overselling it.
- **AGENTS.md is accurate.** I verified its two most load-bearing claims: the ~350-file
  nikcli suite does not run in CI (`script/ci-validate.ts` has 2 advisory steps at
  `:120`/`:129` and every test reference is a comment explaining the omission), and
  `windows-compat.yml` has exactly 4 `bun test` steps (`:86`, `:90`, `:94`, `:98`).
- **Path containment is well engineered** where it is used — symlink resolution,
  ancestor walking, Windows cross-drive rejection (`src/file/index.ts:327`).
- **The auth surface largely holds up.** PKCE S256 with no downgrade, constant-time
  `secureEqual` comparison, exact-match redirect allowlist, single-use device codes.

## Corrections

Two subagent claims did not survive verification. Recording them so they do not get
repeated:

- Claim: "the TUI installs no SIGINT/SIGTERM handler." **False as stated.**
  `packages/tui/src/component/prompt/index.tsx:148-160` calls `signal(SIGINT, SIG_IGN)`
  / `signal(SIGTERM, SIG_IGN)` and then installs its own `DispatchSource` handlers.
  The accurate statement: the `tui` package has no app-level signal handling (that
  lives in `packages/nikcli/src/cli/handlers/{default,serve}.ts`), but the prompt's
  voice-recording path deliberately intercepts both signals and exits `0`.
- Claim: test count "~599". That is only the `test/` directory. The repo has 1,069
  test files once colocated `src/**/*.test.ts` files are counted.

## Recommendations

**Tier 1 — do now**

1. Fix F1. Route `httpapi/file.ts` `write` through `File.Service.write`. The guard
   already exists; this is a one-line-class change closing an arbitrary-write hole.
2. Fix F2. Make `release-github.ts` refuse a dirty tree, and automate the 44-package
   version bump. Until then, do not trust a release tag as a bisect point.

**Tier 2 — this cycle**

3. Fix F3. Remove `!**/test/**` from `turbo.json:6`.
4. Fix F5/F6 together — add `packages/identity` tests around the token endpoint,
   starting with a concurrent-redemption test that fails today.
5. Decide F4 explicitly: fund the Ghostty/tmux legs, or descope EOT-00 and stop
   citing it as a gate. Leaving it open is the one option that costs the most and buys
   the least.

**Tier 3 — next cycle**

6. Begin responsibility-based extraction on `workbench.tsx`, following the B18
   guidance already in the spec. Do not set an arbitrary line target.
7. Move the two lander MP4s and the `ade/design` HTML exports out of git history.

**Tier 4 — opportunistic**

8. Raise density in `mobile` (0.16) and `console` (0.03) as those surfaces get touched.
9. Add a test-import-boundary check so `packages/tui` coverage cannot silently erode
   now that it lives outside the package that owns it.

## Method

Typecheck was run directly: `bun run typecheck` → 39/39 packages successful, exit 0,
4m17s. Structural, debt, spec and CI analysis was delegated to five read-only explorers;
three supervisors hit a 10-minute no-output timeout and two were interrupted, so only
their distilled summaries survived. Every claim above that came from a delegation was
re-verified in this session, and the two that failed are recorded under Corrections.

**The full suite was not verified.** `bun run test:ci` (the sharded runner, ~350 files)
was started and terminated without producing output — 0 bytes, no surviving process.
That is consistent with the memory ceiling AGENTS.md documents, and it is why this
report contains no repo-wide pass/fail claim.

What did run, matching two of the four `windows-compat.yml` steps:

```
$ bun test test/util test/config
 452 pass
 1 skip
 0 fail
 1312 expect() calls
Ran 453 tests across 37 files. [14.95s]   exit 0
```

The test-density figures in F5 are file counts, not results. Treat "do the tests pass
repo-wide" as UNVERIFIED.
