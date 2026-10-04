# EOT-21: Gadgets — Device SDK, Bridge and Agent Tool

Status: proposed. Tier: 2. Phase: P3. Dependencies: EOT-04, EOT-10, EOT-14, EOT-17, EOT-19.
Owner: `packages/nikcli/src/server/httpapi/*`, `packages/nikcli/src/plugin/*`, `packages/nikcli/src/mod/*`, mobile-auth
and TUI feature-plugin maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Muse Gadgets (Meta, 2026-10-02, `facebookincubator/muse-gadget-sdk`) lets a cheap device — an ESP32 board or a Linux
single-board computer — pair with an agent and become one of its hands: the agent runs `system.run`, `file.read`,
`file.write` and `device.health` on the device, the device pushes a message into a session (`send-user-msg
--session-id`), a button or push-to-talk starts a turn, and a display shows what the agent answers. Pairing needs an SDK
token and a physical confirmation; the token on an ESP32 is "an identifier rather than a password".

nikcli already has every half of that and none of the whole:

- **Pairing and capability tokens.** `packages/nikcli/src/mobile/auth.ts` mints `nkm_` tokens, hashes them at rest,
  derives capabilities from a scope (`mobile`, `studio`, `cli-sync`) and refuses an unknown scope with nothing. The LAN
  listener a phone pairs against is opened on demand (`/mobile/host/lan`, `packages/nikcli/src/server/httpapi/mobile.ts`).
- **A typed HTTP contract with raw streams.** `packages/nikcli/src/server/httpapi/` is the single source for OpenAPI and
  the generated clients; long-lived feeds are raw handlers listed in `packages/nikcli/src/server/httpapi/inventory.ts`
  and fan out through `packages/nikcli/src/server/httpapi/event-feed.ts` with a per-connection lag budget (EOT-04).
- **Tools from plugins.** A v1 server plugin returns `tool: { … }` and `packages/nikcli/src/tool/registry.ts`
  (`fromPlugin`) turns each into a registry tool; internal plugins (`HerdrPlugin`, the auth plugins) are registered in
  `packages/nikcli/src/plugin/index.ts` the same way as user ones. A mod can add tools at runtime through `$.tool.register`
  (`packages/nikcli/src/mod/api.ts`) and can refuse or gate any call with `tool.check`.
- **Drawing for clients that are not a terminal.** Mods draw plain-data trees (`packages/nikcli/src/mod/ui.ts`) for a
  declared `Surface` — `terminal`, `mobile`, `desktop`, `ade` — with a `viewport`; a pressed `Button` comes back as
  `ui.press { key }` through `Mod.Service.uiEvent` (`packages/nikcli/src/mod/index.ts`). Nothing in a tree is
  executable, and the server bounds depth, node count and text before a tree leaves it.
- **Voice in.** `POST /voice/transcribe` (`packages/nikcli/src/server/httpapi/voice.ts`) takes base64 audio and returns
  a transcript.
- **A v2 plugin surface for the TUI and ADE.** `packages/plugin/src/v2/manifest.ts` and the `routes`, `commands`,
  `storage` capabilities the TUI host supplies (`packages/tui/src/plugin/v2.ts`, `TUI_HOST_CAPABILITIES`).

What is missing is the device: a way for something that is neither a terminal, a phone nor a browser to pair, declare
what it can do, receive invocations, report results, push messages and draw. This spec defines that device as a
**gadget**, the SDK a gadget runs, the bridge the server exposes, the tool the agent calls, and the TUI/ADE plugin that
shows it — reusing the seams above instead of adding a second transport, a second token scheme or a second drawing
format.

## Scope and Non-Goals

In scope:

1. `@nikcli-ai/gadget` — the device SDK, TypeScript on Bun or Node ≥ 20, for a Linux single-board computer or any
   host that can reach the nikcli server. It ships the four Muse commands, a `display` and a `button` driver interface,
   a CLI (`nikcli-gadget pair|run|send|health`) and a reference driver pair (Linux framebuffer, terminal preview).
2. `GadgetHttpApi` — the `/gadget/*` group: pairing, hello, invocation feed, results, messages, frames, listing,
   revocation. Declared in `src/server/httpapi/`, regenerated into the SDK clients.
3. `Gadget.Service` — the server-side registry of paired devices, declared commands, per-device invocation queue and
   result correlation.
4. The `gadget` tool, registered by an internal plugin so that the agent can list devices, read health, run a declared
   command, show a tree on a display and send a message to a device — all permission-gated.
