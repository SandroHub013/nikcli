/**
 * The one place ADE talks to the machine.
 *
 * In the desktop shell this runs real processes through Tauri; in the browser
 * harness there is nothing to run and every entry point returns undefined, so
 * callers branch on absence once instead of asking "am I in Tauri?" everywhere.
 *
 * Nothing above this file imports @tauri-apps directly: the browser build must
 * not fail to load because a desktop-only module is missing.
 */

export interface SpawnedSession {
  /** Kills the process. Safe to call more than once. */
  kill: () => void
  /**
   * Sends a line to the process's stdin, newline included.
   * This is what makes a pane a session rather than a transcript: an agent that
   * asks a question can be answered where it asked it.
   */
  write: (line: string) => void
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface Host {
  /** Runs `command arg` and returns its output, or null when it cannot run. */
  probe: (command: string, arg: string) => Promise<string | null>
  /**
   * Runs a command to completion and hands back everything it said.
   * Used for git, where the answer matters more than the stream, and where a
   * non-zero exit is often information rather than a failure.
   *
   * `env` extends the inherited environment rather than replacing it. It exists
   * for GIT_INDEX_FILE, which git accepts only as a variable: staging into a
   * throwaway index is the one way to snapshot the working tree without
   * touching the index the user is working in.
   */
  run: (command: string, args: string[], cwd?: string, env?: Record<string, string>) => Promise<RunResult>
  /**
   * Starts `command args` in `cwd`, streaming stdout and stderr as they arrive.
   * Every line reaches `onLine`; `onExit` fires once with the status code.
   */
  /**
   * Points `link` at `target`. Implemented as a purpose-built command rather
   * than a shell call: allowing `cmd` so it could run `mklink` would hand the
   * page arbitrary execution, which is a far larger grant than one directory
   * pointing at another. Resolves to an error string, or null on success.
   */
  linkDirectory: (link: string, target: string) => Promise<string | null>
  spawn: (input: {
    command: string
    args: string[]
    cwd?: string
    onLine: (line: string, stream: "out" | "err") => void
    onExit: (code: number | null) => void
  }) => Promise<SpawnedSession>
}

const inTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)

let cached: Host | undefined | null = null

/** The host for this build, or undefined in the browser harness. */
export async function getHost(): Promise<Host | undefined> {
  if (cached !== null) return cached ?? undefined
  if (!inTauri()) {
    cached = undefined
    return undefined
  }

  const { Command } = await import("@tauri-apps/plugin-shell")

  cached = {
    async probe(command, arg) {
      try {
        const result = await Command.create(command, [arg]).execute()
        // A CLI that answers a version flag on stderr is still installed, so
        // both streams count; only a failure to run at all means absent.
        const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
        return text.length > 0 ? text : `${command} presente`
      } catch {
        return null
      }
    },

    async run(command, args, cwd, env) {
      try {
        const options = cwd || env ? { ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) } : undefined
        const result = await Command.create(command, args, options).execute()
        return {
          code: result.code ?? null,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        }
      } catch (error) {
        // A command that cannot start at all is reported like one that ran and
        // failed, so callers have a single shape to handle.
        return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
      }
    },

    async linkDirectory(link, target) {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        await invoke("link_directory", { link, target })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },

    async spawn({ command, args, cwd, onLine, onExit }) {
      const child = Command.create(command, args, cwd ? { cwd } : undefined)
      child.stdout.on("data", (line: string) => onLine(line, "out"))
      child.stderr.on("data", (line: string) => onLine(line, "err"))
      child.on("close", (payload: { code: number | null }) => onExit(payload?.code ?? null))
      const handle = await child.spawn()
      let dead = false
      return {
        kill: () => {
          if (dead) return
          dead = true
          void handle.kill().catch(() => undefined)
        },
        write: (line) => {
          if (dead) return
          // Most CLIs read a line at a time and will sit there forever without
          // the terminator, looking like they ignored the answer.
          void handle.write(`${line}
`).catch(() => undefined)
        },
      }
    },
  }

  return cached
}
