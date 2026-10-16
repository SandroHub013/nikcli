/**
 * nikcli became ragu, and a user's folders and config files keep their old names until `ragu migrate` moves
 * them. Rule B, as the CLI applies it (`packages/util/src/app-folder.ts`, which ADE cannot import): the ragu
 * one if it exists, else the nikcli one. With neither there yet, the old name, which is where a CLI of before
 * the rename and this one both look.
 *
 * Every reader asks here; every guard that protects ragu's configuration knows both names.
 */
export const CONFIG_STEMS = ["ragu", "nikcli"] as const
export const DOT_FOLDERS = [".ragu", ".nikcli"] as const

/**
 * Folders where a write turns into a command run later, by git, an editor, CI or the next agent session
 * (review B3, M1; review of the bots, S2): hooks, tasks, workflows, and the settings and plugins of Claude Code, ragu
 * and Codex. One list for every runner: `runners.ts` refuses them to Claude, `serve-rules.ts` to ragu.
 */
export const EXECUTES_LATER = [".git", ".claude", ...DOT_FOLDERS, ".codex", ".husky", ".vscode", ".github/workflows"] as const

/** Every name a project's config file has: the root's and the one in its dot folder. */
export const CONFIG_FILE_NAMES = CONFIG_STEMS.flatMap((stem) => [`${stem}.json`, `${stem}.jsonc`])

/** Whether a path exists; ADE asks the host, so it is a promise, and a refusal counts as no. */
export type Exists = (path: string) => Promise<boolean>

async function first(base: string, names: readonly string[], exists: Exists): Promise<string> {
  const root = base.replace(/[\\/]+$/, "")
  for (const name of names) if (await exists(`${root}/${name}`).catch(() => false)) return name
  return names[names.length - 1]!
}

/** `.ragu` or `.nikcli`: the name of the project's own folder under `base`. */
export function dotFolderName(base: string, exists: Exists): Promise<string> {
  return first(base, DOT_FOLDERS, exists)
}

/** `ragu` or `nikcli`: the name of the platform folder under `base` (APPDATA, XDG). */
export function appFolderName(base: string, exists: Exists): Promise<string> {
  return first(base, CONFIG_STEMS, exists)
}

/** A host's `readDir` as an `Exists` for folders. */
export function folderExists(readDir: ((path: string) => Promise<unknown>) | undefined): Exists {
  return (path) => (readDir ? readDir(path).then(() => true, () => false) : Promise.resolve(false))
}
