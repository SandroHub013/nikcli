import { createEffect, createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { Sheet } from "../ui/sheet"
import { t } from "../i18n"
import {
  CATEGORIES,
  findCategory,
  readLastView,
  resolveTarget,
  saveLastView,
  type CategoryId,
  type CategoryItem,
} from "./categories"
import { CategoryIcon, CloseIcon } from "./icons"
import "./shell.css"

export interface SettingsShellProps {
  initialTarget?: string
  onClose: () => void
  version?: string
  onCheckUpdates?: () => void
  renderContent: (category: CategoryId, tab: string) => JSX.Element
}

export function SettingsShell(props: SettingsShellProps): JSX.Element {
  const initial = props.initialTarget ? resolveTarget(props.initialTarget) : readLastView()

  const [activeCategory, setActiveCategory] = createSignal<CategoryId>(initial.category)
  const [activeTab, setActiveTab] = createSignal<string>(initial.tab)

  const currentCategory = createMemo((): CategoryItem => {
    return findCategory(activeCategory()) ?? CATEGORIES[0]!
  })

  // When initialTarget changes from outside, apply it
  createEffect(() => {
    if (props.initialTarget) {
      const resolved = resolveTarget(props.initialTarget)
      setActiveCategory(resolved.category)
      setActiveTab(resolved.tab)
    }
  })

  // Save the view whenever it changes
  createEffect(() => {
    saveLastView({ category: activeCategory(), tab: activeTab() })
  })

  const categoryRefs: (HTMLButtonElement | undefined)[] = []
  const tabRefs: (HTMLButtonElement | undefined)[] = []
  let bodyRef: HTMLDivElement | undefined

  const focusContent = () => {
    if (!bodyRef) return
    const candidate = bodyRef.querySelector<HTMLElement>(
      'h3[tabindex], button, input, select, textarea, [tabindex="0"]',
    )
    candidate?.focus()
  }

  const selectCategory = (categoryId: CategoryId) => {
    setActiveCategory(categoryId)
    const cat = findCategory(categoryId)
    const firstTab = cat?.tabs[0]?.id
    if (firstTab) setActiveTab(firstTab)
  }

  const selectTab = (tabId: string) => {
    setActiveTab(tabId)
  }

  const handleCategoryKeyDown = (e: KeyboardEvent, index: number) => {
    const total = CATEGORIES.length
    if (e.key === "ArrowDown") {
      e.preventDefault()
      const next = (index + 1) % total
      categoryRefs[next]?.focus()
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      const prev = (index - 1 + total) % total
      categoryRefs[prev]?.focus()
    } else if (e.key === "Home") {
      e.preventDefault()
      categoryRefs[0]?.focus()
    } else if (e.key === "End") {
      e.preventDefault()
      categoryRefs[total - 1]?.focus()
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      selectCategory(CATEGORIES[index]!.id)
      focusContent()
    }
  }

  const handleTabKeyDown = (e: KeyboardEvent, index: number) => {
    const tabs = currentCategory().tabs
    const total = tabs.length
    if (total === 0) return

    if (e.key === "ArrowRight") {
      e.preventDefault()
      const next = (index + 1) % total
      const nextTab = tabs[next]!
      selectTab(nextTab.id)
      tabRefs[next]?.focus()
    } else if (e.key === "ArrowLeft") {
      e.preventDefault()
      const prev = (index - 1 + total) % total
      const prevTab = tabs[prev]!
      selectTab(prevTab.id)
      tabRefs[prev]?.focus()
    } else if (e.key === "Home") {
      e.preventDefault()
      selectTab(tabs[0]!.id)
      tabRefs[0]?.focus()
    } else if (e.key === "End") {
      e.preventDefault()
      selectTab(tabs[total - 1]!.id)
      tabRefs[total - 1]?.focus()
    } else if (e.key === "Enter") {
      e.preventDefault()
      focusContent()
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation()
      props.onClose()
    }
  }

  const versionLabel = () => `ADE ${props.version ?? "0.9.1"}`

  return (
    <Sheet
      component="settings-sheet"
      surface={false}
      labelledBy={activeCategory() === "voice" ? "voice-panel-title" : "settings-panel-title"}
      onClose={props.onClose}
      onKeyDown={handleKeyDown}
    >
      <div data-component="settings-shell" class="settings-shell" onKeyDown={handleKeyDown}>
        {/* Left Category Rail */}
        <nav data-slot="settings-rail" aria-label={t("settings.title")}>
          <div data-slot="settings-rail-head">
            <h2 data-slot="settings-rail-title">{t("settings.title")}</h2>
          </div>

          <div data-slot="settings-rail-categories" role="tablist" aria-orientation="vertical">
            <For each={CATEGORIES}>
              {(cat, index) => {
                const isActive = () => activeCategory() === cat.id
                return (
                  <button
                    type="button"
                    role="tab"
                    data-slot="category-button"
                    data-category={cat.id}
                    data-active={isActive() ? "true" : undefined}
                    aria-selected={isActive()}
                    tabIndex={isActive() ? 0 : -1}
                    ref={(el) => (categoryRefs[index()] = el)}
                    onClick={() => selectCategory(cat.id)}
                    onKeyDown={(e) => handleCategoryKeyDown(e, index())}
                    title={t(cat.labelKey)}
                    aria-label={t(cat.labelKey)}
                  >
                    <CategoryIcon category={cat.id} />
                    <span data-slot="category-label">{t(cat.labelKey)}</span>
                  </button>
                )
              }}
            </For>
          </div>

          <div data-slot="settings-rail-footer">
            <span data-slot="settings-version">{versionLabel()}</span>
            <button
              type="button"
              data-slot="settings-check-update"
              onClick={() => props.onCheckUpdates?.()}
            >
              {t("palette.update.check")}
            </button>
          </div>
        </nav>

        {/* Main Content Area */}
        <div data-slot="settings-main">
          <Show
            when={activeCategory() !== "voice"}
            fallback={
              <div data-slot="settings-body" data-category="voice" ref={bodyRef}>
                {props.renderContent("voice", activeTab())}
              </div>
            }
          >
            {/* Header for non-voice categories */}
            <header data-slot="settings-header">
              <div data-slot="settings-header-text">
                <h3 id="settings-panel-title" data-slot="settings-title" tabIndex={-1}>
                  {t(currentCategory().labelKey)}
                </h3>
                <p data-slot="settings-subtitle">{t(currentCategory().descKey)}</p>
              </div>
              <button
                type="button"
                data-slot="settings-close"
                onClick={props.onClose}
                aria-label={t("sidebar.menu.close")}
                title={t("sidebar.menu.close")}
              >
                <CloseIcon />
              </button>
            </header>

            {/* Tab list for non-voice categories */}
            <Show when={currentCategory().tabs.length > 0}>
              <div
                data-slot="settings-tabs"
                role="tablist"
                aria-label={t(currentCategory().labelKey)}
              >
                <For each={currentCategory().tabs}>
                  {(tab, index) => {
                    const isActive = () => activeTab() === tab.id
                    return (
                      <button
                        type="button"
                        role="tab"
                        data-slot="settings-tab"
                        data-tab={tab.id}
                        data-active={isActive() ? "true" : undefined}
                        aria-selected={isActive()}
                        tabIndex={isActive() ? 0 : -1}
                        ref={(el) => (tabRefs[index()] = el)}
                        onClick={() => selectTab(tab.id)}
                        onKeyDown={(e) => handleTabKeyDown(e, index())}
                      >
                        {t(tab.labelKey)}
                      </button>
                    )
                  }}
                </For>
              </div>
            </Show>

            {/* Body */}
            <div data-slot="settings-body" ref={bodyRef}>
              {props.renderContent(activeCategory(), activeTab())}
            </div>

            {/* Footer */}
            <footer data-slot="settings-footer">
              <button
                type="button"
                data-slot="settings-done"
                onClick={props.onClose}
              >
                {t("settings.done")}
              </button>
            </footer>
          </Show>
        </div>
      </div>
    </Sheet>
  )
}
