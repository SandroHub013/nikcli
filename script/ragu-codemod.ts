#!/usr/bin/env bun
/**
 * The nikcli → Ragu Code codemod: renames the project in the tracked files and their paths, by the ordered map in
 * `ragu-codemod.map.ts`, and leaves alone what the map protects or excludes.
 *
 *   bun script/ragu-codemod.ts                 dry run (the default): what would change, nothing written
 *   bun script/ragu-codemod.ts --apply         write the files, then `git mv` the renamed paths
 *   options: --report FILE   also write the full report (every excluded line) as Markdown
 *            --samples N     sample lines per rule and exclusion in the printed summary (default 3)
 *
 * Rerunnable: a second --apply on the same tree changes nothing, so it can run again on a branch still open
 * (R16, Overclock) before its merge. Reads only `git ls-files`: node_modules, build output, untracked files and
 * the .git folder are never touched; binaries, lockfiles and the files in SKIP_FILES keep their content.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  BINARY_EXT,
  KEEP_SEGMENT,
  LINE_EXCLUSIONS,
  PROSE_EXT,
  PROTECTED,
  RULES,
  SKIP_DIRS,
  SKIP_FILES,
  type Context,
} from "./ragu-codemod.map"

const ROOT = join(import.meta.dir, "..")
const APPLY = process.argv.includes("--apply")
const argValue = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const REPORT = argValue("--report")
const SAMPLES = Number(argValue("--samples") ?? 3)

/** Any form of the old name: what a rule or an exclusion could be about. */
const OLD = /nik-?cli|nikomatt69/i

type Sample = { path: string; line: number; text: string }
type Tally = { count: number; files: Set<string>; samples: Sample[] }
const tally = () => ({ count: 0, files: new Set<string>(), samples: [] as Sample[] })

const ruleTally = new Map(RULES.map((rule) => [rule.id, tally()]))
const excludedTally = new Map<string, Tally>()
const skippedTally = new Map<string, Tally>()
const unreadable: string[] = []
const changedFiles: string[] = []
const renames: [string, string][] = []
const collisions: string[] = []

/** Off while the output is run through the map a second time, to check the rerun changes nothing. */
let counting = true

function note(map: Map<string, Tally>, id: string, path: string, line: number, text: string, by = 1) {
  if (!counting) return
  const t = map.get(id) ?? tally()
  map.set(id, t)
  t.count += by
  t.files.add(path)
  if (t.samples.length < 200) t.samples.push({ path, line, text: text.trim().slice(0, 200) })
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** One line through the map: protected spans out, rules in order, spans back. Counts as it goes. */
function convertLine(line: string, previous: string, path: string, lineNo: number, context: Context, only?: readonly string[]): string {
  if (!OLD.test(line)) return line
  for (const exclusion of LINE_EXCLUSIONS) {
    if (exclusion.files && !exclusion.files.test(path)) continue
    if (exclusion.unless && (exclusion.unless.test(line) || exclusion.unless.test(previous))) continue
    if (exclusion.find.test(line)) {
      note(excludedTally, `line:${exclusion.id}`, path, lineNo, line)
      return line
    }
  }
  const kept: string[] = []
  let work = line
  for (const protect of PROTECTED) {
    work = work.replace(protect.find, (match) => {
      if (!OLD.test(match)) return match
      note(excludedTally, `span:${protect.id}`, path, lineNo, line)
      kept.push(match)
      return `\u0000${kept.length - 1}\u0000`
    })
  }
  for (const rule of RULES) {
    if (rule.files && !rule.files.test(path)) continue
    if (only && !only.includes(rule.id)) continue
    work = work.replace(rule.find, (match: string, ...args: unknown[]) => {
      const offset = args.find((value) => typeof value === "number") as number
      const whole = args.find((value, i) => typeof value === "string" && i > 0 && typeof args[i - 1] === "number") as string
      const replaced =
        typeof rule.to === "string"
          ? match.replace(new RegExp(rule.find.source, rule.find.flags.replace("g", "")), rule.to)
          : rule.to(match, context, whole.slice(Math.max(0, offset - 1), offset), whole.slice(offset + match.length, offset + match.length + 1))
      if (replaced !== match) note(ruleTally as Map<string, Tally>, rule.id, path, lineNo, line)
      return replaced
    })
  }
  return work.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]!)
}

/** A path with every segment renamed, except the segments a user's config keeps. */
function renamePath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (KEEP_SEGMENT.test(segment) || !OLD.test(segment)) return segment
      return segment
        .replace(/@nikcli-ai/g, "@ragu")
        .replace(/nikcli-ai/g, "ragu-code")
        .replace(/NIKCLI/g, "RAGU")
        .replace(/NikCLI|NikCli|Nikcli/g, "Ragu")
        .replace(/nikcli/gi, "ragu")
    })
    .join("/")
}

function convertText(text: string, path: string, only?: readonly string[]): string {
  const context: Context = { path, prose: PROSE_EXT.test(path) }
  const parts = text.split(/(\r?\n)/)
  const original = parts.filter((_, i) => i % 2 === 0)
  for (let i = 0; i < parts.length; i += 2) parts[i] = convertLine(parts[i]!, original[i / 2 - 1] ?? "", path, i / 2 + 1, context, only)
  return parts.join("")
}

const notIdempotent: string[] = []
const files = git(["ls-files", "-z"]).split("\0").filter(Boolean)
const tracked = new Set(files)

