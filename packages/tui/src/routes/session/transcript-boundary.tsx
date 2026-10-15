import type { RGBA } from "@opentui/core"
import { createEffect, createSignal, ErrorBoundary, on, onCleanup, Show, untrack, type JSX } from "solid-js"
import { Log } from "@ragu/util/log"
import { errorFormat, errorMessage } from "@ragu/util/error-format"
import { transcriptFailedLines } from "../../util/transcript-notice"

const log = Log.create({ service: "tui.transcript" })

/**
 * Keeps a transcript that cannot be drawn from taking the rest of the TUI with it.
 *
 * A session too large for opentui's native side (past ~16 thousand text
 * buffers: some 1200 messages with every row mounted) throws "Failed to create
 * TextBuffer" while its rows are built. With nothing closer, that reached the
 * App's ErrorBoundary, which threw away the whole App, prompt included, and
 * the screen froze on its last frame with no word of what happened. Here the
 * rows give way to one line that says so, the prompt below stays usable, and
 * the error goes to the log. Moving to another session tries again.
 */
export function TranscriptBoundary(props: {
  sessionID: string
  message: string
  color: RGBA
  /** Where the details went: the log file. */
  logFile?: string
  /** The ways out that are still there: another session, an export. */
  exits?: string
  children?: JSX.Element
}) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        log.error("transcript could not be drawn", {
          sessionID: untrack(() => props.sessionID),
          error: errorMessage(error),
          stack: errorFormat(error),
        })
        createEffect(on(() => props.sessionID, reset, { defer: true }))
        return (
          <TranscriptFailed
            lines={transcriptFailedLines({ message: props.message, logFile: props.logFile, exits: props.exits })}
            color={props.color}
          />
        )
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}

/**
 * The notice is drawn a tick late, and is itself contained.
 *
 * When the failure is the native limit, buffers only come back when the
 * reconciler destroys the rows it has just taken out, and it does that on the
 * next tick. A line asked for at once meets the same limit: contained, it is
 * simply not there; uncontained, its error goes up to the App, whose own
 * fallback fails the same way and leaves the screen as it was.
 */
function TranscriptFailed(props: { lines: string[]; color: RGBA }) {
  const [ready, setReady] = createSignal(false)
  const timer = setTimeout(() => setReady(true), 0)
  onCleanup(() => clearTimeout(timer))
  return (
    <Show when={ready()}>
      <ErrorBoundary fallback={() => null}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0}>
          <text fg={props.color} wrapMode="word">
            {props.lines.join("\n")}
          </text>
        </box>
      </ErrorBoundary>
    </Show>
  )
}
