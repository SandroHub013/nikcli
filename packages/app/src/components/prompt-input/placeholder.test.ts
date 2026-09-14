import { describe, expect, test } from "bun:test"
import { promptPlaceholder } from "./placeholder"

describe("promptPlaceholder", () => {
  const t = (key: string) => key

  test("returns shell placeholder in shell mode", () => {
    const value = promptPlaceholder({
      mode: "shell",
      commentCount: 0,
      t,
    })
    expect(value).toBe("prompt.placeholder.shell")
  })

  test("returns summarize placeholders for comment context", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 1, t })).toBe(
      "prompt.placeholder.summarizeComment",
    )
    expect(promptPlaceholder({ mode: "normal", commentCount: 2, t })).toBe(
      "prompt.placeholder.summarizeComments",
    )
  })

  test("the default placeholder teaches the composer syntax rather than an example", () => {
    // The clickable suggestions on the empty session already answer "what can I
    // ask"; this space is worth more spent on `/` and `@`, which nothing else says.
    expect(promptPlaceholder({ mode: "normal", commentCount: 0, t })).toBe("prompt.placeholder.normal")
  })
})
