import { isTestIdentifier } from "./build-identity"
import { CONFIG_STEMS } from "../bots/app-folder"

/**
 * The OpenRouter key for the voice, taken from ragu's `auth.json` when the
 * keychain has none. `save` writes it into the keychain, as the «OpenRouter»
 * entry of the Chiavi API page (S6), never into browser storage.
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
  removed: () => boolean
}

export type KeySyncOutcome = "copied" | "removed" | "test-identity" | "not-found"

/** Where ragu keeps `auth.json`, on each system, in the spellings the host may need. */
export function authCandidates(home: string): string[] {
  const normalizedHome = home.replace(/\\/g, "/")
  // Rule B (`bots/app-folder.ts`): in each place the ragu folder first, then the nikcli one.
  const inEach = (paths: (name: string) => string[]) => CONFIG_STEMS.flatMap(paths)
  return [
    ...inEach((name) => [
      `${normalizedHome}/AppData/Local/${name}/auth.json`,
      `${home}/AppData/Local/${name}/auth.json`,
      `${home}\\AppData\\Local\\${name}\\auth.json`,
    ]),
    ...inEach((name) => [
      `${normalizedHome}/AppData/Roaming/${name}/auth.json`,
      `${home}/AppData/Roaming/${name}/auth.json`,
      `${home}\\AppData\\Roaming\\${name}\\auth.json`,
    ]),
    // macOS and Linux: ragu's data folder is `$XDG_DATA_HOME/ragu`, `~/.local/share/nikcli` by default (`packages/util/src/global.ts`);
    // without this the copy never found the file there (full review 2026-10-06, sessions). The two below it are older guesses.
    ...inEach((name) => [`${normalizedHome}/.local/share/${name}/auth.json`]),
    ...inEach((name) => [`${normalizedHome}/.config/${name}/auth.json`]),
    `${normalizedHome}/.nikcli/auth.json`,
  ]
}

export async function syncOpenRouterKey(deps: KeySyncDeps): Promise<KeySyncOutcome> {
  const identifier = await deps.identifier().catch(() => undefined)
  if (identifier === undefined || isTestIdentifier(identifier)) return "test-identity"
  if (deps.removed()) return "removed"
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