5. `gadget` as a mod `Surface`, so a mod draws for an e-ink panel the way it draws for a phone.
6. A v2 TUI/ADE plugin `nikcli:gadgets` (sidebar slot, page, commands) over the generated client.

Non-goals, stated so nobody scopes them in by accident:

- **No ESP32 firmware in this spec.** The wire protocol below is designed so C firmware can speak it (HTTP + SSE, JSON,
  one token), and a later spec owns ESP-IDF. Boards without PSRAM, which Muse runs without its tunnel, are exactly the
  case a LAN-direct server avoids — but that is a later measurement, not a claim here.
- **No second transport.** No MQTT, no BLE, no new websocket. The gadget speaks the same HttpApi every other client
  speaks, with the same `Auth.authenticate` order (`packages/nikcli/src/server/httpapi/auth.ts`).
- **No remote plugin loading.** The gadget runs commands on the device; nothing from a device is ever imported or
  executed in the nikcli process. EOT-14's `remote-disabled` stays as it is.
- **No new permission evaluator.** Gating is EOT-17's ruleset through the tool's `permission` id and `tool.check`; this
  spec adds patterns, not a mechanism.
- **No rasterizer in the first slice.** The server sends a bounded tree; the SDK lays out text with its own bitmap font.
  A server-side 1-bit frame is a later, dependency-gated slice (requirement 10).

## Design and Requirements

1. **A gadget is a paired device with a declared command set.** Identity is `gadget:<slug>` (same scoped-id discipline
   as a v2 plugin id). The declaration is a `Hello` document — `name`, `version`, `platform`, `commands[]`,
   `display?`, `buttons?` — sent on every connect and replaced, never merged, so a device that drops a command stops
   advertising it. Each command spec is `{ name, description, args, timeoutMs?, maxOutputBytes? }` with `args` a JSON
   Schema object; the server validates the spec at hello and refuses a device whose spec is malformed with
   `GadgetError.HelloInvalid`, not by silently loading the valid subset.

2. **Pairing is a 10-minute window, a code and a physical confirmation.** `nikcli gadget pair` on the host opens the
   window, starts the LAN listener if needed (`/mobile/host/lan`) and prints a six-digit code plus the URL. On the
   device, `nikcli-gadget pair --server <url> --code <code>` posts to `POST /gadget/pair`; the server mints a token
   with scope `gadget` and the device stores it at `$XDG_STATE_HOME/nikcli-gadget/token`, mode 0600. A device that
   declares a `button` must press it within the window to finish pairing (`POST /gadget/pair/confirm`); one without a
   button finishes on the code alone and the host prints that it did. Pairing creates a fresh token every time; there
   is no re-pair that keeps the old one.

3. **Scope `gadget` grants `gadget` and nothing else.** `MobileAuth.Scope` gains `gadget`, `MobileAuth.Capability`
   gains `gadget`, and `CAPABILITIES.gadget = ["gadget"]`. `/mobile/*` and `/sync/*` refuse it because it is not in
   `SYNC_SCOPES` and carries no `read`; `/gadget/*` requires it; `/voice/transcribe` accepts it only for a device whose
   hello declared `audio: true`. Tokens are hashed at rest exactly as `nkm_` tokens are, listed and revoked with the
   same lifecycle (`token list`, `token revoke`), and a revoked token answers `GadgetError.TokenRevoked`, never a
   network error. The token is bound to the device fingerprint sent at pairing (`platform`, machine id when the
   platform has one); a hello from a different fingerprint on the same token is refused and logged.

4. **The invocation feed is one SSE stream per device, with the EOT-04 budget.** `GET /gadget/:id/commands` is a raw
   handler (listed in `inventory.ts`) over an `EventFeed` instance keyed by device. Frames are `Invoke { callID,
command, args, deadline }`, `Show { frameID, tree, viewport }`, `Ping` and `Bye`. A device that falls behind
   `LAG_BUDGET` is evicted with a reason and the pending invocations fail with `GadgetError.Offline`; a device with no
   open feed is `offline` and every invoke fails fast with the same error instead of queuing forever. The SDK reconnects
   with bounded backoff and re-sends hello on every connect.

5. **Invocations are serialized per device and bounded.** One in-flight command per device; a second invoke waits in a
   bounded queue (default 8) or fails with `GadgetError.Busy`. Each invoke carries a deadline (spec `timeoutMs`,
   default 30 s, ceiling 10 min); the server fails it with `GadgetError.Timeout` when the result does not arrive, and the
   SDK aborts the device-side process at the same deadline. Results arrive on `POST /gadget/:id/result` as
   `{ callID, output, exitCode?, isError?, truncated? }`; output is chunked at 64 KB and capped at the spec's
   `maxOutputBytes` (default 256 KB), truncated at the device, never at the wire, and marked.

