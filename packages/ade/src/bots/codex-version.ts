/**
 * `codex --version`, for a Codex turn from a chat or a routine (bot-lettura-3): only a Codex that reads the
 * project-only profile starts there (`codexKnowsProfiles` in `runners.ts`).
 *
 * Asked once per ADE start, with a time limit, through a pty like `codex login status` in `providers.ts`. An answer
 * that did not come in time, or a failed command, is not kept: the next turn asks again rather than being refused
 * until ADE restarts.
 */

import { stripAnsi } from "../session/stream"

/** How long `codex --version` may take. */
export const CODEX_VERSION_TIMEOUT_MS = 10_000

/** What this needs of the host: a process through a pty. */
export interface VersionHost {
  readonly spawn?: (input: {
    command: string
    args: string[]
    cols?: number
    rows?: number
    onLine: (line: string, stream: "out" | "err") => void
    onExit: (code: number | null) => void
  }) => Promise<{ kill: () => void }>
}

let once: Promise<string | null> | undefined

/** Forgets the version read, for tests. */
export function forgetCodexVersion(): void {
  once = undefined
}

/** What `command --version` printed, or null when it did not run, failed, timed out or named no version. */
export function codexVersion(
  host: VersionHost,
  command: string,
  timeoutMs = CODEX_VERSION_TIMEOUT_MS,
): Promise<string | null> {
  if (!once) {
    const asking = ask(host, command, timeoutMs)
    once = asking
    void asking.then((answer) => {
      if (answer === null && once === asking) once = undefined
    })
  }
  return once
}

function ask(host: VersionHost, command: string, timeoutMs: number): Promise<string | null> {
  const spawn = host.spawn
  if (!spawn) return Promise.resolve(null)
  return new Promise((resolve) => {
    const lines: string[] = []
    let settled = false
    let kill: (() => void) | undefined
    const finish = (answer: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(answer)
    }
    const timer = setTimeout(() => {
      kill?.()
      finish(null)
    }, timeoutMs)
    spawn({
      command,
      args: ["--version"],
      cols: 200,
      rows: 50,
      // Through a pty: the colours and the window title go, the words stay.
      onLine: (line) => lines.push(stripAnsi(line)),
      onExit: (code) => {
        const text = lines.join("\n").trim()
        finish(code === 0 && /\d+\.\d+\.\d+/.test(text) ? text : null)
      },
    })
      .then((session) => {
        kill = () => session.kill()
        if (settled) session.kill()
      })
      .catch(() => finish(null))
  })
}
