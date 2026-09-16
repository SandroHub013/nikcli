/**
 * ADE's texts in Italian: the source catalog.
 *
 * Every other language is typed from this object, so a key added here and
 * forgotten in `en.ts` is a `tsc` error before it is a test failure. Keys are
 * flat and dotted by area (`settings.language.title`); a text with values in it
 * is a function, and its parameters are part of the contract.
 *
 * Not here on purpose: the replies `ade-msg` gives to agents and the Rust
 * errors (agents read Italian as well as English), and the voice grammar,
 * which follows the speech-recognition language rather than the interface.
 */
export const it = {
  "settings.language.label": "Lingua",
  "settings.language.title": "Lingua",
  "settings.language.desc":
    "La lingua dei menu, dei pannelli e degli avvisi di ADE. «Sistema» segue la lingua del computer. L'assistente vocale continua a usare la lingua del riconoscimento, che si sceglie nelle impostazioni della voce.",
  "settings.language.group": "Lingua dell'interfaccia",
  "settings.language.system": "Sistema",
  "settings.language.systemNow": (language: string) => `Sistema (${language})`,
  "settings.language.it": "Italiano",
  "settings.language.en": "English",
}

/** The shape every catalog has: the same keys, the same parameters. */
export type Messages = {
  [K in keyof typeof it]: (typeof it)[K] extends (...args: infer A) => string ? (...args: A) => string : string
}
