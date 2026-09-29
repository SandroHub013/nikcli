/**
 * Builds the page a piece of the look is judged on, from two runs of the bench (`nikverse-shots.ts`): the «prima»
 * and the «dopo». One HTML file, the JPEGs inside it, the clips as links, the numbers of the bench and of the gate
 * beside them (`src/nikverse/city/judge-page.ts` says what the page does).
 *
 *   bun scripts/nikverse-judge.ts --before DIR --after DIR --out FILE.html
 *        [--gate-before FILE.json] [--gate-after FILE.json] [--seed N] [--title TEXT]
 *
 * With no `--after` the page is made of the «prima» against itself: it opens and can be tried, and says so in the title.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { judgePage, type JudgeData, type JudgeImage, type JudgeNumber } from "../src/nikverse/city/judge-page"
import { MAX_BURNT } from "../src/nikverse/city/shot-stats"
import { SHOTS } from "../src/nikverse/city/shots"
import { GATE_LIMITS } from "../src/nikverse/gate"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const beforeDir = arg("--before")
const out = arg("--out")
if (!beforeDir || !out) {
  console.error(
    "usage: bun scripts/nikverse-judge.ts --before DIR --after DIR --out FILE.html [--gate-before F] [--gate-after F] [--seed N] [--title T]",
  )
  process.exit(2)
}
const afterDir = arg("--after") ?? beforeDir
const same = afterDir === beforeDir

interface Row {
  level: string
  n: number
  jpg: string
  stats: { luminance: number; burnt: number; black: number }
  problems: string[]
  gpu?: { p50: number; p95: number; sync: string }
}
interface Bench {
  label: string
  levels: string[]
  rows: Row[]
  renderCheck?: Array<{ name: string; ok: boolean; detail: string }>
}
const readJson = <T>(path: string): T => {
  if (!existsSync(path)) throw new Error(`missing ${path}`)
  return JSON.parse(readFileSync(path, "utf8")) as T
}
const before = readJson<Bench>(join(beforeDir, "bench.json"))
const after = same ? before : readJson<Bench>(join(afterDir, "bench.json"))
const levels = before.levels.filter((l) => after.levels.includes(l))

const dataUrl = (file: string) => `data:image/jpeg;base64,${readFileSync(file).toString("base64")}`
const images: JudgeImage[] = []
for (const level of levels)
  for (const shot of SHOTS) {
    const b = before.rows.find((r) => r.level === level && r.n === shot.n)
    const a = after.rows.find((r) => r.level === level && r.n === shot.n)
    if (b && a)
      images.push({ level, n: shot.n, before: dataUrl(join(beforeDir, b.jpg)), after: dataUrl(join(afterDir, a.jpg)) })
  }

const numbers: JudgeNumber[] = []
const fmt = (n: number | undefined, unit = "", digits = 1) =>
  n === undefined || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}${unit}`
const mean = (values: number[]) => (values.length ? values.reduce((x, y) => x + y, 0) / values.length : Number.NaN)
for (const level of levels) {
  const rows = (bench: Bench) => bench.rows.filter((r) => r.level === level)
  const gpuOf = (bench: Bench) => mean(rows(bench).flatMap((r) => (r.gpu ? [r.gpu.p95] : [])))
  const burntOf = (bench: Bench) => Math.max(...rows(bench).map((r) => r.stats.burnt))
  const bandOk = (bench: Bench) => rows(bench).filter((r) => r.problems.length === 0).length
  numbers.push({
    name: `${level}: tempo GPU del frame, p95 medio sugli scatti (tetto ${GATE_LIMITS.gpuFrameP95Ms} ms)`,
    before: fmt(gpuOf(before), " ms"),
    after: fmt(gpuOf(after), " ms"),
    ok: gpuOf(after) <= GATE_LIMITS.gpuFrameP95Ms,
  })
  numbers.push({
    name: `${level}: pixel bruciati, il peggiore degli scatti (tetto ${MAX_BURNT * 100} %)`,
    before: fmt(burntOf(before) * 100, " %", 2),
    after: fmt(burntOf(after) * 100, " %", 2),
    ok: burntOf(after) <= MAX_BURNT,
  })
  numbers.push({
    name: `${level}: scatti che passano i controlli automatici`,
    before: `${bandOk(before)} / ${rows(before).length}`,
    after: `${bandOk(after)} / ${rows(after).length}`,
    ok: bandOk(after) === rows(after).length,
  })
}
const checks = (bench: Bench) => new Map((bench.renderCheck ?? []).map((c) => [c.name, c]))
const b = checks(before)
const a = checks(after)
for (const name of new Set([...b.keys(), ...a.keys()])) {
  const x = b.get(name)
  const y = a.get(name)
  numbers.push({
    name: `controllo: ${name}`,
    before: x ? (x.ok ? "ok" : "NO") : "—",
    after: y ? (y.ok ? "ok" : "NO") : "—",
    ok: y?.ok,
  })
}

// The gate's own numbers, when the two runs have them.
interface Gate {
  checks?: Array<{ name: string; value: number; limit: number; ok: boolean }>
}
const gateFile = (name: string) => {
  const path = arg(name)
  return path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Gate) : undefined
}
const gb = gateFile("--gate-before")
const ga = gateFile("--gate-after")
for (const name of new Set([...(gb?.checks ?? []), ...(ga?.checks ?? [])].map((c) => c.name))) {
  const x = gb?.checks?.find((c) => c.name === name)
  const y = ga?.checks?.find((c) => c.name === name)
  const limit = (x ?? y)!.limit
  numbers.push({
    name: `gate: ${name} (tetto ${limit})`,
    before: x ? String(x.value) : "—",
    after: y ? String(y.value) : "—",
    ok: y?.ok,
  })
}

const clips: NonNullable<JudgeData["clips"]> = {}
const outDir = dirname(resolve(out))
const link = (dir: string, level: string) => {
  const file = join(dir, `${level}.webm`)
  return existsSync(file) ? relative(outDir, resolve(file)).replaceAll("\\", "/") : undefined
}
for (const level of levels)
  clips[level] = { before: link(beforeDir, level), after: same ? undefined : link(afterDir, level) }

const seed = Number(arg("--seed") ?? Date.now() % 100000)
const title =
  arg("--title") ?? (same ? `Tripla A · il «prima» (${before.label})` : `Tripla A · ${before.label} → ${after.label}`)
const page = judgePage({
  title,
  seed,
  generated: new Date().toISOString().slice(0, 10),
  levels,
  shots: SHOTS.map((s) => ({ n: s.n, name: s.name, about: s.about })),
  images,
  numbers,
  clips,
})
writeFileSync(out, page)
console.log(
  `${out}: ${images.length} pairs of pictures, ${numbers.length} numbers, ${(page.length / 1048576).toFixed(1)} MB, seed ${seed}`,
)
