/**
 * Renders NikVerse's world in a real browser and checks what it draws.
 *
 * It serves the world's page and the 3D bundle (built in memory) on a local port, the way the
 * `nikverse` scheme does, starts a headless Edge or Chrome of its own (a temporary profile, killed at
 * the end: never ADE), and drives it over CDP:
 *
 *   1. `?check=logo`: the logo flat and front-on at 960×1200, compared with the brand's SVG drawn by
 *      the same browser at the same size. Passes at ≥ 99.5 % of pixels within ΔE 3 and a silhouette
 *      IoU ≥ 0.995 (the plan's thresholds).
 *   2. The city, fed a picture the way ADE feeds it (a MessageChannel and a snapshot): it must start,
 *      draw, and take a key: W held moves the character, so the picture changes.
 *
 * Both run on the classic WebGL renderer (`?renderer=classic`) and on whatever the world picks by itself
 * (`WebGPURenderer` when the browser has a WebGPU adapter, the classic one when it has not).
 * A backend that the headless browser does not have is reported, not failed.
 *
 *   bun scripts/nikverse-render-check.ts [--out DIR] [--browser PATH] [--json FILE] [--strict-logo]
 *
 * `--json FILE` writes every check as {name, ok, detail}; `--strict-logo` asks the logo check for 100 % of the pixels
 * within ΔE 3, as the bench does (an effect must never touch the logo).
 * Exits 1 when a check fails. Time cap: 5 minutes.
 */

import { existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bc1Ktx2 } from "../src/nikverse/city/fixtures/make-ktx2"
import { actAsAde, arg, startHarness } from "./nikverse-harness"

const root = join(import.meta.dir, "..")
const out = arg("--out") ?? join(tmpdir(), "nikverse-render-check")
const LEVELS_DIR = join(root, "src-tauri", "nikverse-assets", "levels")
const NONCE = "0123456789abcdef".repeat(3)

const deadline = setTimeout(() => {
  console.error("time cap of 5 minutes reached")
  process.exit(1)
}, 300_000)

// The server, the browser and the line to it are `nikverse-harness.ts`'s; this script adds its own two pages.
const { base, page, browserLine, cpuByProcess, problems, evaluate, open, until, shot, close } = await startHarness({
  out,
  // The reference page is the harness's own (it compares pictures through `data:` addresses): no policy on it.
  noPolicy: ["/reference.html"],
  routes(url, policy) {
    // A KTX2 file in the GPU's own format (BC1), made here, for the check of the KTX2 path.
    if (url.pathname === "/fixtures/bc1.ktx2") return new Response(bc1Ktx2(8, 8), { headers: { "content-type": "image/ktx2", "cache-control": "no-store", ...policy } })
    if (url.pathname === "/reference.html")
      return new Response(
        '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}img{display:block;width:960px;height:1200px}</style><img id="logo" src="/logo.svg">',
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...policy } },
      )
    return undefined
  },
})

/** The two pictures compared in the browser: pixels within ΔE 3, and the silhouettes' IoU. */
const COMPARE = `(async (a, b) => {
  const load = async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob())
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const g = canvas.getContext("2d", { willReadFrequently: true })
    g.fillStyle = "#808080"
    g.fillRect(0, 0, bitmap.width, bitmap.height)
    g.drawImage(bitmap, 0, 0)
    const raw = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d", { willReadFrequently: true })
    raw.drawImage(bitmap, 0, 0)
    return { flat: g.getImageData(0, 0, bitmap.width, bitmap.height), alpha: raw.getImageData(0, 0, bitmap.width, bitmap.height), w: bitmap.width, h: bitmap.height }
  }
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const lab = (r, g, bl) => {
    const R = lin(r), G = lin(g), B = lin(bl)
    const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]
  }
  const A = await load(a), B = await load(b)
  if (A.w !== B.w || A.h !== B.h) return { error: "sizes differ", a: [A.w, A.h], b: [B.w, B.h] }
  let close = 0, inter = 0, union = 0, worst = 0
  const n = A.w * A.h
  for (let i = 0; i < n; i++) {
    const p = i * 4
    const la = lab(A.flat.data[p], A.flat.data[p + 1], A.flat.data[p + 2]), lb = lab(B.flat.data[p], B.flat.data[p + 1], B.flat.data[p + 2])
    const de = Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2])
    if (de <= 3) close++
    worst = Math.max(worst, de)
    const sa = A.alpha.data[p + 3] > 127, sb = B.alpha.data[p + 3] > 127
    if (sa && sb) inter++
    if (sa || sb) union++
  }
  return { pixels: n, closeShare: close / n, iou: union ? inter / union : 1, worstDeltaE: worst }
})`

