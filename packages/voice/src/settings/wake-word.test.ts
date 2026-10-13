import { describe, expect, test } from "bun:test"
import { matchesWakeWord } from "./wake-word"

describe("settings/wake-word - matchesWakeWord", () => {
  const wakeWord = "ei ragù"

  test("triggers on canonical and common speech-to-text misrecognitions", () => {
    // Exact canonical phrase
    expect(matchesWakeWord("ei ragù", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    // Italian phonetic and spelling ASR variations
    expect(matchesWakeWord("ei ragu", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("ei ragú", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("ehi ragù", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("hey ragu", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("hei ragu", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("hey ragoo", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("ehi rago", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("eh ragù", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })
  })

  test("extracts what remains of the utterance following the wake word", () => {
    const res = matchesWakeWord("ei ragù apri il browser", wakeWord)
    expect(res).toEqual({
      matched: true,
      remainder: "apri il browser",
    })

    const res2 = matchesWakeWord("hey ragoo crea una nuova sessione", wakeWord)
    expect(res2).toEqual({
      matched: true,
      remainder: "crea una nuova sessione",
    })

    const resWithFillers = matchesWakeWord("ehm ehi ragù per favore apri la plancia", wakeWord)
    expect(resWithFillers.matched).toBe(true)
    expect(resWithFillers.remainder).toBe("apri la plancia")
  })

  test("said quickly and written as one word, it still triggers", () => {
    expect(matchesWakeWord("eiragu apri il browser", wakeWord)).toEqual({
      matched: true,
      remainder: "apri il browser",
    })
    expect(matchesWakeWord("eiragù apri il browser", wakeWord)).toEqual({
      matched: true,
      remainder: "apri il browser",
    })
    expect(matchesWakeWord("heyragu apri il browser", wakeWord)).toEqual({
      matched: true,
      remainder: "apri il browser",
    })
    expect(matchesWakeWord("heyragoo, apri il browser", wakeWord)).toEqual({
      matched: true,
      remainder: "apri il browser",
    })
  })

  test("does NOT trigger when wake-phrase appears embedded inside a longer word", () => {
    expect(matchesWakeWord("ragusano", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("aragosta", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("tiragù", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("eiragusano", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("parola con ragù dentro", wakeWord).matched).toBe(false)
  })

  test("returns not matched on unrelated utterances or empty inputs", () => {
    expect(matchesWakeWord("", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("chiudi il pannello", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("buongiorno a tutti", wakeWord).matched).toBe(false)
  })

  test("the word «ragù» alone without «ei» does NOT activate", () => {
    expect(matchesWakeWord("ragù", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("ragu", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("ragù apri il browser", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("ragu apri il browser", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("rago apri il browser", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("ragoo apri il browser", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("il telegiornale ehi ragù", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("domani il ragù della nonna", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("secondo me il ragù è buono", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("ehi apri il browser", wakeWord).matched).toBe(false)
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

describe("the fixed phrase, «ei ragù», as the recogniser writes it", () => {
  const phrase = "ei ragù"

  test("the common transcriptions all call it", () => {
    for (const heard of [
      "ei ragù",
      "ehi ragù",
      "hey ragù",
      "hei ragu",
      "ei ragu",
      "ehi ragoo",
      "Hey, Ragù!",
      "Ehi Ragù,",
    ]) {
      expect(matchesWakeWord(`${heard} apri il browser`, phrase)).toEqual({
        matched: true,
        remainder: "apri il browser",
      })
    }
  })

  test("said quickly and written as one word, it still does", () => {
    expect(matchesWakeWord("eiragu apri il browser", phrase)).toEqual({
      matched: true,
      remainder: "apri il browser",
    })
    expect(matchesWakeWord("heyragoo, apri il browser", phrase)).toEqual({
      matched: true,
      remainder: "apri il browser",
    })
    expect(matchesWakeWord("heyragu apri il browser", phrase)).toEqual({
      matched: true,
      remainder: "apri il browser",
    })
  })

  test("the name alone, or the greeting alone, does not", () => {
    expect(matchesWakeWord("ragù apri il browser", phrase).matched).toBe(false)
    expect(matchesWakeWord("ragu apri il browser", phrase).matched).toBe(false)
    expect(matchesWakeWord("ehi apri il browser", phrase).matched).toBe(false)
    expect(matchesWakeWord("il telegiornale ehi ragù", phrase).matched).toBe(false)
    expect(matchesWakeWord("eiragusano", phrase).matched).toBe(false)
  })
})

describe("only the name itself when wakeWord is configured as ragù", () => {
  test("words one letter away from it are not the name", () => {
    for (const heard of [
      "tiragù",
      "aragosta",
      "ragusano",
      "ragusana",
      "ragusa",
    ]) {
      expect(matchesWakeWord(heard, "ragù").matched).toBe(false)
    }
  })
})

describe("«e ragù» from a television", () => {
  test("without a pause after the name, it is not a call", () => {
    for (const heard of [
      "E ragù ha detto che domani piove",
      "E ragù apre la porta",
      "e ragù apri il browser",
      "eragu apri il browser",
    ]) {
      expect(matchesWakeWord(heard, "ragù").matched).toBe(false)
    }
  })
})
