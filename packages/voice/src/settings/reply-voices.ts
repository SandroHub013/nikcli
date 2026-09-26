import { REPLY_VOICES, type ReplyBackend, type ReplyVoice, type TtsLocale } from "./model";
import { t, type Locale } from "@nikcli-ai/ade/i18n";

/*
 * Nothing in this file may import a *value* from `model.ts`. `model.ts` needs
 * `replyVoiceFor` to repair a profile, and this file needs the unions from
 * there; a type-only import is erased and the two modules do not see each
 * other at runtime, but a value import would close the loop.
 */

/** The Kokoro voices, as facts and not as labels. */
export type KokoroVoiceId = "af_heart" | "am_fenrir" | "bf_emma" | "bm_george";

export interface KokoroVoice {
  readonly id: KokoroVoiceId;
  /** The locale the voice is spoken in, and the only one it can be spoken in. */
  readonly locale: TtsLocale;
  readonly gender: "f" | "m";
  /**
   * The speaker index in the voice pack. The model is shared by all four and
   * weighs 163 MB; this is what says which voice speaks, and it is why the
   * pack is installed once for the four rather than four times.
   */
  readonly sid: number;
  /** The weights behind the voice, and the licence they come with. */
  readonly model: string;
  /** Where the files are pinned: a release tag, not a branch. */
  readonly source: string;
  readonly licence: string;
}

/**
 * The four English Kokoro voices, and the whole first tranche.
 *
 * D95: the English ones are added, and the Italian `if_sara` and `im_nicola`
 * are not — upstream calls its own non-English support subtle, the only G2P
 * here is espeak, and a voice nobody has listened to is a voice nobody can
 * choose. And fp16, not int8: int8 is about ten times slower and the listening
 * test did not make it worth the 30 MB.
 *
 * `sid` and the G2P locales below are what K1 measured on this machine; the
 * model files are `thewh1teagle/kokoro-onnx` at `model-files-v1.1`, the weights
 * are Apache-2.0 and the export is MIT.
 */
export const KOKORO_VOICES: readonly KokoroVoice[] = [
  {
    id: "af_heart",
    locale: "en-US",
    gender: "f",
    sid: 3,
    model: "Kokoro-82M",
    source: "thewh1teagle/kokoro-onnx@model-files-v1.1",
    licence: "Apache-2.0",
  },
  {
    id: "am_fenrir",
    locale: "en-US",
    gender: "m",
    sid: 14,
    model: "Kokoro-82M",
    source: "thewh1teagle/kokoro-onnx@model-files-v1.1",
    licence: "Apache-2.0",
  },
  {
    id: "bf_emma",
    locale: "en-GB",
    gender: "f",
    sid: 21,
    model: "Kokoro-82M",
    source: "thewh1teagle/kokoro-onnx@model-files-v1.1",
    licence: "Apache-2.0",
  },
  {
    id: "bm_george",
    locale: "en-GB",
    gender: "m",
    sid: 26,
    model: "Kokoro-82M",
    source: "thewh1teagle/kokoro-onnx@model-files-v1.1",
    licence: "Apache-2.0",
  },
];

const BY_ID = new Map<string, KokoroVoice>(KOKORO_VOICES.map((voice) => [voice.id, voice]));

/** What is known about a voice, or nothing when it is not a Kokoro one. */
export function kokoroVoice(voice: ReplyVoice): KokoroVoice | undefined {
  return BY_ID.get(voice);
}

/** Whether this voice is read by Kokoro rather than by Piper. */
export function isKokoroVoice(voice: ReplyVoice): boolean {
  return BY_ID.has(voice);
}

/**
 * The locale the G2P is actually handed, allowlisted.
 *
 * Not the identity, and the British one is the reason: K1 measured that the
 * British voices take `en` and that `en-gb` is not among the espeak voices
 * inside the runtime — asking for it fails with "Failed to set eSpeak-ng
 * voice", on a machine whose interface is in English and whose voice would
 * otherwise have been the only thing wrong.
 */
export function g2pLocale(locale: TtsLocale): "it" | "en-us" | "en" {
  if (locale === "en-US") return "en-us";
  if (locale === "en-GB") return "en";
  return "it";
}

/** A Piper voice asked for the wrong language: Lessac is the English one. */
function piperVoiceFor(chosen: ReplyVoice, locale: TtsLocale): ReplyVoice {
  const italian = chosen === "ugo" || chosen === "paola";
  if (locale.startsWith("en")) return italian ? "lessac" : chosen;
  return chosen === "lessac" ? "ugo" : chosen;
}

/**
 * The voice that speaks for `chosen` in `locale`.
 *
 * The Kokoro voices are English, so an Italian reply on one of them does not
 * become a broken synthesis: it goes to the Piper voice of the same gender,
 * Ugo or Paola, and the choice stays where the user put it. Nothing is written
 * here — this is asked at every operation, and the settings keep what was
 * chosen; the one place it is written down is the repair in `normalizeSettings`,
 * which says so.
 *
 * The other direction is here for the same reason and not out of symmetry: Ugo
 * read in English would be an Italian voice saying English words, which is the
 * thing this whole rule exists to avoid.
 */
