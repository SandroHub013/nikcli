import path from "path"

/*
 * A test must never open the user's own database.
 *
 * `statement-cache` once did: it asked for the default database path, which on Windows is
 * `%LOCALAPPDATA%\nikcli\nikcli.db`, and ran the migrations against the file the user's
 * sessions live in. The test preload (`test/isolate.ts`) now points every data root at a
 * temporary home; this is the second line, for a test that resets the environment and lands
 * on a real folder anyway.
 *
 * It only acts under `NIKCLI_TEST_MODE`, and only when the preload has named the real folders
 * in `NIKCLI_TEST_FORBIDDEN_DIRS` (a release build has neither). The folders the tests may use
 * are `NIKCLI_TEST_ALLOWED_DIRS`: the temp folder is itself inside the real home on Windows, so
 * an allowed folder wins over the forbidden one that contains it.
 */

const windows = process.platform === "win32"

const normal = (value: string) => {
  const resolved = path.resolve(value)
  return windows ? resolved.toLowerCase() : resolved
}

function within(file: string, dir: string) {
  const relative = path.relative(dir, file)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function list(value: string | undefined) {
  return (value ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map(normal)
}

/** The real folder that holds `filename` while a test runs, or `undefined` when it is a place a test may use. */
export function realFolderOf(filename: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.NIKCLI_TEST_MODE !== "1" || filename === ":memory:") return undefined
  const file = normal(filename)
  if (list(env.NIKCLI_TEST_ALLOWED_DIRS).some((dir) => within(file, dir))) return undefined
  return list(env.NIKCLI_TEST_FORBIDDEN_DIRS).find((dir) => within(file, dir))
}

/** Throws before anything is created or opened when a test is about to use a real folder. */
export function assertNotARealFolder(filename: string, env: NodeJS.ProcessEnv = process.env): void {
  const folder = realFolderOf(filename, env)
  if (!folder) return
  throw new Error(
    `A test is about to open the user's real database: ${filename} is inside ${folder}. ` +
      `Tests keep their data in NIKCLI_TEST_HOME (test/isolate.ts sets it); ` +
      `do not clear it, and give a test that needs its own database a folder under the temp dir.`,
  )
}
