/*
 * Drives an open ADE Test window from the terminal: types into a pane as the
 * user would, reads what its terminal shows, reads ADE's notes, takes a
 * screenshot. It is how S70 (native mail between two Claude sessions) was
 * proven live, and the live run found four defects no reading of the code had.
 *
 * Typical use, from this worktree:
 *
 *   bun run test:app --cdp                      opens ADE Test with remote debugging
 *   bun scripts/drive-test-app.ts panes         which panes are open, by index
 *   bun scripts/drive-test-app.ts type 1 'Esegui: ade-msg ask 2 "rispondi PRONTA"'
 *   bun scripts/drive-test-app.ts text 2        the visible rows of pane 2's terminal
 *   bun scripts/drive-test-app.ts notes 2       ADE's own notes in pane 2 ("Consegna nativa…")
 *   bun scripts/drive-test-app.ts shot out.png
 *   bun run test:app stop
 *
 * How it finds the window: `test:app --cdp` writes the remote-debugging port
 * in `<worktree>/.ade-test/record.json`; this script reads it, or `CDP_PORT`
 * when set. Each worktree has its own instance and its own port (dev port +
 * 4000, see `host/test-app.ts`), so run it from the worktree whose ADE Test
 * you mean. If nothing answers on the port it says so and exits 1 within a
 * few seconds; it never waits for a window to appear.
 *
 * It drives ADE Test only. Before any command it asks the page for its build
 * mark (`data-ade-build="test"`, set by `dev.tsx` from the Tauri identifier)
 * and refuses anything else, so the official ADE cannot be driven by mistake
 * even if remote debugging happened to be open on it. A window still on its
 * splash has no mark yet: the script waits for it up to fifteen seconds and
 * says so if it never comes, which is not the same message as another ADE.
 *
 * Two things that cost half an hour to whoever does not know them:
 *   - a change to the Rust sources does not reach the open window: stop and
 *     restart (`test:app stop`, then `test:app --cdp`), about three minutes;
 *     a change to the TypeScript is picked up by Vite without a restart, but
 *     the workbench state is lost and the panes come back through restore;
 *   - the panes are real sessions on the user's subscription: a Claude pane
 *     that is asked to do something spends real turns. Ask for little, and
 *     read the outcome with `text`/`notes` rather than asking the model.
 *
 * `text` reads xterm's rendered rows: the Claude Code interface keeps its own
 * screen, so only what is visible comes back, not the scrollback. `notes`
 * reads ADE's transcript beside the terminal, which is where delivery notes
 * and receipts are.
 */

import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

import {
  BUILD_CHECK,
  BUILD_WAIT_MS,
  CONNECT_TIMEOUT_MS,
  buildRefusal,
  buildVerdict,
  chooseCdpPort,
  notListening,
  parseArgs,
  pickPage,
} from "../src/host/drive-test-app"
import { parseRecord, planTestApp } from "../src/host/test-app"

function fail(message: string): never {
  console.error(`drive-test-app: ${message}`)
  process.exit(1)
}

const parsed = parseArgs(process.argv.slice(2))
if (typeof parsed === "string") fail(parsed)

function git(args: string[]): string {
  const run = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" })
  return run.status === 0 ? run.stdout.trim() : ""
}

const record = (() => {
  const root = git(["rev-parse", "--show-toplevel"])
  if (!root) return undefined
  const plan = planTestApp({ root, branch: git(["branch", "--show-current"]) })
  try {
    return parseRecord(readFileSync(plan.recordPath, "utf8"))
  } catch {
    return undefined
  }
})()

const choice = chooseCdpPort(process.env.CDP_PORT, record)
if (typeof choice === "string") fail(choice)

// The knock: a short timeout, because a port nobody listens on can also just swallow the SYN.
let targets: unknown
try {
  const response = await fetch(`http://127.0.0.1:${choice.port}/json/list`, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })
  if (!response.ok) fail(notListening(choice, `HTTP ${response.status}`))
  targets = await response.json()
} catch (error) {
  fail(notListening(choice, error instanceof Error ? (error.name === "TimeoutError" ? "nessuna risposta entro 3 s" : error.message) : String(error)))
}
const page = pickPage(targets)
if (typeof page === "string") fail(page)

