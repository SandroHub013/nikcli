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

import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { getHost } from "../host/shell"
import { mediaUrl } from "../video/video"
import { t } from "../i18n"

export function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\")
}

export function resolvePreviewPath(path: string, projectRoot?: string): string {
  const clean = path.trim().replace(/[?#].*$/, "")
  if (isAbsolute(clean) || !projectRoot) return clean
  const separator = projectRoot.includes("\\") && !projectRoot.includes("/") ? "\\" : "/"
  const root = projectRoot.replace(/[\\/]+$/, "")
  const relative = clean.replace(/^\.[\\/]/, "").replace(/[\\/]/g, separator)
  return `${root}${separator}${relative}`
}

export function shortenPath(fullPath: string, maxLen = 45): string {
  const clean = fullPath.replace(/[?#].*$/, "").trim()
  if (clean.length <= maxLen) return clean
  const separator = clean.includes("\\") && !clean.includes("/") ? "\\" : "/"
  const parts = clean.split(/[\\/]/)
  if (parts.length <= 2) return clean
  const filename = parts[parts.length - 1]
  const parent = parts[parts.length - 2]
  return `…${separator}${parent}${separator}${filename}`
}

export function isHtmlPreview(preview: string): boolean {
  const trimmed = preview.trim()
  if (/\.html?([?#].*)?$/i.test(trimmed)) return true
  if (trimmed.startsWith("<!") || trimmed.startsWith("<html") || trimmed.startsWith("<div") || trimmed.startsWith("<head")) return true
  return false
}

export function isImagePreview(preview: string): boolean {
  const trimmed = preview.trim()
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)([?#].*)?$/i.test(trimmed)) return true
  if (trimmed.startsWith("data:image/") || trimmed.startsWith("ade-media://")) return true
  return false
}

export interface PreviewSize {
  readonly width: number
  readonly height: number
}

/** A page without the meta, or with a size out of range, shows at this size. */
export const DEFAULT_PREVIEW_SIZE: PreviewSize = { width: 360, height: 240 }
const MIN_SIDE = 120
const MAX_SIDE = 1600

/** The size a page declares in `<meta name="ade-size" content="WxH">`, in CSS px. */
export function previewSize(html: string): PreviewSize {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']?ade-size["'\s>/]/i.test(tag)) continue
    const size = /\bcontent\s*=\s*["']\s*(\d+)\s*[x×]\s*(\d+)\s*["']/i.exec(tag)
    if (!size) return DEFAULT_PREVIEW_SIZE
    const width = Number(size[1])
    const height = Number(size[2])
    const fits = (side: number) => side >= MIN_SIDE && side <= MAX_SIDE
    return fits(width) && fits(height) ? { width, height } : DEFAULT_PREVIEW_SIZE
  }
  return DEFAULT_PREVIEW_SIZE
}

/** `path` with `.` and `..` resolved and one kind of separator, for comparing. */
function normalized(path: string): string {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "." || (part === "" && parts.length > 0)) continue
    if (part === ".." && parts.length > 1) parts.pop()
    else parts.push(part)
  }
  return parts.join("/")
}

/** Whether `path` is inside `root`; drive letters and case do not count on Windows paths. */
export function isInsideRoot(path: string, root: string): boolean {
  const windows = /^[A-Za-z]:/.test(root) || root.includes("\\")
  const fold = (text: string) => (windows ? text.toLowerCase() : text)
  const inner = fold(normalized(path))
  const outer = fold(normalized(root)).replace(/\/+$/, "")
  return inner.startsWith(`${outer}/`)
}

export type PreviewPlan =
  | { readonly kind: "none" }
  | { readonly kind: "html"; readonly path: string; readonly src: string }
  | { readonly kind: "image"; readonly path: string; readonly src: string }
  | { readonly kind: "error"; readonly text: string }

/** What a variant's `preview` becomes: a frame, an image, or an error said with the path. */
export function previewPlan(preview: string, projectRoot: string | undefined, k: string, windows?: boolean): PreviewPlan {
  const raw = preview.trim()
  if (!raw) return { kind: "none" }
  // HTML written into the register would be a `srcdoc`: its scripts do not run in the release build.
  if (raw.startsWith("<")) return { kind: "error", text: t("design.preview.inline", k) }
  if (/\.html?([?#].*)?$/i.test(raw)) {
    const path = resolvePreviewPath(raw, projectRoot)
    if (!projectRoot || !isInsideRoot(path, projectRoot)) return { kind: "error", text: t("design.preview.outside", path, k) }
    return { kind: "html", path, src: mediaUrl(path, windows) }
  }
  if (/^(https?:|data:|ade-media:)/.test(raw)) return { kind: "image", path: raw, src: raw }
  const path = resolvePreviewPath(raw, projectRoot)
  return { kind: "image", path, src: mediaUrl(path, windows) }
}

/** The frame's attributes, all of them: its `src`, its size in px, its sandbox. No `srcdoc`, no scaling. */
export function frameProps(plan: { src: string }, size: PreviewSize, title: string) {
  return {
    src: plan.src,
    width: String(size.width),
    height: String(size.height),
    sandbox: "allow-scripts allow-forms",
    title,
  }
}

/** «Non si carica: <percorso> — <errore>». The host's message often starts with the path again: said once. */
export function loadFailure(path: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const prefix = `${path}: `
  return t("design.preview.failed", path, message.startsWith(prefix) ? message.slice(prefix.length) : message)
}

/** Whether two variants point at the same page: the user would see it twice and never the variant. */
export function sharedPreview(variants: readonly { preview: string }[]): boolean {
  const seen = new Set<string>()
  for (const { preview } of variants) {
    const key = preview.trim().replace(/[?#].*$/, "")
    if (!key) continue
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

export function DesignPreview(props: {
  preview: string
  /** The proposal's key, for the folder an error points to. */
  k: string
  name?: string
  projectRoot?: string
  fullScreen?: boolean
  onToggleFullScreen?: () => void
}) {
  const plan = () => previewPlan(props.preview, props.projectRoot, props.k)
  const [size, setSize] = createSignal<PreviewSize>()
  const [failure, setFailure] = createSignal<string>()

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
    <div
      data-component="design-preview"
      data-fullscreen={props.fullScreen ? "true" : undefined}
      data-type={plan().kind}
    >
      <Show when={props.onToggleFullScreen && !failure() && (plan().kind === "html" || plan().kind === "image")}>
        <button
          type="button"
          data-slot="preview-expand-btn"
          title={props.fullScreen ? t("design.preview.close") : t("design.preview.full")}
          aria-label={props.fullScreen ? t("design.preview.close") : t("design.preview.full")}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleFullScreen?.()
          }}
        >
          <Show
            when={props.fullScreen}
            fallback={
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
                <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            }
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
              <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </Show>
        </button>
      </Show>

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
                {(measured) => (
                  <div data-slot="preview-frame-wrap">
                    {/*
                      `src` from ade-media, never `srcdoc`: a srcdoc document inherits
                      ADE's CSP, whose release nonce stops every inline script. No
                      `allow-same-origin`: the page stays at an opaque origin, and ADE's
                      IPC stub in the frame refuses `invoke`. See the note at the top.
                    */}
                    <iframe data-slot="preview-frame" {...frameProps(current, measured(), title())} />
                  </div>
                )}
              </Show>
            </>
          )
        }
        return null
      })()}
    </div>
  )
}
