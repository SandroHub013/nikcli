import { describe, expect, test } from "bun:test"
import { noticeTarget, registerAuthor } from "./mailbox"

describe("a message with no session behind it (audit 0.7.7, MEDIO 6)", () => {
  const open = (paneId: string) => paneId === "p1"

  test("an empty from: the notice goes to the window, not to nobody", () => {
    expect(noticeTarget("", open)).toBe("window")
    expect(noticeTarget(undefined, open)).toBe("window")
  })

  test("an open sender hears it in its session; a closed one, as before, not at all", () => {
    expect(noticeTarget("p1", open)).toEqual({ pane: "p1" })
    expect(noticeTarget("p9", open)).toBeUndefined()
  })

  test("the author of a register event is never empty", () => {
    expect(registerAuthor(undefined, "")).toBe("ade-msg")
    expect(registerAuthor("", "")).toBe("ade-msg")
    expect(registerAuthor(undefined, "p3")).toBe("p3")
    expect(registerAuthor("Master", "p1")).toBe("Master")
  })

  test("a session never signs as the user, whatever its pane is titled", () => {
    for (const title of ["utente", "UTENTE", " Utente ", "u t e n t e"]) {
      expect(registerAuthor(title, "p1")).toBe("p1")
      expect(registerAuthor(title, "")).toBe("ade-msg")
    }
  })
})
