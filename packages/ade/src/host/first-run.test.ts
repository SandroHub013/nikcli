import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_VOICE_SETTINGS, loadVoiceSettings, saveVoiceSettings } from "@ragu/voice/core"
import { isVoiceSetUp } from "../voice/global-shortcut"
import {
  FIRST_RUN_SWITCHES,
  emptyStorage,
  markedAsTest,
  pageFirstRun,
  parseFirstRun,
  voiceStorageFor,
} from "./first-run"
import { workbenchSource } from "../test-support/workbench-source"
import { firstRunEnv, parseTestAppArgs } from "./test-app"

const adeDir = join(import.meta.dir, "..", "..")
const read = (...parts: string[]) => readFileSync(join(adeDir, ...parts), "utf8")
const root = (dataset: Record<string, string>) => ({ dataset }) as unknown as HTMLElement

describe("first-run switches: the list", () => {
  test("a comma list, in any order and case, with `all` for every switch", () => {
    expect(parseFirstRun("no-voice, NO-AGENTS").switches).toEqual(["no-agents", "no-voice"])
    expect(parseFirstRun("all").switches).toEqual([...FIRST_RUN_SWITCHES])
    expect(parseFirstRun(undefined).switches).toEqual([])
    expect(parseFirstRun("no-agents,no-agents").switches).toEqual(["no-agents"])
  })

  test("what is not a switch is said, not dropped", () => {
    expect(parseFirstRun("no-agents,no-keys").unknown).toEqual(["no-keys"])
  })

  test("the launcher reads --first-run in both spellings, and refuses a name it does not know", () => {
    expect(parseTestAppArgs(["--first-run=no-screenshots,no-agents"]).firstRun).toEqual(["no-screenshots", "no-agents"])
    expect(parseTestAppArgs(["--first-run", "no-voice", "--cdp"])).toMatchObject({
      firstRun: ["no-voice"],
      cdp: true,
      command: "start",
    })
    expect(parseTestAppArgs([]).firstRun).toEqual([])
    for (const bad of [["--first-run=no-keys"], ["--first-run="], ["--first-run"]]) {
      expect(parseTestAppArgs(bad).error).toContain("--first-run")
    }
  })

  test("the launcher gives the Rust host and the page the same list, and an empty one when none was asked", () => {
    expect(firstRunEnv(["no-agents", "no-voice"])).toEqual({
      ADE_TEST_FIRST_RUN: "no-agents,no-voice",
      VITE_ADE_FIRST_RUN: "no-agents,no-voice",
    })
    // Empty, not absent: a list left in the shell that started the launcher is not inherited.
    expect(firstRunEnv([])).toEqual({ ADE_TEST_FIRST_RUN: "", VITE_ADE_FIRST_RUN: "" })
  })

  test("lint: the launcher passes the list to the app, and says each case in its help", () => {
    const script = read("scripts", "test-app.ts")
    expect(script).toContain("...firstRunEnv(parsed.firstRun)")
    for (const name of FIRST_RUN_SWITCHES) {
      const lines = script.split("\n").filter((line) => line.includes(` *       ${name} `))
      expect(lines.length, name).toBe(1)
    }
    // «Installa» runs the real installers: the help says never to press it with `no-agents`.
    expect(script).toContain("NEVER press «Installa»")
  })

  test("lint: with no-screenshots each start empties the folder the switch keeps its choice in", () => {
    expect(read("scripts", "test-app.ts")).toContain(
      'parsed.firstRun.includes("no-screenshots")) rmSync(join(plan.tmpDir, "ade-first-run")',
    )
  })
})

