/**
 * The diagnostic checks behind `ragu doctor`.
 *
 * Their own module because the HTTP route `server/httpapi/doctor.ts` runs them
 * too: a server reaching into a CLI command's file to borrow a function is how
 * `cli/cmd/**` stopped being a leaf directory. Self-contained — no shared state,
 * no `process.exit` — so either caller can use it.
 */
import { Installation } from "@/installation"
import { Global } from "@ragu/util/global"
import { configFile as userConfigFile } from "@ragu/util/app-folder"
import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import { statfsSync } from "fs"
import path from "path"

export type CheckResult = { ok: boolean; label: string; detail?: string; fix?: string }

type Record = (ok: boolean, label: string, detail?: string, fix?: string) => void

function makeRecorder(results: CheckResult[]): Record {
  return (ok, label, detail, fix) => {
    results.push(
      detail !== undefined ? (fix !== undefined ? { ok, label, detail, fix } : { ok, label, detail }) : { ok, label },
    )
  }
}

/**
 * Run all diagnostic checks and return the structured results. Self-contained
 * (no shared state, no process.exit) so it can be reused by the HTTP route as
 * well as the CLI command.
 */
export async function runDoctorChecks(): Promise<{ ok: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = []
  const record = makeRecorder(results)
  checkVersion(record)
  checkNode(record)
  checkTty(record)
  checkPath(record)
  checkDisk(record)
  await checkConfig(record)
  await checkDeprecatedConfigKeys(record)
  checkServer(record)
  return { ok: results.every((r) => r.ok), results }
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

function checkVersion(record: Record) {
  record(true, "Version", `${Installation.VERSION} (${Installation.CHANNEL})`)
}

function checkNode(record: Record) {
  record(true, "Runtime", `Bun ${typeof Bun !== "undefined" ? Bun.version : process.version}`)
}

function checkTty(record: Record) {
  const tty = Boolean(process.stdout.isTTY)
  record(tty, "TTY", tty ? "stdout is a terminal" : "stdout is not a terminal — TUI features will be limited")
}

function checkPath(record: Record) {
  // `Installation.Path.bin` resolves to the directory holding the current
  // executable. If it isn't on $PATH, a shell will not find `ragu`.
  try {
    const execDir = path.dirname(process.execPath)
    const onPath = (process.env.PATH ?? "").split(path.delimiter).some((p) => p === execDir)
    record(
      onPath,
      "PATH",
      onPath ? `exec dir (${execDir}) is on $PATH` : `exec dir (${execDir}) is NOT on $PATH`,
      onPath ? undefined : `Add ${execDir} to your PATH, or put this build in a folder that is already on it.`,
    )
  } catch (err) {
    record(false, "PATH", `could not resolve exec dir: ${err instanceof Error ? err.message : "unknown"}`)
  }
}

function checkDisk(record: Record) {
  try {
    const target = Global.Path.state
    const stat = statfsSync(target)
    const free = stat.bavail * stat.bsize
    const total = stat.blocks * stat.bsize
    const freePct = total > 0 ? (free / total) * 100 : 0
    const ok = freePct > 5 // less than 5% free is concerning
    record(
      ok,
      "Disk",
      `${bytes(free)} free of ${bytes(total)} at ${target} (${freePct.toFixed(1)}%)`,
      ok ? undefined : `Free up some space — ragu caches prompts in ${target}.`,
    )
  } catch (err) {
    record(false, "Disk", `statfs failed: ${err instanceof Error ? err.message : "unknown"}`)
  }
}

/**
 * Parses a config file the way the loader does (`config/config.ts`): JSONC, with comments and trailing commas.
 * A plain `JSON.parse` called a file with a comment broken, and a user who followed its advice lost the config.
 */
export function parseConfigText(text: string): { data: unknown } | { error: string } {
  const errors: JsoncParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length === 0) return { data }
  const first = errors[0]!
  const line = text.substring(0, first.offset).split("\n").length
  return { error: `${printParseErrorCode(first.error)} at line ${line}` }
}

async function checkConfig(record: Record) {
  try {
    // Best-effort: a real config-schema validation needs an instance context.
    // We just check the raw file for now — the full validation runs on
    // the next `ragu` invocation.
    const fs = await import("fs")
    // The file `Config.global()` loads: `ragu.json`, else `nikcli.json` (rule B).
    const configFile = userConfigFile(Global.Path.config)
    if (!fs.existsSync(configFile)) {
      // The user-level loader reads `<stem>.json` only; `ragu.jsonc` is read inside a project folder, not here.
      const jsonc = path.join(Global.Path.config, "ragu.jsonc")
      if (fs.existsSync(jsonc)) {
        record(
          false,
          "Config",
          `${jsonc} is not read: ragu loads the user config from ragu.json (ragu.jsonc only inside a project folder)`,
          `Rename ${jsonc} to ragu.json; comments are allowed there.`,
        )
        return
      }
      record(true, "Config", "no user config file (defaults in use)")
      return
    }
    const parsed = parseConfigText(fs.readFileSync(configFile, "utf-8"))
    if ("error" in parsed) {
      record(
        false,
        "Config",
        `${configFile} is not valid JSON: ${parsed.error}`,
        `Fix the syntax at that line (comments and trailing commas are allowed). Do not delete the file: it holds your settings.`,
      )
    } else {
      record(true, "Config", `${configFile} parses as JSON`)
    }
  } catch (err) {
    record(false, "Config", `unexpected error: ${err instanceof Error ? err.message : "unknown"}`)
  }
}

async function checkDeprecatedConfigKeys(record: Record) {
  // Known renames / removals per the integration-master-plan and ux-roadmap.
  const deprecated: Array<{ from: string; to?: string; since?: string }> = [
    { from: "keybinds", to: "keymappings", since: "ux-roadmap E5" },
  ]
  try {
    const fs = await import("fs")
    // The file `Config.global()` loads: `ragu.json`, else `nikcli.json` (rule B).
    const configFile = userConfigFile(Global.Path.config)
    if (!fs.existsSync(configFile)) {
      record(true, "Deprecated keys", "no user config file — nothing to check")
      return
    }
    const parsed = parseConfigText(fs.readFileSync(configFile, "utf-8"))
    // The Config check above has already said what is wrong with the syntax.
    if ("error" in parsed) return
    const data = parsed.data
    const found: string[] = []
    for (const item of deprecated) {
      if (data && typeof data === "object" && item.from in data) found.push(item.from)
    }
    if (found.length === 0) {
      record(true, "Deprecated keys", "none found")
    } else {
      record(
        false,
        "Deprecated keys",
        `Found: ${found.join(", ")}. ${deprecated
          .filter((d) => found.includes(d.from))
          .map((d) => `${d.from} → ${d.to ?? "(removed)"} (${d.since ?? ""})`)
          .join("; ")}.`,
        "Rename the keys in your config file. See the ux-roadmap and integration-master-plan for details.",
      )
    }
  } catch {
    // Config-check already reported the JSON error; nothing to add.
  }
}

function checkServer(record: Record) {
  // Best-effort: a running ragu server in the current directory is a good
  // sign. We don't fail if it's not running — many workflows (one-shot `run`,
  // upgrade, doctor itself) don't need it.
  const port = process.env.RAGU_PORT ?? "0"
  record(true, "Server", port !== "0" ? `RAGU_PORT=${port}` : "no server required for `ragu doctor`")
}
