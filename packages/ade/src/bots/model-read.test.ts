import { describe, expect, test } from "bun:test"
import { t } from "../i18n"
import type { Host, RunResult } from "../host/shell"
import { readModelCatalog } from "./store"

/*
 * Review 4, MEDIO 2: the bot form said «serve nikcli nel PATH» whatever had
 * happened. The read now says why it failed.
 */

const hostRunning = (run: (args: string[], cwd?: string) => Promise<RunResult>) =>
  async () => ({ nikcliBot: run }) as unknown as Host

describe("reading nikcli's catalog, and why it failed", () => {
  test("the list, from the folder, with every provider", async () => {
    const asked: { args: string[]; cwd?: string }[] = []
    const read = await readModelCatalog(
      undefined,
      "C:/progetto",
      hostRunning(async (args, cwd) => {
        asked.push({ args, ...(cwd ? { cwd } : {}) })
        return { code: 0, stdout: "openrouter/x:free\n{\n}\n", stderr: "" }
      }),
    )
    expect(read).toEqual({ ok: true, text: "openrouter/x:free\n{\n}\n" })
    expect(asked).toEqual([{ args: ["models", "--verbose"], cwd: "C:/progetto" }])
  })

  test("an exit with an error gives the code and nikcli's first line of error, cut short", async () => {
    const long = "x".repeat(400)
    const read = await readModelCatalog(
      undefined,
      "C:/p",
      hostRunning(async () => ({ code: 1, stdout: "", stderr: `\n  Error: config non valida ${long}\nstack…` })),
    )
    expect(read.ok).toBe(false)
    const reason = read.ok ? "" : read.reason
    expect(reason).toStartWith(t("bots.models.exit", "1", "").slice(0, 10))
    expect(reason).toContain("Error: config non valida")
    expect(reason).not.toContain("stack")
    expect(reason.length).toBeLessThan(260)
  })

  test("a nikcli that does not start, a host that cannot run it, and an empty list each say so", async () => {
    expect(await readModelCatalog(undefined, "C:/p", hostRunning(async () => Promise.reject(new Error("program not found"))))).toEqual({
      ok: false,
      reason: t("bots.models.notFound"),
    })
    expect(await readModelCatalog(undefined, "C:/p", async () => undefined)).toEqual({ ok: false, reason: t("bots.models.noHost") })
    expect(await readModelCatalog(undefined, "C:/p", hostRunning(async () => ({ code: 0, stdout: " \n", stderr: "" })))).toEqual({
      ok: false,
      reason: t("bots.models.empty"),
    })
  })
})
