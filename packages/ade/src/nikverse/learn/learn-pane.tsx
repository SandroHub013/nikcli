import { LearnLayer } from "./learn-layer"
import type { LearnProgressHost } from "./learn-frame"
import "./learn-pane.css"
import { t } from "../../i18n"

/**
 * The «Impara» panel: the lesson page with its bar, in a panel of its own. It goes away in this series (the lessons live inside
 * NikVerse, `nikverse-pane.tsx`); until the panel's own wiring is removed it only wraps the layer.
 */
export type { LearnProgressHost }

export function LearnPane(props: {
  focused: boolean
  /** ADE's commands for the progress; absent where there is no host, and then the panel only shows the page. */
  progress?: () => Promise<LearnProgressHost | undefined>
  /** A message the page sent that ADE ignored, and why. */
  onIgnored?: (reason: string) => void
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}) {
  return (
    <article
      data-component="learn-pane"
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" aria-hidden="true">
          <LearnGlyph />
        </span>
        <h2 data-slot="pane-title">{t("newPane.learn")}</h2>
        <div data-slot="pane-actions">
          <button
            type="button"
            data-slot="pane-action"
            onClick={() => props.onExpand?.()}
            aria-label={t("pane.expand")}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path
                d="M1 4.5V1h3.5M11 7.5V11H7.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <button type="button" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label={t("pane.close")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div data-slot="learn-body">
        <LearnLayer place="percorsi" progress={props.progress} onIgnored={props.onIgnored} />
      </div>
    </article>
  )
}

export function LearnGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M2 14V7l3-2v9M5 14V4l4-2v12M9 14V6l5 2v6M1.5 14h13" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M11.5 3.2l.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2L8.6 5.3l2-.3z" stroke-linejoin="round" />
    </svg>
  )
}
