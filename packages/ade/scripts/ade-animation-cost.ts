/**
 * What ADE's CSS animations cost in the states they are really in, on the running ADE Test (CDP), the way
 * ade-team/results/ade-animazioni-costo.md measures them: CPU as a percentage of one core, summed over the renderer and the GPU
 * processes of this ADE Test (`SystemInfo.getProcessInfo`), the window visible, three repetitions taken in turn.
 *
 * Not forced with `Animation.play()`: each condition is put in the state the app would be in, and what runs is read back.
 *   rest        nothing touched
 *   hover       the pointer moved onto the logo and left parked there (measured from 4 s after it arrived)
 *   awake-idle  the orb's microphone open, waiting for the wake word (`data-awake`, `data-status=idle`)
 *   listening   the orb listening (`data-awake`, `data-status=listening`, `data-spin`)
 * The orb's attributes are set on the element by hand (the voice is never started: it would listen, and could spend the user's key).
 *
 *   bun scripts/ade-animation-cost.ts [--out FILE] [--seconds 20] [--reps 3]
 *
 * Needs an ADE Test with remote debugging (`bun run test:app --cdp`); reads its port from `.ade-test/record.json`.
 */

import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const SECONDS = Number(arg("--seconds") ?? 20)
const REPS = Number(arg("--reps") ?? 3)
const ONLY = arg("--only")?.split("|")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ps = (s: string) => spawnSync("powershell", ["-NoProfile", "-Command", s], { encoding: "utf8" }).stdout.trim()
const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim()
const port =
  Number(process.env.CDP_PORT) ||
  (JSON.parse(readFileSync(join(root, ".ade-test", "record.json"), "utf8")) as { cdpPort: number }).cdpPort

async function connect(url: string) {
  const ws = new WebSocket(url)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new Error("no websocket")))))
  let id = 0
  const pending = new Map<number, (d: any) => void>()
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data))
    if (d.id) pending.get(d.id)?.(d)
  }
  return (method: string, params: object = {}) =>
    new Promise<any>((res, rej) => {
      const i = ++id
      const t = setTimeout(() => rej(new Error("timeout " + method)), 30000)
      pending.set(i, (d) => {
        clearTimeout(t)
        d.error ? rej(new Error(method + ": " + JSON.stringify(d.error))) : res(d.result)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
}
const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]
const target = list.find((t) => t.type === "page" && /^http:\/\/localhost:\d+\//.test(t.url))
if (!target) throw new Error("no ADE page on the debugging port")
const page = await connect(target.webSocketDebuggerUrl)
const browser = await connect(
  ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as any).webSocketDebuggerUrl,
)
const ev = async (expression: string) => {
  const r = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails)
    throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300))
  return r.result?.value
}
const build = await ev(`document.documentElement.dataset.adeBuild ?? ""`)
if (build !== "test") throw new Error("the page is not ADE Test (data-ade-build != test): refusing to measure")

const showWindow = () =>
  ps(
    `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);'; ` +
      `Get-Process ade-test -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${basename(root)}*' } | ForEach-Object { [W.U]::ShowWindow($_.MainWindowHandle,4) | Out-Null }`,
  )

// A count of the animation frames the page asks for, with where they come from.
await ev(
  `(() => { if (window.__raf) return 1; const o = window.requestAnimationFrame.bind(window); window.__raf = { n: 0 }; window.requestAnimationFrame = (cb) => { window.__raf.n++; return o(cb) }; return 1 })()`,
)

type Proc = { id: number; type: string; cpuTime: number }
const procs = async () => (await browser("SystemInfo.getProcessInfo")).processInfo as Proc[]
async function cost(seconds: number) {
  const a = await procs()
  const r0 = (await ev(`window.__raf.n`)) as number
  const t0 = performance.now()
  await sleep(seconds * 1000)
  const b = await procs()
  const r1 = (await ev(`window.__raf.n`)) as number
  const dt = (performance.now() - t0) / 1000
  const per = (type: string) =>
    b
      .filter((p) => p.type === type)
      .reduce((s, p) => s + ((p.cpuTime - (a.find((q) => q.id === p.id)?.cpuTime ?? p.cpuTime)) / dt) * 100, 0)
  const renderer = per("renderer")
  const gpu = per("GPU")
  const running = (await ev(
    `JSON.stringify(document.getAnimations().filter((a) => a.playState === "running").map((a) => a.animationName || a.constructor.name))`,
  )) as string
  return {
    renderer: +renderer.toFixed(2),
    gpu: +gpu.toFixed(2),
    total: +(renderer + gpu).toFixed(2),
    rafPerSec: +((r1 - r0) / dt).toFixed(1),
    running: JSON.parse(running) as string[],
  }
}

