import { describe, expect, test } from "bun:test"
import { withoutNumber } from "./note-line"

/* D2 review, BASSO 2: a name that already carries the number is not numbered twice. */
describe("a numbered variant name", () => {
  test("«1 · A linea» on variant 1 is written once", () => {
    expect(withoutNumber("1 · A linea", 1)).toBe("A linea")
    expect(withoutNumber("2. Vetro", 2)).toBe("Vetro")
    expect(withoutNumber("3) Rail", 3)).toBe("Rail")
  })

  test("another number, or a number that is the name, stays", () => {
    expect(withoutNumber("2 · Vetro", 1)).toBe("2 · Vetro")
    expect(withoutNumber("12 colonne", 1)).toBe("12 colonne")
    expect(withoutNumber("1", 1)).toBe("")
  })

  test("withoutNumber strips variant number prefix", () => {
    expect(withoutNumber("1 · Vetro", 1)).toBe("Vetro")
    expect(withoutNumber("1. Vetro", 1)).toBe("Vetro")
    expect(withoutNumber("1 - Vetro", 1)).toBe("Vetro")
    expect(withoutNumber("Vetro", 1)).toBe("Vetro")
  })
})