const ws = new WebSocket(page.webSocketDebuggerUrl!)
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve()
  ws.onerror = () => reject(new Error("il WebSocket di debug non si apre"))
  setTimeout(() => reject(new Error("il WebSocket di debug non risponde")), CONNECT_TIMEOUT_MS)
}).catch((error: Error) => fail(notListening(choice, error.message)))

let nextId = 0
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => reject(new Error(`${method}: nessuna risposta`)), 10_000)
    const on = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener("message", on)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolve(message.result)
    }
    ws.addEventListener("message", on)
    ws.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async (expression: string): Promise<unknown> => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eccezione nella pagina")
  return result?.result?.value
}

// The rule before anything else: a test build, or nothing. A page still
// loading has no mark yet and is asked again for a while; another ADE is
// refused at once.
{
  const until = Date.now() + BUILD_WAIT_MS
  for (;;) {
    const answer = await evaluate(BUILD_CHECK).catch(() => undefined)
    const verdict = buildVerdict(answer, Date.now() >= until)
    if (verdict === "test") break
    if (verdict === "other" || Date.now() >= until) {
      ws.close()
      fail(buildRefusal(verdict, answer))
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

const cell = (n: number) => `document.querySelectorAll("[data-slot=grid-cell]")[${n - 1}]`

try {
  switch (parsed.command) {
    case "panes": {
      const panes = (await evaluate(
        `[...document.querySelectorAll("[data-slot=grid-cell]")].map((cell, i) => (i + 1) + "  " + ((cell.querySelector("[data-slot=pane-title]") || {}).textContent || "(senza titolo)"))`,
      )) as string[]
      console.log(panes.length ? panes.join("\n") : "nessun pannello aperto")
      break
    }
    case "text": {
      const rows = await evaluate(
        `(() => { const p = ${cell(parsed.pane!)}; if (!p) return null; return [...p.querySelectorAll(".xterm-rows > div")].map((d) => d.textContent.replace(/\\s+$/, "")).filter(Boolean).join("\\n") })()`,
      )
      if (rows === null) fail(`nessun pannello con indice ${parsed.pane}`)
      console.log(rows || "(terminale vuoto)")
      break
    }
    case "notes": {
      const lines = await evaluate(
        `(() => { const p = ${cell(parsed.pane!)}; if (!p) return null; return [...p.querySelectorAll("[data-slot=pane-transcript] [data-slot=pane-line]")].map((l) => l.textContent.trim()).filter((x) => x.length > 3).slice(-30) })()`,
      )
      if (lines === null) fail(`nessun pannello con indice ${parsed.pane}`)
      console.log((lines as string[]).join("\n") || "(nessuna nota)")
      break
    }
    case "type":
    case "key": {
      const focused = await evaluate(
        `(() => { const p = ${cell(parsed.pane!)}; if (!p) return "pane"; const t = p.querySelector("textarea.xterm-helper-textarea"); if (!t) return "terminal"; t.focus(); return "ok" })()`,
      )
      if (focused === "pane") fail(`nessun pannello con indice ${parsed.pane}`)
      if (focused === "terminal") fail(`il pannello ${parsed.pane} non ha un terminale`)
      if (parsed.command === "type") {
        await send("Input.insertText", { text: parsed.rest })
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      const keys: Record<string, [number, string]> = { Enter: [13, "\r"], Escape: [27, "\u001b"], Tab: [9, "\t"] }
      const name = parsed.command === "type" ? "Enter" : parsed.rest
      const key = keys[name]
      if (!key) fail(`tasto non previsto: ${name} (Enter, Escape, Tab)`)
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: key[0], text: key[1] })
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: key[0] })
      console.log(parsed.command === "type" ? `digitato nel pannello ${parsed.pane}` : `${name} nel pannello ${parsed.pane}`)
      break
    }
    case "shot": {
      const result = await send("Page.captureScreenshot", { format: "png" })
      await Bun.write(parsed.rest, Buffer.from(result.data, "base64"))
      console.log(`salvato ${parsed.rest}`)
      break
    }
    case "eval": {
      console.log(JSON.stringify(await evaluate(parsed.rest), null, 1))
      break
    }
  }
} catch (error) {
  ws.close()
  fail(error instanceof Error ? error.message : String(error))
}
ws.close()
