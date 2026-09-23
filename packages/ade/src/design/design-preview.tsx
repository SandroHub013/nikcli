/**
 * Design preview component for images and standalone HTML pages.
 *
 * Security architecture and path handling (S57):
 * Previews execute arbitrary HTML pages (e.g. S54-anteprima.html) or render images
 * while strictly preserving ADE application security:
 * 1. Sandboxed iframe: `sandbox="allow-scripts allow-forms"`.
 *    The absence of `allow-same-origin` ensures the document has an opaque unique origin ('null').
 *    It cannot access ADE's window or DOM (`window.parent.document` throws SecurityError).
 *    It cannot access cookies, localStorage, IndexedDB, or Tauri IPC bindings (`__TAURI_INTERNALS__`).
 * 2. Communication isolation: No `message` event listener is installed on ADE's window for
 *    preview frames, ensuring scripts running in the preview cannot send commands or trigger actions in ADE.
 * 3. Path resolution: Supports both project-relative paths (resolved against the active project
 *    root, e.g. `.ade/preview.html` or `shots/mockup.png`) and absolute paths anywhere on disk
 *    (e.g. `C:/Users/.../ade-team/results/S54-anteprima.html`). Security is enforced by the
 *    opaque null-origin sandbox boundary rather than filesystem confinement.
 * 4. Image previews: Local images are loaded via safe `mediaUrl` custom protocol with path resolution.
 */

import { Show, createEffect, createSignal, onMount } from "solid-js"
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

export function DesignPreview(props: {
  preview: string
  name?: string
  projectRoot?: string
  fullScreen?: boolean
  onToggleFullScreen?: () => void
}) {
  const [htmlContent, setHtmlContent] = createSignal<string>()
  const [loadError, setLoadError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)

  const isHtml = () => isHtmlPreview(props.preview)

  createEffect(() => {
    const raw = props.preview.trim()
    if (!raw) {
      setHtmlContent(undefined)
      setLoadError(undefined)
      return
    }

    if (raw.startsWith("<!") || raw.startsWith("<html") || raw.startsWith("<div")) {
      setHtmlContent(raw)
      setLoadError(undefined)
      return
    }

    if (/\.html?([?#].*)?$/i.test(raw)) {
      setLoading(true)
      setLoadError(undefined)
      void (async () => {
        try {
          const filePath = resolvePreviewPath(raw, props.projectRoot)
          const host = await getHost()
          if (host?.readTextFile) {
            const res = await host.readTextFile(filePath)
            setHtmlContent(res.text)
          } else {
            const res = await fetch(filePath)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const text = await res.text()
            setHtmlContent(text)
          }
        } catch (err) {
          setLoadError(err instanceof Error ? err.message : String(err))
        } finally {
          setLoading(false)
        }
      })()
      return
    }

    setHtmlContent(undefined)
  })

  const imageSrc = () => {
    const raw = props.preview.trim()
    if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("data:") || raw.startsWith("ade-media:")) {
      return raw
    }
    return mediaUrl(resolvePreviewPath(raw, props.projectRoot))
  }

  return (
    <div
      data-component="design-preview"
      data-fullscreen={props.fullScreen ? "true" : undefined}
      data-type={isHtml() ? "html" : "image"}
    >
      <Show when={props.onToggleFullScreen}>
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

      <Show
        when={isHtml()}
        fallback={
          <div data-slot="preview-image-wrap">
            <img
              data-slot="preview-image"
              src={imageSrc()}
              alt={props.name || t("design.preview")}
              loading="lazy"
            />
          </div>
        }
      >
        <Show when={loading()}>
          <div data-slot="preview-loading">
            <span>{t("design.preview")}…</span>
          </div>
        </Show>
        <Show when={loadError()}>
          <div data-slot="preview-error" role="alert">
            <span>{loadError()}</span>
          </div>
        </Show>
        <Show when={htmlContent()}>
          {/*
            Security architecture:
            - sandbox="allow-scripts allow-forms":
              No allow-same-origin, so the frame gets an opaque unique origin (null).
              It cannot read parent document/DOM (window.parent.document throws an error).
              It cannot access cookies, localStorage, IndexedDB or Tauri IPC bindings (__TAURI_INTERNALS__).
            - No message bridge is registered in ADE for this frame, so no script in the preview
              can talk to ADE.
            - Scripts can run safely inside their own isolated context (e.g. themes and interactions in S54-anteprima.html).
          */}
          <iframe
            data-slot="preview-frame"
            sandbox="allow-scripts allow-forms"
            srcdoc={htmlContent()}
            title={props.name || t("design.preview")}
            loading="lazy"
          />
        </Show>
      </Show>
    </div>
  )
}
