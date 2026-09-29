#!/usr/bin/env bun
/**
 * `script/perf-baseline.ts` — EOT-01 candidate-budget probe.
 *
 * Boots an isolated nikcli server in-process, fires N requests against the
 * three declared server routes, and reports min/median/p95/max in
 * milliseconds plus a counter snapshot from `effect/lifecycle-counters.ts`.
 *
 * This is the probe the spec demands: reproducible measurements against the
 * real router, no mocks. Numbers vary by host, so the script is the *harness*,
 * not a single value. The gate uses `script/check-perf-baseline.ts` to diff a
 * recorded baseline against a candidate run.
 *
 * Defaults follow EOT-01: 30 samples per route. Override with `--samples`.
 * Routes can be skipped with `--skip <prefix>`.
 */
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { REQUIRED_ROUTES } from "./check-perf-baseline"

type Sample = number

export function summarize(samples: Sample[]): {
  min: number
  median: number
  p95: number
  max: number
} {
  if (!samples.length || samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("samples must contain finite non-negative timings")
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]
  return {
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  }
}

export function parseArgs(argv: string[]) {
  const out = {
    samples: 30,
    skip: new Set<string>(),
    route: undefined as string | undefined,
    json: undefined as string | undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--samples") {
      out.samples = Number(argv[++i])
      if (!Number.isSafeInteger(out.samples) || out.samples <= 0)
        throw new Error("--samples must be a positive safe integer")
    } else if (arg === "--skip" || arg === "--route" || arg === "--json") {
      const value = argv[++i]
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
      if (arg === "--skip") out.skip.add(value)
      else if (arg === "--route") out.route = value
      else out.json = value
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: perf-baseline.ts [--samples N] [--route /path] [--skip /prefix] [--json out.json]")
      process.exit(0)
    } else throw new Error(`unknown argument ${arg}`)
  }
  return out
}

type Probe = {
  name: string
  method: "GET" | "POST"
  path: string
  buildBody?: (i: number) => string
}

const PROBES: readonly Probe[] = REQUIRED_ROUTES

/**
 * Thrown when a probe does not describe a real request.
 *
 * A baseline is only evidence if every number in it came from the route it
 * claims. A 404 or a 405 answers in microseconds and looks like an excellent
 * result, so swallowing it does not produce a gap in the data — it produces a
 * plausible lie. Anything outside 2xx/3xx stops the run.
 */
class ProbeUnreachable extends Error {
  constructor(probe: Probe, detail: string) {
    super(`${probe.method} ${probe.path}: ${detail}`)
  }
}

async function time(probe: Probe): Promise<Sample> {
  const { Server } = await import("@/server/server")
  const url = "http://localhost:4096" + probe.path
  const init: RequestInit = { method: probe.method }
  if (probe.buildBody) init.body = probe.buildBody(0)
  const start = performance.now()
  let response: Response
  try {
    response = await Server.fetch(new Request(url, init))
  } catch (error) {
    throw new ProbeUnreachable(probe, `threw ${String(error).slice(0, 120)}`)
  }
  const elapsed = performance.now() - start
  // Cancel before asserting on the status: an SSE body left open keeps the
  // connection — and the process — alive.
  await response.body?.cancel().catch(() => undefined)
  if (response.status < 200 || response.status >= 400) throw new ProbeUnreachable(probe, `status ${response.status}`)
  return elapsed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const probes = PROBES.filter(
    (probe) =>
      ![...args.skip].some((prefix) => probe.path.startsWith(prefix)) &&
      (!args.route || probe.path.startsWith(args.route)),
  )
  if (!probes.length) throw new Error("no routes selected - the probe measured nothing")
  const home = join(tmpdir(), `nikcli-perf-${Date.now()}-${process.pid}`)
  process.env.NIKCLI_TEST_HOME = home
  process.env.NIKCLI_TEST_MODE = "1"
  process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
  process.env.XDG_DATA_HOME = join(home, "data")
  process.env.XDG_CACHE_HOME = join(home, "cache")
  process.env.XDG_CONFIG_HOME = join(home, "config")
  process.env.XDG_STATE_HOME = join(home, "state")

  const { Effect, Layer } = await import("effect")
  const { Config } = await import("@/config/config")
  const { runtimeFor, runPromise } = await import("@/effect/runtime")
  const { snapshot, reset } = await import("@/effect/lifecycle-counters")

  reset()
  // `Layer.build` produces `Effect<void, never, Scope>`; `runPromise` only
  // accepts `Effect<…, never, never>`, so we wrap with `Effect.scoped`.
  await runPromise(Effect.scoped(Layer.build(Config.defaultLayer).pipe(Effect.asVoid)))

  const routes: {
    name: string
    method: string
    path: string
    n: number
    min: number
    median: number
    p95: number
    max: number
  }[] = []
  const reportLines: string[] = []
  reportLines.push(`nikcli perf baseline — samples=${args.samples} home=${home}`)
  reportLines.push("")

  for (const probe of probes) {
    // Warm up one request (router initializes on first hit).
    await time(probe)

    const samples: Sample[] = []
    for (let i = 0; i < args.samples; i++) {
      samples.push(await time(probe))
    }

    const summary = summarize(samples)
    routes.push({
      name: probe.name,
      method: probe.method,
      path: probe.path,
      n: samples.length,
      ...summary,
    })
    reportLines.push(
      `${probe.name.padEnd(20)} min=${summary.min.toFixed(2)}ms  median=${summary.median.toFixed(2)}ms  p95=${summary.p95.toFixed(2)}ms  max=${summary.max.toFixed(2)}ms  (n=${samples.length})`,
    )
  }

  reportLines.push("")
  reportLines.push("lifecycle counters:")
  const snap = snapshot()
  for (const [key, value] of Object.entries(snap)) {
    if (value === 0) continue
    reportLines.push(`  ${key.padEnd(32)} ${value}`)
  }

  console.log(reportLines.join("\n"))
  console.log(
    "Server-route characterization only; partial runs cannot pass the baseline gate and TUI budgets remain unratified.",
  )

  if (args.json) {
    /**
     * The machine-readable form, for `bench-compare.ts`.
     *
     * `host` is recorded because these timings are not portable and a baseline
     * that hides where it came from invites someone to diff it against a
     * different machine and call the difference a regression.
     */
    const artifact = {
      version: 1,
      recordedAt: new Date().toISOString(),
      samples: args.samples,
      host: {
        platform: process.platform,
        arch: process.arch,
        cpus: navigator.hardwareConcurrency,
        bun: Bun.version,
      },
      routes,
      counters: snap,
    }
    await Bun.write(args.json, JSON.stringify(artifact, null, 2) + "\n")
    console.error(`Wrote ${args.json}`)
  }

  await rm(home, { recursive: true, force: true }).catch(() => undefined)
  // Drop the runtime cache so the next test starts clean.
  const layer = Layer.empty
  const runtime = runtimeFor(layer)
  await runtime.dispose()
}

if (import.meta.main)
  main().then(
    () => {
      // Explicit, because the in-process server and the instance it booted keep
      // handles open: falling off the end of `main` left the probe running
      // forever. That is why no baseline artifact was ever produced — the
      // measurement finished in under a second and the command never returned.
      process.exit(0)
    },
    (error) => {
      console.error("perf-baseline failed:", error instanceof Error ? error.message : error)
      process.exit(1)
    },
  )
