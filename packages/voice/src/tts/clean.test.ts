import { describe, expect, test } from "bun:test"
import { cleanForSpeech } from "./clean"

describe("cleanForSpeech", () => {
  test("testo senza link non deve cambiare", () => {
    const raw = "Tutti i test sono passati con successo e la compilazione è completata."
    expect(cleanForSpeech(raw)).toBe(raw)

    const simple = "Ho corretto il parser: mancava il caso della riga vuota."
    expect(cleanForSpeech(simple)).toBe(simple)
  })

  test("frase con un link in mezzo", () => {
    // 1. Preposizione "su"
    expect(
      cleanForSpeech("Puoi trovare la documentazione su https://example.com/docs per tutti i dettagli tecnici."),
    ).toBe("Puoi trovare la documentazione sul link per tutti i dettagli tecnici.")

    // 2. Preposizione "a"
    expect(
      cleanForSpeech("Collegati a https://example.com/login per accedere."),
    ).toBe("Collegati al link per accedere.")

    // 3. In mezzo a una frase con verbo
    expect(
      cleanForSpeech("Visita https://example.com per registrarti."),
    ).toBe("Visita il link per registrarti.")

    // 4. Con link già menzionato
    expect(
      cleanForSpeech("Trovi il file al link https://example.com/download ora."),
    ).toBe("Trovi il file al link ora.")

    // 5. Link tra parentesi
    expect(
      cleanForSpeech("Leggi la guida (https://example.com/docs) prima di iniziare."),
    ).toBe("Leggi la guida prima di iniziare.")
  })

  test("risposta che finisce con un elenco di fonti", () => {
    // 1. Blocco con "Fonti:" e lista puntata
    const withFonti = `La configurazione del server è terminata con successo.

Fonti:
- https://example.com/source1
- https://example.com/source2`
    expect(cleanForSpeech(withFonti)).toBe("La configurazione del server è terminata con successo.")

    // 2. Blocco con "Sources:" e note numerate
    const withSources = `Ho trovato tre riferimenti utili.
Sources:
[1] https://site1.com
[2] https://site2.com`
    expect(cleanForSpeech(withSources)).toBe("Ho trovato tre riferimenti utili.")

    // 3. "Fonti:" inline in fondo alla risposta
    expect(
      cleanForSpeech("La capitale è Parigi. Fonti: https://it.wikipedia.org/wiki/Parigi."),
    ).toBe("La capitale è Parigi.")

    // 4. Elenco finale di link senza intestazione esplicita
    const withLinksList = `Tutte le informazioni sono confermate.
- https://example.com/a
- https://example.com/b`
    expect(cleanForSpeech(withLinksList)).toBe("Tutte le informazioni sono confermate.")
  })

  test("testo con più link", () => {
    // 1. Due URL raw
    expect(
      cleanForSpeech("Visita https://example.com e consulta anche https://test.org/api per verificare le chiamate."),
    ).toBe("Visita il link e consulta anche il link per verificare le chiamate.")

    // 2. Markdown links con testo descrittivo
    expect(
      cleanForSpeech("Trovi sia la [guida ufficiale](https://docs.example.com) sia il [codice sorgente](https://github.com/repo) online."),
    ).toBe("Trovi sia la guida ufficiale sia il codice sorgente online.")

    // 3. Markdown link dove il testo è un URL
    expect(
      cleanForSpeech("Vai su [https://example.com](https://example.com) per continuare."),
    ).toBe("Vai sul link per continuare.")
  })

  test("percorsi di file trasformati in linguaggio naturale", () => {
    // 1. Percorso Windows con lettera di unità
    expect(
      cleanForSpeech("Leggi C:/Users/39349/Favorites/ade-team/briefs/lucia-voce-no-link.md e fallo."),
    ).toBe("Leggi il file e fallo.")

    // 2. Preposizione "in" prima di un percorso
    expect(
      cleanForSpeech("Dettagli in C:/Users/39349/Favorites/nikcli/.ade/results/1789864941966-0bea8afe.md."),
    ).toBe("Dettagli nel file.")

    // 3. Se "il file" è già presente nel testo
    expect(
      cleanForSpeech("Ho modificato il file C:\\Users\\39349\\Favorites\\nikcli\\packages\\voice\\src\\tts\\clean.ts con le nuove modifiche."),
    ).toBe("Ho modificato il file con le nuove modifiche.")

    // 4. Percorso relativo con directory
    expect(
      cleanForSpeech("I dettagli sono in packages/voice/src/tts/clean.ts per la revisione."),
    ).toBe("I dettagli sono nel file per la revisione.")

    // 5. Percorso tra parentesi
    expect(
      cleanForSpeech("Consulta la configurazione (C:/Users/39349/config.json) per verificare i parametri."),
    ).toBe("Consulta la configurazione per verificare i parametri.")
  })

  test("rimozione dei riferimenti a piè di pagina nel testo", () => {
    expect(
      cleanForSpeech("Il modulo audio [1] è stato aggiornato secondo le indicazioni [2]."),
    ).toBe("Il modulo audio è stato aggiornato secondo le indicazioni.")
  })

  test("link a fine frase come oggetto non viene troncato", () => {
    // 1. Oggetto diretto con verbo essere
    expect(
      cleanForSpeech("Il repository è https://github.com/x/y."),
    ).toBe("Il repository è il link.")

    // 2. Dopo due punti
    expect(
      cleanForSpeech("Trovi tutto qui: https://example.com/api."),
    ).toBe("Trovi tutto qui: il link.")

    // 3. Oggetto diretto con verbo transitivo
    expect(
      cleanForSpeech("Ho configurato https://example.com."),
    ).toBe("Ho configurato il link.")
  })

  test("articolo prima del link non viene duplicato", () => {
    // 1. Articolo determinativo femminile "la"
    expect(
      cleanForSpeech("Guarda la https://esempio.com."),
    ).toBe("Guarda il link.")

    // 2. Articolo determinativo maschile "il"
    expect(
      cleanForSpeech("Apri il https://esempio.com."),
    ).toBe("Apri il link.")

    // 3. Articolo indeterminativo "una" / "un"
    expect(
      cleanForSpeech("Ho trovato una https://esempio.com per te."),
    ).toBe("Ho trovato un link per te.")
    expect(
      cleanForSpeech("Crea un https://esempio.com."),
    ).toBe("Crea un link.")

    // 4. Articolo plurale "i" / "le"
    expect(
      cleanForSpeech("Consulta i https://esempio.com."),
    ).toBe("Consulta i link.")
  })

  test("risposta contenente solo un URL o solo una fonte", () => {
    expect(cleanForSpeech("https://example.com")).toBe("Il link.")
    expect(cleanForSpeech("Fonti: https://example.com")).toBe("La fonte.")
  })
})

