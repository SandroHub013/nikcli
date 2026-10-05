import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useHostEvents } from "@/hooks/use-host-events"
import { answerFrom, invalidates, isModEvent, type ModAnswer, type ModEvents, type ModPane } from "@/lib/mod-tree"
import { useServer } from "@/lib/server-context"
import type { HostEvent } from "@/lib/types"

/**
 * One connection to the mods for everything on a screen.
 *
 * Mods live in the nikcli server and draw on request, so a screen that shows several of their panes
 * would otherwise open one event stream per pane, and a phone only gets a handful of simultaneous
 * connections to one host. The host keeps a single `/mobile/events` stream, tells every `ModSite` below
 * it when its drawing may have changed, and keeps the pane list and "does any mod draw at all" current.
 * A mod that is edited on disk reloads on the server and reaches the phone through the same events.
 */

type Listener = (event: HostEvent) => void

type ModHostValue = {
  /** Whether a mod is loaded that hooks `ui.render`. Without one, sites do not ask. */
  hooked: boolean
  panes: ModPane[]
  /** Only `true` once the first answer arrived, so a screen can tell "none" from "not yet". */
  ready: boolean
  subscribe: (listener: Listener) => () => void
  render: (input: {
    component: string
    requestId: string
    sessionID?: string
    props?: Record<string, unknown>
  }) => Promise<ModAnswer>
  events: (site: { component: string; requestId: string; sessionID?: string }) => ModEvents
}

const ModHostContext = createContext<ModHostValue | null>(null)

export function useModHost(): ModHostValue {
  const value = useContext(ModHostContext)
  if (!value) throw new Error("useModHost needs a <ModHost> above it")
  return value
}

export function ModHost({ children }: { children: ReactNode }) {
  const { client, config } = useServer()
  const [hooked, setHooked] = useState(false)
  const [panes, setPanes] = useState<ModPane[]>([])
  const [ready, setReady] = useState(false)
  const listeners = useRef(new Set<Listener>())

  const loadHooked = useCallback(async () => {
    if (!client) return
    const mods = await client.modList().catch(() => undefined)
    if (mods) setHooked(mods.some((mod) => mod.events.includes("ui.render")))
  }, [client])

  const loadPanes = useCallback(async () => {
    if (!client) return
    const next = await client.modPanes().catch(() => undefined)
    if (next) setPanes(next)
  }, [client])

  useEffect(() => {
    setReady(false)
    if (!client) {
      setHooked(false)
      setPanes([])
      return
    }
    let active = true
    void Promise.all([loadHooked(), loadPanes()]).then(() => {
      if (active) setReady(true)
    })
    return () => {
      active = false
    }
  }, [client, loadHooked, loadPanes])

  useHostEvents({
    config,
    enabled: Boolean(client),
    onEvent: (event) => {
      if (!isModEvent(event)) return
      if (event.type === "mod.ui.panes") void loadPanes()
      // An untargeted invalidation is a mod loading, reloading or unloading.
      if (event.type === "mod.ui.invalidate" && !event.properties?.component && !event.properties?.requestID) {
        void loadHooked()
        void loadPanes()
      }
      for (const listener of listeners.current) listener(event)
    },
  })

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  const render = useCallback<ModHostValue["render"]>(
    async (input) => {
      if (!client) return undefined
      const out = await client.modRender(input).catch(() => undefined)
      return answerFrom(out)
    },
    [client],
  )

  const events = useCallback<ModHostValue["events"]>(
    (site) => ({
      press: (key) => void client?.modEvent({ kind: "press", key, ...site }).catch(() => undefined),
      input: (key, value, submit) =>
        void client?.modEvent({ kind: "input", key, value, submit, ...site }).catch(() => undefined),
      select: (key, value) => void client?.modEvent({ kind: "select", key, value, ...site }).catch(() => undefined),
    }),
    [client],
  )

  const value = useMemo<ModHostValue>(
    () => ({ hooked, panes, ready, subscribe, render, events }),
    [hooked, panes, ready, subscribe, render, events],
  )

  return <ModHostContext.Provider value={value}>{children}</ModHostContext.Provider>
}

/**
 * The mods' answer for one render site, asked again whenever a mod invalidates it. `always` asks even
 * when no mod is known to draw (panes and the band are drawn by mods alone, so there the answer is the
 * only thing there is).
 */
export function useModSite(site: {
  component: string
  requestId: string
  sessionID?: string
  props?: Record<string, unknown>
  always?: boolean
}) {
  const host = useModHost()
  const [answer, setAnswer] = useState<ModAnswer>(undefined)
  const sequence = useRef(0)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const propsKey = JSON.stringify(site.props ?? {})
  const { component, requestId, sessionID, always } = site
  const asks = always || host.hooked

  const refresh = useCallback(async () => {
    if (!asks) {
      setAnswer(undefined)
      return
    }
    const mine = ++sequence.current
    const next = await host.render({ component, requestId, sessionID, props: JSON.parse(propsKey) })
    // A newer request is in flight: this answer is already out of date.
    if (mine === sequence.current) setAnswer(next)
  }, [asks, host.render, component, requestId, sessionID, propsKey])

  useEffect(() => {
    void refresh()
    return () => {
      sequence.current++
    }
  }, [refresh])

  useEffect(() => {
    const off = host.subscribe((event) => {
      if (!invalidates(event, { component, requestId })) return
      if (settle.current) return
      // Mods invalidate in bursts; draw once.
      settle.current = setTimeout(() => {
        settle.current = undefined
        void refresh()
      }, 30)
    })
    return () => {
      off()
      if (settle.current) clearTimeout(settle.current)
      settle.current = undefined
    }
  }, [host.subscribe, component, requestId, refresh])

  const events = useMemo(
    () => host.events({ component, requestId, sessionID }),
    [host.events, component, requestId, sessionID],
  )

  return { answer, events }
}
