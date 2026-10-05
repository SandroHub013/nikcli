import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The voice settings' source, for the tests that read it.
 *
 * It was one file, `ui/voice-settings-panel.tsx`; since S5 the pages are in
 * `ui/settings-pages/` and their state in `ui/settings-state.ts`, and the
 * panel draws them. The rules those tests hold are about the voice settings,
 * wherever the line now lives, so they read all of it — the panel first.
 */
export function voiceSettingsSource(): string {
  const ui = join(import.meta.dir, "../ui")
  const pages = join(ui, "settings-pages")
  const files = [
    join(ui, "voice-settings-panel.tsx"),
    join(ui, "settings-state.ts"),
    ...readdirSync(pages)
      .filter((name) => name.endsWith(".tsx"))
      .sort()
      .map((name) => join(pages, name)),
  ]
  return files.map((file) => readFileSync(file, "utf8")).join("\n")
}
