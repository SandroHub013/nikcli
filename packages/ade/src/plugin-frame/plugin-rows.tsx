import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { t } from "../i18n"
import type { Host } from "../host/shell"
import { CATALOG, type CatalogEntry } from "./catalog"
import { pluginsChanged, pluginsRevision } from "./changes"
import { InstallConfirm } from "./install-confirm"
import { forgetPlugin, pluginBooks } from "./books"
import type { InstalledPlugin, PluginAvailable } from "./host-types"
import { markFramePlugins } from "./marker"
import { formatSize } from "./words"
import "./plugin-frame.css"

/**
 * The plugins in a frame, as rows in Estensioni › Plugin: what is installed (with what it weighs, and a discreet dot when an update is
 * waiting for the next opening), what the catalog offers, and the two questions ADE asks in its own DOM, install and uninstall.
 *
 * Loaded when the section is opened, not before: ADE with no plugin never reads their folder until then.
 */

type Confirming =
  | { kind: "install"; available: PluginAvailable; name: string }
  | { kind: "preview"; plugin: InstalledPlugin }
  | { kind: "uninstall"; plugin: InstalledPlugin }

export function FramePluginRows(props: {
  host: () => Promise<Host | undefined>
  onOpen: (id: string) => void
  /** What the catalog offers; the catalog of this build unless a test hands another. */
  catalog?: readonly CatalogEntry[]
}) {
  const books = pluginBooks()
  const [installed, setInstalled] = createSignal<InstalledPlugin[]>([])
  const [confirming, setConfirming] = createSignal<{ id: string; what: Confirming }>()
  const [busy, setBusy] = createSignal<string>()
  const [failure, setFailure] = createSignal<{ id: string; reason: string }>()
  const [progress, setProgress] = createSignal<{ id: string; percent: number }>()
  let alive = true
  onCleanup(() => (alive = false))

  const refresh = async () => {
    const host = await props.host()
    const all = (await host?.pluginList?.().catch(() => [])) ?? []
    if (!alive) return
    markFramePlugins(all.length > 0)
    setInstalled(all)
  }
  onMount(() => void refresh())
  createEffect(on(pluginsRevision, () => void refresh(), { defer: true }))

  const catalog = () => props.catalog ?? CATALOG
  const nameOf = (id: string) => catalog().find((entry) => entry.id === id)?.name ?? id
  const rows = () => {
    const have = new Set(installed().map((plugin) => plugin.id))
    return {
      installed: installed(),
      offered: catalog().filter((entry) => !have.has(entry.id)),
    }
  }
  const isTestBuild = () => document.documentElement.dataset.adeBuild === "test"

  /** «Installa» on a row: what the release says about it first, then the question. */
  const ask = async (entry: CatalogEntry) => {
    setBusy(entry.id)
    setFailure(undefined)
    try {
      const host = await props.host()
      if (!host?.pluginCheck) throw new Error("questo host non può installare plugin")
      const available = await host.pluginCheck(entry.id)
      setConfirming({ id: entry.id, what: { kind: "install", available, name: entry.name } })
    } catch (error) {
      setFailure({ id: entry.id, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(undefined)
    }
  }

  /** The yes: what was said yes to is written first, then the download, whose progress is read while it runs. */
  const install = async (available: PluginAvailable) => {
    setConfirming(undefined)
    setBusy(available.id)
    books.grants.accept(available.id, available.permissions)
    const host = await props.host()
    let poll: ReturnType<typeof setInterval> | undefined
    try {
      if (!host?.pluginInstall) throw new Error("questo host non può installare plugin")
      poll = setInterval(() => {
        void host.pluginStatus?.(available.id).then((status) => {
          if (alive && status.running && status.bytes_total > 0) setProgress({ id: available.id, percent: Math.floor((status.bytes_done / status.bytes_total) * 100) })
        })
      }, 500)
      await host.pluginInstall(available.id)
      pluginsChanged()
    } catch (error) {
      setFailure({ id: available.id, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      if (poll) clearInterval(poll)
      setProgress(undefined)
      setBusy(undefined)
      await refresh()
    }
  }

  const uninstall = async (plugin: InstalledPlugin) => {
    setConfirming(undefined)
    setBusy(plugin.id)
    try {
      const host = await props.host()
      await host?.pluginUninstall?.(plugin.id)
      forgetPlugin(plugin.id)
      // The panels that are open look again, and find nothing: they show the placeholder.
      pluginsChanged()
    } catch (error) {
      setFailure({ id: plugin.id, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(undefined)
      await refresh()
    }
  }

  const confirmation = (id: string) => {
    const current = confirming()
    return current?.id === id ? current.what : undefined
  }

  return (
    <Show when={rows().installed.length + rows().offered.length > 0}>
    <div data-slot="plugin-rows" data-count={installed().length}>
      <h4 data-slot="plugin-rows-heading">{t("plugin.rows.heading")}</h4>

      <For each={rows().installed}>
        {(plugin) => (
          <div data-slot="plugin-row" data-plugin={plugin.id} data-dev={plugin.dev ? "true" : undefined}>
            <span data-slot="plugin-row-name">
              {nameOf(plugin.id)}
              <Show when={plugin.pending}>
                <span
                  data-slot="plugin-row-update"
                  role="img"
                  title={t("plugin.rows.update", plugin.pending ?? "")}
                  aria-label={t("plugin.rows.update", plugin.pending ?? "")}
                />
              </Show>
            </span>
            <span data-slot="plugin-row-meta">
              {plugin.current ?? plugin.pending} · {formatSize(plugin.bytes)}
              <Show when={plugin.dev}> · {t("plugin.dev")}</Show>
            </span>
            <span data-slot="plugin-row-actions">
              <button type="button" data-slot="plugin-row-open" disabled={busy() === plugin.id} onClick={() => props.onOpen(plugin.id)}>
                {t("plugin.open")}
              </button>
              <Show when={!plugin.dev}>
                <button
                  type="button"
                  data-slot="plugin-row-uninstall"
                  disabled={busy() === plugin.id}
                  onClick={() => setConfirming({ id: plugin.id, what: { kind: "uninstall", plugin } })}
                >
                  {t("plugin.uninstall")}
                </button>
              </Show>
              <Show when={plugin.dev && isTestBuild()}>
                <button
                  type="button"
                  data-slot="plugin-row-preview-confirm"
                  onClick={() => setConfirming({ id: plugin.id, what: { kind: "preview", plugin } })}
                >
                  {t("plugin.confirm.preview")}
                </button>
              </Show>
            </span>
            <Show when={failure()?.id === plugin.id}>
              <span data-slot="plugin-row-meta" role="alert">
                {t("plugin.rows.failed", failure()!.reason)}
              </span>
            </Show>
            <Show when={confirmation(plugin.id)}>
              {(what) => (
                <div data-slot="plugin-row-confirm">
                  <Show when={what().kind === "uninstall"}>
                    <div data-slot="plugin-confirm" role="alertdialog">
                      <p data-slot="plugin-confirm-title">{t("plugin.uninstall.ask", nameOf(plugin.id), formatSize(plugin.bytes))}</p>
                      <div data-slot="plugin-confirm-actions">
                        <button type="button" data-slot="plugin-uninstall-yes" onClick={() => void uninstall(plugin)}>
                          {t("plugin.uninstall")}
                        </button>
                        <button type="button" data-slot="plugin-uninstall-cancel" onClick={() => setConfirming(undefined)}>
                          {t("plugin.uninstall.cancel")}
                        </button>
                      </div>
                    </div>
                  </Show>
                  <Show when={what().kind === "preview"}>
                    <InstallConfirm
                      name={nameOf(plugin.id)}
                      version={plugin.current ?? "?"}
                      sizeBytes={plugin.bytes}
                      permissions={plugin.permissions}
                      onConfirm={() => setConfirming(undefined)}
                      onCancel={() => setConfirming(undefined)}
                    />
                  </Show>
                </div>
              )}
            </Show>
          </div>
        )}
      </For>

      <For each={rows().offered}>
        {(entry) => (
          <div data-slot="plugin-row" data-plugin={entry.id} data-offered="true">
            <span data-slot="plugin-row-name">{entry.name}</span>
            <span data-slot="plugin-row-actions">
              <button type="button" data-slot="plugin-row-install" disabled={busy() === entry.id} onClick={() => void ask(entry)}>
                {busy() === entry.id ? t("plugin.installing") : t("plugin.install")}
                <Show when={progress()?.id === entry.id}> {progress()!.percent}%</Show>
              </button>
            </span>
            <Show when={failure()?.id === entry.id}>
              <span data-slot="plugin-row-meta" role="alert">
                {t("plugin.rows.failed", failure()!.reason)}
              </span>
            </Show>
            <Show when={confirmation(entry.id)}>
              {(what) => (
                <div data-slot="plugin-row-confirm">
                  <Show when={what().kind === "install" ? (what() as Extract<Confirming, { kind: "install" }>) : undefined}>
                    {(installing) => (
                      <InstallConfirm
                        name={installing().name}
                        version={installing().available.version}
                        sizeBytes={installing().available.size_bytes}
                        permissions={installing().available.permissions}
                        onConfirm={() => void install(installing().available)}
                        onCancel={() => setConfirming(undefined)}
                      />
                    )}
                  </Show>
                </div>
              )}
            </Show>
          </div>
        )}
      </For>
    </div>
    </Show>
  )
}
