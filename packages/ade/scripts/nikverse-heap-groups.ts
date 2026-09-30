/**
 * The biggest groups of the world frame's memory, from a heap snapshot of the real browser on the real GPU: the world at a level
 * (Media by default) once it has settled, the snapshot's nodes summed by what they are (constructor for objects; type and name for
 * the rest, so an ArrayBuffer's backing store shows as `native:system / JSArrayBufferData`), the largest first.
 *
 *   bun scripts/nikverse-heap-groups.ts [--level media] [--top 20] [--out DIR] [--refuse-files]
 *
 * A snapshot holds what the JS heap owns and the array buffers' bytes beside it; what the frame's process holds beyond that (the
 * WebAssembly memories' pages, the renderer's own allocations) is printed as `outside the snapshot`: the private bytes of the frame,
 * read as the gate reads them, minus the snapshot's total.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { arg, startHarness } from "./nikverse-harness"

const NONCE = "0123456789abcdef".repeat(3)
const LEVEL = arg("--level") ?? "media"
const TOP = Number(arg("--top") ?? 20)
const refusing = process.argv.includes("--refuse-files")
const out = arg("--out") ?? join(tmpdir(), "nikverse-heap-groups")
mkdirSync(out, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ps = (s: string) => spawnSync("powershell", ["-NoProfile", "-Command", s], { encoding: "utf8" }).stdout.trim()

const { page, browserLine, open, until, close } = await startHarness({
  out,
  gpu: "real",
  routes: (url) =>
    refusing && url.pathname.startsWith("/assets/levels/") ? new Response("no", { status: 404 }) : undefined,
})

interface Snapshot {
  snapshot: { meta: { node_fields: string[]; node_types: [string[]] } }
  nodes: number[]
  strings: string[]
}

async function takeSnapshot(): Promise<Snapshot> {
  const chunks: string[] = []
  page.on((method, params) => {
    if (method === "HeapProfiler.addHeapSnapshotChunk") chunks.push(params.chunk)
  })
  await page.send("HeapProfiler.enable")
  await page.send("HeapProfiler.collectGarbage")
  await page.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false })
  await page.send("HeapProfiler.disable")
  return JSON.parse(chunks.join("")) as Snapshot
}

interface Group {
  key: string
  bytes: number
  count: number
}

function groupsOf(snap: Snapshot): { groups: Group[]; total: number } {
  const fields = snap.snapshot.meta.node_fields
  const stride = fields.length
  const iType = fields.indexOf("type")
  const iName = fields.indexOf("name")
  const iSize = fields.indexOf("self_size")
  const types = snap.snapshot.meta.node_types[0]
  const map = new Map<string, Group>()
  let total = 0
  for (let i = 0; i < snap.nodes.length; i += stride) {
    const type = types[snap.nodes[i + iType]]
    const name = snap.strings[snap.nodes[i + iName]] ?? ""
    const size = snap.nodes[i + iSize]
    total += size
    const key =
      type === "object" || type === "closure"
        ? `${type}:${name.slice(0, 60)}`
        : type === "string" || type === "concatenated string" || type === "sliced string"
          ? "string"
          : `${type}:${name.slice(0, 60)}`
    const g = map.get(key) ?? { key, bytes: 0, count: 0 }
    g.bytes += size
    g.count++
    map.set(key, g)
  }
  return { groups: [...map.values()].sort((a, b) => b.bytes - a.bytes), total }
}

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

await open(`/?quality=${LEVEL}#n=${NONCE}`, { width: 1600, height: 900 })
await until(
  `document.documentElement.dataset.ready === "1" || document.documentElement.dataset.city === "failed"`,
  "the world",
  120_000,
)
await sleep(6000)

const info = (await browserLine.send("SystemInfo.getProcessInfo")).processInfo as Array<{ id: number; type: string }>
const mem = memoryOf(info.map((p) => p.id))
const frameMb = Math.max(...info.filter((p) => p.type === "renderer").map((p) => mem[p.id] ?? 0))

const snap = await takeSnapshot()
const { groups, total } = groupsOf(snap)
const mb = (n: number) => +(n / 1048576).toFixed(2)
const report = {
  level: LEVEL,
  refusingFiles: refusing,
  frameMb: +frameMb.toFixed(1),
  snapshotMb: mb(total),
  outsideSnapshotMb: +(frameMb - total / 1048576).toFixed(1),
  top: groups.slice(0, TOP).map((g) => ({ group: g.key, mb: mb(g.bytes), objects: g.count })),
}
writeFileSync(join(out, `heap-groups-${LEVEL}${refusing ? "-refused" : ""}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
close()
process.exit(0)
