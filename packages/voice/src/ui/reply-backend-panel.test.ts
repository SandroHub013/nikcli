import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * K6, held on the panel's source: a `.tsx` cannot be imported under bun test
 * here (no JSX runtime), and what is checked is the wiring, while the rules it
 * draws are `packView`'s and `replyVoiceChoicesFor`'s, tested on their own.
 */
const panel = readFileSync(join(import.meta.dir, "voice-settings-panel.tsx"), "utf8");
const box = readFileSync(join(import.meta.dir, "voice-pack-box.tsx"), "utf8");

describe("the reply voice in the panel", () => {
  test("a backend is picked first, and the voices listed are its own", () => {
    expect(panel).toContain('aria-labelledby="reply-backend-label"');
    expect(panel).toContain("<For each={REPLY_BACKEND_CHOICES}>");
    expect(panel).toContain("<For each={replyVoiceChoicesFor(replyBackendNow(), locale())}>");
    expect(panel).not.toContain("replyVoiceChoicesForLocale(");
  });

  test("the voice and its backend are written together", () => {
    expect(panel).toContain("updateSettings({ replyVoice: voice, replyBackend: backendOf(voice) })");
    expect(panel).not.toContain("updateSettings({ replyVoice: choice.value })");
  });

  test("Kokoro shows its pack; Piper its download with the cancel", () => {
    expect(panel).toContain("<VoicePackBox");
    expect(panel).toContain('props.onCancelInstall?.("kokoro")');
    expect(panel).toContain('props.onCancelInstall?.("piper")');
    expect(panel).toContain("<InstallBar");
  });

  test("the pack says where the model and its reader come from, and their licences", () => {
    expect(box).toContain('t("vui.pack.kokoro.model")');
    expect(box).toContain('t("vui.pack.kokoro.host")');
    expect(box).toContain('t("vui.pack.installSize", view().size ?? "")');
    expect(box).toContain('role="progressbar"');
  });

  test("Kokoro's source is the pack's note, not the Piper voice-page button", () => {
    // The host opens only a Piper voice's page: under Kokoro the button would open nothing.
    expect(panel).toContain('<Show when={props.onOpenVoiceSource && replyBackendNow() !== "kokoro"}>');
    expect(box).toContain('{t("vui.pack.kokoro.model")} {t("vui.pack.kokoro.host")}');
    expect(box).not.toContain('data-slot="sub-item-licence"');
  });

  test("the pack is spaced as a column, its notes without their own margins", () => {
    const css = readFileSync(join(import.meta.dir, "voice-settings.css"), "utf8");
    const rule = (selector: string) => css.slice(css.indexOf(selector + " {"), css.indexOf("}", css.indexOf(selector + " {")));
    const pack = '[data-component="voice-settings-panel"] [data-slot="voice-pack"]';
    expect(rule(pack)).toContain("flex-direction: column");
    expect(rule(pack)).toContain("gap: var(--ade-space-4)");
    expect(rule(pack + ' [data-slot="sub-choice-note"]')).toContain("margin: 0");
  });
});
