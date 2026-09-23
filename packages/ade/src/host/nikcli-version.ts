/**
 * Which nikcli the user is actually running.
 *
 * Asked of the binary rather than read from a `package.json`: the repository
 * open in ADE is usually not nikcli's own, and when it is, its version is the
 * one being *developed*, not the one installed. On this machine nikcli lives
 * at `~/.nikcli/bin/nikcli.exe`, updates itself in place, and is reached on
 * PATH — so the only thing that knows the truth is the executable, and the
 * only honest question is the one the user would type: `nikcli --version`.
 *
 * Plain `.ts`, because everything worth getting wrong here is in the parsing:
 * an older CLI that prints something else, a build that colours its output, a
 * machine with no nikcli at all. All three have to end in the same place —
 * nothing shown — and none of them may show an error, because this sits in
 * the top bar where an error would be permanent furniture.
 */

import { stripAnsi } from "./ansi"

export interface VersionResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * How often the version is asked for again.
 *
 * nikcli updates itself in place while ADE is open — the swap leaves a line in
 * `~/.nikcli/bin/nikcli.update.log` — so a version read once at startup goes
 * stale on a long day. Six hours is chosen against what it costs to be wrong:
 * the number is shown, not acted on, so a stale one misleads nobody into
 * anything, while the question is a whole process started for one line of
 * output. The poll pauses while the window is hidden.
 */
export const NIKCLI_VERSION_EVERY_MS = 6 * 60 * 60 * 1000

/*
 * A version is three numbers, and whatever the build appends to them.
 *
 * Matched anywhere in the first line rather than at a fixed position, because
 * what surrounds it is not a contract: today it is `nikcli v1.384.0`, and a
 * CLI that one day prints its name differently, or adds a build hash, still
 * answers this question. The `v` is optional in what is read and always
 * present in what is returned, so the bar does not gain or lose a letter when
 * the CLI changes its mind.
 */
const VERSION = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/

/**
 * The version to show, or undefined when there is nothing to show.
 *
 * Undefined covers every failure on purpose: nikcli absent, nikcli present but
 * refusing the flag, nikcli printing something unrecognisable. The caller has
 * one case to draw and the bar stays clean.
 */
export function parseNikcliVersion(result: VersionResult | null | undefined): string | undefined {
  if (!result || result.code !== 0) return undefined
  /*
   * stdout first, then stderr. Some CLIs print their version on the error
   * stream, and one that exited 0 having said it there has still answered.
   */
  for (const stream of [result.stdout, result.stderr]) {
    const line = stripAnsi(stream ?? "")
      .split("\n")
      .map((row) => row.trim())
      .find((row) => VERSION.test(row))
    const found = line?.match(VERSION)?.[1]
    if (found) return `v${found}`
  }
  return undefined
}
