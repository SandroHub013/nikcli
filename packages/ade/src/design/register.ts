import { createMemo, createSignal, type Accessor } from "solid-js"
import { every } from "../host/every"
import type { DirEntry } from "../host/shell"
import type { DesignEvent } from "./log"
import { foldProposals, type DesignState } from "./state"
import { appendDesignEvent, loadDesign, type DesignIo, type LoadedRegister } from "./store"
import { t } from "../i18n"

export const REGISTER_WATCH_MS = 2500

export interface DesignRegisterDeps {
  path: Accessor<string | undefined>
  io: () => Promise<(DesignIo & { readDir?: (path: string) => Promise<DirEntry[]> }) | undefined>
}

export interface DesignRegister {
  readonly path: Accessor<string | undefined>
  readonly loaded: Accessor<LoadedRegister | undefined>
  readonly state: Accessor<DesignState | undefined>
  readonly error: Accessor<string | undefined>
  refresh: () => Promise<void>
  append: (event: DesignEvent) => Promise<void>
  watch: () => () => void
}

export function createDesignRegister(deps: DesignRegisterDeps): DesignRegister {
  const [loaded, setLoaded] = createSignal<LoadedRegister>()
  const [error, setError] = createSignal<string>()
  const state = createMemo(() => {
    const register = loaded()
    return register ? foldProposals(register.events) : undefined
  })
  let loadedPath: string | undefined
  let stamp: string | undefined

  const stampOf = async (path: string): Promise<string | undefined> => {
    const io = await deps.io()
    if (!io?.readDir) return undefined
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    const dir = path.slice(0, slash)
    const name = path.slice(slash + 1)
    const entries = await io.readDir(dir).catch(() => [] as DirEntry[])
    const entry = entries.find((item) => item.name === name)
    return entry ? `${entry.size}:${entry.modified_ms}` : "assente"
  }

  const refresh = async () => {
    const path = deps.path()
    if (!path) {
      loadedPath = undefined
      stamp = undefined
      setLoaded(undefined)
      setError(undefined)
      return
    }
    const io = await deps.io()
    if (!io) return
    try {
      const nextStamp = await stampOf(path)
      const register = await loadDesign(io, path)
      if (deps.path() !== path) return
      loadedPath = path
      stamp = nextStamp
      setLoaded(register)
      setError(undefined)
    } catch (failure) {
      if (deps.path() === path) setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const append = async (event: DesignEvent) => {
    const path = deps.path()
    const io = await deps.io()
    if (!path || !io) throw new Error(t("design.noProject.short"))
    await appendDesignEvent(io, path, event)
    await refresh()
  }

  const tick = async () => {
    const path = deps.path()
    if (path !== loadedPath) return refresh()
    if (!path) return
    const next = await stampOf(path)
    if (next === undefined || next !== stamp) await refresh()
  }

  return {
    path: deps.path,
    loaded,
    state,
    error,
    refresh,
    append,
    watch: () => every(REGISTER_WATCH_MS, tick, { immediate: true }),
  }
}
