import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { Sheet, SheetTitle } from "../ui/sheet"
import { waitedFor, type ChoiceItem } from "./list"
import "../decisions/decisions.css"
import "./choices.css"
import { t } from "../i18n"

/**
 * «Da scegliere»: the one window of the bar's one button, with every decision
 * and design proposal waiting for the user (notifiche-design). Each entry
 * says what it is, who asked and how long ago; pressing it opens it.
 */
export function ChoicesSheet(props: {
  items: readonly ChoiceItem[]
  onPick: (item: ChoiceItem) => void
  onClose: () => void
  onOpenPanels: () => void
}) {
  // The ages move on while the window is open.
  const [now, setNow] = createSignal(new Date())
  const timer = setInterval(() => setNow(new Date()), 30_000)
  onCleanup(() => clearInterval(timer))
  const items = createMemo(() => props.items)

  return (
    <Sheet component="choices-sheet" onClose={props.onClose} size="md">
      <header data-slot="sheet-head">
        <SheetTitle as="strong">{t("choices.title")}</SheetTitle>
        <button type="button" data-slot="sheet-close" onClick={() => props.onClose()} aria-label={t("new.close")}>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path
              d="M2.5 2.5l7 7M9.5 2.5l-7 7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </header>

      <div data-slot="sheet-body">
        <Show
          when={items().length > 0}
          fallback={
            <div data-slot="sheet-empty">
              <b>{t("choices.empty")}</b>
              <span>{t("choices.emptyHint")}</span>
            </div>
          }
        >
          <ul data-slot="choices-list">
            <For each={items()}>
              {(item) => (
                <li>
                  <button type="button" data-slot="choice" data-kind={item.kind} onClick={() => props.onPick(item)}>
                    <span data-slot="choice-kind">
                      {item.kind === "decision" ? t("choices.kind.decision") : t("choices.kind.design")}
                    </span>
                    <span data-slot="choice-title">{item.title}</span>
                    <span data-slot="choice-meta">{t("choices.asked", item.by, waitedFor(item.openedAt, now()))}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>

      <footer data-slot="sheet-foot">
        <button type="button" data-slot="decision-ghost" onClick={() => props.onOpenPanels()}>
          {t("choices.panels")}
        </button>
      </footer>
    </Sheet>
  )
}
