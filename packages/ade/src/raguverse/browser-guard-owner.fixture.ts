// A script that owns a stand-in browser and ends the way the test says: `exit`, `throw`, `hang` (waits to be killed hard) or `close`.
// A `+launcher` after the mode makes the stand-in hand over to a real one and exit, as Edge's launcher does.
import { join } from "node:path"
import { guardBrowser, newProfile } from "./browser-guard"

const [mode, dir] = [process.argv[2].split("+")[0], process.argv[3]]
const launcher = process.argv[2].includes("+launcher")
const profile = newProfile(dir)
const started = Bun.spawn(
  [process.execPath, join(import.meta.dir, "browser-guard-dummy.fixture.ts"), `--user-data-dir=${profile}`, ...(launcher ? ["--launcher"] : [])],
  { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
)
const guard = guardBrowser({ profile, program: "bun" })
console.log(`launched ${started.pid} profile ${profile}`)
// Long enough for the test to see the stand-in alive before this script acts on it.
if (mode !== "hang") await Bun.sleep(3000)
if (mode === "exit") process.exit(0)
if (mode === "throw") throw new Error("the script fails with the browser open")
if (mode === "close") {
  guard.stop()
  process.exit(0)
}
setInterval(() => {}, 1000)
