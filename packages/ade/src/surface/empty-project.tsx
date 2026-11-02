import { Show } from "solid-js"
import { t } from "../i18n"
import { RaguPotMark } from "./ragu-pot-mark"

export interface EmptyProjectProps {
  /** False in the browser build, where nothing can be read or run. */
  hasHost: boolean
  onOpenProject?: () => void
}

/**
 * What ADE shows before it has a project.
 *
 * Two different absences, and they must not be told the same way: no folder
 * chosen yet is a step away from working, while running in the browser is a
 * wall. The second one gets no button, because there is nothing behind it.
 */
export function EmptyProject(props: EmptyProjectProps) {
  return (
    <div data-component="ade-empty">
      <div data-slot="empty-card">
        <span data-slot="empty-mark" aria-hidden="true">
          {/* The pixel pot is for this screen only: the first one a new user sees (DS-17). */}
          <RaguPotMark size={40} />
        </span>

        <h2 data-slot="empty-title">{t("empty.title")}</h2>

        <Show when={props.hasHost} fallback={<p data-slot="empty-text">{t("empty.browser")}</p>}>
          <p data-slot="empty-text">{t("empty.desktop")}</p>
          <button type="button" data-slot="empty-action" onClick={() => props.onOpenProject?.()}>
            {t("empty.open")}
          </button>
        </Show>
      </div>
    </div>
  )
}
