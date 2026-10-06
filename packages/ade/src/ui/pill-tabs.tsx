import { Index, Show } from "solid-js"
import "./pill-tabs.css"

export interface PillTabItem {
  readonly id: string
  readonly label: string
  readonly shortLabel?: string
  /** Shown as a pill badge only when greater than zero. */
  readonly badge?: number | string
  /** Amber dot with a gentle pulse for new items (N to N+1). */
  readonly attention?: boolean
  readonly title?: string
  readonly ariaLabel?: string
  readonly family?: string
  readonly active?: boolean
}

export interface PillTabsProps {
  readonly items: readonly PillTabItem[]
  readonly active?: string
  readonly onSelect: (id: string) => void
  readonly role: "tab" | "button"
  readonly ariaLabel: string
  readonly dataSlot?: string
  readonly itemDataSlot?: string
}

/**
 * Segmented control and pill button group (T1).
 *
 * Renders an inset sunken track with cells that look raised when active.
 * Used for the top view selector (`role="tab"`) and the bar queue buttons (`role="button"`).
 */
export function PillTabs(props: PillTabsProps) {
  const isTab = () => props.role === "tab"
  const itemSlot = () => props.itemDataSlot ?? (props.dataSlot === "ade-pill-tabs" ? "ade-pill-tab" : "ade-view-tab")

  return (
    <div
      data-slot={props.dataSlot ?? "ade-views"}
      role={isTab() ? "tablist" : "group"}
      aria-label={props.ariaLabel}
    >
      <Index each={props.items}>
        {(item) => {
          const isActive = () => item().active ?? (props.active === item().id)
          const hasBadge = () => {
            const b = item().badge
            return b !== undefined && b !== "" && b !== 0 && b !== "0"
          }

          return (
            <button
              type="button"
              role={isTab() ? "tab" : "button"}
              aria-selected={isTab() ? isActive() : undefined}
              aria-pressed={!isTab() ? isActive() : undefined}
              aria-haspopup={!isTab() ? "dialog" : undefined}
              data-slot={itemSlot()}
              data-active={isActive() ? "true" : undefined}
              data-attention={item().attention ? "true" : undefined}
              data-family={item().family}
              title={item().title}
              aria-label={item().ariaLabel}
              onClick={() => props.onSelect(item().id)}
            >
              <Show when={item().attention}>
                <span data-slot="ade-pill-dot" aria-hidden="true" />
              </Show>
              <Show when={item().shortLabel} fallback={item().label}>
                <span data-slot="ade-pill-label-full">{item().label}</span>
                <span data-slot="ade-pill-label-short">{item().shortLabel}</span>
              </Show>
              <Show when={hasBadge()}>
                <span data-slot="ade-pill-badge">{item().badge}</span>
              </Show>
            </button>
          )
        }}
      </Index>
    </div>
  )
}
