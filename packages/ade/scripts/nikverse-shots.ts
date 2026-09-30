/**
 * The bench of NikVerse's look: eight fixed shots at each level, and a walking clip, in a real browser.
 *
 * Each shot is the fixed scene (`src/nikverse/city/shots.ts`: six shops, eighteen people, the world clock at 12.0 s)
 * from one fixed camera, drawn once at 1600×900 with a pixel ratio of 1 by the world's own page (`?shot=N&quality=…`).
 * The page reads its own canvas in the task that draws it and hands back the PNG and the numbers; this script writes
 * `<level>-<n>-<name>.png` and `.jpg`, checks the numbers (no NaN or pure-black pixels outside the sky, at most 2 % burnt,
 * the mean luminance inside the shot's band) and records a 10 s walk through the same scene as `<level>.webm`
 * (CDP screencast, ffmpeg when it is installed). With `--checks` it also runs the render check with the logo held to
 * 100 % of the pixels within ΔE 3.
 *
 *   bun scripts/nikverse-shots.ts --label prima [--out DIR] [--levels bassa,media] [--shots 1,2,…] [--gpu real|software] [--no-clip] [--checks] [--browser PATH]
 *
 * Writes `bench.json` next to the pictures. Exits 1 when a check fails. Time cap: 10 minutes.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SHOTS, shotPicture } from "../src/nikverse/city/shots"
import type { GpuTiming } from "../src/nikverse/city/bench"
import { drawnOver } from "../src/nikverse/city/drawn"
import type { ShotResult } from "../src/nikverse/city/shot-handle"
import { GATE_LIMITS } from "../src/nikverse/gate"
import { SCALE_DOWN_ABOVE_MS, SCALE_MIN } from "../src/nikverse/city/resolution"
import { actAsAde, arg, startHarness } from "./nikverse-harness"

const label = arg("--label") ?? "shots"
const out = arg("--out") ?? join(tmpdir(), "nikverse-shots", label)
const levels = (arg("--levels") ?? "bassa,media").split(",").filter(Boolean)
const only = arg("--shots")?.split(",").map(Number)
// For measuring: `--tune samples=1&maxscale=0.9` rides on the shot pages' query (`CityDeps.tune`); the pictures name it in `label`.
const tune = arg("--tune")
const NONCE = "0123456789abcdef".repeat(3)
mkdirSync(out, { recursive: true })

const deadline = setTimeout(() => {
  console.error("time cap of 10 minutes reached")
  process.exit(1)
}, 600_000)

const { page, problems, evaluate, open, until, close } = await startHarness({
  out,
  gpu: arg("--gpu") === "software" ? "software" : "real",
})

/** The scene as ADE would send it: for the walking clip. */
function snapshot() {
  const picture = shotPicture()
  return { at: 1, shops: [...picture.shops.values()], agents: [...picture.agents.values()], waiting: { decisions: 0 } }
}

interface Row {
  level: string
  n: number
  name: string
  backend: string
  resolved: string
  width: number
  height: number
  stats: ShotResult["stats"]
  problems: string[]
  png: string
  jpg: string
  /** The GPU time of the shot's view, drawn back to back (`window.__nikverseBench`): undefined when it could not be taken. */
  gpu?: GpuTiming
  /** What the frame drew: triangles and draw calls, as the renderer counts them. */
  drawn?: { calls: number; triangles: number }
  /** The same frame part by part (`city/drawn.ts`): vegetation, palms, terrain, water, shops, people, sky, the rest. */
  split?: ShotResult["split"]
}
const rows: Row[] = []
const failures: string[] = []
const fail = (text: string) => {
  failures.push(text)
  console.log(`FAIL  ${text}`)
}

