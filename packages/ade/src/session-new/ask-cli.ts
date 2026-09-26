/**
 * Waiting for a short CLI command's answer: the conversation `nikcli api
 * session.create` opens, the most recent one `session.list` finds.
 *
 * The command prints its answer and then stays up (it holds the CLI's
 * background service open), so the output is read as it arrives until
 * `read` finds the answer, and the command is killed: `null` from `read` is
 * a final "nothing", undefined means "not yet". Past `timeoutMs` the wait
 * gives up with undefined; `slow` is said once, at its time, when the answer
 * is late but the wait goes on.
 */
export interface AskedCommand {
  kill: (options?: { tree?: boolean }) => void | Promise<boolean>
}

export function waitForAnswer(options: {
  /** Starts the command; `onLine` for each line it prints, `onExit` when it ends. */
  start: (onLine: (line: string) => void, onExit: () => void) => Promise<AskedCommand>
  read: (output: string) => string | null | undefined
  timeoutMs: number
  slow?: { afterMs: number; say: () => void }
}): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    let text = ""
    let settled = false
    let child: AskedCommand | undefined
    const finish = (answer?: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(slowTimer)
      void child?.kill({ tree: true })
      resolve(answer)
    }
    const timer = setTimeout(() => finish(undefined), options.timeoutMs)
    const slowTimer = options.slow ? setTimeout(options.slow.say, options.slow.afterMs) : undefined
    options
      .start(
        (line) => {
          text += `${line}\n`
          const answer = options.read(text)
          if (answer !== undefined) finish(answer)
        },
        () => finish(options.read(text)),
      )
      .then((started) => {
        child = started
        if (settled) void started.kill({ tree: true })
      })
      .catch(() => finish(undefined))
  })
}

/**
 * How long a mint may take, and when the pane says it is taking long.
 *
 * `session.create` answers in about 2 s, a new repository included, two at
 * once included (measured, ripristino-sexies). At the first opening of prova
 * dal vivo 7, 1b, both panes' mints went past 15 s and the TUIs started
 * without a conversation ADE could name: the pane could no longer be
 * reopened by id, and an empty conversation was left behind. A pane that
 * waits longer only when the CLI is slow costs less than that, so the mint
 * has 30 s and says so at 15; the list, whose failure costs nothing, keeps 15.
 */
export const MINT_MS = 30_000
export const MINT_SLOW_MS = 15_000
export const LIST_MS = 15_000