for (const path of files) {
  if (SKIP_DIRS.test(path)) continue
  const skip = SKIP_FILES.find((entry) => entry.find.test(path))
  // A kept file keeps its own name but follows its folder: a prompt under packages/nikcli/ moves with it.
  const slash = path.lastIndexOf("/")
  const target = skip ? `${renamePath(path.slice(0, slash + 1))}${path.slice(slash + 1)}` : renamePath(path)
  if (target !== path) {
    if (tracked.has(target) || renames.some(([, to]) => to.toLowerCase() === target.toLowerCase())) collisions.push(`${path} → ${target}`)
    else renames.push([path, target])
  }
  if (BINARY_EXT.test(path)) continue
  let bytes: Buffer
  try {
    bytes = readFileSync(join(ROOT, path))
  } catch {
    continue
  }
  if (bytes.subarray(0, 8000).includes(0)) continue
  const text = bytes.toString("utf8")
  if (Buffer.from(text, "utf8").compare(bytes) !== 0) {
    if (OLD.test(text)) unreadable.push(path)
    continue
  }
  if (!OLD.test(text)) continue
  // The rerun guarantee, checked on every file without writing: the output, at its new path and with the skip
  // that path gets, through the map again is itself.
  const rerun = SKIP_FILES.find((entry) => entry.find.test(target))
  const stable = (out: string) => {
    if (rerun && !rerun.onlyRules) return true
    counting = false
    const again = convertText(out, target, rerun?.onlyRules)
    counting = true
    return again === out
  }
  if (skip && !skip.onlyRules) {
    const count = text.match(new RegExp(OLD.source, "gi"))?.length ?? 0
    note(skippedTally, skip.id, path, 0, "", count)
    if (!stable(text)) notIdempotent.push(path)
    continue
  }
  const out = convertText(text, path, skip?.onlyRules)
  if (skip) note(skippedTally, skip.id, path, 0, "", out.match(new RegExp(OLD.source, "gi"))?.length ?? 0)
  if (!stable(out)) notIdempotent.push(path)
  if (out !== text) {
    changedFiles.push(path)
    if (APPLY) writeFileSync(join(ROOT, path), out)
  }
}
for (const [, to] of renames) if (renamePath(to) !== to) notIdempotent.push(to)

if (APPLY) {
  for (const [from, to] of renames) {
    mkdirSync(dirname(join(ROOT, to)), { recursive: true })
    git(["mv", "-k", from, to])
  }
}

const total = (map: Map<string, Tally>) => [...map.values()].reduce((sum, t) => sum + t.count, 0)
const lines: string[] = []
const print = (line = "") => lines.push(line)
print(`# ragu-codemod ${APPLY ? "--apply" : "dry run"}`)
print()
print(
  `${changedFiles.length} files change, ${total(ruleTally as Map<string, Tally>)} replacements, ${renames.length} paths renamed, ${collisions.length} collisions; a rerun would change ${notIdempotent.length} files.`,
)
for (const path of notIdempotent.slice(0, 20)) print(`- not stable on a rerun: ${path}`)
print()
print("## Rules")
for (const rule of RULES) {
  const t = ruleTally.get(rule.id)!
  print(`- **${rule.id}**: ${t.count} replacements in ${t.files.size} files. ${rule.why}`)
  for (const s of t.samples.slice(0, SAMPLES)) print(`    - ${s.path}:${s.line}: ${s.text}`)
}
print()
print("## Kept: protected spans and excluded lines")
for (const [id, t] of [...excludedTally].sort((a, b) => b[1].count - a[1].count)) {
  const why = [...PROTECTED, ...LINE_EXCLUSIONS].find((entry) => id.endsWith(`:${entry.id}`))?.why ?? ""
  print(`- **${id}**: ${t.count} in ${t.files.size} files. ${why}`)
  for (const s of t.samples.slice(0, SAMPLES)) print(`    - ${s.path}:${s.line}: ${s.text}`)
}
print()
print("## Kept: whole files")
for (const [id, t] of [...skippedTally].sort((a, b) => b[1].count - a[1].count)) {
  const why = SKIP_FILES.find((entry) => entry.id === id)?.why ?? ""
  print(`- **${id}**: ${t.count} mentions in ${t.files.size} files. ${why}`)
  for (const path of [...t.files].slice(0, Math.max(SAMPLES, 8))) print(`    - ${path}`)
}
print()
print(`## Renamed paths (${renames.length})`)
const dirs = new Map<string, number>()
for (const [from, to] of renames) {
  const a = from.split("/")
  const b = to.split("/")
  const k = a.findIndex((segment, i) => segment !== b[i])
  const key = `${a.slice(0, k + 1).join("/")} → ${b.slice(0, k + 1).join("/")}`
  dirs.set(key, (dirs.get(key) ?? 0) + 1)
}
for (const [key, count] of [...dirs].sort((a, b) => b[1] - a[1])) print(`- ${key}${count > 1 ? ` (${count} files)` : ""}`)
if (collisions.length) {
  print()
  print("## Collisions (not renamed)")
  for (const c of collisions) print(`- ${c}`)
}
if (unreadable.length) {
  print()
  print("## Not UTF-8, left alone")
  for (const path of unreadable) print(`- ${path}`)
}
console.log(lines.join("\n"))

if (REPORT) {
  const full: string[] = [...lines, "", "## Every kept line"]
  for (const [id, t] of excludedTally) {
    full.push("", `### ${id} (${t.count})`)
    for (const s of t.samples) full.push(`- ${s.path}:${s.line}: ${s.text}`)
    if (t.count > t.samples.length) full.push(`- … ${t.count - t.samples.length} more`)
  }
  full.push("", "## Every renamed path")
  for (const [from, to] of renames) full.push(`- ${from} → ${to}`)
  if (!existsSync(dirname(REPORT))) mkdirSync(dirname(REPORT), { recursive: true })
  writeFileSync(REPORT, full.join("\n") + "\n")
}
