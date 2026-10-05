/**
 * The project's mods, drawn in ADE.
 *
 * A mod is a plugin that runs in the nikcli server and answers "what do I draw here?" with a tree of
 * plain data. The terminal draws that tree with cells, the phone with native views, and ADE with the
 * DOM — from the same mod, which is told it is drawing for the `ade` surface and can answer with a
 * layout made for a window like this one. Edit the mod on disk and the server reloads it; the
 * invalidation that follows redraws it here without a restart.
 *
 * ADE does not run that server for every folder, and a mod is code that runs in it. So nothing is
 * asked until the user connects: `openChat` admits the folder first, with the same question and the
 * same remembered answer as the chat and the bots. A no is final for that folder.
 *
 * Like the plugin manager, it is a v2 plugin that registers a pane, a sidebar section and a command.
 */
import { batch, createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Plugin } from "@nikcli-ai/plugin/v2/ade"
import { ModSite, type ModInfo, type ModPane } from "@nikcli-ai/ui/mod-tree"
import "@nikcli-ai/ui/mod-tree.css"
import { appChatConnectionDeps, openChat, type ChatConnection } from "../../chat/connection"
import { t } from "../../i18n"
import { adeModSource, type AdeModSource } from "./mods-source"
import "./mods.css"

export const MODS_ID = "ade.mods"

type Status = "idle" | "connecting" | "ready" | "failed"

export function createModsPlugin(options: { connect?: (directory: string) => Promise<ChatConnection> } = {}) {
  const connect = options.connect ?? ((directory: string) => openChat(directory, appChatConnectionDeps()))

  return Plugin.define({
    id: MODS_ID,
    setup(context) {
      const root = () => context.data.project()?.root
      const [status, setStatus] = createSignal<Status>("idle")
      const [source, setSource] = createSignal<AdeModSource | undefined>(undefined)
      const [mods, setMods] = createSignal<ModInfo[]>([])
      const [panes, setPanes] = createSignal<ModPane[]>([])
      let owner: string | undefined
      let attempt = 0

      const load = async () => {
        const current = source()
        if (!current) return
        const [nextMods, nextPanes] = await Promise.all([
          current.list().catch(() => undefined),
          current.panes().catch(() => undefined),
        ])
        // The folder changed while this was in flight: it is another folder's answer.
        if (current !== source()) return
        batch(() => {
          setMods(nextMods ?? [])
          setPanes(nextPanes ?? [])
        })
      }

      const disconnect = () => {
        attempt++
        source()?.close()
        owner = undefined
        batch(() => {
          setSource(undefined)
          setMods([])
          setPanes([])
          setStatus("idle")
        })
      }

      const open = async () => {
        const directory = root()
        if (!directory || status() === "connecting") return
        const mine = ++attempt
        setStatus("connecting")
        const connection = await connect(directory).catch((): ChatConnection => ({ ok: false }))
        // Another connect or a disconnect came after this one.
        if (mine !== attempt) {
          if (connection.ok) adeModSource(connection).close()
          return
        }
        if (!connection.ok) return setStatus("failed")
        const next = adeModSource(connection)
        owner = directory
        batch(() => {
          setSource(next)
          setStatus("ready")
        })
        await load()
      }

      const Body = (props: { surface: "pane" | "section" }) => {
        // Another folder is another server instance with other mods: start over, ask again.
        createEffect(
          on(root, (directory) => {
            if (owner !== undefined && owner !== directory) disconnect()
          }),
        )
        createEffect(() => {
          const current = source()
          if (!current) return
          const off = current.subscribe((event) => {
            if (event.type === "mod.ui.panes") return void load()
            // An untargeted invalidation is a mod loading, reloading or unloading.
            if (event.type === "mod.ui.invalidate" && !event.properties?.component && !event.properties?.requestID) {
              void load()
            }
          })
          onCleanup(off)
        })

        return (
          <div data-component="ade-mods" data-surface={props.surface}>
            <Show when={root()} fallback={<p data-slot="mods-note">{t("mods.noProject")}</p>}>
              <Show
                when={status() === "ready"}
                fallback={
                  <>
                    <p data-slot="mods-note">{status() === "failed" ? t("mods.failed") : t("mods.explain")}</p>
                    <button
                      type="button"
                      data-slot="mods-connect"
                      disabled={status() === "connecting"}
                      onClick={() => void open()}
                    >
                      {status() === "connecting" ? t("mods.connecting") : t("mods.connect")}
                    </button>
                  </>
                }
              >
                <ModSite source={source()} component="AbovePrompt" requestId="band" />
                <For each={panes()}>
                  {(pane) => (
                    <ModSite
                      source={source()}
                      component="Pane"
                      requestId={pane.id}
                      title={pane.title}
                      extra={{ title: pane.title, placement: pane.placement }}
                    />
                  )}
                </For>
                <Show when={mods().length > 0} fallback={<p data-slot="mods-note">{t("mods.none")}</p>}>
                  <ul data-slot="mods-list">
                    {/* Text nodes: the name comes from a plugin on disk. */}
                    <For each={mods()}>{(mod) => <li>{mod.name}</li>}</For>
                  </ul>
                </Show>
              </Show>
            </Show>
          </div>
        )
      }

      context.ui.pane.register({
        name: "overview",
        title: t("mods.pane"),
        render: () => <Body surface="pane" />,
      })

      context.ui.section.register({
        name: "mods",
        title: t("mods.title"),
        render: () => <Body surface="section" />,
      })

      context.ui.command.register({
        id: "overview",
        title: t("mods.command"),
        group: t("mods.title"),
        keywords: ["plugin", "estensioni", "mod", "pannelli"],
        run: () => {
          // One tile, not one per invocation.
          if (context.ui.pane.list().some((pane) => pane.name === "overview")) return
          context.ui.pane.open({ name: "overview" })
        },
      })

      return () => {
        attempt++
        source()?.close()
      }
    },
  })
}
