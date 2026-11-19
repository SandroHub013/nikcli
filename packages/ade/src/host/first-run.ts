/**
 * Switches that show ADE's first-run cases in ADE Test, on a PC that already has everything.
 *
 * `bun run test:app --first-run=no-screenshots,no-agents,no-voice` puts the list in `ADE_TEST_FIRST_RUN` (read by the
 * Rust host, only in the test build: `src-tauri/src/first_run.rs`) and in `VITE_ADE_FIRST_RUN` (read here). The page
 * knows it is ADE Test from the mark `dev.tsx` writes from the identifier, the same one the voice settings read:
 * without that mark the list is empty, whatever the build was given.
 */

export const FIRST_RUN_SWITCHES = ["no-screenshots", "no-agents", "no-voice"] as const
export type FirstRunSwitch = (typeof FIRST_RUN_SWITCHES)[number]

export interface FirstRunParse {
  switches: FirstRunSwitch[]
  /** What was written and is not a switch, as written. */
  unknown: string[]
}

/** A comma list (`all` is every switch); spaces and case do not matter, order and repeats do not either. */
export function parseFirstRun(value: string | undefined): FirstRunParse {
  const wanted = new Set<FirstRunSwitch>()
  const unknown: string[] = []
  for (const raw of (value ?? "").split(",")) {
    const item = raw.trim().toLowerCase()
    if (!item) continue
    if (item === "all") for (const name of FIRST_RUN_SWITCHES) wanted.add(name)
    else if ((FIRST_RUN_SWITCHES as readonly string[]).includes(item)) wanted.add(item as FirstRunSwitch)
    else unknown.push(raw.trim())
  }
  return { switches: FIRST_RUN_SWITCHES.filter((name) => wanted.has(name)), unknown }
}

/** The page, in the test build only: the strict mark, not `testBuildMarked`, which also counts an identifier it could not read. */
export const markedAsTest = (root: HTMLElement | undefined = globalThis.document?.documentElement): boolean =>
  root?.dataset.adeBuild === "test"

/** The switches the page honours: none unless the host marked this as ADE Test. */
export function pageFirstRun(
  value: string | undefined = import.meta.env?.VITE_ADE_FIRST_RUN as string | undefined,
  testBuild: boolean = markedAsTest(),
): FirstRunSwitch[] {
  return testBuild ? parseFirstRun(value).switches : []
}

/** A storage with nothing in it and no way to keep anything: a profile that has never been opened. */
export function emptyStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

/**
 * Where the voice settings are read from and saved to: `undefined` is the profile's own storage, and with `no-voice`
 * one empty storage in memory for this run, so a change made in the settings never reaches the stored profile.
 * One call per page: the load and every save must use the same one.
 */
export function voiceStorageFor(switches: readonly FirstRunSwitch[]): Storage | undefined {
  return switches.includes("no-voice") ? emptyStorage() : undefined
}
