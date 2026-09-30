/**
 * What a plugin may do, and what the user has said yes to.
 *
 * A manifest names the permissions its version asks for. The user accepts them in ADE's own DOM when installing (`InstallConfirm`), and ADE
 * keeps what was accepted apart from the plugin: in its own storage, keyed by plugin id, never in the plugin's folder (a plugin cannot widen
 * its own grant by rewriting a file). What a running plugin is granted is the permissions of its installed manifest that were accepted; one
 * the user never accepted is not granted, whatever the manifest says.
 *
 * An update that asks for a permission more than was accepted does not switch on by itself: it stays `pending` and asks again.
 */

import { isPermission, knownPermissions, type Permission } from "./api"
import { newSalt } from "./bridge"

/** The subset of `Storage` these books use, so a test can hand in a map. */
export interface BookStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export const GRANTS_KEY = "ade.plugin-grants"
export const REJECTED_KEY = "ade.plugin-rejected"
export const SALTS_KEY = "ade.plugin-salts"
export const UNCONFIRMED_KEY = "ade.plugin-unconfirmed"

type Book<T> = { [id: string]: T }

/** A book with no prototype: an id of `__proto__` or `constructor` is a key like any other. */
const emptyBook = <T>(): Book<T> => Object.create(null) as Book<T>

function readRecord<T>(storage: BookStorage | undefined, key: string, keep: (value: unknown) => T | undefined): Book<T> {
  const out = emptyBook<T>()
  let raw: string | null = null
  try {
    raw = storage?.getItem(key) ?? null
  } catch {
    return out
  }
  if (!raw) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out
  for (const [id, value] of Object.entries(parsed)) {
    const kept = keep(value)
    if (kept !== undefined) out[id] = kept
  }
  return out
}

function writeRecord(storage: BookStorage | undefined, key: string, value: Book<unknown>): void {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: what was accepted is asked again next time, which is the safe way to lose it.
  }
}

const keepPermissions = (value: unknown): Permission[] | undefined =>
  Array.isArray(value) ? knownPermissions(value) : undefined

/** The permissions the user accepted for each plugin. */
export function createGrantBook(storage: BookStorage | undefined) {
  return {
    accepted(id: string): Permission[] {
      return readRecord(storage, GRANTS_KEY, keepPermissions)[id] ?? []
    },
    /** The user said yes to `permissions` for `id`: what was accepted before stays accepted (an update adds, never takes away). */
    accept(id: string, permissions: readonly string[]): void {
      const all = readRecord(storage, GRANTS_KEY, keepPermissions)
      all[id] = [...new Set([...(all[id] ?? []), ...knownPermissions(permissions)])]
      writeRecord(storage, GRANTS_KEY, all)
    },
    forget(id: string): void {
      const all = readRecord(storage, GRANTS_KEY, keepPermissions)
      delete all[id]
      writeRecord(storage, GRANTS_KEY, all)
    },
  }
}
export type GrantBook = ReturnType<typeof createGrantBook>

/** What a running plugin is granted: what its manifest asks for and the user accepted. */
export function grantedFor(manifest: readonly string[], accepted: readonly Permission[]): Permission[] {
  const asked = new Set(knownPermissions(manifest))
  return accepted.filter((permission) => asked.has(permission))
}

/** What a manifest asks for that was not accepted: the words of the question when a version asks for more. Unknown names are not permissions. */
export function addedPermissions(manifest: readonly string[], accepted: readonly Permission[]): Permission[] {
  return knownPermissions(manifest).filter((permission) => !accepted.includes(permission))
}

/** A manifest that names something ADE does not know: shown as it is, and granting nothing. */
export function unknownPermissions(manifest: readonly string[]): string[] {
  return [...new Set(manifest.filter((name) => !isPermission(name)))]
}

/** The versions that did not answer `ready` and were taken back: not offered again. */
export function createRejectedBook(storage: BookStorage | undefined) {
  const keep = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length <= 64) : undefined
  return {
    has(id: string, version: string): boolean {
      return readRecord(storage, REJECTED_KEY, keep)[id]?.includes(version) ?? false
    },
    add(id: string, version: string): void {
      const all = readRecord(storage, REJECTED_KEY, keep)
      const known = all[id] ?? []
      if (!known.includes(version)) all[id] = [...known, version].slice(-8)
      writeRecord(storage, REJECTED_KEY, all)
    },
    forget(id: string): void {
      const all = readRecord(storage, REJECTED_KEY, keep)
      delete all[id]
      writeRecord(storage, REJECTED_KEY, all)
    },
  }
}
export type RejectedBook = ReturnType<typeof createRejectedBook>

/** A version that was switched on and has not yet said `ready`: what `activation.ts` needs to go on watching it if the panel was closed. */
export interface Unconfirmed {
  version: string
  /** There was an earlier version to go back to. */
  hadEarlier: boolean
}

/**
 * The version each plugin has that was committed and never said `ready`.
 *
 * Closing the panel within `READY_MS` of a commit cancels the clock, and the new version stays `current` without having proved it starts. This
 * book is what lets the next opening take up the watch again (and roll back if the version still does not answer). `ready` clears it.
 */
export function createUnconfirmedBook(storage: BookStorage | undefined) {
  const keep = (value: unknown): Unconfirmed | undefined => {
    if (!value || typeof value !== "object") return undefined
    const { version, hadEarlier } = value as Record<string, unknown>
    return typeof version === "string" && version.length > 0 && version.length <= 64 && typeof hadEarlier === "boolean" ? { version, hadEarlier } : undefined
  }
  return {
    get(id: string): Unconfirmed | undefined {
      return readRecord(storage, UNCONFIRMED_KEY, keep)[id]
    },
    set(id: string, version: string, hadEarlier: boolean): void {
      const all = readRecord(storage, UNCONFIRMED_KEY, keep)
      all[id] = { version, hadEarlier }
      writeRecord(storage, UNCONFIRMED_KEY, all)
    },
    clear(id: string): void {
      const all = readRecord(storage, UNCONFIRMED_KEY, keep)
      if (!(id in all)) return
      delete all[id]
      writeRecord(storage, UNCONFIRMED_KEY, all)
    },
  }
}
export type UnconfirmedBook = ReturnType<typeof createUnconfirmedBook>

/** The salt each plugin's project ids are made with: made once, kept, and the plugin's alone. */
export function createSaltBook(storage: BookStorage | undefined, make: () => string = newSalt) {
  const keep = (value: unknown): string | undefined => (typeof value === "string" && value.length >= 16 ? value : undefined)
  return {
    of(id: string): string {
      const all = readRecord(storage, SALTS_KEY, keep)
      const known = all[id]
      if (known) return known
      const fresh = make()
      all[id] = fresh
      writeRecord(storage, SALTS_KEY, all)
      return fresh
    },
    forget(id: string): void {
      const all = readRecord(storage, SALTS_KEY, keep)
      delete all[id]
      writeRecord(storage, SALTS_KEY, all)
    },
  }
}

/** What a check offers, unless it is a version that was already taken back. */
export function offerable<T extends { version: string; update: boolean }>(available: T, rejected: (version: string) => boolean): T | undefined {
  return available.update && !rejected(available.version) ? available : undefined
}

/** The i18n key that says what a permission lets the plugin do, in plain words. */
export function permissionKey(permission: Permission): string {
  return `plugin.permission.${permission}`
}
