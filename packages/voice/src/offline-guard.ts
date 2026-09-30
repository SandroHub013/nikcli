import { afterAll } from "bun:test"

/**
 * The suite never goes to the network: preloaded by `bunfig.toml` before every
 * test run.
 *
 * A voice test that reached OpenRouter got a 401 from a key nobody meant to
 * use, waited on someone else's service, and passed or failed on latency
 * instead of on what it was testing — and the credit check, which swallows its
 * own errors, did it silently fifteen times a run.
 *
 * Every remote request is refused here, before it leaves, and recorded: the
 * test that made it fails on the refusal unless it swallows it, and `afterAll`
 * reads the record once the run is over, so an attempt made anywhere in the
 * suite turns it red either way.
 */

const attempts: string[] = []

declare global {
  /** The guard the preload installed, so a test can tell it from its own import. */
  // eslint-disable-next-line no-var
  var __offlineGuard: { attempts: string[]; ignoreLast(count?: number): void }
}

const original = globalThis.fetch.bind(globalThis)

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  if (typeof Request !== "undefined" && input instanceof Request) return input.url
  return String(input)
}

function isRemote(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  return parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]"
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = urlOf(input)
  if (!isRemote(url)) return original(input, init)
  attempts.push(url)
  throw new Error(`questa suite non deve andare in rete: ${url}`)
}) as typeof fetch

export const offlineGuard = {
  /** Every request this suite tried to make while the guard was armed. */
  attempts,
  /** Drops the last `count` entries: the probe `offline.test.ts` makes on purpose. */
  ignoreLast(count = 1): void {
    attempts.splice(Math.max(0, attempts.length - count), count)
  },
}

globalThis.__offlineGuard = offlineGuard

afterAll(() => {
  if (attempts.length === 0) return
  throw new Error(`${attempts.length} richieste di rete nella suite: ${attempts.join(", ")}`)
})
