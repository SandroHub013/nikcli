/*
 * Runs before anything else in the test preload: no test may reach the user's
 * own data folders.
 *
 * `Global.Path` takes its roots from `NIKCLI_TEST_HOME` when it is set, and from
 * LOCALAPPDATA / APPDATA (Windows) or XDG_* (elsewhere) when it is not. Nothing
 * in the preload set it, so a test that did not set it itself — `statement-cache`
 * called `Database.rawSql(...)` — opened `%LOCALAPPDATA%\nikcli\nikcli.db`, the
 * user's real database, and ran migrations against it.
 *
 * So the whole run gets one temporary home, and every platform root is pointed
 * into it. This file has to be the first import of the preload: `@nikcli-ai/util/global`
 * reads LOCALAPPDATA, APPDATA and XDG_* when it is evaluated.
 *
 * The real folders are kept in `NIKCLI_TEST_FORBIDDEN_DIRS`, and the temp folder in
 * `NIKCLI_TEST_ALLOWED_DIRS`, for the guard in `src/database/test-guard.ts`: a test that
 * resets `NIKCLI_TEST_HOME` and still lands in a real folder fails at once, with a message.
 */
import fs from "fs"
import os from "os"
import path from "path"
import { removeTestDirSync } from "./helpers/fs"

const forbidden = [process.env.LOCALAPPDATA, process.env.APPDATA, process.env.USERPROFILE, process.env.HOME, os.homedir()]
  .filter((dir): dir is string => !!dir)
  .map((dir) => path.resolve(dir))

// The real roots are kept from the first load only: a nested process inherits the
// redirected environment, and its "real" folders would be the temporary ones.
if (!process.env.NIKCLI_TEST_FORBIDDEN_DIRS) {
  process.env.NIKCLI_TEST_FORBIDDEN_DIRS = [...new Set(forbidden)].join(path.delimiter)
}
process.env.NIKCLI_TEST_ALLOWED_DIRS ??= path.resolve(os.tmpdir())

const PREFIX = "nikcli-test-home-"
const STALE_MS = 6 * 60 * 60 * 1000

if (!process.env.NIKCLI_TEST_HOME) {
  // `bun test` fires neither "exit" nor "beforeExit", so the folder of the run before this
  // one is still there: sweep the ones nobody can still be using.
  try {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (!entry.startsWith(PREFIX)) continue
      const old = path.join(os.tmpdir(), entry)
      if (Date.now() - fs.statSync(old).mtimeMs > STALE_MS) removeTestDirSync(old)
    }
  } catch {}
  const home = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  process.env.NIKCLI_TEST_HOME = home
  // Where the runtime does fire it: databases may still be open on Windows, so it is retried, then left to the sweep.
  process.on("exit", () => removeTestDirSync(home))
}

const home = process.env.NIKCLI_TEST_HOME

// The test home is a place a test may use even when it sits inside a forbidden folder: a CI that sets
// NIKCLI_TEST_HOME to its own temp folder (`${runner.temp}`, under HOME on Linux and macOS) while os.tmpdir()
// is elsewhere would otherwise fail every test that opens a database.
process.env.NIKCLI_TEST_ALLOWED_DIRS = [
  ...new Set([...process.env.NIKCLI_TEST_ALLOWED_DIRS!.split(path.delimiter).filter(Boolean), path.resolve(home)]),
].join(path.delimiter)

const roots = {
  LOCALAPPDATA: path.join(home, "os", "LocalAppData"),
  APPDATA: path.join(home, "os", "AppData"),
  XDG_DATA_HOME: path.join(home, "xdg", "data"),
  XDG_CACHE_HOME: path.join(home, "xdg", "cache"),
  XDG_CONFIG_HOME: path.join(home, "xdg", "config"),
  XDG_STATE_HOME: path.join(home, "xdg", "state"),
} as const
for (const [key, value] of Object.entries(roots)) process.env[key] = value
