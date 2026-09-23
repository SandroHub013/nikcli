/**
 * What a file pane draws, chosen by `viewKind`: the editor, or a viewer.
 *
 * Nothing here executes the file. An SVG goes in an `<img>`, where its scripts,
 * its `onload` and its `foreignObject` do not run; it never enters the DOM as
 * XML. A markdown preview goes through `renderMarkdown`, which cleans it. An
 * image, a font and a sound are drawn from their bytes and never read as text.
 */
import { Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { Editor } from "./editor"
import type { Buffer } from "./buffer"
import { folderOf, handlePreviewClick, joinPath, renderMarkdown, safeDecodeURI } from "./markdown"
import type { ViewKind } from "../surface/open-route"
import { mediaUrl } from "../video/video"
import { t } from "../i18n"

/** The most a font file may weigh before it is refused, well under `read_project_bytes`' own cap. */
const MAX_FONT_BYTES = 32 * 1024 * 1024

export interface FileViewProps {
  path: string
  kind: ViewKind
  /** SVG and markdown: the text instead of the preview. */
  asText: boolean
  buffer: Buffer | undefined
  loading?: boolean
  /** Why there is no buffer: the read's error. */
  error?: string
  goTo?: { line: number; at: number }
  onChange: (draft: string) => void
  onSave: () => void
  onRevert?: () => void
  readBytes?: (path: string, maxBytes: number) => Promise<Uint8Array>
  /** A web link clicked in a markdown preview. */
  openUrl?: (url: string) => void
  /** A file linked from a markdown preview. */
  openFile?: (path: string) => void
}

/** What the pane says when the read failed: a binary gets the sentence the brief asks for. */
export function readFailure(error: string): string {
  return /^file binario/.test(error) ? t("file.binary", error) : error
}

export function FileView(props: FileViewProps) {
  /*
   * A saved SVG must be drawn again, and an `<img>` whose `src` did not change
   * keeps the picture it has. Every save changes `saved`, and the count of
   * those changes goes in the URL.
   */
  const [version, setVersion] = createSignal(0)
  createEffect(on(() => props.buffer?.saved, () => setVersion((n) => n + 1), { defer: true }))
  const src = () => `${mediaUrl(props.path)}${version() ? `?v=${version()}` : ""}`

  const editor = () => (
    <Show
      when={!props.error || props.buffer}
      fallback={<div data-slot="file-message">{readFailure(props.error ?? "")}</div>}
    >
      <Editor
        buffer={props.buffer}
        loading={props.loading}
        goTo={props.goTo}
        onChange={props.onChange}
        onSave={props.onSave}
        onRevert={props.onRevert}
      />
    </Show>
  )

  return (
    <Switch fallback={editor()}>
      <Match when={props.kind === "svg" && !props.asText}>
        <SvgView src={src()} path={props.path} />
      </Match>
      <Match when={props.kind === "image"}>
        <ImageView src={src()} path={props.path} />
      </Match>
      <Match when={props.kind === "markdown" && !props.asText}>
        <MarkdownView {...props} />
      </Match>
      <Match when={props.kind === "font"}>
        <FontView path={props.path} readBytes={props.readBytes} />
      </Match>
      <Match when={props.kind === "audio"}>
        <AudioView src={src()} />
      </Match>
    </Switch>
  )
}

export function SvgView(props: { src: string; path: string }) {
  const [failed, setFailed] = createSignal(false)
  createEffect(on(() => props.src, () => setFailed(false)))
  return (
    <div data-slot="file-view" data-kind="svg">
      <Show when={!failed()} fallback={<div data-slot="file-message">{t("file.imageFailed")}</div>}>
        <img data-slot="file-image" src={props.src} alt={props.path} onError={() => setFailed(true)} />
      </Show>
    </div>
  )
}

function ImageView(props: { src: string; path: string }) {
  const [size, setSize] = createSignal<string>()
  const [failed, setFailed] = createSignal(false)
  createEffect(on(() => props.src, () => setFailed(false)))
  return (
    <div data-slot="file-view" data-kind="image">
      <Show when={!failed()} fallback={<div data-slot="file-message">{t("file.imageFailed")}</div>}>
        <img
          data-slot="file-image"
          src={props.src}
          alt={props.path}
          onLoad={(event) => setSize(`${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`)}
          onError={() => setFailed(true)}
        />
        <Show when={size()}>
          <div data-slot="file-caption">{size()}</div>
        </Show>
      </Show>
    </div>
  )
}

function MarkdownView(props: FileViewProps) {
  const base = () => folderOf(props.path)
  const html = createMemo(() =>
    renderMarkdown(props.buffer?.draft ?? "", (relative) => mediaUrl(joinPath(base(), safeDecodeURI(relative)))),
  )
  return (
    <Show when={props.buffer} fallback={<Show when={props.error}>{(error) => <div data-slot="file-message">{readFailure(error())}</div>}</Show>}>
      <div
        data-slot="file-markdown"
        // Cleaned by DOMPurify in `renderMarkdown`: no script, no handler, no frame.
        innerHTML={html()}
        onClick={(event) => handlePreviewClick(event, base(), { url: props.openUrl, file: props.openFile })}
        // Nothing in the preview submits: the allowlist has no form, and this holds if one slips in.
        onSubmit={(event) => event.preventDefault()}
      />
    </Show>
  )
}

/** The characters every font is shown with: not words, so not in the catalogue. */
const FONT_SETS = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", "0123456789"]

let fontCount = 0

/**
 * A font, loaded from its bytes with `FontFace`.
 *
 * Not from a URL: the release CSP's `font-src` allows only `'self' data:`, and
 * a font built from a buffer makes no request at all.
 */
function FontView(props: { path: string; readBytes?: FileViewProps["readBytes"] }) {
  const family = `ade-file-font-${++fontCount}`
  const [state, setState] = createSignal<"loading" | "ready" | "failed">("loading")
  let face: FontFace | undefined
  createEffect(() => {
    const read = props.readBytes
    const path = props.path
    setState("loading")
    if (!read || typeof FontFace === "undefined") return setState("failed")
    read(path, MAX_FONT_BYTES)
      .then((bytes) => new FontFace(family, bytes).load())
      .then((loaded) => {
        face = loaded
        document.fonts.add(loaded)
        setState("ready")
      })
      .catch(() => setState("failed"))
  })
  onCleanup(() => {
    if (face) document.fonts.delete(face)
  })
  return (
    <div data-slot="file-view" data-kind="font">
      <Switch>
        <Match when={state() === "failed"}>
          <div data-slot="file-message">{t("file.fontFailed")}</div>
        </Match>
        <Match when={state() === "loading"}>
          <div data-slot="file-message">{t("editor.loading")}</div>
        </Match>
        <Match when={state() === "ready"}>
          <div data-slot="file-font" style={{ "font-family": `"${family}"` }}>
            {[32, 24, 16, 12].map((size) => (
              <p style={{ "font-size": `${size}px` }}>{t("file.fontSample")}</p>
            ))}
            {FONT_SETS.map((set) => (
              <p data-slot="file-font-set">{set}</p>
            ))}
          </div>
        </Match>
      </Switch>
    </div>
  )
}

function AudioView(props: { src: string }) {
  const [failed, setFailed] = createSignal(false)
  return (
    <div data-slot="file-view" data-kind="audio">
      <audio data-slot="file-audio" controls preload="metadata" src={props.src} onError={() => setFailed(true)} />
      <Show when={failed()}>
        <div data-slot="file-message">{t("file.audioFailed")}</div>
      </Show>
    </div>
  )
}
