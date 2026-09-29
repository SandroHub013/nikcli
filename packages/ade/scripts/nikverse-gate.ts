/**
 * The live gate for NikVerse's city (V1): opens the world in this worktree's ADE Test, measures it, and
 * fails above the ceilings in `src/nikverse/gate.ts` (frame 130 MB, ADE +5 MB, nothing drawn 1 % of a core over what
 * ADE alone costs the GPU process, 60 fps while walking, a frame in 15 ms of GPU at the 95th percentile, GPU memory +250 MB). JSON on stdout, the log on stderr; exit 0 green, 1 red or out of time, 2 could not run.
 *
 *   bun run test:app --cdp                    ADE Test of this worktree, with remote debugging
 *   bun scripts/nikverse-gate.ts              attach to it (its port is in .ade-test/record.json, or CDP_PORT)
 *   bun scripts/nikverse-gate.ts --start      start it first (voice off) and stop it after
 *   options: --cycles N (3) --rest S (30, wait for "at rest") --cap S (600, the whole run) --out FILE
 *            --bench FILE  the bench.json of a `nikverse-shots.ts` run to read the GPU time from, instead of running one
 *
 * What it measures, with the window visible and on a project (the real iGPU, so not headless): the
 * `nikverse.localhost` renderer's private bytes and working set over N open/close cycles; ADE's own
 * renderer (private, working set, JS heap after a GC) against the world-closed baseline 5 s after the last
 * close and again after `--rest` (the baseline is taken after one warm-up open/close, once ADE has settled); CPU of the frame, the GPU and ADE in the three draw modes (moving, still,
 * immobile) three times each, after a baseline of the GPU process with the world closed; frames a second; the GPU time of a
 * frame: the p95 of the WORST of the eight shots of the level, read from the bench (`nikverse-shots.ts`, run here on the real GPU unless `--bench` gives one), with the scale it settled at; the view a player starts in (the world's own `window.__nikverseBench` in ADE Test, three times) is kept in the JSON as information only; the GPU process' memory. Only ADE Test is driven (it asks for
 * `data-ade-build="test"` first); the UI it clicks is the Italian one ("Nuovo pannello", "NikVerse").
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { profilesDir, sweepOrphans } from "../src/nikverse/browser-guard"
import {
  gateChecks,
  gatePasses,
  immobileCost,
  mean,
  median,
  worstShot,
  GATE_LIMITS,
  type BenchRow,
} from "../src/nikverse/gate"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(name)
const CYCLES = Number(arg("--cycles") ?? 3)
/** For measuring an option of the renderer: `--tune "samples=1&maxscale=0.9"` reaches the world through the pane and the shot pages (`CityDeps.tune`). */
const TUNE = arg("--tune")
const REST_S = Number(arg("--rest") ?? 30)
const CAP_S = Number(arg("--cap") ?? 600)
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
/** ADE Test is shut when this script started it, on any way out: the end, an error nobody caught, a signal (rule 26: nothing left running). */
function stopApp() {
  if (!startedByUs) return
  startedByUs = false
  spawnSync("bun", ["scripts/test-app.ts", "stop"], { cwd: adeDir, stdio: "ignore" })
}
process.on("exit", stopApp)
for (const event of ["uncaughtException", "unhandledRejection"] as const)
  process.on(event, (error) => {
    console.error(`[nikverse-gate] ${event}:`, error)
    stopApp()
    process.exit(2)
  })
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    stopApp()
    process.exit(130)
  })
