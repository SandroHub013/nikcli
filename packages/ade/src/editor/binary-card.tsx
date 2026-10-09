/**
 * The card a file pane shows for a file that is not text.
 *
 * It says what the file is and how big, from the fields the host sent with
 * the failed read (`binary-file.ts`). Nothing here opens or runs the file.
 */
import { Show, createSignal, type JSX } from "solid-js"
import { binaryType, formatSize, isArchive, type ArchiveListing, type BinaryFile, type BinaryType } from "./binary-file"
import { ArchiveList } from "./archive-list"
import { locale, t } from "../i18n"

type Family = "package" | "program" | "document" | "data"

const FAMILY: Record<BinaryType, Family> = {
  apk: "package",
  aab: "package",
  jar: "package",
  zip: "package",
  gzip: "package",
  "7z": "package",
  rar: "package",
  exe: "program",
  dll: "program",
  elf: "program",
  wasm: "program",
  pdf: "document",
  sqlite: "data",
  binary: "data",
}

/** One outline per family, drawn like the pane header's icons: stroke only, current colour. */
const ICONS: Record<Family, () => JSX.Element> = {
  package: () => (
    <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
      <path d="M5 10 16 4l11 6v12l-11 6-11-6Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      <path d="m5 10 11 6 11-6M16 16v12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
  ),
  program: () => (
    <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
      <rect x="4" y="6" width="24" height="20" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M4 11h24M9 16l4 3-4 3M15 22h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  ),
  document: () => (
    <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
      <path d="M8 4h11l6 6v18H8Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      <path d="M19 4v6h6M12 17h9M12 21h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  ),
  data: () => (
    <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
      <path d="M8 4h11l6 6v18H8Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      <path d="M19 4v6h6M12 16h2M12 20h2M12 24h2M17 16h4M17 20h4M17 24h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  ),
}

export interface BinaryCardProps {
  path: string
  binary: BinaryFile
  /** Shows the file selected in the system's file manager; absent when the host cannot. */
  revealFile?: (path: string) => Promise<void>
  /** What a ZIP-built file holds; absent when the host cannot read it. */
  listArchive?: (path: string) => Promise<ArchiveListing>
}

/** A drive path as Windows writes it, for pasting into Explorer or a prompt; any other path as it is. */
export function nativePath(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\//g, "\\") : path
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function BinaryCard(props: BinaryCardProps) {
  const name = () => props.path.split(/[\\/]/).pop() ?? props.path
  const type = () => binaryType(props.path, props.binary.head)
  const family = () => FAMILY[type()]
  const modified = () =>
    props.binary.modified === undefined
      ? undefined
      : new Date(props.binary.modified).toLocaleString(locale() === "it" ? "it-IT" : "en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })
  /* What the last action did: «Copiato», or why it failed. */
  const [status, setStatus] = createSignal<string>()
  const reveal = () =>
    props.revealFile?.(props.path).then(
      () => setStatus(undefined),
      (error) => setStatus(messageOf(error)),
    )
  const copy = () =>
    navigator.clipboard.writeText(nativePath(props.path)).then(
      () => setStatus(t("pane.copied")),
      (error) => setStatus(messageOf(error)),
    )
  return (
    <div data-slot="file-view" data-kind="binary">
      <section data-slot="binary-card" data-type={type()}>
        <header data-slot="binary-head">
          <span data-slot="binary-icon" data-family={family()}>
            {ICONS[family()]()}
          </span>
          <div data-slot="binary-title">
            <h2 data-slot="binary-name" title={props.path}>
              {name()}
            </h2>
            <div data-slot="binary-type">{t(`file.type.${type()}`)}</div>
          </div>
        </header>
        <dl data-slot="binary-facts">
          <dt>{t("file.binary.size")}</dt>
          <dd data-slot="binary-size">{formatSize(props.binary.bytes, locale())}</dd>
          <Show when={modified()}>
            <dt>{t("file.binary.modified")}</dt>
            <dd data-slot="binary-modified">{modified()}</dd>
          </Show>
        </dl>
        {/* Never «Apri» or «Esegui»: the pane does not run what it shows. */}
        <div data-slot="binary-actions">
          <Show when={props.revealFile}>
            <button type="button" data-slot="binary-reveal" onClick={reveal}>
              {t("file.binary.reveal")}
            </button>
          </Show>
          <button type="button" data-slot="binary-copy" onClick={copy}>
            {t("file.binary.copyPath")}
          </button>
          <Show when={status()}>
            <span data-slot="binary-status" role="status">
              {status()}
            </span>
          </Show>
        </div>
        <p data-slot="binary-note">{t("file.binary.note")}</p>
        <Show when={isArchive(type()) && props.listArchive}>
          {(listArchive) => <ArchiveList path={props.path} listArchive={listArchive()} />}
        </Show>
      </section>
    </div>
  )
}