let failed = 0
const results: Array<{ name: string; ok: boolean; detail: string }> = []
const strictLogo = process.argv.includes("--strict-logo")
const report = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed++
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`)
}

async function logoCheck(renderer: "classic" | "auto") {
  const label = renderer === "classic" ? "classic WebGL (asked for)" : "auto"
  try {
    problems.length = 0
    await open(`/reference.html`, { width: 960, height: 1200 })
    await until(`document.getElementById("logo")?.complete === true`, "the reference image")
    const reference = await shot("logo-reference")
    await open(`/?check=logo${renderer === "classic" ? "&renderer=classic" : ""}`, { width: 960, height: 1200 })
    await until(`document.documentElement.dataset.ready === "1" || document.documentElement.dataset.city === "failed"`, "the check picture")
    if ((await evaluate<string>(`document.documentElement.dataset.city`)) === "failed")
      throw new Error(`the city did not start: ${await evaluate(`document.documentElement.dataset.cityError`)}`)
    await Bun.sleep(300)
    const backend = await evaluate<string>(`document.documentElement.dataset.backend`)
    const mine = await shot(`logo-check-${renderer}`)
    await open(`/reference.html`, { width: 960, height: 1200 })
    await until(`document.getElementById("logo")?.complete === true`, "the reference image")
    const result = await evaluate<any>(`${COMPARE}(${JSON.stringify(mine)}, ${JSON.stringify(reference)})`)
    if (result.error) throw new Error(JSON.stringify(result))
    report(
      `logo ${label} [${backend}]`,
      (strictLogo ? result.closeShare === 1 : result.closeShare >= 0.995) && result.iou >= 0.995,
      `${(result.closeShare * 100).toFixed(3)} % of pixels within ΔE 3, IoU ${result.iou.toFixed(5)}, worst ΔE ${result.worstDeltaE.toFixed(2)}${problems.length ? `, ${problems.length} browser errors: ${problems[0]}` : ""}`,
    )
  } catch (error) {
    report(`logo ${label}`, false, String((error as Error).message ?? error))
  }
}

const SNAPSHOT = {
  at: 1,
  shops: [
    { id: "s1", name: "nikcli", slot: 0 },
    { id: "s2", name: "un-progetto-con-un-nome-molto-lungo-davvero", slot: 1 },
    { id: "s3", name: "ade", slot: 2 },
  ],
  agents: [
    ["p1", "s1", "work"],
    ["p2", "s1", "perm"],
    ["p3", "s1", "ask"],
    ["p4", "s2", "err"],
    ["p5", "s2", "idle"],
    ["p6", "s3", "limit"],
    ["p7", "s3", "off"],
  ].map(([paneId, shop, state], i) => ({ paneId, title: paneId, kind: "claude-code", shop, state, since: 1, look: { body: i, palette: i } })),
  waiting: { decisions: 0 },
}

const asAde = (spot?: { x: number; z: number; heading: number }) => actAsAde(SNAPSHOT, spot)

async function cityCheck(renderer: "classic" | "auto") {
  const label = renderer === "classic" ? "classic WebGL (asked for)" : "auto"
  try {
    problems.length = 0
    await open(`/?${renderer === "classic" ? "renderer=classic" : "x=1"}#n=${NONCE}`, { width: 1100, height: 700 })
    await until(`document.documentElement.dataset.ready === "1" || document.documentElement.dataset.city === "failed"`, "the city")
    if ((await evaluate<string>(`document.documentElement.dataset.city`)) === "failed")
      throw new Error(`the city did not start: ${await evaluate(`document.documentElement.dataset.cityError`)}`)
    const backend = await evaluate<string>(`document.documentElement.dataset.backend`)
    const castState = await evaluate<string>(`document.documentElement.dataset.cast + " kit " + document.documentElement.dataset.kit + " " + (document.documentElement.dataset.qualityWhy ?? "")`)
    const levelState = await evaluate<string>(`document.documentElement.dataset.quality + " (" + document.documentElement.dataset.qualityWhy + ")"`)
    console.log(`  [${renderer}] cast: ${castState.trim()}; level: ${levelState}`)
    const castOk = castState.startsWith("ok kit ok")
    const ready = await evaluate<boolean>(asAde())
    // The shops rise in 0.8 s.
    await Bun.sleep(1800)
    const before = await shot(`city-${renderer}-1-start`)
    // W held for a second: the character walks toward the square, and the picture changes.
    const codes: Record<string, [string, number]> = { w: ["KeyW", 87], a: ["KeyA", 65], d: ["KeyD", 68] }
    /** Holds a key until `done(x, z)` says so, or a minute passes: a software renderer draws few frames a second, so time is not the measure. */
    const holdUntil = async (letter: string, done: (x: number, z: number) => boolean, run = false) => {
      const [code, vk] = codes[letter]
      const base = { code, key: letter, windowsVirtualKeyCode: vk, modifiers: run ? 8 : 0 }
      await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base })
      if (run) await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16, modifiers: 8 })
      const start = Date.now()
      let at = await where()
      while (Date.now() - start < 60_000) {
        const [x, z] = at.split(",").map(Number)
        if (done(x, z)) break
        await Bun.sleep(100)
        at = await where()
      }
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
      if (run) await page.send("Input.dispatchKeyEvent", { type: "keyUp", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16 })
      await Bun.sleep(400)
      return at
    }
    const pressKey = async (letter: string, code: string, vk: number) => {
      await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code, key: letter, windowsVirtualKeyCode: vk })
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", code, key: letter, windowsVirtualKeyCode: vk })
      await Bun.sleep(400)
    }
    await evaluate(`document.querySelector("canvas.city")?.focus()`)
    const where = () => evaluate<string>(`document.documentElement.dataset.at`)
    const from = await where()
    const first = await holdUntil("w", (_x, z) => z <= 3.5)
    const after = await shot(`city-${renderer}-2-walked`)
    console.log(`  [${renderer}] W: ${from} -> ${first}`)
    // Round the projector, and on to the first shop's door, straight ahead of the square.
    const round = await holdUntil("d", (x) => x >= 4)
    const along = await holdUntil("w", (_x, z) => z <= -10, true)
    await holdUntil("a", (x) => Math.abs(x) <= 0.4)
    // The first shop stands at (0, -19) with its door, 3.8 wide, in the front wall at z = -16.5.
    await holdUntil("w", (_x, z) => z <= -14.5)
    const [doorX, doorZ] = (await where()).split(",").map(Number)
    await shot(`city-${renderer}-3-at-the-door`)
    // E outside, in front of the door, opens nothing: no computer is within reach.
    const far = await evaluate<number>(`window.__ade.seen.filter((m) => m.type === "command").length`)
    await pressKey("e", "KeyE", 69)
    const farCommands = (await evaluate<number>(`window.__ade.seen.filter((m) => m.type === "command").length`)) - far
    // In, between the two desks of the window row (the aisle is 0.54 m and the body 0.44), to the chairs of the back row.
    const inside = await holdUntil("w", (_x, z) => z <= -18.6)
    await shot(`city-${renderer}-4-inside`)
    const [ix, iz] = inside.split(",").map(Number)
    // At a desk: E next to a computer opens that session.
    await holdUntil("a", (x) => x <= -0.6)
    const hintShown = await evaluate<string>(`document.getElementById("hint").hidden ? "" : document.getElementById("hint").textContent`)
    await shot(`city-${renderer}-5-at-a-desk`)
    // The people up close, for a look: the camera raised over the wall, behind the character and then in front of it.
    // Synthetic pointer events with a movement, from a corner where nothing can be picked: CDP's own mouse
    // events carry no `movementX`, which is what turns the camera.
    const dragBy = async (dx: number, dy: number) => {
      await evaluate(`(() => {
        const canvas = document.querySelector("canvas.city")
        const at = { clientX: 4, clientY: 4, button: 0, bubbles: true, pointerId: 1 }
        canvas.dispatchEvent(new PointerEvent("pointerdown", at))
        canvas.dispatchEvent(new PointerEvent("pointermove", { ...at, movementX: ${dx}, movementY: ${dy} }))
        window.dispatchEvent(new PointerEvent("pointerup", at))
      })()`)
      await Bun.sleep(1500)
    }
    await dragBy(0, 260)
    await shot(`city-${renderer}-6-desks-from-above`)
    await dragBy(1257, 0)
    await shot(`city-${renderer}-7-desks-from-the-front`)
    // Back behind the character, where the next step needs it.
    await dragBy(-1257, -260)
    await pressKey("e", "KeyE", 69)
    const commands = await evaluate<any[]>(`window.__ade.seen.filter((m) => m.type === "command").map((m) => m.command)`)
    const opened = commands.at(-1)
    // The software renderer overshoots by a step, so the chair next to the wanted one may be the nearest:
    // what must hold is that the hint names the session E then opens, and that it is one of that shop's.
    const eOk = farCommands === 0 && opened?.cmd === "open-session" && ["p1", "p2", "p3"].includes(opened?.paneId) && hintShown === `E · apri ${opened.paneId}`
    console.log(`  [${renderer}] E at the door: ${farCommands} commands; at desk 1 (${await where()}): hint "${hintShown}", command ${JSON.stringify(opened)}`)
    // Paused, no frame is drawn; resumed, they come again.
    const frames = () => evaluate<number>(`window.__nikverseFrames ?? 0`)
    await evaluate(`window.__ade.port.postMessage({ type: "pause" })`)
    await Bun.sleep(500)
    const paused1 = await frames()
    await Bun.sleep(1500)
    const paused2 = await frames()
    await evaluate(`window.__ade.port.postMessage({ type: "resume" })`)
    await Bun.sleep(1500)
    const resumed = await frames()
    const pauseOk = paused1 === paused2 && resumed > paused2
    console.log(`  [${renderer}] frames: ${paused1} -> ${paused2} paused, ${resumed} after resume`)
    // The character's place goes to ADE when it stops, and comes back when ADE gives it.
    const positions = await evaluate<any[]>(`window.__ade.seen.filter((m) => m.type === "position")`)
    const lastPosition = positions.at(-1)
    const [px, pz] = (await where()).split(",").map(Number)
    const positionOk = positions.length >= 1 && Math.abs(lastPosition.x - px) < 0.6 && Math.abs(lastPosition.z - pz) < 0.6
    console.log(`  [${renderer}] positions sent to ADE: ${positions.length}, last ${JSON.stringify(lastPosition)}, now ${px},${pz}`)
    // A place that arrives late does not pull the character away from where the user took it.
    await evaluate(`window.__ade.port.postMessage({ type: "player", x: 7, z: 5, heading: 1 })`)
    await Bun.sleep(800)
    const [lx, lz] = (await where()).split(",").map(Number)
    const lateIgnored = Math.abs(lx - px) < 0.6 && Math.abs(lz - pz) < 0.6
    // A new frame is told where the character stood when it says ready, and starts there.
    // Another query, so that it is a new document and not the same address with its fragment.
    await open(`/?${renderer === "classic" ? "renderer=classic&again=1" : "again=1"}#n=${NONCE}`, { width: 1100, height: 700 })
    await until(`document.documentElement.dataset.ready === "1" && window.__ade === undefined`, "the city again")
    await evaluate<boolean>(asAde({ x: 7, z: 5, heading: 1 }))
    await Bun.sleep(1500)
    const [rx, rz] = (await where()).split(",").map(Number)
    const restoreOk = lateIgnored && Math.abs(rx - 7) < 0.6 && Math.abs(rz - 5) < 0.6
    console.log(`  [${renderer}] late place ${lateIgnored ? "ignored" : "FOLLOWED"}; new frame starts at ${rx},${rz}`)
    // Three ways to draw: walking draws every frame, standing draws few, ten quiet seconds draw nothing until an event.
    const modeOf = () => evaluate<string>(`document.documentElement.dataset.drawMode`)
    const still = await modeOf()
    await Bun.sleep(11_000)
    const immobile = await modeOf()
    const idle1 = await frames()
    // What runs when nothing is drawn: the CPU time of every process over ten seconds, as a share of one core.
    const cpuBefore = await cpuByProcess()
    await Bun.sleep(10_000)
    const cpuAfter = await cpuByProcess()
    const share = [...cpuAfter].map(([key, after]) => `${key} ${(((after - (cpuBefore.get(key) ?? after)) / 10) * 100).toFixed(2)}%`)
    console.log(`  [${renderer}] CPU while immobile, over 10 s: ${share.join(", ")}`)
    const idle2 = await frames()
    await evaluate(`window.__ade.port.postMessage({ type: "snapshot", snapshot: ${JSON.stringify({ ...SNAPSHOT, at: 2, shops: SNAPSHOT.shops.slice(0, 2) })} })`)
    await Bun.sleep(1500)
    const woken = await frames()
    const modeOk = (still === "still" || still === "moving") && immobile === "immobile" && idle1 === idle2 && woken > idle2
    console.log(`  [${renderer}] draw modes: ${still} -> ${immobile}, frames ${idle1} -> ${idle2} while immobile, ${woken} after an event`)
    // The first shop stands at (0, -19) with its door toward the square: inside is between its walls (6 wide, 5 deep).
    const entered = Math.abs(ix) < 2.9 && iz < -17.6 && iz > -21
    console.log(`  [${renderer}] D: ${round}, run W: ${along}, at the door ${doorX},${doorZ}, inside: ${inside}`)
    const status = await evaluate<string>(`document.getElementById("status").textContent`)
    const changed = before !== after
    report(
      `city ${label} [${backend}]`,
      ready && castOk && changed && entered && eOk && pauseOk && positionOk && restoreOk && modeOk && problems.length === 0,
      `cast and city ${castOk ? "loaded" : "NOT loaded"}, port ${ready ? "handed" : "NOT handed"}, status "${status}", picture ${changed ? "changed" : "did NOT change"} after W, walked ${entered ? "into" : "NOT into"} the first shop through its door, E ${eOk ? "opens the right session" : "WRONG"}, pause ${pauseOk ? "stops the frames" : "did NOT stop them"}, position ${positionOk ? "reaches ADE" : "did NOT reach ADE"} and ${restoreOk ? "comes back" : "did NOT come back"}, draw modes ${modeOk ? "as planned" : "WRONG"}${problems.length ? `, ${problems.length} browser errors: ${problems.slice(0, 2).join(" | ")}` : ""}`,
    )
  } catch (error) {
    report(`city ${label}`, false, String((error as Error).message ?? error))
  }
}

