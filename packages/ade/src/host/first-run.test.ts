import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_VOICE_SETTINGS, loadVoiceSettings } from "@ragu/voice/core"
import { isVoiceSetUp } from "../voice/global-shortcut"
import {
  FIRST_RUN_HELP,
  FIRST_RUN_SWITCHES,
  emptyStorage,
  markedAsTest,
  pageFirstRun,
  parseFirstRun,
} from "./first-run"
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
    expect(parseTestAppArgs(["--first-run", "no-voice", "--cdp"])).toMatchObject({ firstRun: ["no-voice"], cdp: true, command: "start" })
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
    expect(read("scripts", "test-app.ts")).toContain("...firstRunEnv(parsed.firstRun)")
  })

  test("the launcher's help says each case on its own line", () => {
    const script = read("scripts", "test-app.ts")
    for (const name of FIRST_RUN_SWITCHES) {
      const lines = script.split("\n").filter((line) => line.includes(` *       ${name} `) || line.includes(` *       ${name}\t`))
      expect(lines.length, name).toBe(1)
      expect(Object.keys(FIRST_RUN_HELP)).toContain(name)
    }
  })
})

describe("first-run switches: the page", () => {
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

  test("no-voice: a profile that set voice up is read as one that never did", () => {
    const configured = { ...DEFAULT_VOICE_SETTINGS, agentChord: "mod+shift+u", transcriptionChord: "mod+shift+i" }
    const saved = emptyStorage()
    saved.setItem("voice.settings", JSON.stringify(configured))

    // As the page loads it without the switch: set up, the chords would be claimed system-wide.
    expect(isVoiceSetUp(loadVoiceSettings(saved, { testIdentity: true }).settings)).toBe(true)
    // With it: the defaults, and no key in them, so the chords are not claimed and the settings say why.
    const fresh = loadVoiceSettings(emptyStorage(), { testIdentity: true }).settings
    expect(isVoiceSetUp(fresh)).toBe(false)
    expect(fresh.openRouterApiKey).toBeUndefined()
    // The saved profile itself is untouched.
    expect(JSON.parse(saved.getItem("voice.settings")!).agentChord).toBe("mod+shift+u")
  })

  test("the workbench reads the switch through pageFirstRun, and skips the key at start", () => {
    const source = read("src", "surface", "workbench.tsx")
    expect(source).toContain('pageFirstRun().includes("no-voice")')
    expect(source).toMatch(/const startVoiceKey = async \(\) => \{\s+if \(voiceNotSetUp\) return/)
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

  test("the variable is named in one file, and its read sits under the test feature", () => {
    expect(sources.filter(({ text }) => text.includes("ADE_TEST_FIRST_RUN")).map(({ name }) => name)).toEqual(["first_run.rs"])
    const text = read("src-tauri", "src", "first_run.rs")
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

  test("each switch has its hook, and only through `first_run::on`", () => {
    const hooks = {
      "pty.rs": 'crate::first_run::on("no-agents")',
      "shots.rs": 'crate::first_run::on("no-screenshots")',
      "secrets.rs": 'crate::first_run::on("no-voice")',
    }
    for (const [file, hook] of Object.entries(hooks)) {
      expect(sources.find(({ name }) => name === file)!.text, file).toContain(hook)
    }
    expect(sources.find(({ name }) => name === "lib.rs")!.text).toContain("mod first_run;")
  })

  test("the agent lookup hides agent names and not the programs ADE itself needs", () => {
    const pty = read("src-tauri", "src", "pty.rs")
    expect(pty).toMatch(/fn is_agent_name\(command: &str\) -> bool \{[^}]*ALLOWED_AGENTS/)
    expect(pty).toContain('stem.eq_ignore_ascii_case("nikcli")')
    // A start too: with nothing found the spawner falls back to the bare name, which the system would find on its own.
    expect(pty).toMatch(/found\.is_none\(\) && crate::first_run::on\("no-agents"\) && is_agent_name\(&command\)/)
  })
})
