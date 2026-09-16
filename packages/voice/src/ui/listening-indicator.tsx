/**
 * The always-on indicator beside the orb; see `listening-state.ts`.
 */

import { Show, createMemo } from "solid-js"
import type { VoiceEngine } from "../engine"
import { listeningState } from "./listening-state"
import "./listening-indicator.css"

export function ListeningIndicator(props: { engine: VoiceEngine }) {
  const state = createMemo(() =>
    listeningState({
      settings: props.engine.settings(),
      running: props.engine.isRunning(),
      mode: props.engine.activeMode(),
      paused: props.engine.listenPaused(),
    }),
  )
  return (
    <Show when={state().kind !== "hidden" ? state() : undefined}>
      {(shown) => {
        const current = shown() as Exclude<ReturnType<typeof state>, { kind: "hidden" }>
        return (
          <button
            type="button"
            data-component="listening-indicator"
            data-state={current.kind}
            title={current.title}
            aria-label={current.title}
            onClick={() =>
              void (current.kind === "listening"
                ? props.engine.stop()
                : props.engine.start("agent", { waitForName: true }))
            }
          >
            <i data-slot="listening-dot" />
            {current.text}
          </button>
        )
      }}
    </Show>
  )
}
