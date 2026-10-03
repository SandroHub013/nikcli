import { createNikcliClient } from "@nikcli-ai/sdk/httpapi"
import type { ModSource, ModSurface } from "@nikcli-ai/ui/mod-tree-model"
import { createMemo, type Accessor } from "solid-js"
import { useGlobalSDK } from "./global-sdk"
import { usePlatform } from "./platform"

/**
 * Where this window reaches the mods of one project.
 *
 * Mods are plugins that run in the nikcli server, per project, and draw on request. This binds a
 * client to the project's directory and listens to that project's `mod.ui.*` events, which is how a
 * mod edited on disk reaches the window: the server reloads it and publishes an invalidation. The
 * window says which `surface` it is, so the same mod that draws a row for the terminal can draw a
 * block for the desktop.
 */
export function useModSource(
  directory: Accessor<string | undefined>,
  surface: Exclude<ModSurface, "terminal" | "mobile"> = "desktop",
): Accessor<ModSource | undefined> {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()

  return createMemo<ModSource | undefined>(() => {
    const dir = directory()
    if (!dir) return undefined
    const client = createNikcliClient({
      baseUrl: globalSDK.url,
      fetch: platform.fetch,
      directory: dir,
      throwOnError: true,
    })
    return {
      surface,
      list: async () =>
        (await client.mod.list()).data?.map((mod) => ({
          ...mod,
          events: [...mod.events],
          tools: [...mod.tools],
          commands: [...mod.commands],
        })),
      panes: async () => (await client.mod.panes()).data?.map((pane) => ({ ...pane })),
      render: async (input) =>
        (
          await client.mod.render({
            component: input.component,
            requestId: input.requestId,
            sessionID: input.sessionID,
            props: JSON.stringify(input.props ?? {}),
            surface,
          })
        ).data,
      event: async (input) => (await client.mod.event(input)).data,
      subscribe: (listener) =>
        globalSDK.event.on(dir, (event) => {
          if (event.type.startsWith("mod.ui.")) {
            listener({ type: event.type, properties: event.properties as Record<string, unknown> })
          }
        }),
    }
  })
}
