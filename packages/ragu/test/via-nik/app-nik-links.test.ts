import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C (review of package A, B9): the web app promoted Ragu Zen when connecting the
 * `ragu` provider (with a nikcli-ai.dev/zen link, in every language), and linked Nik's site from the docs command, the
 * sidebar's help button and the error page («report it on Discord», both nikcli-ai.dev/desktop-feedback), the custom
 * provider and theme settings, the project icon and the notification icon. They go.
 */
const APP = path.join(import.meta.dir, "../../../app")
const read = (file: string) => fs.readFileSync(path.join(APP, file), "utf8")

function sources(dir: string): string[] {
  return (fs.readdirSync(path.join(APP, dir), { recursive: true }) as string[])
    .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => path.join(dir, name))
}

describe("the web app without Nik's site", () => {
  test("no Ragu Zen promotion, in the dialog or in any language", () => {
    expect(read("src/components/dialog-connect-provider.tsx")).not.toContain("raguZen")
    const hits = sources("src/i18n").filter((file) => /raguZen/.test(read(file)))
    expect(hits).toEqual([])
  })

  test("no nikcli-ai.dev in the app's sources, but the release notes of the next commit", () => {
    const hits = sources("src")
      .filter((file) => !file.endsWith(path.join("context", "highlights.tsx")))
      .filter((file) => read(file).includes("nikcli-ai.dev"))
    expect(hits).toEqual([])
    expect(read("AGENTS.md")).not.toContain("nikcli-ai.dev")
  })
})
