import { describe, expect, it } from "bun:test"
import * as prompts from "@/cli/prompts"
import { ExitCode, exitCodeFor } from "@/cli/framework/runtime"
import { UI } from "@/cli/ui"

/** EOT-18 requirement 12: a prompt with no default fails closed instead of waiting on a stdin nobody feeds. */
describe("headless prompts", () => {
  const withHeadless = async (fn: () => Promise<void>) => {
    const saved = process.env.NIKCLI_HEADLESS
    process.env.NIKCLI_HEADLESS = "1"
    try {
      await fn()
    } finally {
      if (saved === undefined) delete process.env.NIKCLI_HEADLESS
      else process.env.NIKCLI_HEADLESS = saved
    }
  }

  it("rejects every interactive prompt with a typed failure that names the question", async () => {
    await withHeadless(async () => {
      for (const ask of [
        () => prompts.select({ message: "Pick", options: [{ value: "a", label: "a" }] }),
        () => prompts.multiselect({ message: "Pick", options: [{ value: "a", label: "a" }] }),
        () => prompts.text({ message: "Name" }),
        () => prompts.password({ message: "Secret" }),
        () => prompts.confirm({ message: "Sure" }),
      ]) {
        const error = await ask().then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(error).toBeInstanceOf(UI.HeadlessFailure)
      }
    })
  })

  it("maps to the no-input exit code and says what to do", () => {
    const error = new UI.HeadlessFailure({ prompt: "Name" })
    expect(exitCodeFor(error)).toBe(ExitCode.noInput)
    expect(error.message).toContain('"Name"')
    expect(error.message).toContain("flag")
  })

  it("re-exports the non-interactive helpers untouched", () => {
    expect(typeof prompts.intro).toBe("function")
    expect(typeof prompts.isCancel).toBe("function")
    expect(typeof prompts.spinner).toBe("function")
  })
})