/** Every level's four characters loaded the way the world loads them, under the world's policy: the pictures decode at the level's size. */
async function levelsCheck() {
  try {
    problems.length = 0
    // Alta's 2K set is a developer's local copy: it is checked where it is.
    const present = ["bassa", "media", "alta"].filter((level) => existsSync(join(LEVELS_DIR, level, "character_user.glb")))
    await open(`/?check=logo&levels=1`, { width: 400, height: 300 })
    await until(`document.documentElement.dataset.ready === "1"`, "the page")
    const result = await evaluate<Record<string, { sizes: number[]; ms: number }>>(`(async () => {
      const m = await import("/assets/world/city.js")
      const out = {}
      for (const level of ${JSON.stringify(present)}) {
        const t0 = performance.now()
        const cast = await m.loadCast({ base: location.origin + "/assets/", level, fetchBytes: (u) => fetch(u).then((r) => r.arrayBuffer()), decode: m.decodePicture })
        const sizes = []
        for (const template of cast.values()) {
          let width = 0
          template.scene.traverse((o) => { if (o.material?.map?.image) width = Math.max(width, o.material.map.image.width) })
          sizes.push(width)
        }
        out[level] = { sizes, ms: Math.round(performance.now() - t0) }
      }
      return out
    })()`)
    const want: Record<string, number> = { bassa: 512, media: 1024, alta: 2048 }
    const ok = present.every((level) => result[level].sizes.length === 4 && result[level].sizes.every((w) => w === want[level]))
    report(
      "levels: the cast of each loads and its pictures decode",
      ok && problems.length === 0,
      Object.entries(result)
        .map(([level, r]) => `${level} ${r.sizes.join("/")} px in ${r.ms} ms`)
        .join(", ") + (problems.length ? `, ${problems.length} browser errors: ${problems[0]}` : ""),
    )
  } catch (error) {
    report("levels", false, String((error as Error).message ?? error))
  }
}

