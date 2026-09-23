import { Show, createSignal } from "solid-js"
import type { Buffer } from "./buffer"
import { FileView } from "./file-view"
import { viewKind } from "../surface/open-route"
import "./file-pane.css"
import { t } from "../i18n"

export interface FilePaneProps {
  path: string
  buffer: Buffer | undefined
  loading?: boolean
  /** Why the file could not be read as text, shown instead of an empty editor. */
  error?: string
  /** A line to put the cursor on, from a link clicked in a session. */
  goTo?: { line: number; at: number }
  focused?: boolean
  onChange: (draft: string) => void
  onSave: () => void
  onRevert?: () => void
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
  /** A font's bytes, for the font viewer. */
  readBytes?: (path: string, maxBytes: number) => Promise<Uint8Array>
  /** A web link clicked in a markdown preview: ADE's browser. */
  openUrl?: (url: string) => void
  /** A file linked from a markdown preview. */
  openFile?: (path: string) => void
}

/**
 * A file, in the grid, wearing the same chrome as everything else.
 *
 * Sessions, browsers and files are all panes: they close the same way, expand
 * the same way, and show focus the same way. An editor that opened somewhere
 * else would be a second kind of window to learn.
 *
 * The unsaved mark lives in the header rather than only in the editor's status
 * bar, because at four panes wide the status bar is the first thing to be
 * scrolled out of sight.
 */
export function FilePane(props: FilePaneProps) {
  const name = () => props.path.split(/[\\/]/).pop() ?? props.path
  const kind = () => viewKind(props.path)
  /*
   * «Anteprima / Testo», for the two formats that are both. An SVG starts on
   * the picture; a markdown file starts on its text, because it is opened to
   * be edited far more often than to be read. A line to go to means the text.
   */
  const [asText, setAsText] = createSignal(kind() === "markdown" || Boolean(props.goTo))
  const switchable = () => kind() === "svg" || kind() === "markdown"

  return (
    <article
      data-component="file-pane"
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
            <path d="M9 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z" />
            <path d="M9 1.5V5h3.5" />
          </svg>
        </span>
        <h2 data-slot="pane-title" title={props.path}>
          {name()}
          <Show when={props.buffer?.dirty}>
            <span data-slot="pane-dirty" title={t("editor.unsaved")}>
              •
            </span>
          </Show>
        </h2>
        <div data-slot="pane-actions">
          <Show when={switchable()}>
            <button
              type="button"
              data-slot="pane-view-toggle"
              aria-pressed={!asText()}
              title={asText() ? t("file.showPreview") : t("file.showText")}
              onClick={() => setAsText((now) => !now)}
            >
              {asText() ? t("file.preview") : t("file.text")}
            </button>
          </Show>
          <button type="button" data-slot="pane-action" onClick={() => props.onExpand?.()} aria-label={t("pane.expand")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M1 4.5V1h3.5M11 7.5V11H7.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button type="button" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label={t("pane.close")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div data-slot="pane-editor">
        <FileView
          path={props.path}
          kind={kind()}
          asText={asText()}
          buffer={props.buffer}
          loading={props.loading}
          error={props.error}
          goTo={props.goTo}
          onChange={props.onChange}
          onSave={props.onSave}
          onRevert={props.onRevert}
          readBytes={props.readBytes}
          openUrl={props.openUrl}
          openFile={props.openFile}
        />
      </div>
    </article>
  )
}
