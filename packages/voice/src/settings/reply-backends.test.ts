import { describe, expect, test } from "bun:test";
import { localePreference, setLocalePreference, t } from "@nikcli-ai/ade/i18n";
import {
  KOKORO_VOICES,
  KOKORO_VOICE_CHOICES,
  REPLY_BACKEND_CHOICES,
  backendOf,
  rememberReplyVoice,
  replyVoiceChoicesFor,
  voiceOnBackend,
} from "./reply-voices";
import {
  normalizeSettings,
  type ReplyVoice,
  type ReplyVoiceMemory,
} from "./model";

/*
 * K6: the panel picks what reads the replies, then a voice of it. A Kokoro voice
 * is listed only under Kokoro, with a name and not its id.
 */
describe("the reply voices, by backend", () => {
  test("three backends, in the order the panel shows them", () => {
    expect(REPLY_BACKEND_CHOICES.map((choice) => choice.value)).toEqual([
      "piper",
      "kokoro",
      "mai",
      "system",
    ]);
    for (const choice of REPLY_BACKEND_CHOICES)
      expect(choice.desc.length).toBeGreaterThan(10);
  });

  test("the pack names every licence it brings, and the system voice no one system (K6 review)", () => {
    const before = localePreference();
    for (const language of ["it", "en"] as const) {
      setLocalePreference(language);
      const model = t("vui.pack.kokoro.model");
      const host = t("vui.pack.kokoro.host");
      expect([
        language,
        model.includes("Apache-2.0"),
        model.includes("kokoro-onnx (MIT)"),
      ]).toEqual([language, true, true]);
      for (const part of [
        "sherpa-onnx",
        "(Apache-2.0)",
        "ONNX Runtime (MIT)",
        "espeak-ng (GPL-3.0-or-later)",
      ]) {
        expect([language, part, host.includes(part)]).toEqual([
          language,
          part,
          true,
        ]);
      }
      // ADE runs on macOS and Linux too.
      expect(t("vui.backend.system.desc")).not.toContain("Windows");
    }
    setLocalePreference(before);
  });

  test("the Kokoro voices have names, in both languages, and the model's licence", () => {
    const before = localePreference();
    for (const language of ["it", "en"] as const) {
      setLocalePreference(language);
      expect(KOKORO_VOICE_CHOICES.map((choice) => choice.value)).toEqual(
        KOKORO_VOICES.map((voice) => voice.id),
      );
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
      for (const backend of ["piper", "kokoro", "mai", "system"] as const) {
        const voices = replyVoiceChoicesFor(backend, language);
        expect(voices.length).toBeGreaterThan(0);
        for (const choice of voices)
          expect(backendOf(choice.value)).toBe(backend);
      }
    }
    expect(
      replyVoiceChoicesFor("piper", "it").map((choice) => choice.value),
    ).toEqual(["ugo", "paola"]);
    expect(
      replyVoiceChoicesFor("piper", "en").map((choice) => choice.value),
    ).toEqual(["lessac"]);
    expect(
      replyVoiceChoicesFor("kokoro", "it").map((choice) => choice.value),
    ).toEqual(["af_heart", "am_fenrir", "bf_emma", "bm_george"]);
    expect(
      replyVoiceChoicesFor("system", "en").map((choice) => choice.value),
    ).toEqual(["system"]);
  });

  test("picking a backend keeps the voice when it is already that backend's", () => {
    expect(voiceOnBackend("kokoro", "bf_emma", "it")).toBe("bf_emma");
    expect(voiceOnBackend("kokoro", "ugo", "it")).toBe("af_heart");
    expect(voiceOnBackend("piper", "af_heart", "it")).toBe("ugo");
    expect(voiceOnBackend("piper", "af_heart", "en")).toBe("lessac");
    expect(voiceOnBackend("piper", "paola", "it")).toBe("paola");
    expect(voiceOnBackend("system", "am_fenrir", "it")).toBe("system");
  });

  test("going to another backend and back finds the voice picked there (K6 review)", () => {
    // As the panel does it: the voice left and the one picked are both remembered.
    let voice: ReplyVoice = "paola";
    let memory: ReplyVoiceMemory | undefined;
    const pickBackend = (backend: "piper" | "kokoro" | "system") => {
      const next = voiceOnBackend(backend, voice, "it", memory);
      memory = rememberReplyVoice(rememberReplyVoice(memory, voice), next);
      voice = next;
    };
    // Read through a function: the closure's writes are not seen by the narrowing.
    const current = (): ReplyVoice => voice;
    pickBackend("kokoro");
    expect(current()).toBe("af_heart");
    pickBackend("piper");
    expect(current()).toBe("paola");
    // Kokoro, a voice of it, the system voice, then Kokoro again: the same voice.
    pickBackend("kokoro");
    memory = rememberReplyVoice(memory, "bm_george");
    voice = "bm_george";
    pickBackend("system");
    expect(current()).toBe("system");
    pickBackend("kokoro");
    expect(current()).toBe("bm_george");
  });

  test("what is remembered survives normalization, and only under its own backend", () => {
    const kept = normalizeSettings({
      replyVoice: "af_heart",
      replyVoiceByBackend: { piper: "paola", kokoro: "bf_emma" },
    });
    expect(kept.replyVoiceByBackend).toEqual({
      piper: "paola",
      kokoro: "bf_emma",
    });
    const wrong = normalizeSettings({
      replyVoice: "ugo",
      replyVoiceByBackend: {
        piper: "af_heart",
        kokoro: "nessuna",
        system: "system",
      },
    });
    expect(wrong.replyVoiceByBackend).toBeUndefined();
  });
});
