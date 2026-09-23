import { describe, expect, test } from "bun:test"
import { registerWrite, withPlace, type RegisterWriteDeps } from "./register-write"

const NOW = new Date("2026-09-23T12:00:00.000Z")

/** A register in memory: `read` sees what `append` wrote, unless `lose` drops it. */
function file(initial = "", options: { lose?: boolean } = {}) {
  let text = initial
  const appended: string[] = []
  const deps: RegisterWriteDeps = {
    read: async () => text,
    append: async (line) => {
      appended.push(line)
      if (!options.lose) text += line
    },
    now: () => NOW,
    sender: "fable",
  }
  return { deps, appended, text: () => text }
}

const openedDesign = JSON.stringify({
  k: "DS1",
  title: "Tasto",
  variants: [
    { name: "A", description: "", preview: ".ade/design/DS1/1.html" },
    { name: "B", description: "", preview: ".ade/design/DS1/2.html" },
  ],
})

describe("ade-msg registro", () => {
  test("broken JSON: nothing appended", async () => {
    const { deps, appended } = file()
    const reply = await registerWrite(deps, { register: "design", op: "aperta", text: "{rotto" })
    expect(reply).toStartWith("errore: il json non si legge: ")
    expect(appended).toEqual([])
  })

  test("an invalid event: nothing appended, with the serializer's reason", async () => {
    const { deps, appended } = file()
    const reply = await registerWrite(deps, { register: "design", op: "aperta", text: JSON.stringify({ k: "DS1", variants: [] }) })
    expect(reply).toBe("errore: evento non valido: titolo mancante")
    expect(appended).toEqual([])
  })

  test("an answer on a key never opened: nothing appended, with the fold's reason", async () => {
    const { deps, appended } = file()
    const reply = await registerWrite(deps, { register: "decisioni", op: "risposta", text: JSON.stringify({ k: "D9", words: "sì" }) })
    expect(reply).toBe("errore: D9 non è mai stata aperta")
    expect(appended).toEqual([])
  })

  test("a valid aperta: one append, then ok", async () => {
    const { deps, appended, text } = file()
    const reply = await registerWrite(deps, { register: "design", op: "aperta", text: openedDesign })
    expect(reply).toBe("ok: DS1 aperta, nel tasto Design entro 3 s")
    expect(appended).toHaveLength(1)
    expect(JSON.parse(text())).toMatchObject({ type: "aperta", k: "DS1", by: "fable", at: NOW.toISOString() })
  })

  test("aperta without k takes the next key", async () => {
    const { deps } = file()
    await registerWrite(deps, { register: "decisioni", op: "aperta", text: JSON.stringify({ k: "D4", title: "prima" }) })
    const reply = await registerWrite(deps, { register: "decisioni", op: "aperta", text: JSON.stringify({ title: "seconda" }) })
    expect(reply).toBe("ok: D5 aperta, nel tasto Decisioni entro 3 s")
  })

  test("a design aperta with two variants on the same preview: nothing appended", async () => {
    const { deps, appended } = file()
    const same = JSON.stringify({
      k: "DS2",
      title: "Doppia",
      variants: [
        { name: "A", preview: "results/confronto.html" },
        { name: "B", preview: "results/confronto.html" },
      ],
    })
    const reply = await registerWrite(deps, { register: "design", op: "aperta", text: same })
    expect(reply).toBe(
      "errore: due varianti con la stessa anteprima (results/confronto.html): una pagina per variante, vedi S75 punto 3",
    )
    expect(appended).toEqual([])
  })

  test("an append that succeeds but a file read back without the line: scritta ma non risulta", async () => {
    const { deps, appended } = file("", { lose: true })
    const reply = await registerWrite(deps, { register: "design", op: "aperta", text: openedDesign })
    expect(appended).toHaveLength(1)
    expect(reply).toStartWith("errore: scritta ma non risulta aperta")
  })

  test("by and at in the JSON are ignored", async () => {
    const { deps, text } = file()
    const forged = JSON.stringify({ ...JSON.parse(openedDesign), by: "utente", at: "2020-01-01T00:00:00Z", type: "chiusa" })
    expect(await registerWrite(deps, { register: "design", op: "aperta", text: forged })).toStartWith("ok")
    expect(JSON.parse(text())).toMatchObject({ type: "aperta", by: "fable", at: NOW.toISOString() })
  })

  test("another round is reported as giro, and a riaperta brings it back open", async () => {
    const { deps } = file()
    await registerWrite(deps, { register: "design", op: "aperta", text: openedDesign })
    expect(await registerWrite(deps, { register: "design", op: "risposta", text: JSON.stringify({ k: "DS1", words: "meno vetro", again: true }) })).toBe(
      "ok: DS1 giro, nel tasto Design entro 3 s",
    )
    const next = JSON.stringify({ k: "DS1", variants: [{ name: "C", preview: ".ade/design/DS1/3.html" }] })
    expect(await registerWrite(deps, { register: "design", op: "riaperta", text: next })).toBe("ok: DS1 aperta, nel tasto Design entro 3 s")
  })

  test("a missing line break at the end of the file is added before the line", async () => {
    const { deps, appended } = file(`${JSON.stringify({ type: "aperta", k: "D1", at: NOW.toISOString(), by: "x", title: "t" })}`)
    await registerWrite(deps, { register: "decisioni", op: "chiusa", text: JSON.stringify({ k: "D1", evidence: "commit" }) })
    expect(appended[0]).toStartWith("\n{")
  })
})

