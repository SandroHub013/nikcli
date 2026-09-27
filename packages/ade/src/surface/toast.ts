/**
 * A short line over the window that goes by itself: «DS1: B · viola, a
 * Sessione 1 — Terminal (1)».
 *
 * The sheet says where an answer went in its own footer, and the last answer
 * closes the sheet or sends it back to «Da scegliere»: the line went with it,
 * unread (Verifiche, rifiniture 2). What the sheet said last is shown here
 * instead. Not the notice strip, which is for what went wrong and stays until
 * it is dismissed.
 */
import { createSignal, type Accessor } from "solid-js"

export const TOAST_MS = 4000

export interface Toast {
  readonly text: Accessor<string | undefined>
  show: (text: string) => void
  hide: () => void
}

export function createToast(ms = TOAST_MS): Toast {
  const [text, setText] = createSignal<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const hide = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    setText(undefined)
  }
  return {
    text,
    show: (line) => {
      if (timer) clearTimeout(timer)
      setText(line)
      timer = setTimeout(hide, ms)
    },
    hide,
  }
}
