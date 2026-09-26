import { describe, expect, test } from "bun:test";
import {
  FIRST_UNIT_WEIGHT,
  UNIT_GROWTH,
  WHOLE_SENTENCES_ABOVE_WEIGHT,
  speechWeight,
  splitSentences,
  splitUnits,
} from "./natural-speaker";

describe("il peso di un pezzo di testo", () => {
  test("una cifra costa quattro, perché si dice con più parole", () => {
    expect(speechWeight("abcd")).toBe(4);
    expect(speechWeight("2026")).toBe(16);
    expect(speechWeight("a1b2")).toBe(2 + 8);
  });

  test("il tetto della prima unità è 30, e i numeri sono quelli di K1", () => {
    expect(FIRST_UNIT_WEIGHT).toBe(30);
    expect(UNIT_GROWTH).toBe(2.5);
    expect(WHOLE_SENTENCES_ABOVE_WEIGHT).toBe(160);
  });
});

describe("il taglio progressivo delle unità", () => {
  test("la prima unità sta sotto il tetto, anche con le cifre", () => {
    const units = splitUnits("Ho aperto la sessione 3.5 sui test del parser e del worktree oggi.");
    expect(speechWeight(units[0]!)).toBeLessThanOrEqual(FIRST_UNIT_WEIGHT);
    expect(units.length).toBeGreaterThan(1);
  });

  test("la prima unità si ferma a una pausa, non a metà parola", () => {
    // «Ho aperto la sessione, poi ho lanciato i test» — la virgola è dopo i
    // 15 caratteri, e il tetto della prima unità è 30: si taglia lì.
    const units = splitUnits("Ho aperto la sessione, poi ho lanciato i test.");
    expect(units[0]).toBe("Ho aperto la sessione,");
  });

  test("senza pause si taglia all'ultimo spazio che ci sta, in peso e non in caratteri", () => {
    // Il peso conta quattro per cifra: «3.5» sono due caratteri e otto di peso,
    // e un taglio a trenta caratteri would've tagliato oltre il tetto.
    const reply = "Il pannello del worktree è ancora aperto e non si chiude";
    const units = splitUnits(reply);
    expect(speechWeight(units[0]!)).toBeLessThanOrEqual(FIRST_UNIT_WEIGHT);
    // E su un confine di parola: ciò che segue è il resto della frase, non un
    // pezzo di parola.
    expect(`${units[0]} ${units.slice(1).join(" ")}`).toBe(reply);
  });

  test("ogni unità sta sotto il tetto, e i tetti crescono", () => {
    const reply = [
      "Ho aperto la sessione Codex sul parser e sto guardando i test del worktree.",
      "Adesso lancio la suite intera, che dura qualche minuto e tiene la CPU occupata.",
      "Poi ti dico com'è andata, con i numeri che escono dalla run.",
    ].join(" ");
    const units = splitUnits(reply);
    expect(units.length).toBeGreaterThan(2);
    expect(units.every((unit) => speechWeight(unit) <= FIRST_UNIT_WEIGHT * Math.pow(UNIT_GROWTH, 3))).toBe(true);
    // Niente parola persa: ricomporre le unità dà la risposta.
    expect(units.join(" ")).toBe(reply);
  });

  test("una frase corta resta una frase, non viene spezzata per amore del tetto", () => {
    expect(splitUnits("Fatto.")).toEqual(["Fatto."]);
    expect(splitUnits("Fatto. Ho aperto la sessione.")).toEqual(["Fatto. Ho aperto la sessione."]);
  });

  test("oltre il tetto le unità sono frasi intere, e non pezzi", () => {
    // Tre frasi lunghe: dopo la prima unità e la seconda il tetto supera 160 e
    // da lì in poi una frase intera è un'unità migliore di un pezzo.
    const long = (n: number) => `${"parola ".repeat(12)}${n}.`;
    const units = splitUnits([long(1), long(2), long(3)].join(" "));
    expect(units.length).toBeGreaterThan(2);
    for (const unit of units) expect(unit.length).toBeGreaterThan(0);
    expect(units.join(" ")).toBe([long(1), long(2), long(3)].join(" "));
  });

  test("il taglio non mangia nulla e non lascia unità vuote", () => {
    const reply = "A, B, C, D, E, F, G, H, I, J.";
    const units = splitUnits(reply);
    expect(units.every((unit) => unit.trim().length > 0)).toBe(true);
    expect(units.join(" ").replace(/\s+/g, " ")).toBe(reply);
  });

  test("Piper resta sulle frasi: è un altro taglio, e lo dice", () => {
    // La stessa frase con le due regole accanto, così la differenza è visibile
    // e non un dettaglio di un test.
    const reply = "Ho aperto la sessione Codex sul parser, poi ho lanciato i test del worktree.";
    expect(splitSentences(reply)).toEqual([reply]);
    expect(splitUnits(reply).length).toBeGreaterThan(1);
  });

  test("un testo vuoto non produce unità", () => {
    expect(splitUnits("")).toEqual([]);
    expect(splitUnits("   ")).toEqual([]);
  });
});