async function shots(level: string) {
  for (const shot of SHOTS.filter((s) => !only || only.includes(s.n))) {
    const name = `${level}-${shot.n}-${shot.name}`
    try {
      problems.length = 0
      await open(`/?shot=${shot.n}&quality=${level}${tune ? `&${tune}` : ""}#n=${NONCE}`, { width: 1600, height: 900 })
      await until(
        `document.documentElement.dataset.shot === "ready" || document.documentElement.dataset.shot === "failed" || document.documentElement.dataset.city === "failed"`,
        `shot ${name}`,
        120_000,
      )
      const state = await evaluate<string>(
        `JSON.stringify({shot: document.documentElement.dataset.shot, city: document.documentElement.dataset.city, error: document.documentElement.dataset.shotError ?? document.documentElement.dataset.cityError, quality: document.documentElement.dataset.quality, why: document.documentElement.dataset.qualityWhy})`,
      )
      const info = JSON.parse(state) as { shot?: string; city?: string; error?: string; quality?: string; why?: string }
      if (info.shot !== "ready") throw new Error(`the page did not take the shot: ${info.error ?? state}`)
      const result = await evaluate<ShotResult>(`window.__nikverseShot`)
      const gpu = await evaluate<GpuTiming>(`window.__nikverseBench(120)`).catch(() => undefined)
      const bytes = (data: string) => Buffer.from(data.slice(data.indexOf(",") + 1), "base64")
      writeFileSync(join(out, `${name}.png`), bytes(result.png))
      writeFileSync(join(out, `${name}.jpg`), bytes(result.jpg))
      const found = [...result.problems]
      if (info.quality !== level) found.push(`asked for ${level} and the page drew ${info.quality} (${info.why})`)
      if (problems.length) found.push(`${problems.length} browser errors: ${problems[0]}`)
      found.push(...drawnOver(result.drawn, result.split))
      rows.push({
        level,
        n: shot.n,
        name: shot.name,
        backend: result.backend,
        resolved: info.quality ?? "?",
        width: result.width,
        height: result.height,
        stats: result.stats,
        problems: found,
        png: `${name}.png`,
        jpg: `${name}.jpg`,
        gpu,
        drawn: result.drawn,
        split: result.split,
      })
      const s = result.stats
      console.log(
        `${found.length ? "FAIL" : "PASS"}  ${name} [${result.backend}]: luminance ${s.luminance.toFixed(3)} (band ${shot.luminance.join("..")}), sky ${(s.sky * 100).toFixed(1)} %, black ${(s.black * 100).toFixed(3)} %, burnt ${(s.burnt * 100).toFixed(3)} %, GPU ${gpu ? `p50 ${gpu.p50.toFixed(1)} ms, p95 ${gpu.p95.toFixed(1)} ms (${gpu.sync}${gpu.scale !== undefined ? `, scale ${gpu.scale}` : ""})` : "n/a"}${result.drawn ? `, drawn ${Math.round(result.drawn.triangles / 1000)}k tris ${result.drawn.calls} calls` : ""}${found.length ? ` — ${found.join("; ")}` : ""}`,
      )
      if (result.split)
        console.log(
          `      split: ${Object.entries(result.split)
            .filter(([, p]) => p.calls > 0)
            .map(([part, p]) => `${part} ${(p.triangles / 1000).toFixed(1)}k/${p.calls}`)
            .join(", ")}`,
        )
      for (const f of found) failures.push(`${name}: ${f}`)
    } catch (error) {
      fail(`${name}: ${String((error as Error).message ?? error)}`)
    }
  }
}

/** Where the frames of the screencast in progress go: the line to the page has one listener for the whole run. */
let collect: ((params: any) => void) | undefined
page.on((method, params) => {
  if (method !== "Page.screencastFrame") return
  collect?.(params)
  void page.send("Page.screencastFrameAck", { sessionId: params.sessionId })
})

