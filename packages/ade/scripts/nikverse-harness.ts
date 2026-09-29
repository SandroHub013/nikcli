/**
 * What the scripts that run NikVerse's world in a real browser share: the world's page and its 3D bundle (built in
 * memory) served on a local port the way the `nikverse` scheme serves them, with the same policy; a headless Edge
 * or Chrome of its own (a profile under `.ade-test/browsers`, its whole tree killed at the end, on any error, on a signal and
 * when the script dies: `src/nikverse/browser-guard.ts`; never ADE); and a line to it over CDP.
 * `nikverse-render-check.ts` and `nikverse-shots.ts` are built on it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildWorld } from "../src/nikverse/city/build-world"
import { guardBrowser, newProfile, profilesDir, sweepOrphans } from "../src/nikverse/browser-guard"

const root = join(import.meta.dir, "..")
const world = join(root, "src", "nikverse", "world")

export const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Acts as ADE: offers the world a port, tells it where the character stood (if it knows) and sends it the snapshot. */
export const actAsAde = (snapshot: object, spot?: { x: number; z: number; heading: number }) => `(async () => {
  const channel = new MessageChannel()
  window.__ade = { port: channel.port1, seen: [] }
  channel.port1.onmessage = (event) => window.__ade.seen.push(event.data)
  window.postMessage({ type: "nikverse:port", version: 1 }, "*", [channel.port2])
  for (let i = 0; i < 100 && !window.__ade.seen.some((m) => m.type === "ready"); i++) await new Promise((r) => setTimeout(r, 50))
  ${spot ? `channel.port1.postMessage({ type: "player", ...${JSON.stringify(spot)} })` : ""}
  channel.port1.postMessage({ type: "snapshot", snapshot: ${JSON.stringify(snapshot)} })
  return window.__ade.seen.some((m) => m.type === "ready")
})()`

export class Cdp {
  private id = 0
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  private listeners: Array<(method: string, params: any) => void> = []
  private constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== undefined) {
        const wait = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) wait?.reject(new Error(message.error.message))
        else wait?.resolve(message.result)
      } else for (const l of this.listeners) l(message.method, message.params)
    }
  }
  static async open(url: string) {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error("no websocket to the page"))
    })
    return new Cdp(ws)
  }
  send<T = any>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }))
  }
  on(fn: (method: string, params: any) => void) {
    this.listeners.push(fn)
  }
  close() {
    this.ws.close()
  }
}

export interface HarnessOptions {
  /** Where the pictures go. */
  out: string
  /** Extra routes of the script's own (a reference page, a fixture); `policy` is the world's, or `{}` for a page that is the harness's. */
  routes?(url: URL, policy: Record<string, string>): Response | undefined
  /** Paths served without the world's policy, because they are the script's own pages. */
  noPolicy?: string[]
  /**
   * `software` (the default): SwiftShader, the same on every machine, WebGL only. `real`: the machine's own GPU through
   * ANGLE/D3D11, with WebGPU, which is where Media and Alta are drawn.
   */
  gpu?: "software" | "real"
  /** Extra flags for the browser. */
  flags?: string[]
  /** The longest the browser may live, ms. Default 45 minutes. */
  maxMs?: number
}

