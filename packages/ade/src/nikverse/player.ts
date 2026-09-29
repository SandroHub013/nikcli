/**
 * Where the user's character stands, as ADE keeps it.
 *
 * The frame is unloaded after five minutes without being seen and its own
 * storage is not to be relied on (its origin is opaque and changes nothing that
 * ADE keeps), so the world tells ADE where the character is and ADE gives it
 * back when the world says `ready`. Kept in ADE's own storage, with a copy in
 * memory for when storage is not there (a private window, blocked data).
 */

/** The character's place on the ground and the way it faces. */
export interface PlayerSpot {
  x: number
  z: number
  heading: number
}

/** Farther than this from the square is not a place in the city. */
export const MAX_DISTANCE = 1000

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

/** A spot from anything the world (or storage) may hand over, or nothing if it is not one. */
export function readSpot(raw: unknown): PlayerSpot | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const { x, z, heading } = raw as Record<string, unknown>
  if (!finite(x) || !finite(z) || !finite(heading)) return undefined
  if (Math.abs(x) > MAX_DISTANCE || Math.abs(z) > MAX_DISTANCE || Math.abs(heading) > 100) return undefined
  return { x, z, heading }
}

export const PLAYER_KEY = "ade.nikverse.player"

/** What the store needs of `localStorage`. */
export interface SpotStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function createPlayerStore(storage?: SpotStorage) {
  let spot: PlayerSpot | undefined
  let read = false
  return {
    /** The last place the character stood at, or nothing on a first visit. */
    load(): PlayerSpot | undefined {
      if (read) return spot
      read = true
      try {
        const text = storage?.getItem(PLAYER_KEY)
        if (text) spot = readSpot(JSON.parse(text))
      } catch {
        /* storage may throw, or hold something else: no saved place */
      }
      return spot
    },
    save(next: PlayerSpot): void {
      const clean = readSpot(next)
      if (!clean) return
      spot = clean
      read = true
      try {
        storage?.setItem(PLAYER_KEY, JSON.stringify(clean))
      } catch {
        /* the copy in memory still holds it for this session */
      }
    },
  }
}
