import { describe, expect, test } from "bun:test";
import { createNaturalSpeaker, type NaturalSpeakerDeps } from "./natural-speaker";
import { createFakeSpeaker } from "./speaker";
import { replyVoiceChain, speakingReplyVoice } from "../settings/reply-voices";
import type { TtsLocale } from "../settings/model";

const wav = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const said = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer);

/**
 * A host that says yes to every voice, with the bridge of K4 replaced by a
 * plain function: the point of these tests is what the speaker asks the host
 * for, not that a host exists.
 */
function host(over: Partial<NaturalSpeakerDeps> = {}) {
  const played: string[] = []
  const asked: { voice: string; text: string; locale: TtsLocale }[] = []
  const fallback = createFakeSpeaker()
  const deps: NaturalSpeakerDeps = {
    voice: () => "af_heart",
    ttsLocale: () => "en-US",
    status: async () => ({ supported: true, installed: true }),
    install: async () => {},
    synthesize: async (voice, text, _token, locale) => {
      asked.push({ voice, text, locale })
      return wav(text)
    },
    play: async (buffer) => {
      played.push(said(buffer))
    },
    fallback,
    ...over,
  }
  return { deps, played, asked, fallback }
}

describe("la lingua che il bridge riceve", () => {
  test("arriva esplicita, e non si deduce dal nome della voce", async () => {
    const h = host({ ttsLocale: () => "en-GB" })
    await createNaturalSpeaker(h.deps).speak("I opened the session and started the tests.")
    // Ogni unità porta la lingua, non la prima: il backend non deve indovinare.
    expect(h.asked.length).toBeGreaterThan(0)
    expect(new Set(h.asked.map((unit) => unit.locale))).toEqual(new Set(["en-GB"]))
  });

  test("una voce Britannica su una lingua britannica, senza 'en-gb'", async () => {
    // K1: `en-gb` non esiste fra le voci espeak del runtime.
    const h = host({ voice: () => "bf_emma", ttsLocale: () => "en-GB" })
    await createNaturalSpeaker(h.deps).speak("I opened the session.")
    expect(h.asked[0]!.locale).toBe("en-GB")
    expect(h.asked[0]!.voice).toBe("bf_emma")
  });

  test("il prefetch porta la stessa lingua del speak", async () => {
    const h = host({ ttsLocale: () => "en-US" })
    const speaker = createNaturalSpeaker(h.deps)
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 0))
    speaker.prefetch?.("I am prefetching this sentence for the reply to come.")
    await new Promise((resolve) => setTimeout(resolve, 10))
    await speaker.speak("I am prefetching this sentence for the reply to come.")
    expect(h.asked.length).toBeGreaterThan(1)
    expect(new Set(h.asked.map((unit) => unit.locale))).toEqual(new Set(["en-US"]))
  })
});

describe("il taglio che spetta alla voce", () => {
  const reply = "Ho aperto la sessione Codex sul parser, poi ho lanciato la suite del worktree e adesso guardo i test.";

  test("Kokoro riceve pezzi, e il primo è corto", async () => {
    const h = host({ voice: () => "af_heart", ttsLocale: () => "en-US" })
    await createNaturalSpeaker(h.deps).speak(reply)
    expect(h.asked.length).toBeGreaterThan(1)
    expect(h.asked[0]!.text.length).toBeLessThan(reply.length)
  });

  test("Piper riceve la frase intera, come prima", async () => {
    const h = host({ voice: () => "ugo", ttsLocale: () => "it-IT" })
    await createNaturalSpeaker(h.deps).speak(reply)
    expect(h.asked.map((unit) => unit.text)).toEqual([reply])
  });

  test("e le unità escono in ordine, con la prima che suona prima delle altre", async () => {
    const h = host({ voice: () => "af_heart" })
    await createNaturalSpeaker(h.deps).speak(reply)
    expect(h.asked.map((unit) => unit.text).join(" ")).toBe(reply)
    expect(h.played).toEqual(h.asked.map((unit) => unit.text))
  });
});

describe("il fallback Kokoro → Piper → sistema", () => {
  test("Kokoro che non può parlare passa alla voce di Piper, e la risposta esce lo stesso", async () => {
    const h = host({
      // Il bridge di K4 risponde che il runtime non c'è: 219 MB non scaricati.
      status: async (voice) => ({ supported: voice !== "af_heart", installed: voice !== "af_heart" }),
      voice: () => "af_heart",
      fallbackNotice: () => "",
    })
    // Il passo intermedio è la decisione del dominio, non dello speaker: qui si
    // vede che la catena lo contiene e in che ordine.
    expect(replyVoiceChain("af_heart", "en-US")).toEqual(["af_heart", "lessac", "system"])
    await createNaturalSpeaker(h.deps).speak("I opened the session and started the tests.")
    // Niente Kokorovoice, e niente silenzio: la voce di sotto ha parlato.
    expect(h.asked.map((unit) => unit.voice)).not.toContain("af_heart")
    expect(h.played).toEqual([])
    expect(h.fallback.spoken.length).toBeGreaterThan(0)
  });

  test("la voce che parla è quella che il dominio dice, non quella memorizzata", () => {
    // Una risposta italiana con una voce Kokoro scelta: il dominio dice Paola.
    expect(speakingReplyVoice("af_heart", "it-IT", "en")).toBe("paola")
    expect(speakingReplyVoice("am_fenrir", "it-IT", "en")).toBe("ugo")
    // E in inglese la voce scelta sta sul posto suo.
    expect(speakingReplyVoice("am_fenrir", "en-US", "en")).toBe("am_fenrir")
  });

  test("un profilo Piper non incontra mai Kokoro nella catena", async () => {
    const h = host({ voice: () => "lessac", ttsLocale: () => "en-US" })
    await createNaturalSpeaker(h.deps).speak("I opened the session.")
    expect(h.asked.map((unit) => unit.voice)).toEqual(["lessac"])
  });
});
