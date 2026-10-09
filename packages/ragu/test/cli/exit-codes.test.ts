import { afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { ExitCode, exitCodeFor } from "@/cli/framework/runtime"
import { UI } from "@/cli/ui"

/**
 * EOT-18 requirement 9: the two typed refusals a handler can raise deliberately
 * get their documented code, and everything else reaches the runner untouched.
 *
 * `Effect.promise` maps a rejection to a `Die` cause, which is the only reason
 * the handler seam in `runtime.ts` can see a thrown `CancelledError` at all. The
 * wiring assertions below therefore drive a real throwing effect rather than
 * `Effect.fail`, so they exercise the same channel the production seam uses.
 */
describe("exit codes", () => {
  const saved = process.exitCode
  afterEach(() => {
    process.exitCode = saved
  })

  it("maps only the typed refusals", () => {
    expect(exitCodeFor(new UI.CancelledError())).toBe(ExitCode.interrupted)
    // A prompt nobody can answer is not a crash and not a cancel: it is the
    // "no input" case, and it is the one that has to say what it needs.
    expect(exitCodeFor(new UI.HeadlessFailure({ prompt: "worktree" }))).toBe(ExitCode.noInput)
    // Everything else is left alone so the runner keeps its report and its own
    // code. A cancel must not become the thing that teaches this to swallow
    // arbitrary defects.
    expect(exitCodeFor(new Error("boom"))).toBeUndefined()
    expect(exitCodeFor("x")).toBeUndefined()
    expect(exitCodeFor(undefined)).toBeUndefined()
  })

  it("keeps the documented table", () => {
    expect(ExitCode).toEqual({
      ok: 0,
      failure: 1,
      usage: 2,
      config: 64,
      noInput: 66,
      unavailable: 69,
      interrupted: 130,
    })
  })

  it("a thrown cancel is recovered as the interrupt code", async () => {
    process.exitCode = undefined
    const exit = await Effect.runPromiseExit(
      Effect.promise(async () => {
        throw new UI.CancelledError()
      }).pipe(
        Effect.catchDefect((defect) => {
          const code = exitCodeFor(defect)
          if (code === undefined) return Effect.die(defect)
          process.exitCode = code
          return Effect.void
        }),
      ),
    )
    // Proof the defect channel is what carries it: `catchDefect` sees a thrown
    // `CancelledError`, so the mapping cannot be bypassed by accident.
    expect(exit._tag).toBe("Success")
    expect(process.exitCode as number | undefined).toBe(ExitCode.interrupted)
  })

  it("an unmapped defect is rethrown rather than swallowed", async () => {
    process.exitCode = undefined
    const exit = await Effect.runPromiseExit(
      Effect.promise(async () => {
        throw new Error("real defect")
      }).pipe(
        Effect.catchDefect((defect) => {
          const code = exitCodeFor(defect)
          if (code === undefined) return Effect.die(defect)
          process.exitCode = code
          return Effect.void
        }),
      ),
    )
    // `exitCode` is Bun-normalised to 0 once a run completes, so the assertion
    // that carries the meaning is the one on the exit.
    expect(exit._tag).toBe("Failure")
    expect(process.exitCode).not.toBe(ExitCode.interrupted)
  })
})
