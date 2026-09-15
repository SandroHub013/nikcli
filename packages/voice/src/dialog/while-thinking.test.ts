import { describe, expect, test } from "bun:test"
import { parseUtterance } from "../intent/parse"
import { triageWhileThinking } from "./while-thinking"

const heard = (text: string, confidence?: number) => triageWhileThinking(parseUtterance(text), { typed: false, confidence }).action
const typed = (text: string) => triageWhileThinking(parseUtterance(text), { typed: true }).action

describe("dialog/while-thinking", () => {
  test("stop words stop, heard or typed", () => {
    for (const text of ["annulla", "Stop.", "basta", "fermati", "lascia stare"]) {
      expect(heard(text)).toBe("stop")
      expect(typed(text)).toBe("stop")
    }
  })

  test("sounds, fillers and fragments heard from the room are ignored", () => {
    for (const text of ["ok", "okay", "sì", "si", "no", "mh", "mmm", "eh", "va bene", "grazie", "e poi", ""]) {
      expect(heard(text)).toBe("ignore")
    }
  })

  test("an unsure recognition is ignored, however long", () => {
    expect(heard("apri la tavolozza dei comandi per favore", 0.4)).toBe("ignore")
    expect(heard("apri la tavolozza dei comandi per favore", 0.9)).toBe("request")
  })

  test("a command or a sentence of three words or more is a request", () => {
    expect(heard("apri la tavolozza")).toBe("request")
    expect(heard("nuova sessione")).toBe("request")
    expect(heard("quante sessioni ci sono")).toBe("request")
  })

  test("typed text is always meant", () => {
    expect(typed("ok")).toBe("request")
    expect(typed("no")).toBe("stop")
  })
})
