import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C: links to nikcli-ai.dev/docs in help, errors, dialogs and menus, the
 * nikcli-ai.dev HTTP-Referer sent to OpenRouter and Vercel, the MCP client's client_uri, the desktop app's homepage,
 * menu, notification icon and "invite" link, and the Ragu Zen tip of the home screen. None of them is ours: they go.
 */
const PACKAGES = path.join(import.meta.dir, "../../..")
const read = (file: string) => fs.readFileSync(path.join(PACKAGES, file), "utf8")

describe("no links to Nik's site in the product", () => {
  test("no nikcli-ai.dev in these sources", () => {
    const hits = [
      "ragu/src/cli/handlers/quickstart.ts",
      "ragu/src/config/config.ts",
      "ragu/src/mcp/oauth-provider.ts",
      "ragu/src/provider/provider.ts",
      "ragu/src/voice/transcribe.ts",
      "ragu/src/server/identity-auth.ts",
      "util/src/tts/openrouter.ts",
      "tui/src/ui/dialog-help.tsx",
      "desktop/package.json",
      "desktop/src/menu.ts",
      "desktop/src/shell.tsx",
      "desktop/src/index.tsx",
      "desktop/src-tauri/release/appstream.metainfo.xml",
      "ui/src/theme/desktop-theme.schema.json",
    ].filter((file) => read(file).includes("nikcli-ai.dev"))
    expect(hits).toEqual([])
  })

  test("no docs link in the files package A also changes", () => {
    // Their other Nik hosts (the account token URL, the Ragu Zen notice) are package A's and go with it.
    for (const file of ["ragu/src/auth/index.ts", "tui/src/app.tsx"])
      expect([file, read(file).includes("nikcli-ai.dev/docs")]).toEqual([file, false])
  })

  test("the home tips do not promote Ragu Zen", () => {
    expect(read("tui/src/feature-plugins/home/tips-view.tsx")).not.toContain("Ragu Zen")
  })
})
