// Does the TUI quit from the keyboard, and what does it leave on the terminal?
// One ConPTY run: esc (closes onboarding), ctrl+c twice, then ctrl+x q if still up.
//
//   node script/ui-review/pty-exit.mjs <out-dir> <work-dir>
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "../../../..")
const require = createRequire(import.meta.url)
const pty = require(join(repo, "node_modules/.bun/node-pty@1.1.0/node_modules/node-pty/lib/index.js"))
const [outArg, workArg] = process.argv.slice(2)
const out = resolve(outArg)
const work = resolve(workArg)
const project = join(work, "project")
for (const dir of [out, project, join(work, "tmp")]) mkdirSync(dir, { recursive: true })
writeFileSync(join(project, "README.md"), "# demo\n")
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const plain = (text) =>
  text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "").replace(/\x1b[=>]/g, "")

const env = {
  ...process.env,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  TMP: join(work, "tmp"),
  TEMP: join(work, "tmp"),
  RAGU_TEST_HOME: join(work, "home"),
  RAGU_DISABLE_PROJECT_CONFIG: "1",
  RAGU_DISABLE_DEFAULT_PLUGINS: "1",
  RAGU_DISABLE_LSP_DOWNLOAD: "1",
  RAGU_DISABLE_AUTOUPDATE: "1",
  RAGU_DISABLE_EDITOR_CONTEXT: "1",
  RAGU_CONFIG_CONTENT: JSON.stringify({ autoupdate: false }),
}
const term = pty.spawn(process.env.BUN_EXE, ["run", "--conditions=browser", "./src/index.ts", project], {
  name: "xterm-256color",
  cols: 100,
  rows: 32,
  cwd: join(repo, "packages/ragu"),
  env,
})
let data = ""
let exited = false
const marks = []
const mark = (label) => marks.push({ label, at: data.length })
term.onData((chunk) => (data += chunk))
term.onExit(() => (exited = true))
const waitExit = async (ms) => {
  for (let i = 0; i < ms / 250 && !exited; i++) await sleep(250)
  return exited
}
await sleep(12_000)
mark("boot")
term.write("\x1b")
await sleep(1200)
mark("esc")
term.write("\x03")
await sleep(700)
mark("ctrl+c 1")
term.write("\x03")
const byCtrlC = await waitExit(10_000)
mark("ctrl+c 2")
let byLeader = false
if (!byCtrlC) {
  term.write("\x18")
  await sleep(200)
  term.write("q")
  byLeader = await waitExit(10_000)
  mark("ctrl+x q")
}
if (!exited) execFileSync("taskkill", ["/T", "/F", "/PID", String(term.pid)], { stdio: "ignore" })
const pieces = marks.map((m, i) => `--- ${m.label}\n${plain(data.slice(i ? marks[i - 1].at : 0, m.at)).slice(-1500)}`)
writeFileSync(join(out, "pty-exit.txt"), [`ctrl+c twice exits: ${byCtrlC}`, `ctrl+x q exits: ${byLeader}`, ...pieces, `--- after\n${plain(data.slice(marks.at(-1).at))}`].join("\n"))
console.log(JSON.stringify({ byCtrlC, byLeader }))
process.exit(0)
