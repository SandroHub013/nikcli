/**
 * The preview of one design variant: a page of its own, or an image.
 *
 * The format (S75 point 3, written out in `log.ts`): one self-contained HTML
 * page per variant, in the project at `.ade/design/<k>/<n>.html`, with its
 * size in `<meta name="ade-size" content="WxH">`. The card shows it at
 * exactly that size, no scaling, with scroll bars when it is bigger.
 *
 * Security. The page is loaded as the frame's `src`, from the `ade-media`
 * protocol, and never as `srcdoc`, `blob:` or `data:`:
 * - those three are documents that inherit ADE's own CSP. In the release
 *   build Tauri adds a nonce to `script-src`, and with a nonce present the
 *   browser ignores `'unsafe-inline'`, so no inline script of a preview runs
 *   in the user's ADE (DS-S66-3 showed its controls and no drop). A frame
 *   navigated to `http://ade-media.localhost/…` has its own response, with
 *   no CSP, and ADE's `frame-src` already admits `http:`.
 * - `ade-media` serves only files inside the projects the window has opened
 *   (`src-tauri/src/media.rs`, `within`): that is why the page lives in the
 *   project, and a path outside it gets no frame at all.
 * - `sandbox="allow-scripts allow-forms"`, without `allow-same-origin`: the
 *   page's origin is opaque, so it cannot reach ADE's DOM, storage or
 *   cookies. `__TAURI_INTERNALS__` is there in the frame, but as ADE's stub,
 *   which refuses `invoke` ("Tauri IPC is not available in a frame"). ADE
 *   installs no `message` listener for these frames.
 *
 * The page is also read as text, only to learn its size and to say why it
 * does not load, with the path.
 */

import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { getHost } from "../host/shell"
import { t } from "../i18n"
import {
  type PreviewSize,
  previewSize,
  previewPlan,
  fitScale,
  roomFor,
  frameProps,
  watchInView,
  loadFailure,
} from "./preview-plan"

export function DesignPreview(props: {
  preview: string
  /** The proposal's key, for the folder an error points to. */
  k: string
  name?: string
  projectRoot?: string
  /** Measured container width override (e.g. for testing). */
  containerWidth?: number
}) {
  const plan = () => previewPlan(props.preview, props.projectRoot, props.k)
  const [size, setSize] = createSignal<PreviewSize>()
  const [failure, setFailure] = createSignal<string>()
  let containerRef: HTMLDivElement | undefined
  const [measuredWidth, setMeasuredWidth] = createSignal<number>(props.containerWidth ?? 330)
  // Whether the page may run: only while it is in view, or near it (`watchInView`).
  const [inView, setInView] = createSignal(false)

  createEffect(() => {
    if (props.containerWidth !== undefined && props.containerWidth > 0) {
      setMeasuredWidth(props.containerWidth)
    }
  })

  onMount(() => {
    if (containerRef) onCleanup(watchInView(containerRef, setInView))
  })

  onMount(() => {
    if (props.containerWidth !== undefined) return
    const el = containerRef
    if (!el) return
    // The row of variants, when the preview is in one (`roomFor`); its own box otherwise.
    const row = el.closest<HTMLElement>('[data-slot="design-variants"]')
    const card = el.closest<HTMLElement>('[data-slot="design-variant-item"]')
    const measure = () => {
      const own = el.getBoundingClientRect().width || el.clientWidth
      const width =
        row && card
          ? roomFor(row.getBoundingClientRect().width || row.clientWidth, card.getBoundingClientRect().width, own)
          : own
      if (width > 0) setMeasuredWidth(Math.round(width))
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => measure())
    observer.observe(row ?? el)
    onCleanup(() => observer.disconnect())
  })

  // Reads the page only for its size, and for the error when it does not load.
  createEffect(() => {
    const current = plan()
    setSize(undefined)
    setFailure(undefined)
    if (current.kind !== "html") return
    let stale = false
    onCleanup(() => (stale = true))
    void (async () => {
      try {
        const host = await getHost()
        const text = host?.readTextFile ? (await host.readTextFile(current.path)).text : ""
        if (!stale) setSize(previewSize(text))
      } catch (error) {
        if (!stale) setFailure(loadFailure(current.path, error))
      }
    })()
  })

  const title = () => props.name || t("design.preview")

  return (
    <div ref={(el) => (containerRef = el)} data-component="design-preview" data-type={plan().kind}>
      {(() => {
        const current = plan()
        if (current.kind === "error") {
          return (
            <div data-slot="preview-error" role="alert">
              <span>{current.text}</span>
            </div>
          )
        }
        if (current.kind === "image") {
          return (
            <Show
              when={!failure()}
              fallback={
                <div data-slot="preview-error" role="alert">
                  <span>{failure()}</span>
                </div>
              }
            >
              <div data-slot="preview-image-wrap">
                <img
                  data-slot="preview-image"
                  src={current.src}
                  alt={title()}
                  loading="lazy"
                  onError={() => setFailure(loadFailure(current.path, t("design.preview.imageBroken")))}
                />
              </div>
            </Show>
          )
        }
        if (current.kind === "html") {
          return (
            <>
              <Show when={failure()}>
                <div data-slot="preview-error" role="alert">
                  <span>{failure()}</span>
                </div>
              </Show>
              <Show when={!failure() && !size()}>
                <div data-slot="preview-loading">
                  <span>{t("design.preview")}…</span>
                </div>
              </Show>
              <Show when={!failure() && size()}>
                {(measured) => {
                  const fit = () => fitScale(measured(), measuredWidth())
                  return (
                    <div
                      data-slot="preview-frame-wrap"
                      style={{
                        width: `${fit().width}px`,
                        height: `${fit().height}px`,
                        overflow: "hidden",
                        position: "relative",
                      }}
                    >
                      {/*
                        `src` from ade-media, never `srcdoc`: a srcdoc document inherits
                        ADE's CSP, whose release nonce stops every inline script. No
                        `allow-same-origin`: the page stays at an opaque origin, and ADE's
                        IPC stub in the frame refuses `invoke`. At its own size, smaller
                        only when the column is (`fitScale`), and live.
                      */}
                      {/* Out of view the frame is gone, and its scripts with it; the box keeps its size. */}
                      <Show when={inView()} fallback={<div data-slot="preview-asleep" aria-hidden="true" />}>
                        <iframe
                          data-slot="preview-frame"
                          {...frameProps(current, measured(), title())}
                          style={{
                            width: `${fit().frameWidth}px`,
                            height: `${fit().frameHeight}px`,
                            transform: `scale(${fit().scale})`,
                            "transform-origin": "top left",
                            border: "0",
                          }}
                        />
                      </Show>
                    </div>
                  )
                }}
              </Show>
            </>
          )
        }
        return null
      })()}
    </div>
  )
}