6. **The built-in commands are Muse's four, with Muse's limits.** `system.run` (argv array, cwd, env allowlist, returns
   stdout/stderr/exit code), `file.read` and `file.write` (64 KB chunks, a write replaces the file only when the last
   chunk lands), `device.health` (uptime, load, memory, disk, temperature where the platform exposes it). Commands run
   as the account the SDK was installed for, with exactly that account's permissions; the SDK never elevates. A gadget
   author adds a command by adding a spec and a handler to `commands` in `Gadget.create` — no other file.

7. **The agent reaches a gadget through one tool, registered by an internal plugin.** An internal plugin in
   `src/plugin/` (registered beside `HerdrPlugin` and the auth plugins in `packages/nikcli/src/plugin/index.ts`)
   returns `tool: { gadget }`. The tool takes `action: "list" | "health" | "run" | "show" | "send"`, `device`,
   `command?`, `args?`, `tree?`, `text?`, `sessionID?`. It is registered only when `experimental.gadgets` is `true`
   in config, so a build with the flag off has no tool, no routes served and no surface. Per-command tools
   (`gadget_<slug>_<command>`) are a later slice: they need the registry's derived state to re-run on `gadget.hello`,
   which today it does only on instance reload (`registry.ts`, "join instance hot reload").

8. **Every invoke is permission-gated before it leaves the server.** The tool's permission id is `gadget`; the pattern
   is `<slug>:<command>`. The shipped default ruleset asks for `system.run` and `file.write`, allows `device.health`
   and `display.show`, and asks for everything a gadget author declared. `plan` is denied the tool entirely, like
   `plugin`. A mod may tighten any of this with `tool.check`; `sec-default` keeps a deny a deny. The decision is audited
   with the rule that produced it (EOT-17 landed slice), with the device slug in the span.

9. **A device message is a session message, with the 202 contract.** `POST /gadget/:id/message` carries `{ text,
sessionID? }`. With a `sessionID` the text is enqueued into that session exactly as mobile's `sessionMessage`
   does (202 Accepted, no model turn awaited). Without one, the server creates a session titled after the device and
   answers its id, so the device can keep a side chat the way Muse's `--session-id` does. Messages are rate-limited per
   device (default 60/min) and answer `GadgetError.RateLimited` with `retryAfter`; a device cannot flood sessions.

10. **A display is a mod surface, not a new drawing format.** `ModUi.Surface` gains `gadget` and `ModHttpApi.RenderInput`
    accepts it. The tool's `show` action, and any mod answering `ui.render` for `component: "Gadget"` with `surface:
