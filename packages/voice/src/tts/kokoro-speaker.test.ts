import { describe, expect, test } from "bun:test";
import { createNaturalSpeaker, type NaturalSpeakerDeps } from "./natural-speaker";
import { createFakeSpeaker } from "./speaker";
import { detectReplyLanguage, replyLocale, replyVoiceChain, speakingReplyVoice, type ReplyLanguage } from "../settings/reply-voices";
import type { ReplyVoice, TtsLocale } from "../settings/model";

const wav = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const said = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer);

/**
 * A host that answers, with the bridge of K4 replaced by a plain function: what
 * these tests are about is what the speaker asks the host for, not that a host
 * exists.
 *
 * `voiceFor` is the real rule, not a stub: the chosen voice, the language the
 * reply's text says, and the setting as the fallback. That is the same
 * composition `workbench.tsx` does, so a test that says the wrong voice is
 * caught here and not in the application.
 */
function host(chosen: ReplyVoice = "af_heart", over: Partial<NaturalSpeakerDeps> = {}) {
  const played: string[] = []
  const asked: { voice: string; text: string; locale: TtsLocale }[] = []
  const fallback = createFakeSpeaker()
  const deps: NaturalSpeakerDeps = {
    voiceFor: (detected) => {
      const spoken = replyLocale(chosen, detected, "it-IT");
      return { voice: speakingReplyVoice(chosen, spoken, "it"), locale: spoken }
    },
    status: async () => ({ supported: true, installed: true }),
    install: async () => {},
    synthesize: async (voice, text, _token, locale) => {
      asked.push({ voice, text, locale });
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

describe("la lingua della risposta viene dal suo testo", () => {
  test("un testo italiano lo dice, e lo dice anche quando l'inglese è più lungo", () => {
    expect(detectReplyLanguage("Ho aperto la sessione e i test sono verdi.")).toBe("it");
    // Una riga di identificatori non è un indizio, e non viene tirata a italianità.
    expect(detectReplyLanguage("RSSMRA80A01H501U")).toBeUndefined();
    expect(detectReplyLanguage("OK 42 3.5 2026-09-26")).toBeUndefined();
  });

  test("un testo inglese lo dice, e senza le vocali accentate italiane", () => {
    expect(detectReplyLanguage("I opened the session and the tests are green.")).toBe("en");
    expect(detectReplyLanguage("Ho aperto la sessione, ma i test non sono verdi.")).toBe("it");
  });

  test("quando il testo non dice niente, decide la voce, e il sistema segue l'impostazione", () => {
    // Ogni voce porta con sé la sua lingua, e il testo non ha detto niente.
    expect(replyLocale("af_heart", undefined, "it-IT")).toBe("en-US");
    expect(replyLocale("bf_emma", undefined, "it-IT")).toBe("en-GB");
    expect(replyLocale("lessac", undefined, "it-IT")).toBe("en-US");
    expect(replyLocale("ugo", undefined, "en-US")).toBe("it-IT");
    // La voce di sistema non ha una lingua propria: è l'impostazione.
    expect(replyLocale("system", undefined, "en-GB")).toBe("en-GB");
  });

  test("una risposta italiana resta italiana anche con la voce inglese scelta", () => {
    expect(replyLocale("af_heart", "it", "en-US")).toBe("it-IT");
    expect(replyLocale("bm_george", "it", "en-US")).toBe("it-IT");
  });

  test("una risposta inglese tiene la variante della voce scelta", () => {
    expect(replyLocale("bf_emma", "en", "it-IT")).toBe("en-GB");
    expect(replyLocale("af_heart", "en", "it-IT")).toBe("en-US");
  });
});

describe("la voce che parla è quella che il testo chiede", () => {
  const italian = "Ho aperto la sessione sul parser e adesso i test sono verdi.";
  const english = "I opened the session on the parser and the tests are green.";

  test("testo italiano con una voce Kokoro scelta: parla Ugo o Paola", async () => {
    for (const [kokoro, piper] of [
      ["af_heart", "paola"],
      ["bf_emma", "paola"],
      ["am_fenrir", "ugo"],
      ["bm_george", "ugo"],
    ] as const) {
      const h = host(kokoro);
      await createNaturalSpeaker(h.deps).speak(italian);
      expect(new Set(h.asked.map((unit) => unit.voice))).toEqual(new Set([piper]));
    }
  });

  test("e il testo inglese con la stessa voce parla la voce Kokoro", async () => {
    const h = host("af_heart");
    await createNaturalSpeaker(h.deps).speak(english);
    expect(new Set(h.asked.map((unit) => unit.voice))).toEqual(new Set(["af_heart"]));
  });

  test("la lingua che arriva al bridge è quella della risposta", async () => {
    const h = host("af_heart");
    await createNaturalSpeaker(h.deps).speak(english);
    expect(new Set(h.asked.map((unit) => unit.locale))).toEqual(new Set(["en-US"]));
  });

  test("il prefetch porta la lingua del testo che prefetcha", async () => {
    const h = host("af_heart");
    const speaker = createNaturalSpeaker(h.deps);
    speaker.prepare();
    await new Promise((resolve) => setTimeout(resolve, 0));
    speaker.prefetch?.(english);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.asked.length).toBeGreaterThan(1);
    expect(new Set(h.asked.map((unit) => unit.locale))).toEqual(new Set(["en-US"]));
  });

  test("un warm-up non ha testo da leggere, e usa la voce delle impostazioni", async () => {
    const h = host("ugo");
    await createNaturalSpeaker(h.deps).prepare();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.asked.map((unit) => unit.voice)).toEqual(["ugo"]);
    // E dice quello che non sente nessuno nella lingua di quella voce.
    expect(h.asked.map((unit) => unit.locale)).toEqual(["it-IT"]);
  });
});

describe("il taglio che spetta alla voce", () => {
  // Tre frasi, e la prima pesa più dei 30 caratteri del primo pezzo: è il
  // taglio progressivo di K1, non una novità di questo punto.
  const kokoroReply =
    "I opened the Codex session on the parser and the toolchain. Then I ran the whole suite on the worktree, twice, because the first run looked green. Now I am reading the diff and the numbers again.";
  const piperReply = "Ho aperto la sessione Codex sul parser, poi ho lanciato la suite del worktree e adesso guardo i test.";

  test("Kokoro riceve pezzi, e il primo è corto", async () => {
    const h = host("af_heart");
    await createNaturalSpeaker(h.deps).speak(kokoroReply);
    expect(new Set(h.asked.map((unit) => unit.voice))).toEqual(new Set(["af_heart"]));
    expect(h.asked.length).toBeGreaterThan(1);
    expect(h.asked[0]!.text.length).toBeLessThan(kokoroReply.length);
  });

  test("Piper riceve la frase intera, come prima", async () => {
    const h = host("ugo");
    await createNaturalSpeaker(h.deps).speak(piperReply);
    expect(h.asked.map((unit) => unit.text)).toEqual([piperReply]);
  });

  test("e le unità escono in ordine, con la prima che suona prima delle altre", async () => {
    const h = host("af_heart");
    await createNaturalSpeaker(h.deps).speak(kokoroReply);
    expect(h.asked.map((unit) => unit.text).join(" ")).toBe(kokoroReply);
    expect(h.played).toEqual(h.asked.map((unit) => unit.text));
  });
});

describe("la catena di ripiego è quella del dominio", () => {
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
      for (const locale of ["it-IT", "en-US", "en-GB"] as const) {
        expect(replyVoiceChain(id, locale)).not.toContain("af_heart");
      }
    }
  });

  test("la catena segue la lingua della risposta, non quella delle impostazioni", () => {
    const chosen: ReplyVoice = "af_heart";
    const italian: ReplyLanguage = "it";
    const spoken = replyLocale(chosen, italian, "en-US");
    expect(replyVoiceChain(chosen, spoken)).toEqual(["paola", "system"]);
  });
});
