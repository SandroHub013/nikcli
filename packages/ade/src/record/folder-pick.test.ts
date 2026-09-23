import { describe, expect, test } from "bun:test"
import { onePickAtATime } from "./folder-pick"

describe("the take folder is asked for once at a time", () => {
  test("three Enters while the dialog is open: one dialog, and all three get its answer", async () => {
    let dialogs = 0
    let answer!: (folder: string | undefined) => void
    const pick = onePickAtATime(() => {
      dialogs++
      return new Promise<string | undefined>((resolve) => (answer = resolve))
    })
    const asked = [pick(), pick(), pick()]
    expect(dialogs).toBe(1)
    answer("C:/video")
    expect(await Promise.all(asked)).toEqual(["C:/video", "C:/video", "C:/video"])
  })

  test("once answered, or cancelled, the next command asks again", async () => {
    let dialogs = 0
    const pick = onePickAtATime(async () => (dialogs++, undefined))
    await pick()
    await pick()
    expect(dialogs).toBe(2)
  })
})
