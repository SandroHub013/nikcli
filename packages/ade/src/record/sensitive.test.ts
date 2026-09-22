import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  coverSecrets,
  RECORDING_ATTRIBUTE,
  SECRET_ZONE_ATTRIBUTE,
  SENSITIVE_PARTS,
  SENSITIVE_SELECTOR,
} from "./sensitive"

const src = join(import.meta.dir, "..")

/** Every .tsx under src, so a field cannot hide in a file this test forgot. */
function sources(dir = src): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return entry.endsWith(".tsx") ? [path] : []
  })
}

describe("record/sensitive", () => {
  test("i tipi di campo che contano sono coperti, marcati o no", () => {
    document.body.innerHTML = `
      <input id="password" type="password">
      <input id="nuova-password" type="text" autocomplete="new-password">
      <input id="codice" type="text" autocomplete="one-time-code">
      <div id="marcato" data-sensitive="true"></div>
      <form id="zona" data-secrets><input id="dentro-la-zona" type="text"></form>
      <input id="ricerca" type="text">`
    const found = [...document.querySelectorAll(SENSITIVE_SELECTOR)].map((element) => element.id)
    expect(found).toEqual(["password", "nuova-password", "codice", "marcato", "zona", "dentro-la-zona"])
    document.body.innerHTML = ""
  })

  test("un campo aggiunto a una zona di segreti nasce coperto", () => {
    /*
     * The point of marking the zone instead of the field. The id cabled into
     * the old selector covered one field, and by the time anyone looked it
     * covered none — the element had been renamed out of existence, while the
     * key form had grown two more inputs.
     */
    document.body.innerHTML = `<form data-secrets><input id="domani" type="text" placeholder="scritto la settimana prossima"></form>`
    const nuovo = document.querySelector("#domani")!
    expect(nuovo.matches(SENSITIVE_SELECTOR)).toBe(true)
    document.body.innerHTML = ""
  })

  test("un campo chiave resta coperto anche quando «Mostra» lo rende testo", () => {
    /*
     * Why an id had been cabled in here. Measured live in ADE Test: the
     * OpenRouter field is `type="password"` until «Mostra» is pressed, and
     * then it really is `type="text"` with the key drawn in the clear. The
     * field lives in `packages/voice`, which belongs to another session, so
     * the cover cannot be a mark on it — it has to be something the field
     * already says about itself. It says `id="openrouter-key-field"`.
     */
    document.body.innerHTML = `
      <input id="openrouter-key-field" type="text" value="sk-or-v1-vero">
      <input id="anthropic-token-field" type="text">
      <input name="api_secret" type="text">
      <input id="incolla" type="text" placeholder="sk-or-v1-…">`
    for (const element of [...document.body.querySelectorAll("input")]) {
      expect([element.id || element.name, element.matches(SENSITIVE_SELECTOR)]).toEqual([
        element.id || element.name,
        true,
      ])
    }
    document.body.innerHTML = ""
  })

  test("i campi noti che tengono segreti stanno tutti dentro una zona marcata", () => {
    /*
     * The census, kept where it can go stale loudly. Each entry is a file that
     * draws a field holding a key, a token or a password; the test reads the
     * source and fails if the field is no longer inside a `data-secrets` zone
     * — which is what happens when someone adds a form and copies the markup
     * from somewhere else.
     */
    const noti = [
      { file: "secrets/keys-section.tsx", che: "la lista delle chiavi salvate (coda mascherata, variabile)" },
      { file: "secrets/keys-section.tsx", che: "il form: nome, variabile d'ambiente, valore" },
    ]
    for (const { file, che } of noti) {
      const text = readFileSync(join(src, file), "utf8")
      expect([che, text.includes(SECRET_ZONE_ATTRIBUTE)]).toEqual([che, true])
    }
    // Two zones in that file: the list and the form.
    const keys = readFileSync(join(src, "secrets/keys-section.tsx"), "utf8")
    expect(keys.split(SECRET_ZONE_ATTRIBUTE).length - 1).toBeGreaterThanOrEqual(2)
  })

  test("nessun campo password vive fuori da una zona marcata senza essere coperto", () => {
    /*
     * A password input is covered wherever it is, so this is not about safety
     * but about noticing: a new one means a new place where credentials are
     * typed, and whoever reads this test should be told to look at it.
     */
    const conPassword = sources()
      .filter((path) => /type="password"|autocomplete="(new|current)-password"/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(src.length + 1).replace(/\\/g, "/"))
    expect(conPassword).toEqual(["secrets/keys-section.tsx"])
  })

  test("a take covers them and the end of the take uncovers them", () => {
    const root = document.createElement("html")
    coverSecrets(true, root)
    expect(root.hasAttribute(RECORDING_ATTRIBUTE)).toBe(true)
    coverSecrets(false, root)
    expect(root.hasAttribute(RECORDING_ATTRIBUTE)).toBe(false)
  })

  test("the stylesheet covers every kind of secret the selector names", () => {
    const css = readFileSync(join(src, "index.css"), "utf8")
    for (const part of SENSITIVE_PARTS) {
      expect([part, css.includes(`html[${RECORDING_ATTRIBUTE}] ${part}`)]).toEqual([part, true])
      // Selecting a covered field must not paint its text back.
      expect([part, css.includes(`html[${RECORDING_ATTRIBUTE}] ${part}::selection`)]).toEqual([part, true])
    }
  })

  test("il foglio di stile non copre per nome un campo solo", () => {
    /*
     * `#openrouter-key-field` was the whole reason for this pass: a cover that
     * protects one element by name stops protecting anything the day it is
     * renamed, and says nothing about the field written next to it.
     */
    const css = readFileSync(join(src, "index.css"), "utf8")
    const recording = css.slice(css.indexOf(`html[${RECORDING_ATTRIBUTE}]`))
    const perNome = recording.match(new RegExp(`html\\[${RECORDING_ATTRIBUTE}\\] #[A-Za-z][\\w-]*`, "g"))
    expect(perNome).toBeNull()
  })
})