/*
 * Un taglio che cade dentro una parola è un refuso. Un taglio che cade dentro un
 * numero è un numero diverso: `1.234.567` letto da solo e `89` letto dopo non
 * dicono `1.234.567,89`. Il tetto è un peso e non una lunghezza proprio perché
 * un pezzo che lo supera costa silenzio, mentre un pezzo spezzato costa il
 * numero che si stava dicendo.
 */
describe("il taglio non spezza mai quello che va detto intero", () => {
  /** Every token with a digit in it, in order: what the reply is saying. */
  function numbers(text: string): string[] {
    return text.match(/[\d][\d.,/]*\d|\d/g) ?? [];
  }

  test("un importo con i separatori delle migliaia resta un numero", () => {
    const reply = "Il totale è 1.234.567,89 EUR come da fattura numero 20260926001.";
    const units = splitUnits(reply);
    // Non basta che il testo si ricomponga: ogni cifra deve essere nella stessa
    // unità in cui era stata scritta.
    for (const number of numbers(reply)) {
      expect(units.some((unit) => unit.includes(number)), `«${number}» intero in una unità`).toBe(true);
    }
  });

  test("un codice fiscale non viene spezzato", () => {
    const units = splitUnits("Il codice fiscale RSSMRA80A01H501U del cliente va nel fatturato.");
    expect(units.some((unit) => unit.includes("RSSMRA80A01H501U"))).toBe(true);
  });

  test("un lungo numero senza spazi resta un numero", () => {
    const units = splitUnits("Il saldo è 1234567890 euro.");
    expect(units.some((unit) => unit.includes("1234567890"))).toBe(true);
  });

  test("un indirizzo non viene spezzato a metà", () => {
    const units = splitUnits("Guarda https://esempio.it/articolo/molto-lungo per il seguito.");
    const together = units.filter((unit) => unit.includes("esempio.it")).join(" ");
    expect(together).toContain("https://esempio.it/articolo/molto-lungo");
  });

  test("una data intera, trattini e punti compresi", () => {
    const units = splitUnits("Il prezzo è 9,99 e la data è 2026-09-26.");
    expect(units.some((unit) => unit.includes("2026-09-26"))).toBe(true);
    // E il punto finale non è una sintesi tutta sua.
    expect(units.some((unit) => unit.trim() === ".")).toBe(false);
  });

  test("andare oltre il tetto è accettato, tagliare dentro no", () => {
    // Il codice da solo pesa 64 e il tetto è 30: nessuno spazio ci sta dentro,
    // e la prima unità lo prende intero passando oltre. È il compromesso: un
    // pezzo più lungo costa qualche millisecondo, un pezzo spezzato costa il
    // codice.
    const units = splitUnits("RSSMRA80A01H501U è il codice del cliente.");
    expect(units[0]).toBe("RSSMRA80A01H501U");
    expect(speechWeight(units[0]!)).toBeGreaterThan(FIRST_UNIT_WEIGHT);
    // E nessun pezzo è rimasto a metà di un token con cifre.
    for (const unit of units) {
      for (const number of numbers(unit)) expect(number.length).toBeGreaterThan(0);
    }
  });

  test("un'unità solo di punteggiatura non resta orfana", () => {
    const units = splitUnits("Il prezzo è 9,99 e la data è 2026-09-26.");
    for (const unit of units) expect(unit.trim()).not.toMatch(/^[^\p{L}\p{N}]+$/u);
  });
});
