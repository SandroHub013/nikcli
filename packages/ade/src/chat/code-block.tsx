/** A code block from a model's reply: its language, a copy button, and the code as text. */

import { createSignal, onCleanup } from "solid-js"
import { t } from "../i18n"

export function CodeBlock(props: { language?: string; text: string }) {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text)
      setCopied(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard denied. The text is selectable, which is the fallback.
    }
  }

  return (
    <figure data-slot="chat-code">
      <figcaption data-slot="chat-code-head">
        <span data-slot="chat-code-lang">{props.language ?? t("chat.code.text")}</span>
        <button type="button" data-slot="chat-copy" onClick={() => void copy()}>
          {copied() ? t("chat.code.copied") : t("chat.code.copy")}
        </button>
      </figcaption>
      <pre data-slot="chat-code-body">{props.text}</pre>
    </figure>
  )
}
