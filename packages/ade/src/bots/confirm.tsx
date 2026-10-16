import { createSignal, Show, type JSX } from "solid-js"
import { t } from "../i18n"

/**
 * The one way the bot's screens confirm something that cannot be taken back
 * (D25): the button is replaced, on the same line, by what would be lost and
 * two buttons, «Annulla» first and the danger one after. Delete a bot, delete a
 * routine, take a memory out, remove a token, revoke an account, start a
 * conversation over: all of them ask like this, and none of them asks with a
 * dialog of the system.
 *
 * Nothing is done until the second press. Pressing «Annulla» (or Escape) puts
 * the first button back; so does the action finishing, whether it worked or not.
 */
export function ConfirmAction(props: {
  /** The first button's text. */
  label: string
  /** What the second press does, in words: names what is lost. */
  question: string
  /** The danger button's text. */
  confirm: string
  onConfirm: () => void | Promise<void>
  disabled?: boolean
  /** A text link (the default, as the destructive links of the cards), or a button. */
  look?: "link" | "button"
  /** The accessible name of the first button, when `label` alone does not say what it acts on. */
  describedBy?: string
  children?: JSX.Element
}) {
  const [asking, setAsking] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const slot = () => (props.look === "button" ? "bots-btn" : "bots-link")

  const run = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await props.onConfirm()
    } finally {
      setBusy(false)
      setAsking(false)
    }
  }

  return (
    <Show
      when={asking()}
      fallback={
        <button
          type="button"
          data-slot={slot()}
          data-tone="danger"
          disabled={props.disabled}
          aria-describedby={props.describedBy}
          onClick={() => setAsking(true)}
        >
          {props.label}
        </button>
      }
    >
      <span
        data-slot="bots-confirm"
        role="group"
        aria-label={props.question}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation()
            setAsking(false)
          }
        }}
      >
        <span data-slot="bots-confirm-question">{props.question}</span>
        <button type="button" data-slot="bots-btn" disabled={busy()} onClick={() => setAsking(false)} autofocus>
          {t("bots.confirm.cancel")}
        </button>
        <button
          type="button"
          data-slot="bots-btn"
          data-tone="danger"
          disabled={busy() || props.disabled}
          onClick={() => void run()}
        >
          {props.confirm}
        </button>
      </span>
    </Show>
  )
}
