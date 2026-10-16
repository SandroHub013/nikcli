import { For, Show } from "solid-js"
import { t } from "../i18n"
import { movedTab, tabButtonId, tabPanelId, TAB_LABEL, type BotTab } from "./tabs"

/**
 * The strip of tabs at the top of the bot's page. A real tablist: one tab is in
 * the tab order, the arrows move between them, and the panel it opens is named
 * by it. The strip wraps instead of scrolling, so no tab is ever out of sight.
 */
export function BotTabs(props: {
  tabs: readonly BotTab[]
  active: BotTab
  /** Ties the ids of the tabs to the ids of their panels. */
  idPrefix: string
  /** A count shown on a tab (the pairings waiting, say); nothing for 0. */
  badges?: Partial<Record<BotTab, number>>
  /** The tabs whose panel is in the page: only they have one to control. Absent: all of them. */
  mounted?: ReadonlySet<BotTab>
  onSelect: (tab: BotTab) => void
}) {
  let strip: HTMLDivElement | undefined

  const onKey = (event: KeyboardEvent, tab: BotTab) => {
    const next = movedTab(props.tabs, tab, event.key)
    if (!next) return
    event.preventDefault()
    props.onSelect(next)
    strip?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
  }

  return (
    <div data-slot="bots-tabs" role="tablist" aria-label={t("bots.tab.list")} ref={(el) => (strip = el)}>
      <For each={props.tabs}>
        {(tab) => (
          <button
            type="button"
            role="tab"
            data-slot="bots-tab"
            data-tab={tab}
            data-active={props.active === tab ? "true" : undefined}
            id={tabButtonId(props.idPrefix, tab)}
            aria-controls={props.mounted && !props.mounted.has(tab) ? undefined : tabPanelId(props.idPrefix, tab)}
            aria-selected={props.active === tab}
            tabIndex={props.active === tab ? 0 : -1}
            onClick={() => props.onSelect(tab)}
            onKeyDown={(event) => onKey(event, tab)}
          >
            {t(TAB_LABEL[tab])}
            <Show when={(props.badges?.[tab] ?? 0) > 0}>
              <span data-slot="bots-tab-badge">{props.badges?.[tab]}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}
