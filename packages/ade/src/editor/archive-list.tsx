/**
 * What a ZIP, APK, JAR or AAB holds, under the binary file card.
 *
 * The host reads the archive's central directory (`archive.rs`): nothing is
 * extracted, nothing is run. An APK also says who it is, from its manifest;
 * when that parse fails the block is simply not there.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js"
import {
  SHOWN_ENTRIES,
  formatSize,
  sortEntries,
  type AndroidManifest,
  type ArchiveListing,
  type SortKey,
  type SortOrder,
} from "./binary-file"
import { locale, t, type MessageKey } from "../i18n"

type State = { kind: "loading" } | { kind: "ready"; listing: ArchiveListing } | { kind: "failed"; reason: string }

/** The manifest's fields, in the order a person looks for them. */
const ANDROID_FIELDS: Array<[keyof AndroidManifest, MessageKey, string]> = [
  ["package", "file.android.package", "android-package"],
  ["versionName", "file.android.versionName", "android-version-name"],
  ["versionCode", "file.android.versionCode", "android-version-code"],
  ["minSdk", "file.android.minSdk", "android-min-sdk"],
  ["targetSdk", "file.android.targetSdk", "android-target-sdk"],
]

export function ArchiveList(props: { path: string; listArchive: (path: string) => Promise<ArchiveListing> }) {
  const [state, setState] = createSignal<State>({ kind: "loading" })
  createEffect(
    on(
      () => props.path,
      (path) => {
        setState({ kind: "loading" })
        props.listArchive(path).then(
          (listing) => {
            if (path === props.path) setState({ kind: "ready", listing })
          },
          (error) => {
            if (path === props.path) setState({ kind: "failed", reason: error instanceof Error ? error.message : String(error) })
          },
        )
      },
    ),
  )
  const listing = () => {
    const current = state()
    return current.kind === "ready" ? current.listing : undefined
  }

  // By path first; a size click starts from the largest, which is what a size column is opened for.
  const [order, setOrder] = createSignal<SortOrder>({ key: "path", descending: false })
  const sortBy = (key: SortKey) =>
    setOrder((current) =>
      current.key === key ? { key, descending: !current.descending } : { key, descending: key === "size" },
    )
  const ariaSort = (key: SortKey) =>
    order().key === key ? (order().descending ? "descending" : "ascending") : "none"
  const rows = createMemo(() => sortEntries(listing()?.entries ?? [], order()).slice(0, SHOWN_ENTRIES))
  const more = () => {
    const current = listing()
    return current ? current.total - Math.min(current.entries.length, SHOWN_ENTRIES) : 0
  }
  const count = (n: number) => n.toLocaleString(locale() === "it" ? "it-IT" : "en-US")
  const android = () => {
    const manifest = listing()?.android
    return manifest && ANDROID_FIELDS.some(([field]) => manifest[field]) ? manifest : undefined
  }

  return (
    <section data-slot="archive">
      <Switch>
        <Match when={state().kind === "loading"}>
          <div data-slot="archive-loading">{t("file.archive.loading")}</div>
        </Match>
        <Match when={state().kind === "failed"}>
          <div data-slot="archive-failed">
            {t("file.archive.failed", (state() as { reason: string }).reason)}
          </div>
        </Match>
        <Match when={listing()}>
          {(current) => (
            <>
              <Show when={android()}>
                {(manifest) => (
                  <dl data-slot="archive-android">
                    <For each={ANDROID_FIELDS.filter(([field]) => manifest()[field])}>
                      {([field, label, slot]) => (
                        <>
                          <dt>{t(label)}</dt>
                          <dd data-slot={slot}>{manifest()[field]}</dd>
                        </>
                      )}
                    </For>
                  </dl>
                )}
              </Show>
              <div data-slot="archive-count">{t("file.archive.count", count(current().total))}</div>
              <table data-slot="archive-table">
                <thead>
                  <tr>
                    <th aria-sort={ariaSort("path")}>
                      <button type="button" data-slot="archive-sort-path" onClick={() => sortBy("path")}>
                        {t("file.archive.path")}
                      </button>
                    </th>
                    <th aria-sort={ariaSort("size")} data-align="end">
                      <button type="button" data-slot="archive-sort-size" onClick={() => sortBy("size")}>
                        {t("file.binary.size")}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()}>
                    {(entry) => (
                      <tr data-slot="archive-row">
                        <td title={entry.path}>{entry.path}</td>
                        <td data-align="end">{formatSize(entry.size, locale())}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={more() > 0}>
                <div data-slot="archive-more">{t("file.archive.more", count(more()))}</div>
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </section>
  )
}
