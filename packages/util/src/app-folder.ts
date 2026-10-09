import { existsSync } from "fs"
import path from "path"

/**
 * nikcli became ragu, and a user's folders and config files keep their old names until `ragu migrate` moves
 * them. Rule B: the ragu one if it exists, else the nikcli one, and never a copy (a user's data folder is
 * gigabytes). With neither there yet, the old name, so a CLI of before the rename and this one share it.
 *
 * Every reader asks here; every guard that protects a user's configuration knows both names
 * (CONFIG_STEMS, DOT_FOLDERS).
 */
export const CONFIG_STEMS = ["ragu", "nikcli"] as const
export const DOT_FOLDERS = [".ragu", ".nikcli"] as const
export type ConfigStem = (typeof CONFIG_STEMS)[number]

type Exists = (file: string) => boolean

function first(base: string, names: readonly string[], exists: Exists) {
  const found = names.find((name) => exists(path.join(base, name)))
  return path.join(base, found ?? names[names.length - 1]!)
}

/** `<base>/ragu` or `<base>/nikcli`: a platform folder (XDG, APPDATA, LOCALAPPDATA). */
export function appFolder(base: string, exists: Exists = existsSync) {
  return first(base, CONFIG_STEMS, exists)
}

/** `<base>/.ragu` or `<base>/.nikcli`: the home folder and a project's own. */
export function dotFolder(base: string, exists: Exists = existsSync) {
  return first(base, DOT_FOLDERS, exists)
}

/** The stem of the config file in `dir`: `ragu` when `ragu.json` or `ragu.jsonc` is there, else `nikcli`. */
export function configStem(dir: string, exists: Exists = existsSync): ConfigStem {
  return exists(path.join(dir, "ragu.jsonc")) || exists(path.join(dir, "ragu.json")) ? "ragu" : "nikcli"
}

/** `<dir>/ragu.json` or `<dir>/nikcli.json`, by [`configStem`]. */
export function configFile(dir: string, exists: Exists = existsSync) {
  return path.join(dir, `${configStem(dir, exists)}.json`)
}

/** Every name a user's config file has, for the guards that protect them. */
export const CONFIG_FILES = CONFIG_STEMS.flatMap((stem) => [`${stem}.json`, `${stem}.jsonc`])

/** Whether `dir` is a `.ragu` or `.nikcli` folder. */
export function isDotFolder(dir: string) {
  return (DOT_FOLDERS as readonly string[]).includes(path.basename(dir))
}

const OLD_TO_NEW: Record<string, string> = { ".nikcli": ".ragu", "nikcli.json": "ragu.json", "nikcli.jsonc": "ragu.jsonc" }

/**
 * Rule B on a list of found paths: an old one (`.nikcli`, `nikcli.json(c)`) goes when its new sibling is in the
 * list too. The order is kept.
 */
export function preferNew(paths: readonly string[]) {
  const all = new Set(paths)
  return paths.filter((p) => {
    const renamed = OLD_TO_NEW[path.basename(p)]
    return !renamed || !all.has(path.join(path.dirname(p), renamed))
  })
}
