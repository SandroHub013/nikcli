import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sameFields, syncFields, type FormFields } from "./settings-sync"

/*
 * D7: the model changed from the chip of the conversation put every field of the open form back to the file's,
 * the persona typed and not saved included. Now only the fields the user has not touched follow the file.
 */
const file: FormFields = {
  description: "Revisiona",
  model: "xai/grok-4.7",
  effort: "",
  runner: "ragu",
  objectives: "Segnala i rischi",
  persona: "Sei un revisore.",
  avatar: "",
}

describe("the form follows the file, field by field", () => {
  test("a model picked from the chip moves the model and leaves the persona typed in the form", () => {
    const typed = { ...file, persona: "Sei un revisore severo. Non scrivi codice." }
    const after = { ...file, model: "openai/gpt-5" }
    const next = syncFields(typed, file, after)
    expect(next.model).toBe("openai/gpt-5")
    expect(next.persona).toBe("Sei un revisore severo. Non scrivi codice.")
    expect(next.description).toBe("Revisiona")
  })

  test("a field the user changed keeps their text even when the file changed the same field", () => {
    const typed = { ...file, model: "mio/modello" }
    const next = syncFields(typed, file, { ...file, model: "openai/gpt-5" })
    expect(next.model).toBe("mio/modello")
  })

  test("a form with nothing touched follows the file in every field", () => {
    const after: FormFields = { ...file, model: "x/y", effort: "high", persona: "Nuova.", avatar: "hex:blue" }
    expect(syncFields(file, file, after)).toEqual(after)
  })

  test("the effort the chip dropped with the model goes too, if the user did not set it", () => {
    const before = { ...file, effort: "high" }
    expect(syncFields(before, before, { ...before, model: "x/y", effort: "" }).effort).toBe("")
  })

  test("two sets of fields are the same when every field is", () => {
    expect(sameFields(file, { ...file })).toBe(true)
    expect(sameFields(file, { ...file, persona: "altro" })).toBe(false)
  })

  test("lint: the settings form syncs by field, and does not put every field back on any change of the file", () => {
    const view = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")
    const form = view.slice(view.indexOf("function BotSettings"))
    expect(form).toContain("syncFields(current, before, after)")
    expect(form).toContain("path === beforePath")
    // The old effect set the persona from the file at every change.
    expect(form).not.toMatch(/\(\) => \{\s*setRunner\(runnerById\(props\.bot\.runner\)\.id\)/)
  })
})