/** A ten-second walk through the scene: the frames of a screencast, put together by ffmpeg. */
async function clip(level: string) {
  const dir = join(out, `.frames-${level}`)
  mkdirSync(dir, { recursive: true })
  try {
    problems.length = 0
    await open(`/?quality=${level}#n=${NONCE}`, { width: 1280, height: 720 })
    await until(
      `document.documentElement.dataset.ready === "1" || document.documentElement.dataset.city === "failed"`,
      `the city at ${level}`,
      120_000,
    )
    if (!(await evaluate<boolean>(actAsAde(snapshot())))) throw new Error("the world did not say ready")
    // The shops rise in 0.8 s.
    await Bun.sleep(1800)
    const frames: Array<{ file: string; at: number }> = []
    collect = (params) => {
      const file = join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`)
      writeFileSync(file, Buffer.from(params.data, "base64"))
      frames.push({ file, at: params.metadata.timestamp })
    }
    await page.send("Page.startScreencast", {
      format: "jpeg",
      quality: 85,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    })
    const keys: Record<string, [string, number]> = { w: ["KeyW", 87], a: ["KeyA", 65], d: ["KeyD", 68] }
    const hold = async (letter: string, ms: number) => {
      const [code, vk] = keys[letter]
      const base = { code, key: letter, windowsVirtualKeyCode: vk }
      await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base })
      await Bun.sleep(ms)
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
    }
    // The same route every time: toward the square, round the hologram, and out along the ring.
    for (const [letter, ms] of [
      ["w", 2500],
      ["d", 1500],
      ["w", 3000],
      ["a", 1500],
      ["w", 1500],
    ] as const)
      await hold(letter, ms)
    await page.send("Page.stopScreencast")
    await Bun.sleep(200)
    collect = undefined
    if (frames.length < 2) throw new Error(`the screencast gave ${frames.length} frames`)
    const ffmpeg = Bun.which("ffmpeg") ?? "ffmpeg"
    // Frames are shown for as long as they were on screen.
    const list = frames.map(
      (f, i) =>
        `file '${f.file.replaceAll("\\", "/")}'\nduration ${((frames[i + 1]?.at ?? f.at + 0.1) - f.at || 0.033).toFixed(4)}`,
    )
    list.push(`file '${frames[frames.length - 1].file.replaceAll("\\", "/")}'`)
    writeFileSync(join(dir, "list.txt"), list.join("\n"))
    const target = join(out, `${level}.webm`)
    const made = Bun.spawnSync(
      [
        ffmpeg,
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        join(dir, "list.txt"),
        "-vf",
        "fps=30",
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "34",
        "-b:v",
        "0",
        target,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    if (made.exitCode !== 0 || !existsSync(target))
      throw new Error(`ffmpeg did not make the clip: ${made.stderr.toString().slice(0, 200)}`)
    const seconds = frames[frames.length - 1].at - frames[0].at
    console.log(
      `PASS  ${level} clip: ${frames.length} frames over ${seconds.toFixed(1)} s${problems.length ? `, ${problems.length} browser errors: ${problems[0]}` : ""}`,
    )
    if (problems.length) failures.push(`${level} clip: ${problems.length} browser errors: ${problems[0]}`)
  } catch (error) {
    fail(`${level} clip: ${String((error as Error).message ?? error)}`)
  } finally {
    collect = undefined
    // The frames are kept only as long as ffmpeg needs them.
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The render check as a child, with the logo held to 100 % within ΔE 3: what the bench asks of every effect. */
function checks(): unknown {
  const file = join(out, "render-check.json")
  const ran = Bun.spawnSync(
    [
      "bun",
      join(import.meta.dir, "nikverse-render-check.ts"),
      "--strict-logo",
      "--json",
      file,
      "--out",
      join(out, "render-check"),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  )
  console.log(
    ran.stdout
      .toString()
      .split("\n")
      .filter((l) => /^(PASS|FAIL)/.test(l))
      .join("\n"),
  )
  if (ran.exitCode !== 0) failures.push("the render check failed (logo at 100 % within ΔE 3, or another check)")
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined
}

try {
  for (const level of levels) await shots(level)
  // The Architect's ceiling: the worst of the eight shots, not the view a player starts in, at every level that has the GPU's own clock.
  for (const level of levels) {
    const timed = rows.filter((r) => r.level === level && r.gpu?.sync === "timestamp")
    if (!timed.length) continue
    const worst = timed.reduce((a, b) => ((b.gpu?.p95 ?? 0) > (a.gpu?.p95 ?? 0) ? b : a))
    const limit = GATE_LIMITS.gpuFrameP95Ms
    const ok = (worst.gpu?.p95 ?? Number.NaN) <= limit
    const scaled = timed.filter((r) => r.gpu?.scale !== undefined)
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${level} worst GPU p95 of the shots: ${worst.gpu?.p95.toFixed(1)} ms in shot ${worst.n} ${worst.name}, at scale ${worst.gpu?.scale ?? 1} (ceiling ${limit} ms)`,
    )
    if (!ok)
      failures.push(
        `${level}: worst GPU p95 ${worst.gpu?.p95.toFixed(1)} ms in shot ${worst.n} ${worst.name}, over ${limit} ms`,
      )
    // A shot that is still over the governor's line at the smallest scale would need less than 0.75: red, whatever the ceiling says.
    for (const r of scaled)
      if ((r.gpu!.scale ?? 1) <= SCALE_MIN && (r.gpu!.p95 ?? 0) > SCALE_DOWN_ABOVE_MS) {
        console.log(`FAIL  ${level} shot ${r.n} ${r.name}: ${r.gpu!.p95.toFixed(1)} ms at the smallest scale (${SCALE_MIN}), it would need less`)
        failures.push(`${level}: shot ${r.n} ${r.name} does not fit at scale ${SCALE_MIN} (${r.gpu!.p95.toFixed(1)} ms over ${SCALE_DOWN_ABOVE_MS})`)
      }
  }
  if (!process.argv.includes("--no-clip")) for (const level of levels) await clip(level)
  const render = process.argv.includes("--checks") ? checks() : undefined
  writeFileSync(
    join(out, "bench.json"),
    JSON.stringify({ label, at: new Date().toISOString(), levels, rows, renderCheck: render, failures }, null, 2),
  )
  console.log(`${rows.length} shots in ${out}; ${failures.length} problems`)
} finally {
  clearTimeout(deadline)
  close()
}
process.exit(failures.length ? 1 : 0)