export async function startHarness(options: HarnessOptions) {
  const CANDIDATES = [
    arg("--browser"),
    process.env.BROWSER_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].filter((p): p is string => Boolean(p))
  const browser = CANDIDATES.find((p) => existsSync(p))
  if (!browser) {
    console.error("no Edge or Chrome found; pass --browser PATH")
    process.exit(2)
  }
  mkdirSync(options.out, { recursive: true })
  // The browsers of earlier runs that died without closing theirs (a timeout, a closed terminal) go first; the old ones lived in %TEMP%.
  sweepOrphans([profilesDir(root)])

  const built = await buildWorld()
  if (!built.ok) throw new Error(built.errors.join("\n"))

  // The world's own policy, as the `nikverse` scheme sends it, with the host replaced by this server's: a
  // page that works here works there. Without it a `fetch` of a `blob:` address, say, would pass here and fail in ADE.
  const POLICY = readFileSync(join(root, "src-tauri", "src", "nikverse.rs"), "utf8").match(
    /pub const CSP: &str = "([^"]+)"/,
  )?.[1]
  if (!POLICY) throw new Error("no CSP found in nikverse.rs")
  const CSP = POLICY.replaceAll("http://nikverse.localhost nikverse:", "'self'")
  const LEVELS_DIR = join(root, "src-tauri", "nikverse-assets", "levels")
  const LOGO = readFileSync(join(root, "src", "nikverse", "city", "nikcli-logo-dark.svg"), "utf8")
  const text = (path: string) => readFileSync(join(world, path), "utf8")

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const policy: Record<string, string> = options.noPolicy?.includes(url.pathname)
        ? {}
        : { "content-security-policy": CSP }
      const send = (body: string, type: string) =>
        new Response(body, { headers: { "content-type": type, "cache-control": "no-store", ...policy } })
      const own = options.routes?.(url, policy)
      if (own) return own
      // N3's files: `/assets/levels/...` is the levels folder, the way the scheme serves it.
      const level = /^\/assets\/levels\/((?:bassa|media|alta)\/)?((?:lightmap\/)?[a-z_0-9]+\.(?:glb|png|ktx2))$/.exec(
        url.pathname,
      )
      if (level) {
        const file = Bun.file(join(LEVELS_DIR, level[1] ?? "", level[2]))
        const type = level[2].endsWith(".png")
          ? "image/png"
          : level[2].endsWith(".ktx2")
            ? "image/ktx2"
            : "model/gltf-binary"
        return new Response(file, { headers: { "content-type": type, "cache-control": "no-store", ...policy } })
      }
      switch (url.pathname) {
        case "/":
        case "/index.html":
          return send(text("index.html"), "text/html; charset=utf-8")
        case "/world.js":
          return send(text("world.js"), "text/javascript; charset=utf-8")
        case "/world.css":
          return send(text("world.css"), "text/css; charset=utf-8")
        case "/assets/world/city.js":
          return send(built.text, "text/javascript; charset=utf-8")
        case "/favicon.ico":
          return new Response(null, { status: 204 })
        case "/logo.svg":
          return send(LOGO, "image/svg+xml")
        default:
          return new Response("not found", { status: 404 })
      }
    },
  })
  const base = `http://127.0.0.1:${server.port}`

  const profile = newProfile(profilesDir(root))
  // The process this starts is a launcher that may hand over to the real browser and exit at once: the guard follows the profile, not this pid.
  Bun.spawn(
    [
      browser,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(options.gpu === "real"
        ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--enable-features=WebGPU"]
        : [
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
            "--enable-unsafe-webgpu",
          ]),
      "--hide-scrollbars",
      "--mute-audio",
      ...(options.flags ?? []),
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  )
  // From here the browser cannot outlive this process: not on an error below, not on a signal, not on a hard kill.
  const guard = guardBrowser({ profile, maxMs: options.maxMs })

  async function debuggingPort(): Promise<number> {
    const file = join(profile, "DevToolsActivePort")
    for (let i = 0; i < 300; i++) {
      try {
        if (existsSync(file)) {
          const port = Number(readFileSync(file, "utf8").split("\n")[0])
          if (port) return port
        }
      } catch {
        // The browser is writing the file at this moment (EBUSY on Windows): read it again.
      }
      await Bun.sleep(100)
    }
    throw new Error("the browser did not open its debugging port")
  }

  let closed = false
  const shutDown = (pages: Cdp[]) => {
    if (closed) return
    closed = true
    for (const line of pages) {
      try {
        line.close()
      } catch {
        // The line was never opened, or is already shut.
      }
    }
    guard.stop()
    server.stop(true)
  }
  const lines: Cdp[] = []
  try {
    return await launch()
  } catch (error) {
    shutDown(lines)
    throw error
  }

  async function launch() {
    const port = await debuggingPort()
    const targets: Array<{ type: string; webSocketDebuggerUrl: string }> = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json()
    const page = await Cdp.open(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl)
    lines.push(page)
    // The browser's own line, for what the pages cannot say: the CPU time of each of its processes.
    const version: { webSocketDebuggerUrl: string } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const browserLine = await Cdp.open(version.webSocketDebuggerUrl)
    lines.push(browserLine)
    /** CPU seconds so far, by process type (the page's renderer, the GPU process, the browser). */
    const cpuByProcess = async () => {
      const { processInfo } = await browserLine.send<{
        processInfo: Array<{ type: string; id: number; cpuTime: number }>
      }>("SystemInfo.getProcessInfo")
      return new Map(processInfo.map((p) => [`${p.type}:${p.id}`, p.cpuTime]))
    }
    const problems: string[] = []
    page.on((method, params) => {
      if (method === "Runtime.exceptionThrown")
        problems.push(`exception: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`)
      if (method === "Runtime.consoleAPICalled" && params.type === "error")
        problems.push(
          `console.error: ${params.args
            ?.map((a: any) => a.value ?? a.description)
            .join(" ")
            .slice(0, 300)}`,
        )
      if (method === "Log.entryAdded" && params.entry.level === "error")
        problems.push(`log: ${params.entry.text} ${params.entry.url ?? ""}`.slice(0, 300))
    })
    await page.send("Runtime.enable")
    await page.send("Log.enable")
    await page.send("Page.enable")

    const evaluate = async <T = any>(expression: string): Promise<T> => {
      const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value as T
    }

    async function open(path: string, size: { width: number; height: number }) {
      await page.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false })
      await page.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } })
      await page.send("Page.navigate", { url: `${base}${path}` })
    }

    async function until(condition: string, what: string, ms = 30_000) {
      const start = Date.now()
      while (Date.now() - start < ms) {
        if (await evaluate<boolean>(condition).catch(() => false)) return
        await Bun.sleep(150)
      }
      const info = await evaluate(
        `JSON.stringify({city: document.documentElement.dataset.city, error: document.documentElement.dataset.cityError, backend: document.documentElement.dataset.backend})`,
      ).catch(() => "?")
      throw new Error(`timeout waiting for ${what} ${info} ${problems.slice(0, 3).join(" | ")}`)
    }

    async function shot(name: string): Promise<string> {
      const { data } = await page.send("Page.captureScreenshot", { format: "png" })
      writeFileSync(join(options.out, `${name}.png`), Buffer.from(data, "base64"))
      return data
    }

    return {
      base,
      page,
      browserLine,
      cpuByProcess,
      problems,
      evaluate,
      open,
      until,
      shot,
      close: () => shutDown(lines),
    }
  }
}
