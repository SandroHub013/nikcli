import { describe, expect, test } from "bun:test"
import { createLineQueue } from "./line-queue"

/** A typeLine as the workbench does it: the text, a wait, then the Enter. */
const typer = (written: string[]) => (text: string, wait = 5) => async () => {
  written.push(text)
  await new Promise((resolve) => setTimeout(resolve, wait))
  written.push("\\r")
  return true
}

describe("one line at a time per session (D73, third round)", () => {
  test("two lines on one session give A, Enter, B, Enter, never A, B, Enter, Enter", async () => {
    const written: string[] = []
    const queue = createLineQueue()
    const type = typer(written)
    await Promise.all([queue("p1", type("[Tempo] A")), queue("p1", type("[Promemoria] B"))])
    expect(written).toEqual(["[Tempo] A", "\\r", "[Promemoria] B", "\\r"])
  })

  test("a line that fails does not block the ones behind it", async () => {
    const written: string[] = []
    const queue = createLineQueue()
    const failing = queue("p1", async () => {
      written.push("rotta")
      throw new Error("la sessione si è chiusa")
    })
    const next = queue("p1", typer(written)("dopo"))
    await expect(failing).rejects.toThrow("la sessione si è chiusa")
    expect(await next).toBe(true)
    expect(written).toEqual(["rotta", "dopo", "\\r"])
  })

  test("two sessions do not wait for each other", async () => {
    const written: string[] = []
    const queue = createLineQueue()
    const type = typer(written)
    await Promise.all([queue("p1", type("uno", 30)), queue("p2", type("due", 1))])
    expect(written.indexOf("due")).toBeLessThan(written.indexOf("\\r"))
  })

  test("a check made inside the chain sees the state at the moment of writing", async () => {
    const written: string[] = []
    const queue = createLineQueue()
    let draft = false
    const guarded = (text: string) => async () => {
      if (draft) return false
      written.push(text, "\\r")
      return true
    }
    const first = queue("p1", async () => {
      written.push("A")
      // The user starts a draft while A waits for its Enter.
      draft = true
      await new Promise((resolve) => setTimeout(resolve, 5))
      written.push("\\r")
      return true
    })
    const second = queue("p1", guarded("B"))
    expect(await first).toBe(true)
    expect(await second).toBe(false)
    expect(written).toEqual(["A", "\\r"])
  })
})
