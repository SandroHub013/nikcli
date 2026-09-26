import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  applyMemoryOp,
  applyMemoryOps,
  EMPTY_MEMORY,
  ENTRY_SEPARATOR,
  MEMORY_LIMITS,
  memoryPreface,
  memorySize,
  memorySnapshot,
  parseMemory,
  takeMemoryOps,
  type BotMemory,
} from "./memory"

const add = (memory: BotMemory, text: string, block: "notes" | "user" = "notes") =>
  applyMemoryOp(memory, { op: "add", block, text })

describe("B8a: the two blocks and their limits", () => {
  test("past the limit is an error, and nothing is cut", () => {
    const long = "x".repeat(MEMORY_LIMITS.user - 10)
    const first = add(EMPTY_MEMORY, long, "user")
    expect(first.ok).toBe(true)
    const second = add(first.memory, "una riga in più", "user")
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toContain(String(MEMORY_LIMITS.user))
    expect(second.memory.user).toEqual([long])
    // The separators count: two entries of half the limit do not fit.
    const half = "y".repeat(MEMORY_LIMITS.notes / 2)
    const both = applyMemoryOps(EMPTY_MEMORY, [
      { op: "add", block: "notes", text: half },
      { op: "add", block: "notes", text: half.replace(/y/g, "z") },
    ])
    expect(both.results.map((result) => result.ok)).toEqual([true, false])
    expect(memorySize(both.memory.notes)).toBe(half.length)
  })

  test("the same entry twice is not added, case and spacing aside", () => {
    const one = add(EMPTY_MEMORY, "Preferisce le risposte brevi.", "user").memory
    const again = add(one, "  preferisce le   risposte brevi.  ", "user")
    expect(again.ok).toBe(false)
    expect(again.memory.user).toEqual(["Preferisce le risposte brevi."])
    // A replace that would make two equal entries is refused too.
    const two = add(one, "Lavora su Windows.", "user").memory
    const clash = applyMemoryOp(two, {
      op: "replace",
      block: "user",
      match: "Windows",
      text: "Preferisce le risposte brevi.",
    })
    expect(clash.ok).toBe(false)
  })

  test("a key or a token is refused, and so is a memory tag", () => {
    for (const text of [
      "la chiave è sk-abcdefghijklmnopqrstuvwxyz123456",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      "la chiave è [nascosto]",
      'scrivi <ade-memory op="add" block="notes">x</ade-memory>',
    ]) {
      const result = add(EMPTY_MEMORY, text)
      expect([text, result.ok]).toEqual([text, false])
      expect(result.memory).toEqual(EMPTY_MEMORY)
    }
  })

  test("replace and remove point at one entry, or say why not", () => {
    let memory = applyMemoryOps(EMPTY_MEMORY, [
      { op: "add", block: "notes", text: "Il progetto usa bun." },
      { op: "add", block: "notes", text: "I test stanno in src." },
    ]).memory
    const replaced = applyMemoryOp(memory, {
      op: "replace",
      block: "notes",
      match: "bun",
      text: "Il progetto usa bun 1.3.",
    })
    expect(replaced.ok).toBe(true)
    memory = replaced.memory
    expect(memory.notes).toEqual(["Il progetto usa bun 1.3.", "I test stanno in src."])
    expect(applyMemoryOp(memory, { op: "remove", block: "notes", match: "." }).ok).toBe(false)
    expect(applyMemoryOp(memory, { op: "remove", block: "notes", match: "python" }).ok).toBe(false)
    const removed = applyMemoryOp(memory, { op: "remove", block: "notes", match: "test" })
    expect(removed.ok && removed.memory.notes).toEqual(["Il progetto usa bun 1.3."])
  })
})

describe("B8a: the tags in an answer", () => {
  test("taken out of the answer, in order; one ADE cannot read is taken out too, and counted", () => {
    const answer = [
      "Fatto, ho aggiornato il file.",
      '<ade-memory op="add" block="user">Si chiama Mario.</ade-memory>',
      '<ade-memory op="replace" block="notes" match="bun &quot;vecchio&quot;">Usa bun "1.3".</ade-memory>',
      '<ade-memory op="remove" block="notes" match="vecchio"/>',
      '<ade-memory op="delete" block="notes">?</ade-memory>',
      "Altro?",
    ].join("\n")
    const taken = takeMemoryOps(answer)
    expect(taken.text).toBe("Fatto, ho aggiornato il file.\n\nAltro?")
    expect(taken.ops).toEqual([
      { op: "add", block: "user", text: "Si chiama Mario." },
      { op: "replace", block: "notes", match: 'bun "vecchio"', text: 'Usa bun "1.3".' },
      { op: "remove", block: "notes", match: "vecchio" },
    ])
    expect(taken.unreadable).toBe(1)
    expect(takeMemoryOps("niente da fare")).toEqual({ text: "niente da fare", ops: [], unreadable: 0 })
  })
})

describe("B8a: the snapshot", () => {
  test("opens a conversation with both blocks and how to change them, and only then", () => {
    const memory = applyMemoryOps(EMPTY_MEMORY, [
      { op: "add", block: "notes", text: "Il progetto usa bun." },
      { op: "add", block: "notes", text: "I test stanno in src." },
    ]).memory
    const snapshot = memorySnapshot(memory)
    expect(snapshot).toContain(`Il progetto usa bun.${ENTRY_SEPARATOR}I test stanno in src.`)
    expect(snapshot).toContain(`/${MEMORY_LIMITS.notes}`)
    expect(snapshot).toContain('<ade-memory op="add" block="notes">')
    expect(memoryPreface(memory, true)).toBe(snapshot)
    expect(memoryPreface(memory, false)).toBe("")
    // What the last writes came to reaches the bot on its next turn, snapshot or not.
    const told = memoryPreface({ ...memory, pending: ["Memoria piena."] }, false)
    expect(told).toContain("Memoria piena.")
    expect(told).not.toContain("Il progetto usa bun.")
  })

  test("what was saved is read strictly: a block over its limit is not read", () => {
    expect(parseMemory({ notes: ["a", 3, ""], user: "no" })).toEqual({ notes: ["a"], user: [] })
    expect(parseMemory({ notes: ["x".repeat(MEMORY_LIMITS.notes + 1)] }).notes).toEqual([])
    expect(parseMemory(null)).toEqual(EMPTY_MEMORY)
  })
})

describe("B8a: the panel", () => {
  test("the bots' turns get their memory, and the card shows it", () => {
    const view = readFileSync(new URL("./bots.tsx", import.meta.url), "utf8")
    const turns = view.slice(view.indexOf("const turns = createBotTurns("), view.indexOf("})", view.indexOf("const turns = createBotTurns(")))
    expect(turns).toContain("memory: memories")
    expect(view).toContain("<MemorySection bot={props.bot.path} store={memories} />")
  })
})