/**
 * A KTX2 file decoded by three's loader under the world's real policy: read on the main thread, with the
 * policy as it is (no `blob:`, no eval): a violation would be a browser error and the check would fail.
 */
async function ktx2Check() {
  try {
    problems.length = 0
    await open(`/?check=logo&ktx2=1`, { width: 400, height: 300 })
    await until(`document.documentElement.dataset.ready === "1"`, "the page")
    const result = await evaluate<{ width: number; height: number; compressed: boolean; srgb: boolean; ms: number }>(`(async () => {
      const m = await import("/assets/world/city.js")
      // What the loader asks of a renderer, from a real WebGL context: the compressed formats it offers.
      const gl = document.createElement("canvas").getContext("webgl2")
      const renderer = { extensions: { has: (n) => !!gl.getExtension(n), get: (n) => gl.getExtension(n) } }
      const decoder = m.createPictureDecoder(renderer)
      const bytes = new Uint8Array(await (await fetch("/fixtures/bc1.ktx2")).arrayBuffer())
      const t0 = performance.now()
      const texture = await Promise.race([
        decoder.decode(bytes, false),
        new Promise((_, no) => setTimeout(() => no(new Error("no answer from the KTX2 loader in 15 s")), 15000)),
      ])
      decoder.dispose()
      return { width: texture.image.width, height: texture.image.height, compressed: texture.isCompressedTexture === true, srgb: texture.colorSpace === "srgb", ms: Math.round(performance.now() - t0) }
    })()`)
    report(
      "ktx2: a KTX2 file in the GPU's format decodes under the world's policy",
      result.width === 8 && result.height === 8 && result.compressed && result.srgb && problems.length === 0,
      `${result.width}x${result.height}, compressed texture, ${result.srgb ? "sRGB from the file" : "colour space WRONG"}, ${result.ms} ms${problems.length ? `, ${problems.length} browser errors: ${problems[0]}` : ""}`,
    )
  } catch (error) {
    report("ktx2", false, `${String((error as Error).message ?? error)}${problems.length ? ` (browser errors: ${problems.slice(0, 3).join(" | ")})` : ""}`)
  }
}

try {
  await levelsCheck()
  await ktx2Check()
  await logoCheck("classic")
  await logoCheck("auto")
  await cityCheck("classic")
  await cityCheck("auto")
  console.log(`pictures in ${out}`)
  const json = arg("--json")
  if (json) writeFileSync(json, JSON.stringify(results, null, 2))
} finally {
  clearTimeout(deadline)
  close()
}
process.exit(failed ? 1 : 0)