export function replyVoiceFor(chosen: ReplyVoice, locale: TtsLocale): ReplyVoice {
  if (chosen === "system") return "system";
  const kokoro = kokoroVoice(chosen);
  if (!kokoro) return piperVoiceFor(chosen, locale);
  if (locale.startsWith("en")) return chosen;
  return kokoro.gender === "f" ? "paola" : "ugo";
}

/**
 * The order a reply is tried in: the voice, then the same language on the other
 * local backend, then the system voice.
 *
 * The middle step is what makes a Kokoro answer still an offline answer while
 * the 219 MB are downloading, or on a host that cannot run the runtime. It is
 * only ever added downwards: a Piper voice that cannot speak does not silently
 * become a Kokoro one, because Kokoro is opt-in and nobody asked for 219 MB.
 * And a profile that never chose Kokoro cannot reach it through this chain.
 */
export function replyVoiceChain(chosen: ReplyVoice, locale: TtsLocale): ReplyVoice[] {
  const first = replyVoiceFor(chosen, locale);
  if (first === "system") return ["system"];
  if (!isKokoroVoice(first)) return [first, "system"];
  return [first, piperVoiceFor("lessac", locale), "system"];
}

/** Whether a plain string is one of the voices the catalog knows. */
function isReplyVoice(voice: string): voice is ReplyVoice {
  return (REPLY_VOICES as readonly string[]).includes(voice);
}

/**
 * The same chain, from a voice id that has already been decided and may not be in
 * the catalog.
 *
 * The speaker is handed a voice, not a setting, so the chain it walks is the one
 * of that voice: a Kokoro id gets Piper after it, a Piper id does not get a
 * Kokoro one before it, and an id nothing knows is the only step there is. The
 * remap is not applied twice because `replyVoiceFor` is idempotent on an id it
 * already resolved, which is what makes this safe to call on a spoken voice.
 */
export function replyVoiceChainFrom(voice: string, locale: TtsLocale): string[] {
  if (isReplyVoice(voice)) return replyVoiceChain(voice, locale);
  return voice === "system" ? ["system"] : [voice];
}

/** The backend that reads a voice, for the panel and the bridge. */
export function backendOf(voice: ReplyVoice): ReplyBackend {
  return kokoroVoice(voice) ? "kokoro" : voice === "system" ? "system" : "piper";
}

/**
 * The voice that speaks right now, which is not always the one that was chosen.
 *
 * Two rules, and they are not the same rule. A Piper voice is one language, and
 * which one has always been the language of the interface — that is
 * `activeReplyVoice`, and nothing here changes it. A Kokoro voice is English,
 * so what decides is the language of the reply: an Italian answer goes to the
 * Piper voice of the same gender rather than being read with an English mouth.
 *
 * Asking both here rather than in each caller is the point: the speaker, the
 * panel and the tests must not each hold a slightly different idea of which
 * voice is speaking.
 */
export function speakingReplyVoice(chosen: ReplyVoice, ttsLocale: TtsLocale, ui: Locale): ReplyVoice {
  if (!isKokoroVoice(chosen)) return activeReplyVoice(chosen, ui);
  return replyVoiceFor(chosen, ttsLocale);
}

/**
 * D19, in the user's words: «ugo per maschile, e piper per femminile,
 * selezionabile dalle impostazioni». Each Piper voice states its licence where
 * it is chosen: both derive from the English lessac voice, whose dataset is
 * licensed for research only.
 *
 * The Kokoro voices are not in this list yet: they are in `KOKORO_VOICES`, as
 * facts, and the panel that offers them is K6 with their labels. Adding them
 * here without those labels would put four rows in the voice picker with an id
 * where a name should be.
 */
export const REPLY_VOICE_CHOICES: readonly {
  value: ReplyVoice;
  title: string;
  desc: string;
  licence?: string;
}[] = [
  {
    value: "ugo",
    get title() {
      return t("vui.reply.male");
    },
    get desc() {
      return t("vui.reply.ugo");
    },
    get licence() {
      return t("vui.reply.ugo.licence");
    },
  },
  {
    value: "paola",
    get title() {
      return t("vui.reply.female");
    },
    get desc() {
      return t("vui.reply.paola");
    },
    get licence() {
      return t("vui.reply.paola.licence");
    },
  },
  {
    value: "lessac",
    get title() {
      return t("vui.reply.lessac.title");
    },
    get desc() {
      return t("vui.reply.lessac.desc");
    },
    get licence() {
      return t("vui.reply.lessac.licence");
    },
  },
  {
    value: "system",
    get title() {
      return t("vui.reply.system");
    },
    get desc() {
      return t("vui.reply.system.desc");
    },
  },
];

const PIPER_BY_LOCALE: Record<Locale, ReadonlySet<ReplyVoice>> = {
  it: new Set<ReplyVoice>(["ugo", "paola"]),
  en: new Set<ReplyVoice>(["lessac"]),
};

