import { describe, expect, it } from "bun:test"
import { Truncate } from "@/tool/truncation"
import * as fs from "fs/promises"

describe("Truncate.truncateHeadTail", () => {
  it("does not truncate content below or equal to HEAD_TAIL_THRESHOLD", () => {
    const text = "A".repeat(Truncate.HEAD_TAIL_THRESHOLD)
    const result = Truncate.truncateHeadTail(text)
    expect(result.truncated).toBe(false)
    expect(result.content).toBe(text)
    expect(result.outputPath).toBeUndefined()
  })

  it("truncates content exceeding HEAD_TAIL_THRESHOLD keeping 1k head and 7k tail", async () => {
    const text = "START_" + "X".repeat(10000) + "_END"
    const result = Truncate.truncateHeadTail(text)
    expect(result.truncated).toBe(true)
    expect(result.content).toContain("START_")
    expect(result.content).toContain("_END")
    expect(result.content).toContain("The tool call succeeded but the output was truncated")
    expect(result.outputPath).toBeDefined()
    const saved = await fs.readFile(result.outputPath!, "utf-8")
    expect(saved).toBe(text)
  })

  it("does not split a surrogate pair at the head cut boundary", () => {
    // 999 'A's, then 🚀 (\uD83D\uDE80), then 10000 'B's
    // The rocket emoji spans indices 999 and 1000. Slicing at 1000 would split the pair.
    const text = "A".repeat(999) + "🚀" + "B".repeat(10000)
    const result = Truncate.truncateHeadTail(text)
    expect(result.truncated).toBe(true)
    // Head should be shifted by 1 char to 999 chars, not splitting the pair
    const headPart = result.content.split("\n\n...")[0]
    expect(headPart).toBe("A".repeat(999))
    expect(headPart.charCodeAt(headPart.length - 1)).not.toBe(0xd83d)
  })

  it("does not split a surrogate pair at the tail cut boundary", () => {
    // 12000 'X's, then 🚀 (\uD83D\uDE80), then 6999 'Y's
    // Total length = 12000 + 2 + 6999 = 19001.
    // tailChars = 7000 -> text.length - 7000 = 12001 (which is the low surrogate \uDE80).
    const text = "X".repeat(12000) + "🚀" + "Y".repeat(6999)
    const result = Truncate.truncateHeadTail(text)
    expect(result.truncated).toBe(true)
    // Tail should be shifted by 1 char to 6999 chars, not splitting the pair
    const parts = result.content.split("] ...\n\n")
    const tailPart = parts[1]
    expect(tailPart).toBe("Y".repeat(6999))
    expect(tailPart.charCodeAt(0)).not.toBe(0xde80)
  })
})
