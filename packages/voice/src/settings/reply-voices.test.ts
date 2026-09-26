import { describe, expect, test } from "bun:test";
import { REPLY_VOICES } from "./model";
import {
  activeReplyVoice,
  KOKORO_VOICES,
  REPLY_VOICE_CHOICES,
  replyVoiceChoicesForLocale,
} from "./reply-voices";

describe("settings/reply-voices", () => {
  test("D19: Maschile is Ugo and comes first, Femminile is Paola", () => {
    expect(REPLY_VOICE_CHOICES[0]).toMatchObject({
      value: "ugo",
      title: "Maschile",
    });
    expect(
      REPLY_VOICE_CHOICES.find((choice) => choice.value === "paola")?.title,
    ).toBe("Femminile");
  });

  /*
   * Every voice in the model is either offered with a label or is a Kokoro one
   * waiting for the panel that names it (K6), and never both. The two lists
   * together are the whole union, so a voice added to the model and to neither
   * is caught here rather than in the picker.
   */
  test("every voice in the model is offered, or is a Kokoro one waiting for its label", () => {
    const offered = REPLY_VOICE_CHOICES.map((choice) => choice.value);
    const waiting = KOKORO_VOICES.map((voice) => voice.id);
    expect([...offered, ...waiting].sort()).toEqual([...REPLY_VOICES].sort());
    // And the overlap is empty: an id in both lists is a label rendered twice.
    for (const id of waiting) expect(offered).not.toContain(id);
  });

  test("each Piper voice states that its model derives from a research-only dataset", () => {
    for (const choice of REPLY_VOICE_CHOICES.filter(
      (c) => c.value !== "system",
    )) {
      expect(choice.licence).toContain("sola ricerca");
    }
    expect(
      REPLY_VOICE_CHOICES.find((choice) => choice.value === "system")?.licence,
    ).toBeUndefined();
  });

  test("the panel only offers Piper voices that match the interface language", () => {
    expect(
      replyVoiceChoicesForLocale("it").map((choice) => choice.value),
    ).toEqual(["ugo", "paola", "system"]);
    expect(
      replyVoiceChoicesForLocale("en").map((choice) => choice.value),
    ).toEqual(["lessac", "system"]);
  });

  test("a stored voice from the other language is remapped to one the panel actually offers", () => {
    expect(activeReplyVoice("lessac", "it")).toBe("ugo");
    expect(activeReplyVoice("ugo", "en")).toBe("lessac");
    expect(activeReplyVoice("paola", "en")).toBe("lessac");
    expect(activeReplyVoice("ugo", "it")).toBe("ugo");
    expect(activeReplyVoice("paola", "it")).toBe("paola");
    expect(activeReplyVoice("lessac", "en")).toBe("lessac");
    expect(activeReplyVoice("system", "it")).toBe("system");
    expect(activeReplyVoice("system", "en")).toBe("system");
  });
});
