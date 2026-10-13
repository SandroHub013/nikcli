/**
 * Where the world frame's memory goes, in a real browser on the real GPU: the same world loaded at Bassa, at Media, and at Media
 * with its files refused (so the models and the floors stay placeholders), the memory of each browser process read after the
 * world has settled. The difference between the last two is what Media's files cost the frame; what the last one holds is the
 * frame's own floor (the bundle, three.js, the WebAssembly decoders, the renderer).
 *
 *   bun scripts/nikverse-frame-memory.ts [--out DIR]
 *
 * Numbers are the larger of private bytes and working set of each renderer process (as the gate reads them), the JS heap of the
 * page, and the GPU process.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { arg, startHarness } from "./nikverse-harness"

const NONCE = "0123456789abcdef".repeat(3)
const out = arg("--out") ?? join(tmpdir(), "nikverse-frame-memory")
mkdirSync(out, { recursive: true })
const ps = (s: string) => spawnSync("powershell", ["-NoProfile", "-Command", s], { encoding: "utf8" }).stdout.trim()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const { page, browserLine, evaluate, open, until, close } = await startHarness({
  out,
  gpu: "real",
  // The third run refuses N3's files: the models and the floors stay placeholders.
  routes: (url) =>
    refusing && url.pathname.startsWith("/assets/levels/") ? new Response("no", { status: 404 }) : undefined,
})

function memoryOf(ids: number[]): Record<number, number> {
  const raw = ps(
    `Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.PrivateMemorySize64) $($_.WorkingSet64)" }`,
  )
  const result: Record<number, number> = {}
  for (const line of raw.split(/\r?\n/)) {
    const [id, priv, ws] = line.trim().split(" ").map(Number)
    if (id) result[id] = Math.max(priv, ws) / 1048576
  }
  return result
}

const only = arg("--only")
const rows: Array<Record<string, unknown>> = []
let refusing = false
for (const [name, level, refuse] of [
  ["bassa", "bassa", false],
  ["media", "media", false],
  ["media, files refused", "media", true],
] as const) {
  if (only && name !== only) continue
  refusing = refuse
  await open(`/?quality=${level}&run=${rows.length}#n=${NONCE}`, { width: 1600, height: 900 })
  await until(
    `document.documentElement.dataset.ready === "1" || document.documentElement.dataset.city === "failed"`,
    name,
    120_000,
  )
  await sleep(6000)
  const heap = (await page.send("Runtime.getHeapUsage")).usedSize / 1048576
  const info = (await browserLine.send("SystemInfo.getProcessInfo")).processInfo as Array<{ id: number; type: string }>
  const mem = memoryOf(info.map((p) => p.id))
  const renderers = info.filter((p) => p.type === "renderer").map((p) => +(mem[p.id] ?? 0).toFixed(1))
  const gpu = info.filter((p) => p.type === "GPU").map((p) => +(mem[p.id] ?? 0).toFixed(1))
  const row = {
    name,
    refusing,
    cast: await evaluate<string>(`document.documentElement.dataset.cast`),
    rendererMb: renderers,
    jsHeapMb: +heap.toFixed(1),
    gpuMb: gpu,
  }
  rows.push(row)
  console.log(JSON.stringify(row))
}
writeFileSync(join(out, "frame-memory.json"), JSON.stringify(rows, null, 2))
close()
process.exit(0)
