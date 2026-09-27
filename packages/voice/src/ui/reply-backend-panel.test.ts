import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { codeOf } from "../test-support/source-text"

/*
 * K6, held on the panel's source: a `.tsx` cannot be imported under bun test
 * here (no JSX runtime), and what is checked is the wiring, while the rules it
 * draws are `packView`'s and `replyVoiceChoicesFor`'s, tested on their own.
 */
const panel = readFileSync(join(import.meta.dir, "voice-settings-panel.tsx"), "utf8")
const box = readFileSync(join(import.meta.dir, "voice-pack-box.tsx"), "utf8")

describe("the reply voice in the panel", () => {
  test("a backend is picked first, and the voices listed are its own", () => {
    expect(panel).toContain('aria-labelledby="reply-backend-label"')
    expect(panel).toContain("<For each={REPLY_BACKEND_CHOICES}>")
    expect(panel).toContain("<For each={replyVoiceChoicesFor(replyBackendNow(), locale())}>")
    expect(panel).not.toContain("replyVoiceChoicesForLocale(")
  })

  test("the voice and its backend are written together", () => {
    expect(codeOf(panel)).toContain(
      codeOf(
        "updateSettings({ replyVoice: voice, replyBackend: backendOf(voice), ...(memory ? { replyVoiceByBackend: memory } : {}) })",
      ),
    )
    // Coming back to a backend asks for the voice last picked there.
    expect(codeOf(panel)).toContain(
      codeOf(
        "rememberReplyVoice(rememberReplyVoice(props.settings.replyVoiceByBackend, props.settings.replyVoice), voice)",
      ),
    )
    expect(codeOf(panel)).toContain(
      codeOf("voiceOnBackend(backend, props.settings.replyVoice, locale(), props.settings.replyVoiceByBackend)"),
    )
    expect(codeOf(panel)).not.toContain(codeOf("updateSettings({ replyVoice: choice.value })"))
  })

  test("Kokoro shows its pack; Piper its download with the cancel", () => {
    expect(panel).toContain("<VoicePackBox")
    expect(panel).toContain('props.onCancelInstall?.("kokoro")')
    expect(panel).toContain('props.onCancelInstall?.("piper")')
    expect(panel).toContain("<InstallBar")
  })

  test("the pack says where the model and its reader come from, and their licences", () => {
    expect(codeOf(box)).toContain(codeOf('t("vui.pack.kokoro.model")'))
    expect(codeOf(box)).toContain(codeOf('t("vui.pack.kokoro.host")'))
    expect(codeOf(box)).toContain(codeOf('t("vui.pack.installSize", view().size ?? "")'))
    expect(codeOf(box)).toContain(codeOf('role="progressbar"'))
    expect(codeOf(box)).toContain(codeOf('t("vui.pack.filesOf"'))
    expect(codeOf(box)).toContain(codeOf('view().phase === "installed" && view().removable && props.onDelete'))
  })

  test("Kokoro's source is the pack's note, not the Piper voice-page button", () => {
    // The host opens only a Piper voice's page: under Kokoro the button would open nothing.
    expect(panel).toContain('<Show when={props.onOpenVoiceSource && replyBackendNow() !== "kokoro"}>')
    expect(box).toContain('{t("vui.pack.kokoro.model")} {t("vui.pack.kokoro.host")}')
    expect(box).not.toContain('data-slot="sub-item-licence"')
  })

  test("the pack is spaced as a column, its notes without their own margins", () => {
    const css = readFileSync(join(import.meta.dir, "voice-settings.css"), "utf8")
    const rule = (selector: string) =>
      css.slice(css.indexOf(selector + " {"), css.indexOf("}", css.indexOf(selector + " {")))
    const pack = '[data-component="voice-settings-panel"] [data-slot="voice-pack"]'
    expect(rule(pack)).toContain("flex-direction: column")
    expect(rule(pack)).toContain("gap: var(--ade-space-4)")
    expect(rule(pack + ' [data-slot="sub-choice-note"]')).toContain("margin: 0")
  })
})