"gadget"`, produces a tree the server validates with the existing limits and ships as a `Show` frame; `viewport` is
    the device's declared `columns × rows` (character cells for the first slice). The SDK's `Display` interface is
    `{ width, height, depth: 1 | 2 | 8, draw(frame) }`; the reference drivers are the Linux framebuffer and a
    terminal preview. A later slice adds server-side rasterization to a 1-bit PNG for devices that declare
    `display.format: "png1"`, so an e-paper panel gets pixels and the SDK does no layout — gated on that slice, not
    promised here.

11. **A button is `ui.press`; push-to-talk is `/voice/transcribe` then a message.** The SDK's `Button` driver maps a
    press to `POST /gadget/:id/event { kind: "press", key }`, which the server routes through `Mod.Service.uiEvent`
    with `component: "Gadget"` and `requestId: <slug>`, so a mod that drew a `Button` for the gadget answers it the
    way it answers a terminal press. Push-to-talk posts the recording to `/voice/transcribe` (requirement 3's gate)
    and the transcript to `/gadget/:id/message`. No audio leaves the device without the `audio: true` declaration.

12. **The TUI and ADE see gadgets through one v2 plugin.** `nikcli:gadgets` is a `Plugin.define` module with manifest
    `{ capabilities: ["routes", "commands", "storage"] }` — the three `TUI_HOST_CAPABILITIES` supplies, and nothing
    else, because `http`, `tools` and `scheduler` are not supplied by the TUI host and a manifest asking for them is
    refused with `CapabilityDenied`. It registers a `sidebar.content` slot (paired devices, online state, last health),
    a `gadgets` page, and the commands `/gadget pair`, `/gadget show`, `/gadget send`. Everything device-facing is
    requirements 1–11, server-side, reached through the generated client. The same `define` runs in ADE as a pane and a
    sidebar section.

13. **Failures are typed and carried on the contract.** `GadgetError.{NotPaired, HelloInvalid, Offline, Busy, Timeout,
CommandUnknown, Denied, PayloadTooLarge, RateLimited, TokenRevoked}` are `Schema.TaggedError`, each with a
    `message` that renders on its own, returned as typed HttpApi errors (EOT-10: a failure cannot look like success).
    The tool surfaces them verbatim in `output` with `isError`, so the model sees why and does not retry a
    `Denied`.

## Wire Protocol

| Operation       | Method and path             | Auth         | Body / frames                                             |
| --------------- | --------------------------- | ------------ | --------------------------------------------------------- |
| Pair            | `POST /gadget/pair`         | pairing code | `{ code, name, platform, fingerprint }` → `{ id, token }` |
| Confirm         | `POST /gadget/pair/confirm` | token        | `{}` (button pressed)                                     |
| Hello           | `PUT /gadget/:id/hello`     | token        | `Hello` (replaces the declaration)                        |
| Invocation feed | `GET /gadget/:id/commands`  | token        | SSE: `Invoke`, `Show`, `Ping`, `Bye`                      |
| Result          | `POST /gadget/:id/result`   | token        | `{ callID, output, exitCode?, isError?, truncated? }`     |
| Event           | `POST /gadget/:id/event`    | token        | `{ kind: "press" \| "input", key, value? }`               |
| Message         | `POST /gadget/:id/message`  | token        | `{ text, sessionID? }` → 202 `{ sessionID }`              |
| List            | `GET /gadget`               | operator     | `GadgetInfo[]` (id, name, online, commands, health)       |
| Invoke          | `POST /gadget/:id/invoke`   | operator     | `{ command, args }` → result or `GadgetError`             |
| Show            | `POST /gadget/:id/show`     | operator     | `{ tree }` → `{ frameID }`                                |
| Revoke          | `DELETE /gadget/:id`        | operator     | revokes the token and drops the declaration               |

"Operator" is the server's own principal (`user`, `mobile`, or `open` in dev mode); "token" is scope `gadget`. Every
declared endpoint goes through `bun run generate:httpapi-clients`; the SSE route is raw and listed in `inventory.ts`.

## Runtime Topology

```text
Device (Bun/Node on a Pi, or anything speaking HTTP+SSE)
  @nikcli-ai/gadget
    Gadget.create({ server, token, commands, display?, buttons?, audio? })
      -> hello on connect, SSE feed, per-command handler, result post
      -> Display driver (framebuffer | terminal), Button driver (gpio | keyboard)

