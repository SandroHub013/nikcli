import { describe, expect, test } from "bun:test"
import type { ChatModelChoice } from "./model"
import { createModelSource, stateOf, type ModelRead } from "./model-source"

const QWEN: ChatModelChoice = {
  id: "qwen/qwen3-coder:free",
  providerID: "openrouter",
  modelID: "qwen/qwen3-coder:free",
  name: "Qwen3 Coder",
  providerName: "OpenRouter",
  free: true,
  label: "Qwen3 Coder (gratis)",
}

function counted(results: ModelRead[]) {
  const asked: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const source = createModelSource(async (key) => {
    asked.push(key)
    await gate
    const next = results.shift()
    if (!next) throw new Error("nikcli è sparito")
    return next
  })
  return { source, asked, release }
}

describe("the catalog behind a model chip (catalog review, conditions 1 and 3)", () => {
  test("nothing is read until asked, and two opens at once read once", async () => {
    const s = counted([{ ok: true, models: [QWEN] }])
    expect(s.asked).toEqual([])
    expect(s.source.kept("C:/p")).toBeUndefined()
    const first = s.source.read("C:/p")
    const second = s.source.read("C:/p")
    s.release()
    expect(await first).toEqual({ ok: true, models: [QWEN] })
    expect(await second).toEqual({ ok: true, models: [QWEN] })
    expect(s.asked).toEqual(["C:/p"])
  })

  test("a list is kept for the session: the next open reads nothing", async () => {
    const s = counted([{ ok: true, models: [QWEN] }])
    s.release()
    await s.source.read("C:/p")
    expect(s.source.kept("C:/p")).toEqual([QWEN])
    expect(await s.source.read("C:/p")).toEqual({ ok: true, models: [QWEN] })
    expect(s.asked).toEqual(["C:/p"])
  })

  test("a failure is not kept: it says why, and the next open reads again", async () => {
    const s = counted([{ ok: false, reason: "nikcli models è uscito con 1: config non valida" }, { ok: true, models: [QWEN] }])
    s.release()
    const failed = await s.source.read("C:/p")
    expect(failed).toEqual({ ok: false, reason: "nikcli models è uscito con 1: config non valida" })
    expect(stateOf(failed)).toEqual({ kind: "failed", reason: "nikcli models è uscito con 1: config non valida" })
    expect(s.source.kept("C:/p")).toBeUndefined()
    expect(await s.source.read("C:/p")).toEqual({ ok: true, models: [QWEN] })
    expect(s.asked).toEqual(["C:/p", "C:/p"])
  })

  test("a read that throws fails with its message, and is not kept either", async () => {
    const s = counted([])
    s.release()
    expect(await s.source.read("C:/p")).toEqual({ ok: false, reason: "nikcli è sparito" })
    expect(s.source.kept("C:/p")).toBeUndefined()
  })

  test("each folder has its own list", async () => {
    const s = counted([{ ok: true, models: [QWEN] }, { ok: true, models: [] }])
    s.release()
    await s.source.read("C:/a")
    await s.source.read("C:/b")
    expect(s.source.kept("C:/a")).toEqual([QWEN])
    expect(s.source.kept("C:/b")).toEqual([])
    expect(s.asked).toEqual(["C:/a", "C:/b"])
  })
})
