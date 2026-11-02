import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { codeOf } from "../test-support/source-text"
import { formatSpawnFailed, spawnOutcome } from "./spawn-outcome"

/*
 * Live test 2026-11-02: `ade-msg spawn crush "x"` printed «ok: avviata» although the host could not find the program;
 * only the pane said «programma non trovato: crush».
 */
describe("what spawn hears about the start", () => {
  test("a start the host refused is a failure, with the host's reason", async () => {
    const refusals = new Map<string, string>()
    const started = Promise.resolve().then(() => void refusals.set("n1", "programma non trovato: crush"))
    expect(await spawnOutcome(started, () => refusals.get("n1"))).toEqual({
      kind: "failed",
      reason: "programma non trovato: crush",
    })
  })

  test("a start that went through is started", async () => {
    expect(await spawnOutcome(Promise.resolve(), () => undefined)).toEqual({ kind: "started" })
  })

  test("a start that throws is not taken for a success when it left a reason", async () => {
    expect(await spawnOutcome(Promise.reject(new Error("x")), () => "chiave rifiutata")).toEqual({
      kind: "failed",
      reason: "chiave rifiutata",
    })
  })

  test("a slow start is not a failed one: the receipt does not wait for ever", async () => {
    const began = Date.now()
    const outcome = await spawnOutcome(new Promise(() => {}), () => undefined, 30)
    expect(outcome).toEqual({ kind: "slow" })
    expect(Date.now() - began).toBeLessThan(2_000)
  })

  test("the refusal is read after the wait, so one that lands while it waits is heard", async () => {
    const refusals = new Map<string, string>()
    const outcome = spawnOutcome(new Promise(() => {}), () => refusals.get("n1"), 40)
    setTimeout(() => refusals.set("n1", "ssh irraggiungibile"), 5)
    expect(await outcome).toEqual({ kind: "failed", reason: "ssh irraggiungibile" })
  })

  test("the receipt names the reason, the pane and how to close it", () => {
    const text = formatSpawnFailed("Crush ← Master: x", "n1-2", "programma non trovato: crush")
    expect(text.startsWith("errore:")).toBe(true)
    expect(text).toContain("programma non trovato: crush")
    expect(text).toContain("ade-msg close n1-2")
    expect(text).not.toContain("ok: avviata")
  })
})

describe("the workbench's spawn", () => {
  const source = codeOf(readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf-8"))

  test("answers after the start, and a refused one is an error, not «ok: avviata»", () => {
    const branch = source.slice(source.indexOf(codeOf("const outcome = await spawnOutcome(")))
    const failure = branch.slice(0, branch.indexOf(codeOf("ok: avviata la sessione")))
    expect(failure).toContain(codeOf('if (outcome.kind === "failed") {'))
    expect(failure).toContain(codeOf("await answer(formatSpawnFailed(created.title, created.id, outcome.reason))"))
    expect(failure).toContain(codeOf("openRequests.delete(id)"))
  })

  test("both starts, local and ssh, and a folder gone, record why they did not start", () => {
    expect(source.split(codeOf("startRefusals.set(paneId, reason)")).length - 1).toBe(2)
    expect(source).toContain(codeOf('startRefusals.set(paneId, t("project.missing", gone))'))
    // A start forgets what the last one said as it begins.
    const body = source.slice(source.indexOf(codeOf("const startProcess = async (")))
    expect(body.slice(0, body.indexOf("await")).includes(codeOf("startRefusals.delete(paneId)"))).toBe(true)
  })
})