nikcli server
  GadgetHttpApi (/gadget/*)  ──►  Gadget.Service (registry, queues, deadlines)
        │                              │
        │ SSE (EventFeed per device)   │ Invoke / Show
        ▼                              ▼
  Auth (scope gadget)            gadget tool  ◄── internal plugin (flag experimental.gadgets)
                                       │
                                 Permission (id gadget, pattern <slug>:<command>) ◄── tool.check (mods)
                                       │
                                 Mod.Service.render(surface: "gadget") / uiEvent(component: "Gadget")

TUI / ADE
  v2 plugin nikcli:gadgets (routes, commands, storage) over the generated client
```

## Proposed Files

Proposed, not present; cited here as a block so the spec-path gate does not read them as claims.

```text
packages/gadget/                                  @nikcli-ai/gadget (device SDK)
  src/index.ts                                    Gadget.create, Hello, command specs, feed client
  src/commands/{system,file,health}.ts            the four built-in commands
  src/display/{framebuffer,terminal}.ts           reference Display drivers
  src/button/{gpio,keyboard}.ts                   reference Button drivers
  src/cli.ts                                      nikcli-gadget pair|run|send|health
packages/nikcli/src/server/httpapi/gadget.ts      GadgetHttpApi group + handlers (raw SSE in inventory.ts)
packages/nikcli/src/gadget/index.ts               Gadget.Service: registry, per-device queue, deadlines
packages/nikcli/src/gadget/gadget.sql.ts          paired devices and declarations (tokens stay in mobileTokens)
packages/nikcli/src/plugin/gadget.ts              internal plugin registering the `gadget` tool
packages/tui/src/feature-plugins/gadgets/         v2 define: sidebar slot, page, commands (reused by ADE)
packages/nikcli/test/gadget/pair.test.ts          pairing window, code, confirm, fingerprint binding
packages/nikcli/test/gadget/feed.test.ts          feed eviction, offline fast-fail, reconnect re-hello
packages/nikcli/test/gadget/invoke.test.ts        serialization, deadlines, truncation, typed failures
packages/nikcli/test/gadget/tool.test.ts          permission patterns, plan denied, flag off = no tool
packages/nikcli/test/gadget/surface.test.ts       gadget surface render limits, press routing
packages/gadget/test/sdk.test.ts                  SDK against an in-process server
```

Changes to existing files: `packages/nikcli/src/mobile/auth.ts` (scope and capability `gadget`),
`packages/nikcli/src/mod/ui.ts` (surface `gadget`), `packages/nikcli/src/server/httpapi/mod.ts` (`RenderInput.surface`),
`packages/nikcli/src/server/httpapi/inventory.ts` (raw SSE route), `packages/nikcli/src/server/httpapi/public.ts`
(group composition), `packages/nikcli/src/plugin/index.ts` (internal plugin list), `packages/nikcli/src/config/config.ts`
(`experimental.gadgets`).

## Device SDK Contract

```ts
import { Gadget } from "@nikcli-ai/gadget"

export default Gadget.create({
  name: "pi-office",
  commands: {
    // the four built-ins are included unless `builtins: false`
    "ha.toggle": {
      description: "Toggle a Home Assistant entity",
      args: { type: "object", properties: { entity: { type: "string" } }, required: ["entity"] },
      timeoutMs: 10_000,
      async run({ entity }, ctx) {
        const res = await fetch(`http://homeassistant.local:8123/api/services/switch/toggle`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.env.HA_TOKEN}` },
          body: JSON.stringify({ entity_id: entity }),
          signal: ctx.signal, // aborted at the server deadline
        })
        return { output: `${entity}: ${res.status}`, isError: !res.ok }
      },
    },
  },
  display: Gadget.display.framebuffer({ device: "/dev/fb0", depth: 1 }),
  buttons: Gadget.button.gpio({ pins: { ok: 17, next: 27 } }),
})
```

`nikcli-gadget run` loads this file, reads the token, connects, sends hello and serves the feed. `nikcli-gadget send
"text" [--session-id id]` is requirement 9 from a shell. `nikcli-gadget health` prints what `device.health` would return.
The SDK depends on nothing from `packages/nikcli`; it imports the generated client from `@nikcli-ai/sdk/httpapi` only.

## Agent Tool Contract

```ts
// what the model sees, abbreviated
gadget({ action: "list" })
gadget({ action: "health", device: "pi-office" })
gadget({ action: "run", device: "pi-office", command: "system.run", args: { argv: ["uptime"] } })
gadget({ action: "show", device: "pi-office", tree: { type: "Markdown", props: { text: "# Build green" } } })
gadget({ action: "send", device: "pi-office", text: "Deploy finished", sessionID: "ses_…" })
```

`run` is where the permission ask happens (requirement 8); `show` validates the tree with `ModUi` limits before it is
queued; `list` and `health` never ask. The tool is one `tool({ description, args, execute })` from `@nikcli-ai/plugin`,
so a user plugin can wrap or extend it the same way, and a mod can gate it with `tool.check` on `{ tool: "gadget" }`.

## Failure and Cancellation

Every failure is a `GadgetError.*` tagged error (requirement 13). A deadline cancels on both ends: the server fails the
invoke and drops the `callID`, the SDK aborts the handler's `signal`; a late result for a dropped `callID` is logged and
discarded, never attached to a newer call. Feed eviction fails every pending invoke for that device with `Offline`
before the socket closes, so a caller is never left awaiting a result the server has already forgotten. A hello that
fails validation leaves the previous declaration in place and the device marked `offline` with the reason; it does not
load the valid subset. The tool's `execute` honours `ctx.abort`: an aborted turn cancels the invoke it was waiting on.

## Security Posture

- A gadget token is a device credential, not a user: scope `gadget` reaches `/gadget/*` and, when declared,
  `/voice/transcribe`. It cannot list sessions, read files on the host, or open a pty. The capability table is the
  gate, not route-by-route checks (EOT-19 requirement 9, landed).
- Tokens are hashed at rest, bound to a fingerprint, revocable, and listed with the mobile tokens so one `token list`
  shows every credential the host has issued.
- A command runs on the device as the device's account. nikcli never runs device code; the only thing that crosses into
  the host process is JSON the contract validated.
- `system.run` and `file.write` ask by default; a device cannot ask for itself — the ask is on the host, answered by the
  operator, and `plan` cannot call the tool at all.
- Trees, results and messages are bounded (`MAX_DEPTH`, `MAX_NODES`, `MAX_TEXT`; 64 KB chunks; 256 KB default output;
  60 messages/min). An over-limit payload is `PayloadTooLarge`, not a truncated success.
- Like Muse, pairing has no manufacturer attestation: the code and the physical confirmation prove presence, not
  identity. The spec says so in the pairing output rather than implying more.

## Acceptance and Verification

- Pairing: a device pairs inside the window with the code, fails after it, finishes only on button confirm when it
  declared a button, receives a fresh token every time; a hello with another fingerprint on the same token is refused.
- Scope: a `gadget` token is refused on `/mobile/*`, `/sync/*`, `/session/*`; accepted on `/gadget/*`; accepted on
  `/voice/transcribe` only with `audio: true` declared.
- Feed: a reader lagging past `LAG_BUDGET` is evicted with a reason and its pending invokes fail `Offline`; an invoke
  against a device with no feed fails `Offline` within one tick; a reconnect re-sends hello and resumes.
- Invocation: two concurrent invokes serialize; the ninth queued fails `Busy`; a handler past its deadline fails
  `Timeout` on the server and sees `signal.aborted` on the device; output over `maxOutputBytes` arrives marked
  `truncated`; a late result for a dropped `callID` is discarded.
- Tool: with `experimental.gadgets` off the registry has no `gadget` tool and no `/gadget/*` route is served; with it on,
  `run system.run` asks, `health` does not, `plan` is denied, a `tool.check` deny from a mod wins over an allow rule.
- Surface: a tree over `ModUi` limits is refused before queueing; a device press reaches a mod's `ui.press` with
  `component: "Gadget"` and the device slug; `surface: "gadget"` is accepted by `ModHttpApi.render`.
- Contract: `bun run check:routes --strict` passes; `bun run generate:httpapi-clients` produces no tracked drift
  (CI treats drift as blocking); root `bun run typecheck` passes.
- SDK: the SDK's own test (packages/gadget/test/sdk.test.ts in the proposed tree) pairs, hellos, serves one invoke of each built-in and one custom command
  against an in-process server, and survives a feed drop with one reconnect.
- Memory: the per-device feed and queue return to baseline after revoke (EOT-01 counters); no watcher, timer or socket
  outlives the device.

## Migration and Rollback

Nothing ships on by default. `experimental.gadgets: false` leaves no tool, no served route and no surface; flipping it
on adds them and flipping it off removes them without touching stored tokens or declarations, so a rollback is a config
change. Slices land in this order, each its own PR with its tests: (1) scope and pairing, (2) hello, feed and invoke
with the four built-ins, (3) the internal plugin and tool with permission patterns, (4) surface `gadget` and the
`show`/press path, (5) the v2 TUI/ADE plugin, (6) the SDK package and its CLI, (7) later and dependency-gated:
per-command tools on registry re-derivation, server-side 1-bit frames, ESP32 firmware under its own spec. Removing the
feature is deleting the proposed files and the `gadget` scope; the `mobileTokens` rows with that scope are revoked by
the same lifecycle the mobile tokens use.

## Muse ↔ nikcli Mapping

| Muse Gadgets                                     | nikcli (this spec)                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| SDK token from gadgets.muse.ai                   | `nkm_` token, scope `gadget`, minted by `nikcli gadget pair`             |
| Pair in the Muse app, button to confirm          | code in the terminal, `POST /gadget/pair`, button confirm when declared  |
| `COMMAND_SPECS` + `Executor.run`                 | `commands` in `Gadget.create`, JSON Schema args, one handler per command |
| `system.run`, `file.read/write`, `device.health` | the same four, same 64 KB chunks, same account semantics                 |
| `send-user-msg --session-id`                     | `POST /gadget/:id/message { text, sessionID? }` → 202                    |
| Text and images to the display                   | mod tree on surface `gadget`; 1-bit frames in a later slice              |
| Push-to-talk → transcript → reply                | `/voice/transcribe` with `audio: true`, then a message                   |
| Home-network tunnel (needs PSRAM)                | LAN-direct to the nikcli server; no tunnel in scope                      |
| Muse Home Link (HTTPS to smart home)             | a gadget command (`ha.toggle` above); no dedicated device                |
