# gadget-plugin — for coding agents

The nikcli side of gadgets. Read `../gadget/AGENTS.md` first for the rules that hold across both packages.

- `src/registry.ts` is the logic and has no I/O except the devices file. Every rule in the spec is a test in
  `tests/registry.test.ts` that needs no network. Add a rule there first.
- `src/bridge.ts` is the HTTP layer. It never decides anything the registry should: it parses, authenticates, calls the
  registry, and maps `GadgetError` to a status through `ERROR_STATUS`.
- `src/index.ts` keeps **one bridge per process** keyed by host and port, refcounted across project instances; the last
  `dispose` stops it. A taken port is recorded on the bridge and surfaced by the tool, never thrown from the plugin.
- `src/tool.ts`: anything that changes state calls `ctx.ask` before it acts. A new action that does must too.
- `src/tui.ts`: the manifest asks for `commands` only, which `TUI_HOST_CAPABILITIES` supplies. Do not add `routes` or
  a slot without checking that an external plugin can render JSX in the host.
- Do not import from `packages/nikcli`. The plugin reaches the instance only through `PluginInput.client`.

`nikcli.json` takes bare plugin specifiers; settings are environment variables (see the README).

Test: `bun test tests` and `bunx tsc --noEmit` here; `bun test test/plugin/gadgets.test.ts test/tui/plugin-gadgets.test.ts`
from `packages/nikcli` for the real loader and the real TUI v2 host.
