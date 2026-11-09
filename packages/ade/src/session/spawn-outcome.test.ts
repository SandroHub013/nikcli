import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { codeOf } from "../test-support/source-text"
import { formatSpawnFailed, spawnOutcome } from "./spawn-outcome"
import { workbenchSource } from "../test-support/workbench-source"

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
  const source = codeOf(workbenchSource())

  test("answers after the start, and a refused one is an error, not «ok: avviata»", () => {
    const branch = source.slice(source.indexOf(codeOf("const outcome = await spawnOutcome(")))
    const failure = branch.slice(0, branch.indexOf(codeOf("ok: avviata la sessione")))
    expect(failure).toContain(codeOf('if (outcome.kind === "failed") {'))
    expect(failure).toContain(codeOf("const failed = formatSpawnFailed(created.title, created.id, outcome.reason)"))
    expect(failure).toContain(codeOf("await answer(failed)"))
    // Review B5: the request is settled with the refusal as its result, so a waiter past 10 s hears it; a bare delete left it silent.
    expect(failure).toContain(codeOf("await settle(host, id, `[ade-msg] ${failed}`)"))
    expect(failure).not.toContain(codeOf("openRequests.delete(id)"))
  })

  test("both starts, local and ssh, and a folder gone, record why they did not start", () => {
    expect(source.split(codeOf("startRefusals.set(paneId, reason)")).length - 1).toBe(2)
    expect(source).toContain(codeOf('startRefusals.set(paneId, t("project.missing", gone))'))
    // A start forgets what the last one said as it begins.
    const body = source.slice(source.indexOf(codeOf("const startProcess = async (")))
    expect(body.slice(0, body.indexOf("await")).includes(codeOf("startRefusals.delete(paneId)"))).toBe(true)
  })
})

/*
 * Review N2 and N3: a start that threw (not one the host refused) was told to the pane and recorded nowhere, so a spawn
 * waiting on it said «ok», and a relaunch that failed closed its requests with «si è chiusa» and no reason.
 */
describe("every way a start can fail is recorded, and heard by whoever waits", () => {
  const source = codeOf(workbenchSource())

  test("the catch of a local and of a remote start record the reason as the refusals do", () => {
    expect(source).toContain(
      codeOf("tellPane(paneId, startFailureText(String(e), agent))\n      startRefusals.set(paneId, String(e))"),
    )
    expect(source).toContain(
      codeOf("tellPane(paneId, connectFailureText(String(e)))\n      startRefusals.set(paneId, String(e))"),
    )
  })

  test("a pane that is gone forgets what its start said", () => {
    const forget = source.slice(source.indexOf(codeOf("const forgetPane = (id: string) => {")))
    expect(forget.slice(0, 1500)).toContain(codeOf("startRefusals.delete(id)"))
  })

  test("a request closed because its session is gone says why it did not start, when it is known", () => {
    const closing = source.slice(source.indexOf(codeOf('if (state === "sessione chiusa") {')))
    const text = closing.slice(0, closing.indexOf("continue"))
    expect(text).toContain(codeOf("startRefusals.get(request.to)"))
    expect(text).toContain(codeOf("non è ripartita (${refusal})"))
  })
})
