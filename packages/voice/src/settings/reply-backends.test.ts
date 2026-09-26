import { describe, expect, test } from "bun:test";
import { localePreference, setLocalePreference } from "@nikcli-ai/ade/i18n";
import {
  KOKORO_VOICES,
  KOKORO_VOICE_CHOICES,
  REPLY_BACKEND_CHOICES,
  backendOf,
  replyVoiceChoicesFor,
  voiceOnBackend,
} from "./reply-voices";

/*
 * K6: the panel picks what reads the replies, then a voice of it. A Kokoro voice
 * is listed only under Kokoro, with a name and not its id.
 */
describe("the reply voices, by backend", () => {
  test("three backends, in the order the panel shows them", () => {
    expect(REPLY_BACKEND_CHOICES.map((choice) => choice.value)).toEqual(["piper", "kokoro", "system"]);
    for (const choice of REPLY_BACKEND_CHOICES) expect(choice.desc.length).toBeGreaterThan(10);
  });

  test("the Kokoro voices have names, in both languages, and the model's licence", () => {
    const before = localePreference();
    for (const language of ["it", "en"] as const) {
      setLocalePreference(language);
      expect(KOKORO_VOICE_CHOICES.map((choice) => choice.value)).toEqual(KOKORO_VOICES.map((voice) => voice.id));
      for (const choice of KOKORO_VOICE_CHOICES) {
        expect(choice.title).not.toBe(choice.value);
        expect(choice.title).not.toContain("vui.");
        expect(choice.desc).not.toContain("vui.");
        expect(choice.licence).toContain("Apache-2.0");
      }
    }
    setLocalePreference(before);
  });

  test("each backend lists its own voices and no other's", () => {
    for (const language of ["it", "en"] as const) {
      for (const backend of ["piper", "kokoro", "system"] as const) {
        const voices = replyVoiceChoicesFor(backend, language);
        expect(voices.length).toBeGreaterThan(0);
        for (const choice of voices) expect(backendOf(choice.value)).toBe(backend);
      }
    }
    expect(replyVoiceChoicesFor("piper", "it").map((choice) => choice.value)).toEqual(["ugo", "paola"]);
    expect(replyVoiceChoicesFor("piper", "en").map((choice) => choice.value)).toEqual(["lessac"]);
    expect(replyVoiceChoicesFor("kokoro", "it").map((choice) => choice.value)).toEqual(["af_heart", "am_fenrir", "bf_emma", "bm_george"]);
    expect(replyVoiceChoicesFor("system", "en").map((choice) => choice.value)).toEqual(["system"]);
  });

  test("picking a backend keeps the voice when it is already that backend's", () => {
    expect(voiceOnBackend("kokoro", "bf_emma", "it")).toBe("bf_emma");
    expect(voiceOnBackend("kokoro", "ugo", "it")).toBe("af_heart");
    expect(voiceOnBackend("piper", "af_heart", "it")).toBe("ugo");
    expect(voiceOnBackend("piper", "af_heart", "en")).toBe("lessac");
    expect(voiceOnBackend("piper", "paola", "it")).toBe("paola");
    expect(voiceOnBackend("system", "am_fenrir", "it")).toBe("system");
  });
});
