import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * «Ripristina» sat in the settings rail, among the ADE entries, and read as one
 * more section of ADE's settings. It is not one: `restoreDefaults` resets
 * `DEFAULT_VOICE_SETTINGS` and nothing else — the transcription engine included,
 * which comes back on `openrouter`. Pressing it to tidy up ADE's settings left
 * theme, language and grid exactly as they were and changed the voice.
 *
 * It now sits in the panel's own header and says what it resets. These are
 * `lint:` (TEAM.md rule 22): the rule is about what the panel's source says.
 */
const panel = readFileSync(
  join(import.meta.dir, "voice-settings-panel.tsx"),
  "utf-8",
);

test("lint: the reset button is in the panel's header, not in the settings rail", () => {
  const rail = /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(panel)?.[1] ?? "";
  expect([rail.length, rail.includes("restoreDefaults")]).toEqual([
    rail.length,
    false,
  ]);
  // It wears `ghost-btn`, a class the panel's stylesheet already draws, rather
  // than a slot of its own: the button was showing as a bare Arial control with
  // an outset border, because nothing styled `reset-voice`.
  expect(panel).toContain('data-slot="ghost-btn"');
  expect(panel).not.toContain('data-slot="reset-voice"');
  expect(panel).toContain("onClick={restoreDefaults}");
});

test("lint: the button names the voice, in both languages, not a bare «Ripristina»", () => {
  // The two texts it used to hard-code are gone: they are keys now, so the
  // label follows the language like the rest of the panel.
  expect(panel).toContain('t("vui.panel.resetVoice")');
  expect(panel).toContain('t("vui.panel.resetVoiceConfirm")');
  expect(panel).not.toContain('"Ripristina"');
  expect(panel).not.toContain('"Confermi?"');
});
