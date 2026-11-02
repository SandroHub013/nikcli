import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resetLocaleForTests } from "../i18n"
import { connectFailureText, errorMessage, reasonText, startFailureText } from "./start-failure"

afterEach(() => resetLocaleForTests("it"))

describe("a session that did not start says why and what to do (UX-9)", () => {
  test("a program that is not installed names the agent, the command and the fix", () => {
    expect(startFailureText("programma non trovato: claude", { label: "Claude Code" })).toBe(
      "Claude Code non è partito: il comando «claude» non è installato su questo computer. Installalo dalla sua scheda in Nuova sessione, poi premi Riprova.",
    )
  })

  test("the same failure reads in English under English, with no Italian left", () => {
    resetLocaleForTests("en")
    const text = startFailureText("programma non trovato: claude", { label: "Claude Code" })
    expect(text).toBe(
      "Claude Code didn't start: the command “claude” is not installed on this computer. Install it from its card in New session, then press Retry.",
    )
    expect(text).not.toMatch(/programma|trovato|partito/)
  })

  test("any other reason keeps the system's words, minus «Error: », and says where to look", () => {
    expect(startFailureText("Error: accesso negato.")).toBe(
      "La sessione non è partita: accesso negato. Premi Riprova; se succede di nuovo, controlla l'accesso in Impostazioni → Agenti e account.",
    )
  })

  test("Rust's Italian reasons are translated, not shown as they came", () => {
    resetLocaleForTests("en")
    expect(reasonText("claude non parte: accesso negato")).toBe("claude won't start (accesso negato)")
    expect(reasonText("pty non creata: nessuna console")).toBe("the terminal could not be opened (nessuna console)")
    expect(reasonText("un abbonamento non riceve chiavi")).toBe(
      "a subscription does not use keys: choose the key mode or remove the key",
    )
    expect(reasonText("porta ssh non valida: 99999")).toBe("the ssh port 99999 is not valid")
    resetLocaleForTests("it")
    expect(reasonText("porta ssh non valida: 99999")).toBe("la porta ssh 99999 non è valida")
  })

  test("a failed connection asks to check the address, and also drops «Error: »", () => {
    expect(connectFailureText("Error: ssh senza destinazione")).toBe(
      "La connessione non è riuscita: manca la destinazione ssh. Controlla l'indirizzo e la rete, poi riprova.",
    )
  })

  test("what was thrown shows its message, never «Error: …»", () => {
    expect(errorMessage(new Error("file rovinato"))).toBe("file rovinato")
    expect(errorMessage("TypeError: boom")).toBe("boom")
    expect(errorMessage(42)).toBe("42")
  })
})

describe("the nested Rust reasons and the pty.rs wording (UX-9)", () => {
  test("the pty error inside «x non parte: …» is translated too", () => {
    resetLocaleForTests("en")
    expect(reasonText("x non parte: pty non creata: nessuna console")).toBe(
      "x won't start (the terminal could not be opened (nessuna console))",
    )
  })

  test("a connection whose program is missing says to install it, not to check the address", () => {
    expect(connectFailureText("programma non trovato: ssh")).toBe(
      "La connessione non è riuscita: il comando «ssh» non è installato su questo computer. Installalo, poi riprova.",
    )
    expect(reasonText("porta ssh mancante")).toBe("manca la porta dopo -p")
  })

  test("every Rust sentence the mapping knows is still written in pty.rs", () => {
    const rust = readFileSync(join(import.meta.dir, "..", "..", "src-tauri", "src", "pty.rs"), "utf8")
    for (const literal of [
      "programma non trovato: {command}",
      "{command} non parte: {}",
      "pty non creata: {e}",
      "opzione di avvio non consentita per {command}: {flag}",
      "comando non consentito: {command}",
      "{command} non si avvia senza terminale",
      "modalità chiave senza una chiave",
      "modalità chiave: attesa la variabile ANTHROPIC_API_KEY",
      "modalità chiave: attesa la variabile CODEX_API_KEY o OPENAI_API_KEY",
      "un abbonamento non riceve chiavi",
      "argomento ssh non consentito: {arg}",
      "porta ssh non valida: {port}",
      "valore ssh non valido: {value}",
      "porta ssh mancante",
      "valore ssh mancante",
      "ssh senza destinazione",
      "argomento della shell non consentito: {arg}",
    ]) {
      expect(rust, literal).toContain(literal)
    }
  })
})
