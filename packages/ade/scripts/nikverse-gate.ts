/**
 * The live gate for NikVerse's city (V1): opens the world in this worktree's ADE Test, measures it, and
 * fails above the ceilings in `src/nikverse/gate.ts` (frame 130 MB, ADE +5 MB, nothing drawn 1 % of a core,
 * 60 fps while walking). JSON on stdout, the log on stderr; exit 0 green, 1 red or out of time, 2 could not run.
 *
 *   bun run test:app --cdp                    ADE Test of this worktree, with remote debugging
 *   bun scripts/nikverse-gate.ts              attach to it (its port is in .ade-test/record.json, or CDP_PORT)
 *   bun scripts/nikverse-gate.ts --start      start it first (voice off) and stop it after
 *   options: --cycles N (3) --rest S (30, wait for "at rest") --cap S (300, the whole run) --out FILE
 *
 * What it measures, with the window visible and on a project (the real iGPU, so not headless): the
 * `nikverse.localhost` renderer's private bytes and working set over N open/close cycles; ADE's own
 * renderer (private, working set, JS heap after a GC) against the world-closed baseline 5 s after the last
 * close and again after `--rest` (the baseline is taken after one warm-up open/close, once ADE has settled); CPU of the frame, the GPU and ADE in the three draw modes (moving, still,
 * immobile) three times each; frames a second; the GPU process' memory. Only ADE Test is driven (it asks for
 * `data-ade-build="test"` first); the UI it clicks is the Italian one ("Nuovo pannello", "NikVerse").
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { gateChecks, gatePasses, mean, median, GATE_LIMITS } from "../src/nikverse/gate"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(name)
const CYCLES = Number(arg("--cycles") ?? 3)
const REST_S = Number(arg("--rest") ?? 30)
const CAP_S = Number(arg("--cap") ?? 300)
const OUT = arg("--out")

const adeDir = join(import.meta.dir, "..")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (...a: unknown[]) => console.error("[nikverse-gate]", ...a)
const ps = (s: string) => spawnSync("powershell", ["-NoProfile", "-Command", s], { encoding: "utf8" }).stdout.trim()
const git = (args: string[]) => spawnSync("git", args, { cwd: adeDir, encoding: "utf8" }).stdout.trim()
const root = git(["rev-parse", "--show-toplevel"])
const recordPath = join(root, ".ade-test", "record.json")

const result: Record<string, unknown> = { startedAt: new Date().toISOString(), worktree: basename(root) }
let startedByUs = false
function finish(code: number, extra: Record<string, unknown> = {}): never {
  Object.assign(result, extra)
  const json = JSON.stringify(result, null, 2)
  if (OUT) writeFileSync(OUT, json)
  console.log(json)
  if (startedByUs) spawnSync("bun", ["scripts/test-app.ts", "stop"], { cwd: adeDir, stdio: "ignore" })
  process.exit(code)
}
// ---- the app -------------------------------------------------------------------------------------

const cdpPortOf = () => {
  if (process.env.CDP_PORT) return Number(process.env.CDP_PORT)
  try {
    return (JSON.parse(readFileSync(recordPath, "utf8")) as { cdpPort?: number }).cdpPort
  } catch {
    return undefined
  }
}
async function answers(port: number) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}
if (flag("--start") && !((cdpPortOf() ?? 0) > 0 && (await answers(cdpPortOf()!)))) {
  log("avvio ADE Test (voce spenta): la prima volta compila il Rust")
  spawnSync("bun", ["scripts/build-nikverse-world.ts"], { cwd: adeDir, stdio: "ignore" })
  spawn("bun", ["scripts/test-app.ts", "--cdp"], {
    cwd: adeDir,
    env: { ...process.env, NIKCLI_SERVICE: "0" },
    stdio: "ignore",
    detached: true,
  }).unref()
  startedByUs = true
  for (let i = 0; i < 600; i++) {
    await sleep(2000)
    const port = cdpPortOf()
    if (port && (await answers(port))) {
      const page = await pageTarget(port).catch(() => undefined)
      if (page) break
    }
  }
}
const PORT = cdpPortOf()
if (!PORT || !(await answers(PORT))) {
  log("nessuna ADE Test con il debug remoto: bun run test:app --cdp, oppure --start")
  finish(2, { ok: false, error: "no ADE Test answering on the remote debugging port" })
}

async function pageTarget(port: number) {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string
    url: string
    webSocketDebuggerUrl: string
  }[]
  return list.find((t) => t.type === "page" && /^http:\/\/localhost:\d+\//.test(t.url))
}

type Send = (method: string, params?: object, sessionId?: string) => Promise<any>
async function connect(url: string): Promise<Send> {
  const ws = new WebSocket(url)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new Error("no websocket")))))
  let id = 0
  const pending = new Map<number, (d: any) => void>()
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data))
    if (d.id) pending.get(d.id)?.(d)
  }
  return (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const i = ++id
      const t = setTimeout(() => rej(new Error("timeout " + method)), 30000)
      pending.set(i, (d) => {
        clearTimeout(t)
        d.error ? rej(new Error(method + ": " + JSON.stringify(d.error))) : res(d.result)
      })
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
}
const page = await connect((await pageTarget(PORT))!.webSocketDebuggerUrl)
const browser = await connect(
  ((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string })
    .webSocketDebuggerUrl,
)
const ev = async (send: Send, expression: string, sessionId?: string, awaitPromise = false) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId)
  if (r.exceptionDetails)
    throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300))
  return r.result?.value
}
// A window still on its splash has no build mark yet.
let build = ""
for (let i = 0; i < 60 && build !== "test"; i++) {
  build = String(
    await ev(
      page,
      `document.querySelector("[data-slot=ade-bar]") ? (document.documentElement.dataset.adeBuild ?? "") : ""`,
    ).catch(() => ""),
  )
  if (build !== "test") await sleep(1000)
}
// The time cap counts from the moment the app answers: a first start compiles Rust for minutes.
const deadline = setTimeout(() => {
  log(`tempo di ${CAP_S} s esaurito`)
  finish(1, { ok: false, error: `time cap of ${CAP_S} s reached` })
}, CAP_S * 1000)
if (build !== "test") {
  log("la pagina non è una ADE Test: rifiuto")
  finish(2, { ok: false, error: "the page is not ADE Test (data-ade-build != test)" })
}

// ---- the window: visible, or the numbers are those of a hidden page -----------------------------------

const showWindow = () =>
  ps(
    `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);'; ` +
      `Get-Process ade-test -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${basename(root)}*' } | ForEach-Object { [W.U]::ShowWindow($_.MainWindowHandle,4) | Out-Null }`,
  )

// ---- measuring ------------------------------------------------------------------------------------

type Proc = { id: number; type: string; cpuTime: number }
const procs = async () => (await browser("SystemInfo.getProcessInfo")).processInfo as Proc[]
function memory(ids: number[]) {
  const out: Record<number, { priv: number; ws: number }> = {}
  if (!ids.length) return out
  const raw = ps(
    `Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.PrivateMemorySize64) $($_.WorkingSet64)" }`,
  )
  for (const line of raw.split(/\r?\n/)) {
    const [id, priv, ws] = line.trim().split(" ").map(Number)
    if (id) out[id] = { priv: priv / 1048576, ws: ws / 1048576 }
  }
  return out
}
const big = (m?: { priv: number; ws: number }) => (m ? Math.max(m.priv, m.ws) : Number.NaN)
async function heapMb(send: Send, sessionId?: string) {
  await send("HeapProfiler.collectGarbage", {}, sessionId).catch(() => {})
  return (await send("Runtime.getHeapUsage", {}, sessionId)).usedSize / 1048576
}
async function frameSession() {
  const target = (await browser("Target.getTargets")).targetInfos.find(
    (t: any) => t.type === "iframe" && /nikverse\.localhost/.test(t.url) && !/check=/.test(t.url),
  )
  return target
    ? ((await browser("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId as string)
    : undefined
}
async function openWorldOnce() {
  showWindow()
  await ev(page, `document.querySelector('button[aria-label="Nuovo pannello"]')?.click()`)
  await sleep(600)
  await ev(
    page,
    `(() => { const root = document.querySelector('[role=menu]'); const els = [...(root?.querySelectorAll('*') ?? [])].filter(e => (e.textContent || '').trim().startsWith('NikVerse') && e.getBoundingClientRect().width > 0).sort((a, b) => a.textContent.length - b.textContent.length); const r = els[0]?.getBoundingClientRect(); return r ? JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2}) : null })()`,
  ).then(async (c) => {
    if (!c) throw new Error("il menu «Nuovo pannello» non ha la voce NikVerse")
    const { x, y } = JSON.parse(c)
    await page("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
    await page("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
    await page("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
  })
  let session: string | undefined
  for (let i = 0; i < 80 && !session; i++) {
    session = await frameSession()
    if (!session) await sleep(250)
  }
  if (!session) throw new Error("il pannello NikVerse non ha aperto il frame")
  for (let i = 0; i < 80; i++) {
    if ((await ev(browser, `document.documentElement.dataset.ready`, session).catch(() => "")) === "1") return session
    await sleep(250)
  }
  throw new Error("la città non ha disegnato il primo fotogramma")
}
async function openWorld() {
  // Right after a start the workbench may still be restoring its panes: the first click can land on nothing.
  for (let attempt = 1; ; attempt++) {
    try {
      return await openWorldOnce()
    } catch (error) {
      if (attempt >= 3) throw error
      log(`apertura ${attempt} fallita (${String((error as Error).message)}); riprovo`)
      await sleep(4000)
    }
  }
}
const closeWorld = () =>
  ev(
    page,
    `(() => { const x = document.querySelector('[data-component=nikverse-pane] button[aria-label*="Chiudi"]'); x?.click(); return !!x })()`,
  )

try {
  showWindow()
  await sleep(startedByUs ? 8000 : 500)
  // A first open loads code and grows ADE once, and a freshly started ADE is still shrinking from its start-up: neither is a
  // leak. So the baseline is taken after one warm-up open/close, once ADE's renderer has stopped moving.
  log("riscaldamento: un'apertura e una chiusura")
  await closeWorld()
  await sleep(2000)
  await openWorld()
  await sleep(4000)
  await closeWorld()
  const settle = async (pid: number) => {
    // Three steady readings in a row (a start-up shrinks in steps), or a minute.
    let last = Number.NaN
    let steady = 0
    for (let i = 0; i < 20 && steady < 3; i++) {
      await sleep(3000)
      const now = big(memory([pid])[pid])
      steady = Math.abs(now - last) < 1 ? steady + 1 : 0
      last = now
    }
    return last
  }
  const first = await procs()
  const firstMem = memory(first.map((p) => p.id))
  const adePid = first
    .filter((p) => p.type === "renderer")
    .sort((a, b) => big(firstMem[b.id]) - big(firstMem[a.id]))[0].id
  await settle(adePid)
  log("baseline: mondo chiuso, ADE assestata")
  const p0 = await procs()
  const m0 = memory(p0.map((p) => p.id))
  const gpuPid = p0.find((p) => p.type === "GPU")!.id
  const base = { adeMb: big(m0[adePid]), adeHeapMb: await heapMb(page), gpuMb: big(m0[gpuPid]) }

  const cycles: Record<string, unknown>[] = []
  let session = ""
  let framePid = 0
  for (let c = 1; c <= CYCLES; c++) {
    session = await openWorld()
    await sleep(8000)
    const pr = await procs()
    const m = memory(pr.map((p) => p.id))
    // The frame is a renderer of its own; the one that is not ADE's (the largest, if a closed world's is still lingering).
    framePid =
      pr.filter((p) => p.type === "renderer" && p.id !== adePid).sort((a, b) => big(m[b.id]) - big(m[a.id]))[0]?.id ?? 0
    cycles.push({
      cycle: c,
      frameMb: big(m[framePid]),
      framePrivMb: m[framePid]?.priv,
      frameWsMb: m[framePid]?.ws,
      frameHeapMb: await heapMb(browser, session),
      adeMb: big(m[adePid]),
      gpuMb: big(m[gpuPid]),
      backend: await ev(browser, `document.documentElement.dataset.backend`, session),
    })
    log(`ciclo ${c}`, JSON.stringify(cycles.at(-1)))
    if (c < CYCLES) {
      await closeWorld()
      await sleep(5000)
    }
  }

  // ---- the three draw modes, three times each, on the last open world
  const KEYS: Record<string, [string, number]> = { w: ["KeyW", 87], d: ["KeyD", 68] }
  const frame = JSON.parse(
    await ev(
      page,
      `(() => { const r = document.querySelector('iframe[src*="nikverse"]').getBoundingClientRect(); return JSON.stringify({x: r.x, y: r.y}) })()`,
    ),
  )
  const tap = async (x: number, y: number) => {
    await page("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
    await page("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
    await page("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
  }
  await tap(frame.x + 60, frame.y + 40)
  const key = (type: string, l: string) =>
    page("Input.dispatchKeyEvent", { type, code: KEYS[l][0], key: l, windowsVirtualKeyCode: KEYS[l][1] })
  const frames = () => ev(browser, `window.__nikverseFrames ?? 0`, session)
  const mode = () => ev(browser, `document.documentElement.dataset.drawMode`, session)
  async function sample(seconds: number, during?: () => Promise<void>) {
    const a = await procs()
    const f0 = await frames()
    const t0 = performance.now()
    if (during) await during()
    else await sleep(seconds * 1000)
    const c = await procs()
    const dt = (performance.now() - t0) / 1000
    const cpu = (id: number) => {
      const x = a.find((p) => p.id === id)
      const z = c.find((p) => p.id === id)
      return x && z ? ((z.cpuTime - x.cpuTime) / dt) * 100 : Number.NaN
    }
    return {
      seconds: +dt.toFixed(1),
      frameCpu: cpu(framePid),
      gpuCpu: cpu(gpuPid),
      adeCpu: cpu(adePid),
      fps: ((await frames()) - f0) / dt,
      mode: await mode(),
    }
  }
  const modes: Record<string, ReturnType<typeof sample> extends Promise<infer R> ? R : never>[] = []
  for (let rep = 1; rep <= 3; rep++) {
    const moving = await sample(10, async () => {
      const t = Date.now()
      let i = 0
      while (Date.now() - t < 10000) {
        const l = i++ % 2 ? "w" : "d"
        await key("rawKeyDown", l)
        await sleep(700)
        await key("keyUp", l)
        await sleep(50)
      }
    })
    const still = await sample(6)
    for (let i = 0; i < 60 && (await mode()) !== "immobile"; i++) await sleep(500)
    const immobile = await sample(10)
    modes.push({ rep, moving, still, immobile } as never)
    log(`modi ${rep}`, JSON.stringify({ moving, still, immobile }))
  }

  // ---- close, and what ADE kept
  await closeWorld()
  await sleep(5000)
  const p5 = await procs()
  const m5 = memory(p5.map((p) => p.id))
  const after5 = { adeMb: big(m5[adePid]), adeHeapMb: await heapMb(page) }
  log(`attendo ${REST_S} s per il regime`)
  await sleep(REST_S * 1000)
  const p9 = await procs()
  const m9 = memory(p9.map((p) => p.id))
  const rest = {
    adeMb: big(m9[adePid]),
    adeHeapMb: await heapMb(page),
    gpuMb: big(m9[gpuPid]),
    frameProcessGone: !p9.some((p) => p.type === "renderer" && p.id === framePid),
  }

  const rows = modes as unknown as { moving: any; still: any; immobile: any }[]
  const measures = {
    frameMb: Math.max(...cycles.map((c) => c.frameMb as number)),
    adeGrowthAfter5sMb: after5.adeMb - base.adeMb,
    adeGrowthAtRestMb: rest.adeMb - base.adeMb,
    adeHeapGrowthMb: Math.max(after5.adeHeapMb, rest.adeHeapMb) - base.adeHeapMb,
    immobileCpuPercent: mean(rows.map((r) => r.immobile.frameCpu + r.immobile.gpuCpu)),
    movingFps: mean(rows.map((r) => r.moving.fps)),
  }
  const checks = gateChecks(measures)
  const ok = gatePasses(checks)
  finish(ok ? 0 : 1, {
    ok,
    limits: GATE_LIMITS,
    checks,
    measures,
    info: {
      base,
      cycles,
      after5,
      rest,
      stillCpuPercentMedian: median(rows.map((r) => r.still.frameCpu + r.still.gpuCpu)),
      movingCpuPercentMedian: median(rows.map((r) => r.moving.frameCpu + r.moving.gpuCpu)),
      gpuMemoryOpenMinusBaseMb: Math.max(...cycles.map((c) => c.gpuMb as number)) - base.gpuMb,
      modes,
    },
  })
} catch (error) {
  log("errore:", String((error as Error).message ?? error))
  finish(2, { ok: false, error: String((error as Error).message ?? error) })
} finally {
  clearTimeout(deadline)
}
