import { describe, expect, test } from "bun:test"
import { appendNoteLine, noteLine, shortSelector } from "./note-line"

/* D2: the line «Aggiungi alla nota» writes, from what the page reported. */

const deep = "body > div.comparison-grid:nth-of-type(2) > section.cards > div.decision-card:nth-of-type(3) > h2.title"

describe("noteLine", () => {
  test("variant, name, short selector, text and instruction", () => {
    expect(
      noteLine({ variant: 2, name: "Vetro", elements: [{ selector: deep, innerText: "Il titolo" }], instruction: "più grande" }),
    ).toBe("Variante 2 «Vetro» · div.decision-card:nth-of-type(3) > h2.title «Il titolo»: più grande")
  })

  test("control characters and line breaks never reach the note", () => {
    const line = noteLine({
      variant: 1,
      name: "Ve\u0007tro",
      elements: [{ selector: "h1\nx", innerText: "riga uno\nriga due\u0000" }],
      instruction: "prima\r\nseconda",
    })
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(line).toContain("prima seconda")
  })

  test("the text is cut at 60 characters, the selector at 80", () => {
    const line = noteLine({ variant: 1, elements: [{ selector: `div.${"a".repeat(200)}`, innerText: "t".repeat(200) }], instruction: "" })
    expect(line).toContain(`«${"t".repeat(60)}...»`)
    expect(line).toContain(`div.${"a".repeat(76)}...`)
  })

  test("several elements: one line, the selectors separated by commas, no text", () => {
    expect(
      noteLine({ variant: 3, name: "Rail", elements: [{ selector: "a > h1", innerText: "x" }, { selector: "p.lead" }], instruction: "allinea" }),
    ).toBe("Variante 3 «Rail» · a > h1, p.lead: allinea")
  })

  test("an empty instruction: the line only says where", () => {
    expect(noteLine({ variant: 1, name: "Vetro", elements: [{ selector: "h1", innerText: "Ciao" }], instruction: "  " })).toBe(
      "Variante 1 «Vetro» · h1 «Ciao»",
    )
  })

  test("no element: the variant and the instruction", () => {
    expect(noteLine({ variant: 1, elements: [], instruction: "più aria" })).toBe("Variante 1: più aria")
  })
})

describe("shortSelector", () => {
  test("the last two pieces of a long chain", () => {
    expect(shortSelector(deep)).toBe("div.decision-card:nth-of-type(3) > h2.title")
  })

  test("the last piece only, when the two are too long", () => {
    expect(shortSelector(`div.${"a".repeat(90)} > h2.title`)).toBe("h2.title")
  })
})

describe("appendNoteLine", () => {
  test("a note already written stays as it was, the line goes below", () => {
    expect(appendNoteLine("La 2 mi piace.  ", "Variante 2 · h1")).toBe("La 2 mi piace.  \nVariante 2 · h1")
    expect(appendNoteLine("fine riga\n", "Variante 2 · h1")).toBe("fine riga\nVariante 2 · h1")
  })

  test("two lines in a row do not merge", () => {
    const note = appendNoteLine(appendNoteLine("", "uno"), "due")
    expect(note.split("\n")).toEqual(["uno", "due"])
  })
})
