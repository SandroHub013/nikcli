import { describe, expect, test } from "bun:test";
import { REPLY_VOICES } from "./model";
import {
  activeReplyVoice,
  REPLY_VOICE_CHOICES,
  replyVoiceChoicesForLocale,
} from "./reply-voices";

describe("settings/reply-voices", () => {
  test("D19: Maschile is Ugo and comes first, Femminile is Paola, and every voice in the model is offered", () => {
    expect(REPLY_VOICE_CHOICES[0]).toMatchObject({
      value: "ugo",
      title: "Maschile",
    });
    expect(
      REPLY_VOICE_CHOICES.find((choice) => choice.value === "paola")?.title,
    ).toBe("Femminile");
    expect(REPLY_VOICE_CHOICES.map((choice) => choice.value).sort()).toEqual(
      [...REPLY_VOICES].sort(),
    );
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
