import { afterEach, describe, expect, test } from "bun:test"
import { resetLocaleForTests } from "@ragu/ade/i18n"
import { errorKind, plainProblem, spokenMessage } from "./effect/errors"
import { isPlanningSentence, plannerFailure } from "./plan/planner"

/*
 * Full review 2026-10-06, ui 11 and sessions 13 (F7b): the texts the voice shows and says follow the interface's language, and
 * what other code recognises in them (the «Non riesco a pianificare» prefix, the microphone kinds) is recognised in both.
 */
afterEach(() => resetLocaleForTests("it"))

describe("the planner's failures", () => {
  test("say the situation in the interface's language", () => {
    resetLocaleForTests("it")
    expect(plannerFailure(new Error("429 rate limit"))).toBe(
      "Il servizio ha ricevuto troppe richieste in poco tempo. Riprova fra un momento.",
    )
    resetLocaleForTests("en")
    expect(plannerFailure(new Error("429 rate limit"))).toBe("The service got too many requests in a short time. Try again in a moment.")
    expect(plannerFailure(new Error("fetch failed"))).toBe("I didn't reach the service. Check the connection and try again.")
    expect(plannerFailure(new Error("something odd"))).toBe("I couldn't get a plan. Try again in a moment.")
  })

  test("the runner's «could not plan» sentence passes as written, whichever language wrote it", () => {
    expect(isPlanningSentence("Non riesco a pianificare: Claude Code non si avvia.")).toBe(true)
    expect(isPlanningSentence("I can't plan: Claude Code does not start.")).toBe(true)
    expect(isPlanningSentence("Something else")).toBe(false)
    resetLocaleForTests("en")
    expect(plannerFailure(new Error("Non riesco a pianificare: Claude Code non si avvia."))).toBe(
      "Non riesco a pianificare: Claude Code non si avvia.",
    )
    expect(plannerFailure(new Error("I can't plan: Claude Code does not start."))).toBe("I can't plan: Claude Code does not start.")
  })
})

describe("the errors", () => {
  test("the microphone kinds are told in English too", () => {
    expect(errorKind("Microphone access denied: allow it in the system's privacy settings")).toBe("mic-auth")
    expect(errorKind(new Error("No microphone detected or accessible."))).toBe("mic-auth")
    expect(errorKind("Accesso al microfono negato")).toBe("mic-auth")
    expect(errorKind("The service had a problem (500)")).toBe("failed")
  })

  test("a message of the voice's own, in English, is said as it is", () => {
    expect(spokenMessage(new Error("The OpenRouter key does not work: check it in the voice settings."), "en")).toBe(
      "The OpenRouter key does not work: check it in the voice settings.",
    )
    expect(spokenMessage(new Error("I can't open the microphone: busy"), "en")).toBe("I can't open the microphone: busy")
    expect(spokenMessage(new Error("odd"), "en")).toBe("Something went wrong: please try again.")
    expect(plainProblem("Failed to fetch", "en")).toContain("No network connection")
  })
})