function finish(code: number, extra: Record<string, unknown> = {}): never {
  Object.assign(result, extra)
  const json = JSON.stringify(result, null, 2)
  if (OUT) writeFileSync(OUT, json)
  console.log(json)
  stopApp()
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

type Send = ((method: string, params?: object, sessionId?: string) => Promise<any>) & {
  /** Listens for the events of the line (a trace's `Tracing.tracingComplete`). */
  on(fn: (method: string, params: any) => void): void
}
async function connect(url: string): Promise<Send> {
  const ws = new WebSocket(url)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new Error("no websocket")))))
  let id = 0
  const pending = new Map<number, (d: any) => void>()
  const listeners: Array<(method: string, params: any) => void> = []
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data))
    if (d.id) pending.get(d.id)?.(d)
    else if (d.method) for (const l of listeners) l(d.method, d.params)
  }
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((res, rej) => {
      const i = ++id
      const t = setTimeout(() => rej(new Error("timeout " + method)), 30000)
      pending.set(i, (d) => {
        clearTimeout(t)
        d.error ? rej(new Error(method + ": " + JSON.stringify(d.error))) : res(d.result)
      })
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  return Object.assign(send, { on: (fn: (method: string, params: any) => void) => void listeners.push(fn) })
}
const pageAtStart = await pageTarget(PORT)
if (!pageAtStart) finish(2, { ok: false, error: "ADE Test answers but has no page to drive" })
const page = await connect(pageAtStart!.webSocketDebuggerUrl)
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
  await ev(page, `window.__nikverseTune = ${JSON.stringify(TUNE ?? "")}`)
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
  // What the page says about itself, so a red run says why and not only that.
  const why = await ev(
    browser,
    `JSON.stringify({ city: document.documentElement.dataset.city, error: document.documentElement.dataset.cityError, backend: document.documentElement.dataset.backend, quality: document.documentElement.dataset.quality, why: document.documentElement.dataset.qualityWhy })`,
    session,
  ).catch(() => "?")
  throw new Error(`la città non ha disegnato il primo fotogramma ${why}`)
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
  // What ADE alone costs the GPU process: the world is closed, so none of this CPU is the world's. The gate counts
  // only what the world adds to it (`immobileCost`); the GPU process is one for the whole window.
  const cpuOf = async (pid: number, seconds: number) => {
    const a = await procs()
    const t0 = performance.now()
    await sleep(seconds * 1000)
    const c = await procs()
    const dt = (performance.now() - t0) / 1000
    const x = a.find((p) => p.id === pid)
    const z = c.find((p) => p.id === pid)
    return x && z ? ((z.cpuTime - x.cpuTime) / dt) * 100 : Number.NaN
  }
  const baselineGpuRuns: number[] = []
  for (let i = 0; i < 3; i++) baselineGpuRuns.push(await cpuOf(gpuPid, 10))
  log(
    "CPU del processo GPU a mondo chiuso (solo ADE), prima:",
    baselineGpuRuns.map((v) => v.toFixed(2)).join(", "),
    "%",
  )

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
  // What the frame's own main thread did: tasks and script time from the browser's counters, to tell page work from the
  // browser's (a WebGPU device that is alive costs CPU in the renderer without any script running).
  await browser("Performance.enable", {}, session)
  const threadMetrics = async () => {
    const { metrics } = await browser("Performance.getMetrics", {}, session)
    const of = (name: string) =>
      (metrics as { name: string; value: number }[]).find((m) => m.name === name)?.value ?? Number.NaN
    return {
      task: of("TaskDuration"),
      script: of("ScriptDuration"),
      layout: of("LayoutDuration"),
      style: of("RecalcStyleDuration"),
    }
  }
  async function sample(seconds: number, during?: () => Promise<void>) {
    const m0 = await threadMetrics()
    const a = await procs()
    const f0 = await frames()
    const t0 = performance.now()
    if (during) await during()
    else await sleep(seconds * 1000)
    const c = await procs()
    const dt = (performance.now() - t0) / 1000
    const m1 = await threadMetrics()
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
      // Percent of a core spent in the frame's main-thread tasks, and of that in script.
      threadTaskPercent: ((m1.task - m0.task) / dt) * 100,
      threadScriptPercent: ((m1.script - m0.script) / dt) * 100,
      threadLayoutStylePercent: ((m1.layout - m0.layout + (m1.style - m0.style)) / dt) * 100,
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

  // ---- what the frame and the GPU process do while nothing is drawn: a trace of the browser for a few seconds in the
  // "immobile" mode, summed by process, thread and event name. It says whether the CPU of the immobile world is the page's
  // (script, layout), the compositor's, or the browser's own.
  async function traceIdle(seconds: number) {
    while ((await mode()) !== "immobile") await sleep(500)
    const done = new Promise<string>((resolve) =>
      browser.on((method, params) => {
        if (method === "Tracing.tracingComplete") resolve(params.stream)
      }),
    )
    await browser("Tracing.start", {
      categories: "toplevel,devtools.timeline,disabled-by-default-devtools.timeline,cc,viz,gpu,v8,blink",
      transferMode: "ReturnAsStream",
      streamFormat: "json",
    })
    await sleep(seconds * 1000)
    await browser("Tracing.end")
    const stream = await done
    let text = ""
    for (;;) {
      const chunk = await browser("IO.read", { handle: stream, size: 1 << 20 })
      text += chunk.data
      if (chunk.eof) break
    }
    await browser("IO.close", { handle: stream })
    const events = (JSON.parse(text) as { traceEvents: any[] }).traceEvents
    const threads = new Map<string, string>()
    for (const e of events)
      if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args?.name ?? "?")
    // Animation frames the page asked for: one FireAnimationFrame on the frame's main thread per requestAnimationFrame callback.
    const animationFrames = events.filter((e) => e.pid === framePid && e.name === "FireAnimationFrame").length
    const total = new Map<string, { ms: number; count: number }>()
    for (const e of events) {
      if (e.ph !== "X" || (e.pid !== framePid && e.pid !== gpuPid) || !(e.dur > 0)) continue
      const key = `${e.pid === framePid ? "frame" : "gpu"} · ${threads.get(`${e.pid}:${e.tid}`) ?? e.tid} · ${e.name}`
      const t = total.get(key) ?? { ms: 0, count: 0 }
      t.ms += e.dur / 1000
      t.count++
      total.set(key, t)
    }
    return {
      seconds,
      animationFrames,
      animationFramesPerSecond: +(animationFrames / seconds).toFixed(2),
      top: [...total.entries()]
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 25)
        .map(([name, t]) => ({
          name,
          ms: +t.ms.toFixed(2),
          count: t.count,
          percentOfACore: +((t.ms / (seconds * 1000)) * 100).toFixed(3),
        })),
    }
  }
  const idleTrace = await traceIdle(6).catch((error) => ({ error: String((error as Error).message ?? error) }))
  log("traccia da immobile", JSON.stringify(idleTrace).slice(0, 1500))

  // ---- the GPU time of a frame: the world draws its own view back to back with no cap, waiting for the GPU each time
  const timings: { frames: number; p50: number; p95: number; max: number; sync: string; timestampQuery: boolean }[] = []
  for (let rep = 1; rep <= 3; rep++) {
    timings.push(await ev(browser, `window.__nikverseBench(240)`, session, true))
    log(`GPU ${rep}`, JSON.stringify(timings.at(-1)))
  }
  const level = await ev(browser, `document.documentElement.dataset.quality`, session)

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

  // The baseline again, world closed once more: closed, open, closed. ADE's own load drifts, and a base taken only before
  // would blame the world for the drift.
  const baselineGpuRunsAfter: number[] = []
  for (let i = 0; i < 3; i++) baselineGpuRunsAfter.push(await cpuOf(gpuPid, 10))
  log("CPU del processo GPU a mondo chiuso, dopo:", baselineGpuRunsAfter.map((v) => v.toFixed(2)).join(", "), "%")
  const baselineGpuCpu = mean([...baselineGpuRuns, ...baselineGpuRunsAfter])

  // The GPU time the ceiling is held to: the worst of the eight shots of the level the world ran at, not the view a player starts in (a
  // close-up interior took 16 ms while that view took 3). The shots run in a headless browser on the same GPU, with ADE's world shut.
  const benchLevel = String(level ?? "media")
  let benchFile = arg("--bench")
  if (!benchFile) {
    benchFile = join(root, ".ade-test", "gate-bench", "bench.json")
    log(`le 8 inquadrature a ${benchLevel} (banco su Edge headless, GPU vera)`)
    spawnSync(
      "bun",
      [
        "scripts/nikverse-shots.ts",
        "--levels",
        benchLevel,
        "--no-clip",
        "--label",
        "gate",
        ...(TUNE ? ["--tune", TUNE] : []),
        "--out",
        join(root, ".ade-test", "gate-bench"),
      ],
      {
        cwd: adeDir,
        stdio: "ignore",
        timeout: 480_000,
      },
    )
    // A timeout kills the script and nothing of its own runs: the browser it left is taken here, not at somebody's next run.
    sweepOrphans([profilesDir(adeDir)])
  }
  const benchRows: BenchRow[] = existsSync(benchFile)
    ? (JSON.parse(readFileSync(benchFile, "utf8")) as { rows: BenchRow[] }).rows
    : []
  const worst = worstShot(benchRows, benchLevel)
  log(
    `peggiore delle 8 a ${benchLevel}: p95 ${worst.p95.toFixed(2)} ms nell'inquadratura ${worst.n} ${worst.name ?? ""}, scala ${worst.scale}`,
  )

  const rows = modes as unknown as { moving: any; still: any; immobile: any }[]
  const measures = {
    frameMb: Math.max(...cycles.map((c) => c.frameMb as number)),
    adeGrowthAfter5sMb: after5.adeMb - base.adeMb,
    adeGrowthAtRestMb: rest.adeMb - base.adeMb,
    adeHeapGrowthMb: Math.max(after5.adeHeapMb, rest.adeHeapMb) - base.adeHeapMb,
    immobileFrameCpuPercent: mean(rows.map((r) => r.immobile.frameCpu)),
    immobileGpuCpuPercent: mean(rows.map((r) => r.immobile.gpuCpu)),
    baselineGpuCpuPercent: baselineGpuCpu,
    movingFps: mean(rows.map((r) => r.moving.fps)),
    idleAnimationFramesPerSecond:
      "animationFramesPerSecond" in idleTrace ? (idleTrace.animationFramesPerSecond as number) : Number.NaN,
    gpuFrameP95Ms: worst.p95,
    gpuMemoryGrowthMb: Math.max(...cycles.map((c) => c.gpuMb as number)) - base.gpuMb,
  }
  const checks = gateChecks(measures)
  // No browser of the harness survives its script: the tests that start the stand-in and the real Edge, kept out of test:unit.
  const guardRun = spawnSync(
    "bun",
    ["test", "--conditions=browser", "--preload", "./happydom.ts", "./src/nikverse/browser-guard.test.ts"],
    { cwd: adeDir, stdio: "ignore", timeout: 300_000, env: { ...process.env, NIKVERSE_GUARD_TESTS: "1" } },
  )
  checks.push({ name: "browser guard tests (0 = green)", value: guardRun.status ?? 1, limit: 0, ok: guardRun.status === 0 })
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
      level,
      tune: TUNE ?? null,
      gpuTimings: timings,
      // The worst shot the ceiling was held to, and where the bench came from.
      worstShot: { ...worst, level: benchLevel, bench: benchFile },
      // The default view's p95 (ADE Test, `__nikverseBench`): information, not what the ceiling reads.
      defaultViewP95Ms: median(timings.map((t) => t.p95)),
      // The scale the level's resolution settled at for the default view (1 where the level does not move it).
      gpuScale: median(timings.map((t) => (t as { scale?: number }).scale ?? 1)),
      baselineGpuRuns,
      baselineGpuRunsAfter,
      idleTrace,
      immobileThread: rows.map((r) => ({
        task: r.immobile.threadTaskPercent,
        script: r.immobile.threadScriptPercent,
        layoutStyle: r.immobile.threadLayoutStylePercent,
      })),
      // The whole use of frame and GPU process, before the baseline is taken off: what the first live run reported as 2.5 to 3.4 %.
      immobileCpuAbsolutePercent: mean(rows.map((r) => r.immobile.frameCpu + r.immobile.gpuCpu)),
      immobileCostPercent: mean(rows.map((r) => immobileCost(r.immobile.frameCpu, r.immobile.gpuCpu, baselineGpuCpu))),
      modes,
    },
  })
} catch (error) {
  log("errore:", String((error as Error).message ?? error))
  finish(2, { ok: false, error: String((error as Error).message ?? error) })
} finally {
  clearTimeout(deadline)
}
