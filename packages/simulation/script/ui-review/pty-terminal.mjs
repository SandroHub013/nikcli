// Opens the ragu TUI from source in a real ConPTY, once per terminal profile, and
// records what it writes: truecolor vs 256-colour sequences, whether it asks the
// terminal for its background (OSC 11), how long it waits, and what it prints after
// exit. Run with node, not bun: under bun the ConPTY child dies at once.
//
//   node script/ui-review/pty-terminal.mjs <out-dir> <work-dir>
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "../../../..")
const ragu = join(repo, "packages/ragu")
const require = createRequire(import.meta.url)
const pty = require(join(repo, "node_modules/.bun/node-pty@1.1.0/node_modules/node-pty/lib/index.js"))
const [outArg, workArg] = process.argv.slice(2)
if (!outArg || !workArg) throw new Error("usage: pty-terminal.mjs <out-dir> <work-dir>")
const out = resolve(outArg)
const work = resolve(workArg)
const project = join(work, "project")
for (const dir of [out, project, join(work, "tmp")]) mkdirSync(dir, { recursive: true })
writeFileSync(join(project, "README.md"), "# demo\n")
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const profiles = [
  { name: "truecolor", env: { TERM: "xterm-256color", COLORTERM: "truecolor" } },
  { name: "256", env: { TERM: "xterm-256color", COLORTERM: "" } },
  { name: "no-color", env: { TERM: "xterm-256color", COLORTERM: "truecolor", NO_COLOR: "1" } },
]

const count = (text, pattern) => (text.match(pattern) ?? []).length
const report = []
for (const profile of profiles) {
  const home = join(work, `home-${profile.name}`)
  const env = {
    ...process.env,
    ...profile.env,
    TMP: join(work, "tmp"),
    TEMP: join(work, "tmp"),
    RAGU_TEST_HOME: home,
    RAGU_DISABLE_PROJECT_CONFIG: "1",
    RAGU_DISABLE_DEFAULT_PLUGINS: "1",
    RAGU_DISABLE_LSP_DOWNLOAD: "1",
    RAGU_DISABLE_AUTOUPDATE: "1",
    RAGU_DISABLE_EDITOR_CONTEXT: "1",
    RAGU_CONFIG_CONTENT: JSON.stringify({ autoupdate: false }),
  }
  for (const key of Object.keys(profile.env)) if (profile.env[key] === "") delete env[key]
  const started = Date.now()
  const term = pty.spawn(process.env.BUN_EXE ?? "bun.exe", ["run", "--conditions=browser", "./src/index.ts", project], {
    name: profile.env.TERM,
    cols: 100,
    rows: 32,
    cwd: ragu,
    env,
  })
  let data = ""
  let firstQuery = -1
  let firstPaint = -1
  term.onData((chunk) => {
    data += chunk
    if (firstQuery < 0 && data.includes("\x1b]11;?")) firstQuery = Date.now() - started
    if (firstPaint < 0 && /Ask anything|Chiedi qualsiasi/.test(data.replace(/[[0-9;?]*[A-Za-z]/g, ""))) firstPaint = Date.now() - started
  })
  let exited = false
  term.onExit(() => (exited = true))
  // taskkill, not term.kill(): node-pty's console-list agent dies with "AttachConsole failed".
  const stop = () => { try { execFileSync("taskkill", ["/T", "/F", "/PID", String(term.pid)], { stdio: "ignore" }) } catch {} }
  const killer = setTimeout(stop, 90_000)
  for (let i = 0; i < 120 && firstPaint < 0 && !exited; i++) await sleep(500)
  await sleep(2500)
  const before = data.length
  term.write("\x10") // ctrl+p: the palette, painted after the first frame
  await sleep(1500)
  term.write("\x1b")
  await sleep(800)
  term.write("\x03")
  await sleep(500)
  term.write("\x03")
  for (let i = 0; i < 20 && !exited; i++) await sleep(500)
  if (!exited) stop()
  clearTimeout(killer)
  const tail = data
    .slice(-4000)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
  const row = {
    profile: profile.name,
    bytes: data.length,
    afterFirstFrame: data.length - before,
    truecolor: count(data, /\x1b\[[0-9;]*[34]8;2;/g),
    ansi256: count(data, /\x1b\[[0-9;]*[34]8;5;/g),
    osc11Query: firstQuery,
    firstPaintMs: firstPaint,
    cleanExit: exited,
  }
  report.push(row)
  console.log(JSON.stringify(row))
  writeFileSync(join(out, `pty-${profile.name}.raw.txt`), data)
  writeFileSync(join(out, `pty-${profile.name}.exit.txt`), tail)
}
writeFileSync(join(out, "pty-terminal.json"), JSON.stringify(report, null, 1))
process.exit(0)
