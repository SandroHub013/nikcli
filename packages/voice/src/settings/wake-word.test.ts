import { describe, expect, test } from "bun:test"
import { matchesWakeWord } from "./wake-word"

describe("settings/wake-word - matchesWakeWord", () => {
  const wakeWord = "hei nik"

  test("triggers on canonical and common speech-to-text misrecognitions", () => {
    // Exact canonical phrase
    expect(matchesWakeWord("hei nik", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    // Italian phonetic and spelling ASR variations
    expect(matchesWakeWord("ehi nik", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("hey nick", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("ei nik", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("ehi nick", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })
  })

  test("extracts what remains of the utterance following the wake word", () => {
    const res = matchesWakeWord("hei nik apri il browser", wakeWord)
    expect(res).toEqual({
      matched: true,
      remainder: "apri il browser",
    })

    const res2 = matchesWakeWord("ehi nick crea una nuova sessione", wakeWord)
    expect(res2).toEqual({
      matched: true,
      remainder: "crea una nuova sessione",
    })

    const resWithFillers = matchesWakeWord("ehm ehi nik per favore apri la plancia", wakeWord)
    expect(resWithFillers.matched).toBe(true)
    expect(resWithFillers.remainder).toBe("apri la plancia")
  })

  test("does NOT trigger when wake-phrase appears embedded inside a longer word", () => {
    // Substring inside larger Italian words or invented compounds must not fire
    expect(matchesWakeWord("nikopolis", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("disobbedienik", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("scheinik", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("heirloom nik", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("parola con nikopolis dentro", wakeWord).matched).toBe(false)
  })

  test("returns not matched on unrelated utterances or empty inputs", () => {
    expect(matchesWakeWord("", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("chiudi il pannello", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("buongiorno a tutti", wakeWord).matched).toBe(false)
  })

  test("supports custom user-configured wake words", () => {
    const customWake = "jarvis"
    expect(matchesWakeWord("jarvis apri il terminale", customWake)).toEqual({
      matched: true,
      remainder: "apri il terminale",
    })

    expect(matchesWakeWord("jarvisiano", customWake).matched).toBe(false)
  })
})