/** Voices the panel may offer for the interface language: matching Piper voices, plus system. */
export function replyVoiceChoicesForLocale(
  language: Locale,
): (typeof REPLY_VOICE_CHOICES)[number][] {
  const piper = PIPER_BY_LOCALE[language];
  return REPLY_VOICE_CHOICES.filter(
    (choice) => choice.value === "system" || piper.has(choice.value),
  );
}

/**
 * What the text of a reply says about its language.
 *
 * `undefined` is the honest answer and the common one: a handful of words, or a
 * line of numbers and identifiers, says nothing, and guessing there is how an
 * English voice ends up reading an Italian sentence. So this only answers when
 * the words are enough, and the setting is what answers the rest.
 */
export type ReplyLanguage = "it" | "en";

/*
 * Words that only one of the two languages uses, as whole words.
 *
 * The short ones both languages share are left out on purpose: `a`, `in`, `la`,
 * `di`, `che` and `non` are not evidence of anything, and counting them would
 * make a line of code look Italian. What is left are words that decide on their
 * own, which is a smaller list and a much better one.
 */
const ITALIAN_WORDS = new Set([
  "il", "lo", "gli", "una", "uno", "delle", "della", "dei", "degli", "nel", "nella", "nelle", "dal", "dalla",
  "che", "chi", "non", "cosa", "come", "perché", "percio", "quindi", "già", "più", "sono", "essere", "stato",
  "hanno", "aveva", "questo", "quella", "quelli", "quelle", "suo", "sua", "suoi", "sue", "loro", "noi", "voi",
  "molto", "ogni", "qualche", "anche", "ancora", "quando", "dove", "senza", "sotto", "sopra", "dopo", "prima",
  "posso", "devo", "vorrei", "fatto", "adesso", "nessuno", "niente", "sempre", "mai", "così", "sì", "tutto",
  "apro", "aperta", "sessione", "pannello", "errore", "riprova", "funziona", "volendo",
]);

const ENGLISH_WORDS = new Set([
  "the", "of", "for", "with", "and", "are", "was", "were", "its", "this", "that", "these", "those", "you",
  "your", "they", "their", "have", "has", "had", "not", "but", "from", "there", "which", "who", "what", "how",
  "would", "could", "should", "will", "been", "about", "into", "than", "then", "also", "very", "just", "more",
  "some", "only", "other", "because", "where", "when", "does", "session", "opened", "panel", "error", "retry",
  "works", "everything", "still", "want", "need", "let", "please", "here", "now",
]);

/** The accented letters an Italian sentence has and an English one does not. */
const ITALIAN_ONLY_LETTERS = /[àèéìíîòóùú]/i;

/**
 * The language a reply is written in, or `undefined` when the text does not say.
 *
 * Counts whole words, and counts the ones that only one language uses. Italian
 * gets a nudge from the accented letters, which is not a proof and is enough to
 * break a tie: `più`, `già` and `perché` are not English.
 *
 * What it deliberately does not do is answer for a text with no words in it, or
 * for one where the two languages tie. `ttsLocale` is the fallback for both, and
 * a wrong answer here is a wrong voice, not a wrong word.
 */
export function detectReplyLanguage(text: string): ReplyLanguage | undefined {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length === 0) return undefined;
  let italian = 0;
  let english = 0;
  for (const word of words) {
    if (ITALIAN_WORDS.has(word)) italian += 1;
    if (ENGLISH_WORDS.has(word)) english += 1;
  }
  if (ITALIAN_ONLY_LETTERS.test(text) && italian + 1 > english) italian += 1;
  if (italian > english) return "it";
  if (english > italian) return "en";
  return undefined;
}

/**
 * The locale a reply is spoken in: what the text says, and the setting when the
 * text does not.
 *
 * The order matters and is the whole point. A reply in Italian is read in
 * Italian whatever the panel says, which is what keeps a Kokoro voice from
 * reading an Italian answer with an English mouth. A reply in English keeps the
 * English locale of the voice that was chosen — the British voices have one, and
 * it is not the same — and the setting is only asked when nothing else knows.
 */
export function replyLocale(chosen: ReplyVoice, detected: ReplyLanguage | undefined, fallback: TtsLocale): TtsLocale {
  const voice = kokoroVoice(chosen);
  if (detected === "it") return "it-IT";
  if (detected === "en") {
    if (voice && voice.locale.startsWith("en")) return voice.locale;
    return fallback.startsWith("en") ? fallback : "en-US";
  }
  // Nothing said: a voice the user chose for its language brings that language
  // with it, and a Piper voice has one in its own name.
  if (voice) return voice.locale;
  if (chosen === "lessac") return "en-US";
  if (chosen === "ugo" || chosen === "paola") return "it-IT";
  return fallback;
}

/**
 * The Piper (or system) voice that actually speaks for `chosen` in `language`.
 *
 * A stored id from the other language is remapped so speech and the panel
 * agree; the catalog still holds every id, the panel just does not offer the
 * ones that would do nothing.
 */
export function activeReplyVoice(
  chosen: ReplyVoice,
  language: Locale,
): ReplyVoice {
  if (chosen === "system") return "system";
  if (language === "en")
    return chosen === "ugo" || chosen === "paola" ? "lessac" : chosen;
  return chosen === "lessac" ? "ugo" : chosen;
}
