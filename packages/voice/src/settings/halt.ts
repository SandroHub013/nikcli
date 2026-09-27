/**
 * Listening that stopped itself, written down so it survives a restart.
 *
 * The brakes on spending — the cap on requests an hour, half an hour with
 * nobody calling, a key that is refused — stop listening until the user turns
 * it back on. Kept only in memory, closing ADE was a way of clearing them:
 * the next launch opened the microphone again and went on spending.
 *
 * What is stored is why it stopped and when, so the reason can still be read
 * on the screen the next morning. It stays until the user opens the
 * microphone by hand.
 */

export const VOICE_HALT_STORAGE_KEY = "voice.listenHalt"

export interface ListenHalt {
  /** Why listening stopped, in the words the user was shown. */
  readonly reason: string
  /** When it stopped, as epoch milliseconds. */
  readonly at: number
}

/** A stored halt, or nothing when there is none or it cannot be read. */
export function readHalt(raw: string | null): ListenHalt | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<ListenHalt>
    if (typeof parsed?.reason !== "string" || parsed.reason.trim().length === 0) return undefined
    return { reason: parsed.reason, at: typeof parsed.at === "number" ? parsed.at : 0 }
  } catch {
    return undefined
  }
}

export interface HaltStore {
  /** What stopped listening, if anything did and nobody has started it since. */
  read(): ListenHalt | undefined
  /** Remembers that listening stopped itself, and why. */
  write(halt: ListenHalt): void
  /** The user has started it again. */
  clear(): void
}

/** The store, in the browser's storage; without one it still works for this run. */
export function createHaltStore(storage: Storage | null): HaltStore {
  let halt: ListenHalt | undefined
  try {
    halt = readHalt(storage?.getItem(VOICE_HALT_STORAGE_KEY) ?? null)
  } catch {
    halt = undefined
  }
  const save = () => {
    try {
      if (halt) storage?.setItem(VOICE_HALT_STORAGE_KEY, JSON.stringify(halt))
      else storage?.removeItem(VOICE_HALT_STORAGE_KEY)
    } catch {
      // A storage that refuses must not stop the voice from working.
    }
  }
  return {
    read: () => halt,
    write(next: ListenHalt): void {
      halt = next
      save()
    },
    clear(): void {
      if (!halt) return
      halt = undefined
      save()
    },
  }
}
