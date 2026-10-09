import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C (review of package B, B9): after an update, the web and desktop app fetched
 * https://nikcli-ai.dev/changelog.json to show a «What's new» dialog, with a setting to turn it off. It is a call to
 * Nik's site at start-up and the notes are Nik's releases, not ours: the dialog, the fetch and the setting go.
 */
const APP = path.join(import.meta.dir, "../../../app")
const exists = (file: string) => fs.existsSync(path.join(APP, file))
const read = (file: string) => fs.readFileSync(path.join(APP, file), "utf8")

describe("no release notes from Nik's changelog", () => {
  test("the context, the dialog and the setting are gone", () => {
    expect(exists("src/context/highlights.tsx")).toBe(false)
    expect(exists("src/components/dialog-release-notes.tsx")).toBe(false)
    expect(read("src/app.tsx")).not.toContain("HighlightsProvider")
    expect(read("src/context/settings.tsx")).not.toContain("releaseNotes")
    expect(read("src/components/settings-general.tsx")).not.toContain("releaseNotes")
    expect(read("src/i18n/en.ts")).not.toContain("settings.general.row.releaseNotes")
  })
})
