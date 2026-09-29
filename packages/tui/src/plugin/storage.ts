import type { TuiMemoryEntry, TuiStoreEntry, TuiStorage } from "@nikcli-ai/plugin/tui"
import { mkdirSync, readFileSync, renameSync, watch, type FSWatcher } from "fs"
import { unlink } from "fs/promises"
import path from "path"
import { createStore, produce, reconcile } from "solid-js/store"
import { Global } from "@nikcli-ai/util/global"
import { Flock } from "@nikcli-ai/util/flock"
import { Log } from "@nikcli-ai/util/log"

const log = Log.create({ service: "tui.plugin.storage" })

/**
 * Ephemeral per-process plugin state.
 *
 * Entries are memoized here, above the plugin lifecycle, so a hot reload hands
 * the same live Solid store to the new generation: a plugin's in-memory state
 * (counters, drafts, caches) survives its own edit with no serialize/rehydrate
 * step. Everything is gone when the TUI exits.
 */
const memories = new Map<string, TuiMemoryEntry<object>>()

/**
 * Durable per-plugin state: one JSON file per key under the state directory.
 *
 * Like `memory`, entries are memoized above the plugin lifecycle, so a hot
 * reload keeps the same live store. Unlike `memory`, they survive a restart and
 * stay in sync across TUI instances: writes take a cross-process lock and the
 * directory is watched, so another instance's write is reconciled in.
 */
type StoredEntry = {
  readonly value: TuiStoreEntry<object>
  readonly reload: () => void
  /** Bytes loaded from disk or committed by the last successful write. */
  bytes: number
}

const stored = new Map<string, StoredEntry>()
const reservations = new Map<StoredEntry, Set<{ size: number }>>()
let watcher: FSWatcher | undefined

/**
 * Ceiling on what the durable plugin stores may retain, across every plugin.
 *
 * These maps are keyed `id.key` and lived above the plugin lifecycle, so before
 * this a plugin could grow a store without limit and nothing would ever notice
 * — the file watcher reloaded whatever was there. EOT-14 asks for bounded
 * stores, and the bound is on bytes because a store's size is set by the
 * plugin, not by the number of keys it happens to use.
 */
const MAX_STORE_BYTES = 32 * 1024 * 1024

function retainedBytes(replacement?: StoredEntry, bytes = 0) {
  let total = 0
  const entries = new Set([...stored.values(), ...reservations.keys()])
  for (const entry of entries) {
    let size = entry === replacement ? bytes : entry.bytes
    for (const reserved of reservations.get(entry) ?? []) size = Math.max(size, entry.bytes, reserved.size)
    total += size
  }
  return total
}

function directory() {
  return path.join(Global.Path.state, "tui", "plugin")
}

/** One filesystem-safe file name per plugin id + key pair. */
function fileName(id: string, key: string) {
  return `${`${id}.${key}`.replace(/[^A-Za-z0-9._-]/g, "-")}.json`
}

/**
 * Prefix shared by every store file belonging to `id`.
 *
 * `fileName` sanitises `id` and `key` together, but the `.` between them is
 * itself a legal filename character and survives, so the sanitised id followed
 * by a dot is a genuine prefix of every file this plugin owns. Building it from
 * `fileName(id, "")` instead would produce a double dot and match nothing.
 */
function idPrefix(id: string) {
  return `${id.replace(/[^A-Za-z0-9._-]/g, "-")}.`
}

function read(file: string) {
  try {
    const payload = readFileSync(file, "utf8")
    const raw = JSON.parse(payload) as unknown
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
    return {
      value: raw as Record<string, unknown>,
      bytes: Buffer.byteLength(payload),
    }
  } catch {
    // Missing, half-written, or corrupted: fall back to what we have.
    return
  }
}

function ensureWatcher(dir: string) {
  if (watcher) return
  try {
    watcher = watch(dir, () => {
      for (const entry of stored.values()) entry.reload()
    })
    watcher.on("error", () => {
      watcher?.close()
      watcher = undefined
    })
    watcher.unref?.()
  } catch {
    // Without a watcher the store still works, it just misses writes made by
    // another TUI instance.
  }
}