const ORB = `document.querySelector('[data-slot="ade-voice-controls"] [data-component="orb-mark"]') ?? document.querySelector('[data-component="orb-mark"]')`
const LOGO = `document.querySelector('[data-component="nik-chrome-logo"]')`
const pointerAt = (x: number, y: number) => page("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
async function parkOnLogo() {
  const r = (await ev(
    `(() => { const b = ${LOGO}.getBoundingClientRect(); return JSON.stringify([b.left + b.width / 2, b.top + b.height / 2]) })()`,
  )) as string
  const [x, y] = JSON.parse(r) as [number, number]
  // Some movement on the way in, as a hand would, then still.
  for (let i = 0; i < 6; i++) {
    await pointerAt(x - 30 + i * 6, y - 4 + i)
    await sleep(60)
  }
  await pointerAt(x, y)
}
const orbState = (awake: boolean, status: string, spin: boolean) =>
  ev(
    `(() => { const o = ${ORB}; if (!o) return "no orb"; ${
      awake
        ? `o.dataset.awake = "true"; o.dataset.status = ${JSON.stringify(status)};`
        : `delete o.dataset.awake; o.dataset.status = "asleep";`
    } ${spin ? `o.dataset.spin = "true";` : `delete o.dataset.spin;`} return "ok" })()`,
  )

const conditions: Record<string, { set(): Promise<unknown>; settle: number; reset(): Promise<unknown> }> = {
  rest: { set: async () => {}, settle: 2, reset: async () => {} },
  hover: {
    set: parkOnLogo,
    settle: 4,
    reset: async () => {
      await pointerAt(2, 2)
      await sleep(3000)
    },
  },
  "awake-idle": {
    set: () => orbState(true, "idle", false),
    settle: 2,
    reset: () => orbState(false, "asleep", false),
  },
  listening: {
    set: () => orbState(true, "listening", true),
    settle: 2,
    reset: () => orbState(false, "asleep", false),
  },
}
const results: Record<string, unknown[]> = {}
console.error(
  `window: ${showWindow() || "shown"}; ${REPS} x ${Object.keys(conditions).length} conditions x ${SECONDS} s`,
)
for (let rep = 0; rep < REPS; rep++)
  for (const [name, c] of Object.entries(conditions).filter(([n]) => !ONLY || ONLY.includes(n))) {
    showWindow()
    await sleep(500)
    await c.set()
    await sleep(c.settle * 1000)
    const visibility = await ev(`document.visibilityState`)
    const r = { ...(await cost(SECONDS)), visibility }
    ;(results[name] ??= []).push(r)
    console.error(name.padEnd(11), JSON.stringify(r))
    await c.reset()
    await sleep(1500)
  }
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const summary = Object.fromEntries(
  Object.entries(results).map(([k, rs]) => {
    const rows = rs as Array<{ total: number; renderer: number; gpu: number; rafPerSec: number; running: string[] }>
    return [
      k,
      {
        total: +mean(rows.map((r) => r.total)).toFixed(2),
        renderer: +mean(rows.map((r) => r.renderer)).toFixed(2),
        gpu: +mean(rows.map((r) => r.gpu)).toFixed(2),
        rafPerSec: +mean(rows.map((r) => r.rafPerSec)).toFixed(1),
        running: [...new Set(rows.flatMap((r) => r.running))],
      },
    ]
  }),
)
console.log(JSON.stringify(summary, null, 2))
const out = arg("--out")
if (out)
  writeFileSync(
    out,
    JSON.stringify({ at: new Date().toISOString(), seconds: SECONDS, reps: REPS, summary, results }, null, 2),
  )
process.exit(0)
