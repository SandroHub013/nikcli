import { describe, expect, test } from "bun:test"
import { removeTestDirSync } from "../helpers/fs"
import { startupTerminalMode } from "../../script/tui-startup-terminal"
import { spawnPty } from "@nikcli-ai/util/pty"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * `timeoutMs` is the probe's own stall deadline, and it is not cosmetic: the
 * fixture paints in ~200ms, so a deadline near that only measures how loaded
 * the host is. A `tsc` running next to this file used to push the bootstrap
 * past 1000ms and report a phantom hang. Healthy runs get a deadline far above
 * the expected paint; the deliberately stalled run gets a short one, because
 * there the deadline is the thing being tested.
 */
async function fixture(
  options: {
    stalled?: boolean
    baseline?: unknown
    limit?: string
    timeoutMs?: number
  } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "nikcli-startup-evidence-"))
  const binary = path.join(dir, "fixture")
  const reportPath = path.join(dir, "report.json")
  const baseline = path.join(dir, "baseline.json")
  writeFileSync(
    binary,
    `#!/bin/sh\nwhile :; do ${options.stalled ? "printf '\\033]10;?\\007'" : `printf '%s' '${"x".repeat(220)}Ask anything'`}; sleep 0.1; done\n`,
    { mode: 0o755 },
  )
  if (options.baseline !== undefined) writeFileSync(baseline, JSON.stringify(options.baseline))
  try {
    const child = Bun.spawn(
      [process.execPath, "run", new URL("../../script/tui-startup.ts", import.meta.url).pathname, binary],
      {
        env: {
          ...process.env,
          WARM_RUNS: "1",
          COLD_RUNS: "0",
          TIMEOUT_MS: String(options.timeoutMs ?? (options.stalled ? 1500 : 10000)),
          PROMPT_MARKERS: "Ask anything",
          TERMINAL_RELAY: "0",
          TERM_PROGRAM: "ghostty",
          TMUX: "/imitation,123,0",
          REPORT_PATH: reportPath,
          BASELINE: options.baseline === undefined ? "" : baseline,
          BASELINE_MAX_REGRESSION: options.limit ?? "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    return {
      code,
      stderr,
      report: JSON.parse(readFileSync(reportPath, "utf8")),
    }
  } finally {
    removeTestDirSync(dir)
  }
}

describe("startup terminal evidence", () => {
  test("headless environment imitation is not Ghostty or tmux evidence", async () => {
    const { code, report, stderr } = await fixture()
    expect(code, stderr).toBe(0)
    expect(report.environment.terminal.evidence).toMatchObject({
      ghostty: false,
      tmux: false,
      claimedGhostty: true,
      claimedTmux: true,
      realTerminalCoverage: "unavailable",
    })
    expect(report.environment.terminal.tmux).toBe(false)
    expect(report.outcomes.map((item: { phase: string }) => item.phase)).toEqual(["bootstrap", "warm"])
    expect(report.budgetRatification).toContain("not ratified")
  }, 45000)

  test("stalled attempts retain ordered evidence and fail", async () => {
    const { code, report } = await fixture({ stalled: true })
    expect(code).toBe(1)
    expect(report.startup).toEqual({ attempts: 2, stalls: 2, hangRate: 1 })
    expect(report.outcomes).toHaveLength(2)
    expect(report.stalls.warm[0].lastSequences.length).toBeGreaterThan(0)
  }, 20000)

  test("comparison failure preserves the collected report", async () => {
    const { code, report } = await fixture({ baseline: {}, limit: "10" })
    expect(code).toBe(1)
    expect(report.startup.stalls).toBe(0)
    expect(report.samples.warm.firstPaintMs).toHaveLength(1)
    expect(report.comparison.status).toBe("failed")
    expect(report.comparison.error).toContain("recorded zero hangRate")
  }, 45000)

  test("invalid comparison thresholds fail after preserving evidence", async () => {
    const { code, report } = await fixture({ baseline: {}, limit: "NaN" })
    expect(code).toBe(1)
    expect(report.comparison.error).toContain("positive percentage")
  }, 45000)
  test("default remains a non-answering PTY even when attached", () => {
    expect(startupTerminalMode(undefined, false, false)).toBe("non-answering-pty")
    expect(startupTerminalMode("0", true, true)).toBe("non-answering-pty")
  })

  test("relay refuses headless or redirected streams", () => {
    for (const [input, output] of [
      [false, false],
      [true, false],
      [false, true],
    ]) {
      expect(() => startupTerminalMode("1", input, output)).toThrow("requires attached terminal")
    }
    expect(startupTerminalMode("1", true, true)).toBe("attached-terminal")
    expect(() => startupTerminalMode("ghostty", true, true)).toThrow("must be 0 or 1")
  })

  test("relay carries output and replies through real PTYs and restores input ownership", async () => {
    const module = new URL("../../script/tui-startup-terminal.ts", import.meta.url).pathname
    const ptyModule = new URL("../../../util/src/pty.ts", import.meta.url).pathname
    const inner = `process.stdin.setRawMode(true); process.stdin.once('data', (data) => { process.stdout.write('REPLY:' + data.toString().trim()); process.exit(0) }); process.stdout.write('PROBE_READY')`
    const script = `
      import { spawnPty } from ${JSON.stringify(ptyModule)};
      import { relayStartupTerminal } from ${JSON.stringify(module)};
      const raw = process.stdin.isRaw;
      const listeners = process.stdin.listenerCount('data');
      const child = spawnPty({ command: process.execPath, args: ['-e', ${JSON.stringify(inner)}], env: process.env });
      const restore = relayStartupTerminal(child);
      child.onExit(() => {
        restore(); restore();
        console.log('RESTORED:' + (process.stdin.isRaw === raw && process.stdin.listenerCount('data') === listeners));
        process.exit(0);
      });
    `
    const outer = spawnPty({
      command: process.execPath,
      args: ["-e", script],
      env: process.env,
    })
    let output = ""
    let sent = false
    let observedExit: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const exit = await new Promise<number>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`relay did not finish (exit=${observedExit ?? "pending"}): ${output}`)),
          20000,
        )
        outer.onData((data) => {
          output += data
          if (sent || !output.includes("PROBE_READY")) return
          sent = true
          outer.write("terminal-response\n")
        })
        outer.onExit(({ exitCode }) => {
          observedExit = exitCode
          resolve(exitCode)
        })
      })
      expect(exit).toBe(0)
      expect(output).toContain("REPLY:terminal-response")
      expect(output).toContain("RESTORED:true")
    } finally {
      clearTimeout(timer)
      outer.kill()
    }
  }, 30000)
})
