import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js"
import type { GatewayPanelApi } from "./panel-state"
import { PLATFORM_IDS } from "./steps"

/**
 * How many pairing requests wait for the bot on all its platforms: the badge on the Platforms tab, seen from any tab
 * (the review, P2-P7). Read when the bot opens and again each time a request arrives (`gateway:pairing`); a platform
 * that cannot be read counts as none.
 */
export function createWaitingCount(
  api: GatewayPanelApi,
  path: Accessor<string>,
): { readonly count: Accessor<number>; readonly refresh: () => void } {
  const [count, setCount] = createSignal(0)
  let stale = 0

  const read = async (bot: string) => {
    const token = ++stale
    let total = 0
    for (const platform of PLATFORM_IDS) {
      try {
        total += (await api.pairingList(bot, platform)).pending.length
      } catch {
        // No badge for a platform that cannot be read.
      }
    }
    // Another bot was opened meanwhile: this answer is for the old one.
    if (token === stale) setCount(total)
  }

  createEffect(
    on(path, (bot) => {
      setCount(0)
      void read(bot)
    }),
  )

  let disposed = false
  let stop: (() => void) | undefined
  void api
    .listen({
      status: () => {},
      pairing: (request) => {
        if (request.bot === path()) void read(request.bot)
      },
      message: () => {},
    })
    .then((unlisten) => {
      if (disposed) unlisten()
      else stop = unlisten
    })
    .catch(() => {})
  onCleanup(() => {
    disposed = true
    stop?.()
  })

  // The user answered a request in the panel: nothing is emitted for that, so the page asks again when the tab changes.
  return { count, refresh: () => void read(path()) }
}
