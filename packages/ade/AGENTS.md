# ADE — rules for agents

ADE (Agent Development Environment) is a Tauri 2 desktop app: SolidJS frontend
in `src/`, Rust host in `src-tauri/`, voice control in `../voice`. These rules
apply to any agent changing ADE or `packages/voice`.

## Two apps, never mixed

| | Official ADE | ADE Test |
|---|---|---|
| Identifier | `ai.nikcli.ade` (`tauri.conf.json`) | `ai.nikcli.ade.test` (`src-tauri/tauri.test.conf.json`) |
| Built by | the `ade-release` workflow from an `ade-v*` tag, or `bun run native:build` | `bun run native:dev`, `bun run native:build:test` |
| Data, WebView2 profile, install folder | its own | its own |
| Global voice hotkeys | registered | not registered |
| Update notices | yes, from published `ade-v*` releases | never (version `0.0.0`) |

- The official ADE is what the user works in. **Never start, stop, restart,
  rebuild into, or measure it.** If a task needs a running app, use ADE Test.
- When stopping processes, stop only ones you started, matched by creation
  time and ancestry — Windows reuses PIDs, and a parent-id walk alone sweeps in
  unrelated processes.
- Keep the two identities separate: anything that is system-wide (hotkeys,
  files outside the app data directory, CLI hook configuration) must not let
  the test build interfere with the official one. `is_test_build` in
  `src-tauri/src/lib.rs` is the switch.

## Workflow

1. Change the code on the ADE branch (`feat/ade`).
2. Try it in ADE Test (`bun run native:dev` from this directory).
3. Before committing, run from this directory: `bun run typecheck` and
   `bun run test`; from `../voice`: `bun run typecheck` and `bun run test`.
   For Rust changes, `cargo check` and `cargo test` in `src-tauri`.
4. Commit only what the user has confirmed works. Push goes to the fork
   (`origin`), never to the upstream repository; pull requests only when the
   user asks.
5. Releases are cut only when the user asks: push a tag `ade-vX.Y.Z` with a
   version higher than the last one. `.github/workflows/ade-release.yml`
   drafts the release, builds macOS/Windows/Linux, and publishes it only if
   every platform succeeds; running official apps then show the update in
   their notification bell.

## Conventions

- `bun test` cannot load Solid `.tsx`: logic worth testing lives in plain `.ts`
  next to the component.
- Timers go through `src/host/every.ts`, which pauses or slows them while the
  window is hidden. No bare `setInterval` for polling.
- Nothing animates forever at rest: animations run while something is
  happening, on hover, or during a short intro, and honour
  `prefers-reduced-motion`.
- Comments explain why, in full sentences, like the surrounding code.