describe("the check after the write looks for this very event (audit 0.7.7, MEDIO 5)", () => {
  const opened = JSON.stringify({ type: "aperta", k: "D1", at: "2026-09-23T11:00:00.000Z", by: "Master", title: "Quale?", options: ["A", "B"] })

  test("another answer lands just before this one: the key is answered, but not by this write", async () => {
    let text = `${opened}\n`
    const deps: RegisterWriteDeps = {
      read: async () => text,
      append: async (line) => {
        // Someone else's answer reaches the file a moment earlier.
        text += `${JSON.stringify({ type: "risposta", k: "D1", at: "2026-09-23T11:59:59.900Z", by: "Dario", words: "A" })}\n${line.replace(/^\n/, "")}`
      },
      now: () => NOW,
      sender: "fable",
    }
    const reply = await registerWrite(deps, { register: "decisioni", op: "risposta", text: JSON.stringify({ k: "D1", words: "B" }) })
    expect(reply).toStartWith("errore: scritta ma non conta: ")
  })

  test("its own answer, alone: ok as before", async () => {
    const { deps } = file(`${opened}\n`)
    const reply = await registerWrite(deps, { register: "decisioni", op: "risposta", text: JSON.stringify({ k: "D1", words: "B" }) })
    expect(reply).toStartWith("ok: D1 risposta")
  })
})

describe("the reply says which project's register (audit 0.7.7, MEDIO 4)", () => {
  const ok = "ok: D3 aperta, nel tasto Decisioni entro 3 s"

  test("the open project: said, and the button promise stands", () => {
    expect(withPlace(ok, "decisioni", { written: "nikcli", shown: "nikcli", asked: "nikcli" })).toBe(`${ok} (progetto nikcli)`)
  })

  test("another project: the button does not show it, and the reply says where to look", () => {
    const reply = withPlace(ok, "decisioni", { written: "sito", shown: "nikcli", asked: "sito" })
    expect(reply).not.toContain("entro 3 s")
    expect(reply).toBe("ok: D3 aperta, nel progetto sito: il tasto Decisioni ora mostra nikcli, lo vedi aprendo sito")
  })

  test("a session whose project is not among the recents: the fallback is said, not silent", () => {
    expect(withPlace(ok, "decisioni", { written: "nikcli", shown: "nikcli", asked: "vecchio" })).toBe(
      `${ok} (progetto nikcli); la sessione è del progetto vecchio, che non è fra i recenti: scritto in nikcli`,
    )
  })

  test("an error is left as it is", () => {
    expect(withPlace("errore: manca la chiave k", "design", { written: "a", shown: "b" })).toBe("errore: manca la chiave k")
  })
})
