import { isTestIdentifier } from "./build-identity"

/**
 * The OpenRouter key for the voice, taken from nikcli's `auth.json` when the
 * profile has none.
 *
 * Never under the test identity (ADE Test, `ai.nikcli.ade.test`): every new
 * ADE Test profile starts without a key, so each one received the user's paid
 * key, and a voice test spent real money. The identity is asked before the
 * file is even read. An identity that cannot be asked counts as the test one:
 * the copy is a convenience, spending the user's money by mistake is not.
 */
export interface KeySyncDeps {
  /** The app's identifier (Tauri's `getIdentifier`). */
  identifier: () => Promise<string>
  homeDir: () => Promise<string | undefined>
  readTextFile: (path: string, maxBytes: number) => Promise<{ text: string } | undefined>
  save: (key: string) => Promise<void>
}

export type KeySyncOutcome = "copied" | "test-identity" | "not-found"

/** Where nikcli keeps `auth.json`, on each system, in the spellings the host may need. */
export function authCandidates(home: string): string[] {
  const normalizedHome = home.replace(/\\/g, "/")
  return [
    `${normalizedHome}/AppData/Local/nikcli/auth.json`,
    `${home}/AppData/Local/nikcli/auth.json`,
    `${home}\\AppData\\Local\\nikcli\\auth.json`,
    `${normalizedHome}/AppData/Roaming/nikcli/auth.json`,
    `${home}/AppData/Roaming/nikcli/auth.json`,
    `${home}\\AppData\\Roaming\\nikcli\\auth.json`,
    `${normalizedHome}/.config/nikcli/auth.json`,
    `${normalizedHome}/.nikcli/auth.json`,
  ]
}

export async function syncOpenRouterKey(deps: KeySyncDeps): Promise<KeySyncOutcome> {
  const identifier = await deps.identifier().catch(() => undefined)
  if (identifier === undefined || isTestIdentifier(identifier)) return "test-identity"
  const home = await deps.homeDir().catch(() => undefined)
  if (!home) return "not-found"
  for (const authPath of authCandidates(home)) {
    try {
      const file = await deps.readTextFile(authPath, 64 * 1024)
      if (!file?.text) continue
      const key = JSON.parse(file.text)?.openrouter?.key
      if (typeof key === "string" && key.trim().length > 0) {
        await deps.save(key.trim())
        return "copied"
      }
    } catch {
      // The next place.
    }
  }
  return "not-found"
}
