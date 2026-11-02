import { Match, Switch } from "solid-js"
import type { PaneState } from "./pane-state"
import "./state-icon.css"

/**
 * The shape of each session state, stroke-based on a 16px grid.
 *
 * The pane's chip and the sidebar's row both draw it, so a state is told by
 * its shape as well as its colour (WCAG 1.4.1): a spinner arc, a shield, a
 * speech bubble, an octagon with a bang, an hourglass, a prompt, a pause, a
 * square. It does not move; the one breathing animation is the sidebar's
 * (`sidebar.css`), because motion lives there and the pane chip stays still.
 */
export function StateIcon(props: { state: PaneState }) {
  return (
    <svg class={`ic ic-${props.state}`} viewBox="0 0 16 16" aria-hidden="true">
      <Switch>
        <Match when={props.state === "work"}>
          <circle cx="8" cy="8" r="5.5" opacity=".28" />
          <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" />
        </Match>
        <Match when={props.state === "perm"}>
          <path d="M8 1.8l5.2 2.1v3.7c0 3.1-2.2 5.5-5.2 6.6-3-1.1-5.2-3.5-5.2-6.6V3.9z" />
          <path d="M6.5 6.4a1.6 1.6 0 1 1 2.3 1.4c-.5.3-.8.6-.8 1.1" />
          <circle class="f" cx="8" cy="10.9" r=".85" />
        </Match>
        <Match when={props.state === "ask"}>
          <path d="M2.5 3.2h11v7.3H8.2L5 13v-2.5H2.5z" />
          <circle class="f" cx="5.5" cy="6.85" r=".9" />
          <circle class="f" cx="8" cy="6.85" r=".9" />
          <circle class="f" cx="10.5" cy="6.85" r=".9" />
        </Match>
        <Match when={props.state === "err"}>
          <path d="M5.6 1.8h4.8l3.8 3.8v4.8l-3.8 3.8H5.6l-3.8-3.8V5.6z" />
          <path d="M8 4.9v3.6" />
          <circle class="f" cx="8" cy="11" r=".85" />
        </Match>
        <Match when={props.state === "limit"}>
          <path d="M4 1.8h8M4 14.2h8" />
          <path d="M5 1.8c0 3.2 3 3.9 3 6.2s-3 3-3 6.2M11 1.8c0 3.2-3 3.9-3 6.2s3 3 3 6.2" />
          <path class="f" d="M6.3 13.3 8 11.7l1.7 1.6z" />
        </Match>
        <Match when={props.state === "idle"}>
          <path d="M3.5 4.8 6.7 8l-3.2 3.2" />
          <path d="M8.8 11.4h4" />
        </Match>
        <Match when={props.state === "off"}>
          <path d="M6 4.5v7M10 4.5v7" />
        </Match>
        <Match when={props.state === "closed"}>
          <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
        </Match>
      </Switch>
    </svg>
  )
}
