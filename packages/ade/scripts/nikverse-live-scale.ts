/**
 * The dynamic resolution of the live loop, in a real browser on the real GPU (`src/nikverse/city/resolution.ts`).
 *
 * Media is opened in a window four times the size of the bench's, walked in, and the frame's `data-render-scale` and the
 * canvas' size are read every second: the GPU cost of the plaza at that size is over the governor's line, so the scale must go
 * down (never under 0.75) and the canvas must shrink with it. Then the window is made small, walking goes on, and the scale
 * must come back up to 1. It is a check of the loop (timed frames, the governor, the resize), not of a number: the numbers are
 * the bench's.
 *
 *   bun scripts/nikverse-live-scale.ts [--out DIR] [--browser PATH]
 *
 * Exits 1 when the scale never went down, went under 0.75, did not come back, or the canvas did not follow it. Time cap: 5 minutes.
 */

import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SCALE_MIN } from "../src/nikverse/city/resolution"
import { shotPicture } from "../src/nikverse/city/shots"
import { actAsAde, arg, startHarness } from "./nikverse-harness"

const NONCE = "0123456789abcdef".repeat(3)
const out = arg("--out") ?? join(tmpdir(), "nikverse-live-scale")
mkdirSync(out, { recursive: true })
const deadline = setTimeout(() => {
  console.error("time cap of 5 minutes reached")
  process.exit(1)
}, 300_000)

const { page, evaluate, open, until, close } = await startHarness({ out, gpu: "real" })
const picture = shotPicture()
const snapshot = {
  at: 1,
  shops: [...picture.shops.values()],
  agents: [...picture.agents.values()],
  waiting: { decisions: 0 },
}

const failures: string[] = []
const read = () =>
  evaluate<{ scale: number; width: number; mode: string }>(
    `({ scale: Number(document.documentElement.dataset.renderScale), width: document.querySelector("canvas.city").width, mode: document.documentElement.dataset.drawMode })`,
  )

/** Walks for `ms`, reading the scale every second. */
async function walk(ms: number) {
  const base = { code: "KeyW", key: "w", windowsVirtualKeyCode: 87 }
  const series: Array<{ scale: number; width: number }> = []
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base })
  for (let t = 0; t < ms; t += 1000) {
    await Bun.sleep(1000)
    const now = await read()
    series.push({ scale: now.scale, width: now.width })
    // The walker turns round now and then so it stays in the square.
    if ((t / 1000) % 4 === 3) {
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
      await page.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        code: "KeyD",
        key: "d",
        windowsVirtualKeyCode: 68,
      })
      await Bun.sleep(700)
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyD", key: "d", windowsVirtualKeyCode: 68 })
      await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base })
    }
  }
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
  return series
}

try {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 3200,
    height: 1800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await open(`/?quality=media#n=${NONCE}`, { width: 3200, height: 1800 })
  await until(
    `document.documentElement.dataset.ready === "1" || document.documentElement.dataset.city === "failed"`,
    "the city at Media",
    120_000,
  )
  if ((await evaluate<string>(`document.documentElement.dataset.quality`)) !== "media")
    throw new Error("the page did not draw Media")
  if (!(await evaluate<boolean>(actAsAde(snapshot)))) throw new Error("the world did not say ready")
  await Bun.sleep(1800)
  const big = await walk(24_000)
  console.log("large window, scale and canvas width each second:", big.map((s) => `${s.scale}/${s.width}`).join(" "))
  const lowest = Math.min(...big.map((s) => s.scale))
  if (!(lowest < 1)) failures.push("the scale never went down in a window whose frame costs more than the line")
  if (lowest < SCALE_MIN) failures.push(`the scale went under ${SCALE_MIN}: ${lowest}`)
  const widest = Math.max(...big.map((s) => s.width))
  const narrowest = Math.min(...big.map((s) => s.width))
  if (lowest < 1 && !(narrowest < widest)) failures.push("the canvas did not shrink with the scale")

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 800,
    height: 450,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await Bun.sleep(1500)
  const small = await walk(24_000)
  console.log("small window, scale and canvas width each second:", small.map((s) => `${s.scale}/${s.width}`).join(" "))
  if (small.at(-1)!.scale !== 1)
    failures.push(`the scale did not come back to 1 in a small window: ${small.at(-1)!.scale}`)
} catch (error) {
  failures.push(String((error as Error).message ?? error))
} finally {
  clearTimeout(deadline)
  close()
}
console.log(
  failures.length
    ? `FAIL  ${failures.join("; ")}`
    : "PASS  the scale went down in a large window, stayed in range, and came back in a small one",
)
process.exit(failures.length ? 1 : 0)