describe("first-run switches: the page", () => {
  afterEach(() => localStorage.clear())

  test("honoured only when the host marked this as ADE Test", () => {
    expect(pageFirstRun("no-agents,no-voice", true)).toEqual(["no-agents", "no-voice"])
    expect(pageFirstRun("no-agents,no-voice", false)).toEqual([])
  })

  test("the strict mark: an identifier that could not be read is not enough", () => {
    expect(markedAsTest(root({ adeBuild: "test" }))).toBe(true)
    expect(markedAsTest(root({ adeIdentity: "unknown" }))).toBe(false)
    expect(markedAsTest(root({}))).toBe(false)
    expect(markedAsTest(undefined)).toBe(false)
  })

  test("a page with no mark has no switch, whatever the build was given", () => {
    expect(pageFirstRun("all")).toEqual([])
  })

  test("no-voice: the profile reads as one that never set voice up, and a change never reaches the stored one", () => {
    const configured = { ...DEFAULT_VOICE_SETTINGS, agentChord: "mod+shift+u", transcriptionChord: "mod+shift+i" }
    localStorage.setItem("voice.settings", JSON.stringify(configured))
    const stored = localStorage.getItem("voice.settings")

    // Without the switch the page reads the stored profile: set up, the chords would be claimed system-wide.
    expect(voiceStorageFor([])).toBeUndefined()
    expect(isVoiceSetUp(loadVoiceSettings(voiceStorageFor(["no-agents"]), { testIdentity: true }).settings)).toBe(true)

    // With it: the defaults, no key, so the chords are not claimed.
    const store = voiceStorageFor(["no-voice"])!
    const fresh = loadVoiceSettings(store, { testIdentity: true }).settings
    expect(isVoiceSetUp(fresh)).toBe(false)
    expect(fresh.openRouterApiKey).toBeUndefined()

    // The change made in the settings lives for this run, and is not written to the profile.
    saveVoiceSettings({ ...fresh, agentChord: "mod+shift+y" }, store, { testIdentity: true })
    expect(loadVoiceSettings(store, { testIdentity: true }).settings.agentChord).toBe("mod+shift+y")
    expect(localStorage.getItem("voice.settings")).toBe(stored)
  })

  test("lint: the workbench loads and saves the voice settings through the one storage the switch gives", () => {
    const source = workbenchSource()
    expect(source).toContain("const voiceStore = voiceStorageFor(firstRun)")
    expect(source).toContain("loadVoiceSettings(voiceStore,")
    expect(source).toContain("saveVoiceSettings(next, voiceStore,")
    expect(source).toMatch(/const startVoiceKey = async \(\) => \{\s+if \(voiceNotSetUp\) return/)
    // No key at all under the switch: the xAI one in Riconoscimento too.
    expect(source).toContain("if (voiceNotSetUp) return setXaiKeyMasked(null)")
  })

  test("the empty storage keeps nothing and loses nothing it was given", () => {
    const storage = emptyStorage()
    expect(storage.getItem("a")).toBeNull()
    storage.setItem("a", "1")
    expect(storage.getItem("a")).toBe("1")
    expect(storage.length).toBe(1)
    storage.removeItem("a")
    expect(storage.getItem("a")).toBeNull()
  })
})

describe("first-run switches: the Rust host", () => {
  const sources = readdirSync(join(adeDir, "src-tauri", "src"))
    .filter((name) => name.endsWith(".rs"))
    .map((name) => ({ name, text: read("src-tauri", "src", name) }))
  const rust = (file: string) => sources.find(({ name }) => name === file)!.text

  test("lint: the variable is named in one file, and its read sits under the test feature", () => {
    expect(sources.filter(({ text }) => text.includes("ADE_TEST_FIRST_RUN")).map(({ name }) => name)).toEqual([
      "first_run.rs",
    ])
    const text = rust("first_run.rs")
    const gated = (needle: string) => {
      const at = text.indexOf(needle)
      expect(at, needle).toBeGreaterThan(-1)
      const gate = text.lastIndexOf('#[cfg(feature = "test-exe")]', at)
      expect(gate, needle).toBeGreaterThan(-1)
      expect(at - gate, needle).toBeLessThan(200)
    }
    gated('const ENV: &str = "ADE_TEST_FIRST_RUN"')
    gated("pub fn on(name: &str) -> bool")
    // The other build: a constant, with no read at all.
    expect(text).toMatch(/#\[cfg\(not\(feature = "test-exe"\)\)\]\s+pub const fn on\(_name: &str\) -> bool \{\s+false\s+\}/)
  })

  test("lint: each switch has its hook, and only through `first_run::on`", () => {
    expect(rust("pty.rs")).toContain('crate::first_run::on("no-agents")')
    expect(rust("shots.rs")).toContain('crate::first_run::on("no-screenshots")')
    expect(rust("secrets.rs")).toContain('crate::first_run::on("no-voice")')
    // The folder chosen in the tray under the switch goes to the switch's own file, not the one every ADE Test shares.
    expect(rust("shots.rs")).toContain("crate::first_run::chosen_screenshots_file()")
    expect(rust("lib.rs")).toContain("mod first_run;")
  })

  test("lint: the agent lookup and the start hide agent names and not the programs ADE itself needs", () => {
    const pty = rust("pty.rs")
    expect(pty).toMatch(/fn is_agent_name\(command: &str\) -> bool \{[^}]*ALLOWED_AGENTS/)
    expect(pty).toContain('stem.eq_ignore_ascii_case("nikcli")')
    // A start too: with nothing found the spawner falls back to the bare name, which the system would find on its own.
    expect(pty).toMatch(/found\.is_none\(\) && crate::first_run::on\("no-agents"\) && is_agent_name\(&command\)/)
  })
})
