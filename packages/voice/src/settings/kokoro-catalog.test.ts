import { describe, expect, test } from "bun:test";
import { REPLY_BACKEND_BY_VOICE, REPLY_VOICES, TTS_LOCALES, type ReplyVoice, type TtsLocale } from "./model";
import {
  backendOf,
  g2pLocale,
  isKokoroVoice,
  KOKORO_VOICES,
  kokoroVoice,
  replyVoiceChain,
  replyVoiceFor,
  speakingReplyVoice,
} from "./reply-voices";

const KOKORO_IDS = ["af_heart", "am_fenrir", "bf_emma", "bm_george"] as const;

describe("il catalogo Kokoro", () => {
  test("le quattro voci inglesi, e sono tutte nel modello", () => {
    expect(KOKORO_VOICES.map((voice) => voice.id)).toEqual([...KOKORO_IDS]);
    for (const id of KOKORO_IDS) expect(REPLY_VOICES).toContain(id);
  });

  test("D95:due per lingua, una femminile e una maschile, tutte inglesi", () => {
    for (const locale of ["en-US", "en-GB"] as const) {
      const here = KOKORO_VOICES.filter((voice) => voice.locale === locale);
      expect(here.map((voice) => voice.gender).sort()).toEqual(["f", "m"]);
    }
    // Le due voci italiane di upstream non entrano: nessuno le ha ascoltate.
    for (const id of ["if_sara", "im_nicola"]) expect(REPLY_VOICES).not.toContain(id as ReplyVoice);
    for (const voice of KOKORO_VOICES) expect(TTS_LOCALES).toContain(voice.locale);
  });

  test("ogni voce dice da dove viene e con che licenza", () => {
    for (const voice of KOKORO_VOICES) {
      expect(voice.licence).toBe("Apache-2.0");
      expect(voice.model).toBe("Kokoro-82M");
      // Un tag, non un ramo: un asset di release può essere sostituito.
      expect(voice.source).toBe("thewh1teagle/kokoro-onnx@model-files-v1.1");
      expect(voice.source).not.toContain("/main");
    }
  });

  test("il sid è diverso per ogni voce, perché il modello è condiviso", () => {
    const sids = KOKORO_VOICES.map((voice) => voice.sid);
    expect(new Set(sids).size).toBe(sids.length);
  });

  test("il backend di una voce è un fatto della voce, e i due lo concordano", () => {
    for (const id of KOKORO_IDS) {
      expect(backendOf(id)).toBe("kokoro");
      expect(REPLY_BACKEND_BY_VOICE[id]).toBe("kokoro");
      expect(isKokoroVoice(id)).toBe(true);
    }
    for (const id of ["ugo", "paola", "lessac"] as const) {
      expect(backendOf(id)).toBe("piper");
      expect(isKokoroVoice(id)).toBe(false);
      expect(kokoroVoice(id)).toBeUndefined();
    }
    expect(backendOf("system")).toBe("system");
  });
});

describe("la lingua che il G2P riceve", () => {
  test("è quella della voce, e non l'identità: le britanniche prendono 'en'", () => {
    // K1: `en-gb` non esiste fra le voci espeak del runtime, e chiederlo
    // fallisce con «Failed to set eSpeak-ng voice».
    expect(g2pLocale("en-GB")).toBe("en");
    expect(g2pLocale("en-US")).toBe("en-us");
    expect(g2pLocale("it-IT")).toBe("it");
  });

  test("mai una lingua fuori dall'elenco, che il runtime non conosce", () => {
    for (const locale of TTS_LOCALES) expect(["it", "en-us", "en"]).toContain(g2pLocale(locale));
  });
});

describe("il rimappaggio per lingua", () => {
  test("una risposta inglese resta sulla voce Kokoro scelta", () => {
    for (const id of KOKORO_IDS) {
      expect(replyVoiceFor(id, "en-US")).toBe(id);
      expect(replyVoiceFor(id, "en-GB")).toBe(id);
    }
  });

  test("una risposta italiana resta su Ugo o Paola, e sul genere della voce", () => {
    expect(replyVoiceFor("af_heart", "it-IT")).toBe("paola");
    expect(replyVoiceFor("bf_emma", "it-IT")).toBe("paola");
    expect(replyVoiceFor("am_fenrir", "it-IT")).toBe("ugo");
    expect(replyVoiceFor("bm_george", "it-IT")).toBe("ugo");
  });

  test("mai un id Kokoro con la lingua che non può parlare", () => {
    for (const locale of TTS_LOCALES) {
      for (const id of KOKORO_IDS) {
        const speaking = replyVoiceFor(id, locale);
        if (locale === "it-IT") expect(isKokoroVoice(speaking)).toBe(false);
      }
    }
  });

  test("e dalla parte di Piper non cambia niente: una voce sola ha una lingua sola", () => {
    expect(replyVoiceFor("lessac", "it-IT")).toBe("ugo");
    expect(replyVoiceFor("ugo", "en-US")).toBe("lessac");
    expect(replyVoiceFor("paola", "en-GB")).toBe("lessac");
    expect(replyVoiceFor("ugo", "it-IT")).toBe("ugo");
    expect(replyVoiceFor("system", "en-US")).toBe("system");
  });

  test("chi parla tiene conto della lingua del pannello solo per Piper", () => {
    // Il pannolo in inglese ha sempre scelto Lessac: Kokoro non ci passa, e non
    // è un cambiamento che Kokoro può fare da solo.
    expect(speakingReplyVoice("ugo", "it-IT", "en")).toBe("lessac");
    expect(speakingReplyVoice("ugo", "it-IT", "it")).toBe("ugo");
    // Su una voce Kokoro decide la lingua della risposta, non quella del pannello.
    expect(speakingReplyVoice("af_heart", "it-IT", "en")).toBe("paola");
    expect(speakingReplyVoice("af_heart", "en-US", "it")).toBe("af_heart");
  });
});

describe("la catena di fallback", () => {
  test("Kokoro, poi Piper nella stessa lingua, poi il sistema", () => {
    expect(replyVoiceChain("af_heart", "en-US")).toEqual(["af_heart", "lessac", "system"]);
    expect(replyVoiceChain("bm_george", "en-GB")).toEqual(["bm_george", "lessac", "system"]);
  });

  test("su una risposta italiana la catena comincia da Piper, e resta offline", () => {
    expect(replyVoiceChain("af_heart", "it-IT")).toEqual(["paola", "system"]);
    expect(replyVoiceChain("am_fenrir", "it-IT")).toEqual(["ugo", "system"]);
  });

  test("mai Kokoro nel mezzo di un utente che non l'ha scelto", () => {
    // È la regola che 219 MB non arrivano senza che qualcuno li chieda.
    for (const id of ["ugo", "paola", "lessac"] as const) {
      for (const locale of TTS_LOCALES) {
        expect(replyVoiceChain(id, locale as TtsLocale)).not.toContain("af_heart");
      }
    }
  });

  test("la voce di sistema è la fine della catena, e non un tentativo", () => {
    for (const locale of TTS_LOCALES) expect(replyVoiceChain("system", locale)).toEqual(["system"]);
  });

  test("ogni catena finisce nella voce di sistema, e non la nomina due volte", () => {
    for (const id of [...REPLY_VOICES]) {
      for (const locale of TTS_LOCALES) {
        const chain = replyVoiceChain(id, locale);
        expect(chain.at(-1)).toBe("system");
        expect(new Set(chain).size).toBe(chain.length);
      }
    }
  });
});
