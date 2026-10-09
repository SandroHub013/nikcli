import { spawn } from "child_process"
import { Shell } from "../../../src/shell/shell"

/**
 * A stand-in for ragu in the process-tree tests: it runs one command the way the tool bash and the monitor do (spawn, then
 * `Shell.adopt`), prints what happened, and stays alive until the test ends it, the way a real ragu is ended: with `taskkill /f`.
 *
 * argv: <address> <mode>
 *   long: the command keeps running (a long ping) after a middle `cmd` started an orphan ping on <address>
 *   background: the command leaves a ping on <address> in the background and ends by itself
 */
const [address, mode] = process.argv.slice(2)
const script =
  mode === "background"
    ? `cmd /c "start /b ping -n 600 ${address} > nul"`
    : `cmd /c "start /b ping -n 600 ${address} > nul" & ping -n 600 127.0.0.1 > nul`
const proc = spawn(script, { shell: true, windowsHide: true, stdio: "ignore" })
Shell.adopt(proc)
console.log(`started ${proc.pid}`)
proc.once("exit", () => console.log("command-exited"))
setInterval(() => {}, 1_000)
