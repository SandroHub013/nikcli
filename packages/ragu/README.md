# ragu

> **A fork of [OpenCode](https://github.com/anomalyco/opencode)** — the open source coding agent.
> Credit for the original project goes to the OpenCode authors and contributors. ragu is an
> independent fork, not affiliated with or endorsed by them.

ragu is a Bun-based AI coding agent combining a terminal UI, an HTTP server API, external service connectors, and a mobile companion app.

ragu is an AI-powered development tool with connectors, a mobile companion, and a structured CLI command surface.

## Quickstart

```bash
# 1. Install (one of the methods below)
./install

# 2. Run the TUI
ragu

# 3. Or run a one-shot prompt from the shell
ragu run "explain this codebase"
```

Inside the TUI, the one shortcut to remember is **Ctrl+P** — it opens the command palette with every available action, slash command, and provider. From there, the `?` in the bottom-right footer hints shows the same.

| Surface         | Entry               |
| --------------- | ------------------- |
| Terminal UI     | `ragu` (default)  |
| HTTP API        | `ragu serve`      |
| Mobile host     | `ragu mobile`     |
| Remote sessions | `ragu remote`     |
| Connectors      | `ragu connectors` |
| Bots            | `ragu bot`        |

Run `ragu --help` to see all available commands.

## Install

| Method | Command                                                           |
| ------ | ----------------------------------------------------------------- |
| script | `./install` (or `.\install.ps1`) from the repository root          |
| npm    | `npm install -g nikcli-ai`                                        |
| pnpm   | `pnpm install -g nikcli-ai`                                       |
| bun    | `bun install -g nikcli-ai`                                        |
| brew   | `brew install nikcli` (or `nikomatt69/tap/nikcli` if not on core) |
| scoop  | `scoop install nikcli`                                            |
| choco  | `choco install nikcli`                                            |

`ragu upgrade` picks the same method you installed with. `ragu --version` prints the current version without mutating state.

## Development

```bash
bun install
bun dev
```

Local development runs the CLI entrypoint at `packages/ragu/src/index.ts`.

## Packages

| Package           | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `packages/ragu` | CLI, TUI, agent engine, server, connectors |
| `packages/mobile` | Expo mobile companion app                  |
| `packages/web`    | Documentation site                         |
| `packages/sdk`    | Shared TypeScript SDK                      |

## Resources

- [Repository README](../../README.md)

## Specs

In-repo design and roadmap documents live at the repo root (`specs/`, not this package):

- [`specs/README.md`](../../specs/README.md) — catalog, evidence register, and open-payload policy.
- [`specs/ROADMAP.md`](../../specs/ROADMAP.md) — ordered Effect/TUI architecture program (EOT-01 to EOT-10).
- [`docs/sync-architecture.md`](../../docs/sync-architecture.md) — durable per-aggregate sync reference.
