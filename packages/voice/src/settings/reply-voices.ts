import type { ReplyVoice } from "./model"

/**
 * D19, in the user's words: «ugo per maschile, e piper per femminile,
 * selezionabile dalle impostazioni». Each Piper voice states its licence where
 * it is chosen: both derive from the English lessac voice, whose dataset is
 * licensed for research only.
 */
export const REPLY_VOICE_CHOICES: readonly {
  value: ReplyVoice
  title: string
  desc: string
  licence?: string
}[] = [
  {
    value: "ugo",
    title: "Maschile",
    desc: "Ugo (Piper), naturale e offline",
    licence: "Modello CC-BY-4.0, derivato dalla voce lessac, il cui dataset è concesso per sola ricerca.",
  },
  {
    value: "paola",
    title: "Femminile",
    desc: "Paola (Piper), naturale e offline",
    licence: "Dataset CC0, modello derivato dalla voce lessac, il cui dataset è concesso per sola ricerca.",
  },
  { value: "system", title: "Voce di sistema", desc: "Quella di Windows, senza scaricare nulla" },
]
