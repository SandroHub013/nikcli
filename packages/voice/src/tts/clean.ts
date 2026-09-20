/**
 * Cleans text before it is synthesized into spoken voice (TTS).
 *
 * An assistant's prose often contains raw URLs (https://..., www....), file
 * paths (C:/Users/..., packages/voice/...), markdown links ([label](url)),
 * and trailing blocks of sources ("Fonti:", "Sources:", link lists, footnotes).
 *
 * Spoken aloud by TTS, these are unlistenable, hostile, and useless to hear.
 * This module cleans them into natural speech phrasing ("il link", "nel file",
 * etc.) or drops them where the sentence holds up on its own, leaving the
 * displayed transcript in the panel completely untouched.
 */

// Quick test to avoid regex operations on plain text without links or paths
const NEEDS_CLEANING =
  /https?:\/\/|www\.|\.(?:[a-zA-Z]{2,4}\/)|[A-Za-z]:[\\\/]|\/(?:Users|home|root|var|etc|usr|tmp|opt)\/|\w+[\\\/]\w+[\\\/]|\[[^\]]+\]|\b(?:Fonti|Sources|Riferimenti)\b/i

/**
 * Normalizes and cleans text for speech synthesis.
 */
export function cleanForSpeech(text: string): string {
  if (!text || typeof text !== "string") return ""
  if (!NEEDS_CLEANING.test(text)) return text

  let result = text.trim()

  // If the entire text is solely a source block (e.g. "Fonti: https://example.com")
  if (/^(?:Fonti(?:\s+utilizzate)?|Sources|Riferimenti|Note\s+e\s+fonti)\s*:[\s\S]*$/i.test(result)) {
    return "La fonte."
  }

  // 1. Strip trailing sources / references sections at the end of a response
  // Matches when starting on a new line or preceded by sentence-ending punctuation
  result = result.replace(
    /(?:(?:\r?\n|(?<=[.!?])\s+)\s*(?:Fonti(?:\s+utilizzate)?|Sources|Riferimenti|Note\s+e\s+fonti)\s*:[\s\S]*)$/i,
    "",
  )

  // Trailing list of links or footnote definitions at the end of the text
  // Only strips genuine lists of sources (bulleted or numbered items on new lines)
  // e.g. "\n- https://..." or "\n[1] https://..."
  result = result.replace(
    /(?:\r?\n\s*(?:[-*•]\s+|\d+\.\s+|\[\^?\d+\]:?\s*)(?:https?:\/\/|www\.)\S+\s*)+$/i,
    "",
  )

  // 2. Remove inline footnote citation markers like [1], [2], [^1]
  result = result.replace(/\s*\[\^?\d+\](?!\()/g, "")

  // 3. Unwrap Markdown links: [label](url)
  // If label is descriptive (e.g. [documentazione](url)), keep the label.
  // If label is itself an URL, unwrap to the URL so subsequent rules format it with context.
  result = result.replace(
    /\[([^\]]+)\]\(((?:https?:\/\/|www\.)[^\)]+)\)/gi,
    (_match, label: string, url: string) => {
      const trimmed = label.trim()
      if (/^(?:https?:\/\/|www\.)/i.test(trimmed)) {
        return url
      }
      return trimmed
    },
  )

  // 4. Remove parenthetical URLs or paths: (https://...), (vedi https://...), (C:/...)
  // In speech, parenthetical links/paths are citations that can be cleanly omitted.
  result = result.replace(
    /\s*\((?:(?:vedi|guarda|link:?|fonte:?|file:?)\s+)?(?:https?:\/\/|www\.|[A-Za-z]:[\\\/]|\/(?:Users|home|root|var|etc|usr|tmp|opt)\/)[^\)]*\)/gi,
    "",
  )

  // 5. Replace URLs in prose with natural phrasing ("il link", "sul link", etc.)
  result = result.replace(
    /(^|[\s,;:(])([a-zA-ZÀ-ÿ']+)?\s*((?:https?:\/\/|www\.)[^\s)\]>]+)([\.,;:!\?]*)?/gi,
    (_match, leadingSpace: string, prevWord: string | undefined, url: string, trailingPunct: string | undefined) => {
      let punct = trailingPunct || ""
      const prefix = leadingSpace || ""

      const urlPunctMatch = url.match(/[.,;:!?]+$/)
      if (urlPunctMatch) {
        punct = urlPunctMatch[0] + punct
      }

      if (!prevWord) {
        const replacement = prefix === "" ? "Il link" : prefix.endsWith(" ") ? "il link" : " il link"
        return `${prefix}${replacement}${punct}`
      }

      const lower = prevWord.toLowerCase()
      const isCap = prevWord[0] === prevWord[0].toUpperCase()

      // If the preceding word already names the link, keep the noun and drop the raw URL
      if (
        [
          "link",
          "links",
          "url",
          "sito",
          "pagina",
          "indirizzo",
          "portale",
          "fonte",
        ].includes(lower)
      ) {
        return `${prefix}${prevWord}${punct}`
      }

      // Articles: (il, lo, la, i, gli, le, un, uno, una)
      if (["il", "lo", "la", "l'"].includes(lower)) {
        return `${prefix}${isCap ? "Il link" : "il link"}${punct}`
      }
      if (["i", "gli", "le"].includes(lower)) {
        return `${prefix}${isCap ? "I link" : "i link"}${punct}`
      }
      if (["un", "uno", "una", "un'"].includes(lower)) {
        return `${prefix}${isCap ? "Un link" : "un link"}${punct}`
      }

      // Preposition combinations
      if (["su", "sul", "sullo", "sulla", "sugli", "sulle"].includes(lower)) {
        return `${prefix}sul link${punct}`
      }
      if (["a", "al", "allo", "alla", "agli", "alle"].includes(lower)) {
        return `${prefix}al link${punct}`
      }
      if (["da", "dal", "dallo", "dalla", "dagli", "dalle"].includes(lower)) {
        return `${prefix}dal link${punct}`
      }
      if (["in", "nel", "nello", "nella", "negli", "nelle"].includes(lower)) {
        return `${prefix}nel link${punct}`
      }
      if (["di", "del", "dello", "della", "degli", "delle"].includes(lower)) {
        return `${prefix}del link${punct}`
      }
      if (lower === "per") {
        return `${prefix}per il link${punct}`
      }
      if (lower === "con") {
        return `${prefix}con il link${punct}`
      }

      // Action verbs preceding a link
      if (
        [
          "visita",
          "visitare",
          "apri",
          "aprire",
          "guarda",
          "guardare",
          "vedi",
          "vedere",
          "consulta",
          "consultare",
          "trovi",
          "trova",
          "leggi",
          "leggere",
        ].includes(lower)
      ) {
        return `${prefix}${prevWord} il link${punct}`
      }
      if (["clicca", "cliccare"].includes(lower)) {
        return `${prefix}${prevWord} sul link${punct}`
      }

      return `${prefix}${prevWord} il link${punct}`
    },
  )

  // 6. Replace file paths with natural phrasing ("il file", "nel file", etc.)
  const filePathPattern =
    /(^|[\s,;:(])([a-zA-ZÀ-ÿ']+)?\s*([A-Za-z]:[\\\/][^\s)\]>,;]+|\/(?:Users|home|root|var|etc|usr|tmp|opt)\/[^\s)\]>,;]+|(?:\.{1,2}[\\\/]|[a-zA-Z0-9_.-]+[\\\/](?:[a-zA-Z0-9_.-]+[\\\/])+)[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)([\.,;:!\?]*)?/gi

  result = result.replace(
    filePathPattern,
    (_match, leadingSpace: string, prevWord: string | undefined, path: string, trailingPunct: string | undefined) => {
      let punct = trailingPunct || ""
      const prefix = leadingSpace || ""

      const pathPunctMatch = path.match(/[.,;:!?]+$/)
      if (pathPunctMatch) {
        punct = pathPunctMatch[0] + punct
      }

      if (!prevWord) {
        const replacement = prefix === "" ? "Il file" : prefix.endsWith(" ") ? "il file" : " il file"
        return `${prefix}${replacement}${punct}`
      }

      const lower = prevWord.toLowerCase()
      const isCap = prevWord[0] === prevWord[0].toUpperCase()

      if (["file", "cartella", "directory", "percorso"].includes(lower)) {
        return `${prefix}${prevWord}${punct}`
      }

      // Articles before file paths
      if (["il", "lo", "la", "l'"].includes(lower)) {
        return `${prefix}${isCap ? "Il file" : "il file"}${punct}`
      }
      if (["i", "gli", "le"].includes(lower)) {
        return `${prefix}${isCap ? "I file" : "i file"}${punct}`
      }
      if (["un", "uno", "una", "un'"].includes(lower)) {
        return `${prefix}${isCap ? "Un file" : "un file"}${punct}`
      }

      if (["in", "nel", "nello", "nella"].includes(lower)) {
        return `${prefix}nel file${punct}`
      }
      if (["su", "sul", "sullo", "sulla"].includes(lower)) {
        return `${prefix}sul file${punct}`
      }
      if (["da", "dal", "dallo", "dalla"].includes(lower)) {
        return `${prefix}dal file${punct}`
      }
      if (["di", "del", "dello", "della"].includes(lower)) {
        return `${prefix}del file${punct}`
      }
      if (lower === "per") {
        return `${prefix}per il file${punct}`
      }
      if (
        [
          "leggi",
          "leggere",
          "apri",
          "aprire",
          "modificato",
          "aggiornato",
          "creato",
          "salvato",
          "controlla",
          "vedi",
        ].includes(lower)
      ) {
        return `${prefix}${prevWord} il file${punct}`
      }

      return `${prefix}${prevWord} il file${punct}`
    },
  )

  // 7. Cleanup whitespace, empty parens/brackets, and punctuation spacing
  result = result
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()

  // If the input was only an URL or link that had no punctuation
  if (result === "Il link" || result === "La fonte" || result === "Il file") {
    result += "."
  }

  return result
}