export function pluginStorage(id: string): TuiStorage {
  return {
    memory(key, options) {
      const full = `${id}.${key}`
      const existing = memories.get(full)
      if (existing) return existing as TuiMemoryEntry<typeof options.initial>

      const [store, setStore] = createStore(options.initial)
      const entry = [store, (mutation: (draft: typeof options.initial) => void) => setStore(produce(mutation))] as const
      memories.set(full, entry as TuiMemoryEntry<object>)
      return entry
    },
    store(key, options) {
      const dir = directory()
      const file = path.join(dir, fileName(id, key))
      const existing = stored.get(file)
      if (existing) return existing.value as TuiStoreEntry<typeof options.initial>

      mkdirSync(dir, { recursive: true })
      ensureWatcher(dir)

      const loaded = read(file)
      if (retainedBytes() + (loaded?.bytes ?? 0) > MAX_STORE_BYTES) {
        throw new Error(
          `plugin storage quota exhausted: loading ${file} would exceed the ${MAX_STORE_BYTES} byte budget`,
        )
      }
      const [store, setStore] = createStore<typeof options.initial>({
        ...options.initial,
        ...(loaded?.value as Partial<typeof options.initial> | undefined),
      })
      let reloadPending = false

      const flush = async () => {
        if (stored.get(file) !== tracked) throw new Error(`plugin storage entry was evicted: ${file}`)
        const payload = JSON.stringify(store, null, 2)
        const size = Buffer.byteLength(payload)
        // Refused, not silently dropped or silently evicted: EOT-14 requires
        // quota exhaustion to surface as a failure, and a store that quietly
        // stopped persisting is a plugin that appears to work and loses data
        // on restart. The in-memory value is already updated by the caller;
        // this is the durable write declining to grow without bound.
        if (retainedBytes(tracked, size) > MAX_STORE_BYTES) {
          log.error("plugin storage quota exhausted; write refused", {
            file,
            bytes: size,
            retained: retainedBytes(),
            budget: MAX_STORE_BYTES,
          })
          throw new Error(
            `plugin storage quota exhausted: writing ${size} bytes to ${file} would exceed the ${MAX_STORE_BYTES} byte budget`,
          )
        }
        // Reserve before the first await; other keys cannot spend this growth
        // while this write waits for its file lock. Shrinks free bytes at commit.
        const pending = reservations.get(tracked) ?? new Set<{ size: number }>()
        const reservation = { size }
        pending.add(reservation)
        reservations.set(tracked, pending)
        // Locked so two instances writing the same key cannot interleave, and
        // written through a temp file so a reader never sees partial JSON.
        let lease: Flock.Lease | undefined
        const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
        try {
          lease = await Flock.acquire(`tui-plugin-storage:${file}`, {
            timeoutMs: 5_000,
          })
          if (stored.get(file) !== tracked) throw new Error(`plugin storage entry was evicted: ${file}`)
          await Bun.write(temp, payload)
          if (stored.get(file) !== tracked) throw new Error(`plugin storage entry was evicted: ${file}`)
          // Keep the generation check and commit in one turn; eviction cannot
          // hand this path to a new entry while an asynchronous rename is pending.
          renameSync(temp, file)
          tracked.bytes = size
        } catch (error) {
          log.warn("failed to persist plugin storage", { file, error })
          throw error
        } finally {
          try {
            await unlink(temp).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT")
                log.warn("failed to remove plugin storage temporary file", {
                  file,
                  error,
                })
            })
            await lease?.release()
          } finally {
            pending.delete(reservation)
            if (!pending.size) {
              reservations.delete(tracked)
              if (reloadPending && stored.get(file) === tracked) tracked.reload()
            }
          }
        }
      }

      const entry = [
        store,
        async (mutation: (draft: typeof options.initial) => void) => {
          setStore(produce(mutation))
          await flush()
        },
      ] as const

      const tracked: StoredEntry = {
        value: entry as TuiStoreEntry<object>,
        bytes: loaded?.bytes ?? 0,
        reload: () => {
          if (reservations.has(tracked)) {
            reloadPending = true
            return
          }
          reloadPending = false
          const next = read(file)
          if (!next) return
          if (retainedBytes(tracked, next.bytes) > MAX_STORE_BYTES) {
            log.error("plugin storage quota exhausted; reload refused", {
              file,
              bytes: next.bytes,
            })
            return
          }
          setStore(
            reconcile({
              ...options.initial,
              ...(next.value as Partial<typeof options.initial>),
            }),
          )
          tracked.bytes = next.bytes
        },
      }
      stored.set(file, tracked)
      return entry
    },
  }
}

/**
 * Drops one plugin's stores, on removal rather than on every reload.
 *
 * Hot reload deliberately keeps them: `pluginStorage` memoizes above the
 * lifecycle precisely so a plugin's state survives its own edit. Uninstalling
 * is the point where the plugin is gone for good, and EOT-14 wants its entries
 * released then.
 */
export function evictPluginStorage(id: string) {
  for (const full of memories.keys()) {
    if (full.startsWith(`${id}.`)) memories.delete(full)
  }
  for (const file of stored.keys()) {
    // `stored` is keyed by full path, not by bare file name, so the prefix has
    // to be matched against the name within it.
    if (path.basename(file).startsWith(idPrefix(id))) stored.delete(file)
  }
}

/** Drops every memoized store. Only for shutdown and tests. */
export function clearPluginStorage() {
  memories.clear()
  stored.clear()
  watcher?.close()
  watcher = undefined
}
