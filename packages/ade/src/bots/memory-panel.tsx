/**
 * The Memoria section of a bot's card (B8a): both blocks, how full they
 * are, and the user's own add and remove, through the same rules the bot's
 * writes pass (`memory.ts`).
 */

import { createSignal, For, Show } from "solid-js"
import { t } from "../i18n"
import { applyMemoryOp, MEMORY_BLOCKS, MEMORY_LIMITS, memorySize, type MemoryBlock, type MemoryStore } from "./memory"

export function MemorySection(props: { bot: string; store: MemoryStore }) {
  const [drafts, setDrafts] = createSignal<Record<MemoryBlock, string>>({ notes: "", user: "" })
  const [problem, setProblem] = createSignal<string>()

  const memory = () => props.store.get(props.bot)

  const write = (block: MemoryBlock, op: Parameters<typeof applyMemoryOp>[1]) => {
    const result = applyMemoryOp(memory(), op)
    if (!result.ok) return void setProblem(result.error)
    setProblem(undefined)
    props.store.set(props.bot, { ...result.memory, ...(memory().pending ? { pending: memory().pending } : {}) })
    if (op.op === "add") setDrafts((all) => ({ ...all, [block]: "" }))
  }

  /* The user's own remove points at one entry by its place, not by a piece of its text. */
  const drop = (block: MemoryBlock, at: number) => {
    setProblem(undefined)
    const current = memory()
    props.store.set(props.bot, { ...current, [block]: current[block].filter((_, index) => index !== at) })
  }

  return (
    <section data-slot="bots-card-section">
      <span data-slot="bots-label">{t("bots.memory.label")}</span>
      <span data-slot="bots-hint">{t("bots.memory.hint")}</span>
      <For each={MEMORY_BLOCKS}>
        {(block) => {
          const entries = () => memory()[block]
          return (
            <div data-slot="gateway-block">
              <span data-slot="gateway-subtitle">
                {t(
                  "bots.memory.usage",
                  t(block === "notes" ? "bots.memory.notes" : "bots.memory.user"),
                  memorySize(entries()),
                  MEMORY_LIMITS[block],
                )}
              </span>
              <Show
                when={entries().length > 0}
                fallback={<span data-slot="bots-hint">{t("bots.memory.emptyBlock")}</span>}
              >
                <ul data-slot="gateway-list">
                  <For each={entries()}>
                    {(entry, at) => (
                      <li data-slot="memory-entry">
                        <span data-slot="memory-text">{entry}</span>
                        <button
                          type="button"
                          data-slot="bots-link"
                          data-tone="danger"
                          onClick={() => drop(block, at())}
                        >
                          {t("bots.memory.remove")}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <form
                data-slot="gateway-row"
                onSubmit={(event) => {
                  event.preventDefault()
                  write(block, { op: "add", block, text: drafts()[block] })
                }}
              >
                <input
                  data-slot="bots-input"
                  value={drafts()[block]}
                  placeholder={t("bots.memory.placeholder")}
                  onInput={(event) => {
                    const value = event.currentTarget.value
                    setDrafts((all) => ({ ...all, [block]: value }))
                  }}
                />
                <button type="submit" data-slot="bots-btn" disabled={drafts()[block].trim().length === 0}>
                  {t("bots.memory.add")}
                </button>
              </form>
            </div>
          )
        }}
      </For>
      <Show when={problem()}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>
    </section>
  )
}
