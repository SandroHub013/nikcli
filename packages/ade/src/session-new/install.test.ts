import { describe, expect, test } from "bun:test"
import { AGENTS } from "./agents"
import {
  INSTALLS,
  PREREQUISITES,
  commandFor,
  installFor,
  installGaps,
  installOs,
  missingPrerequisite,
  terminalLine,
  type InstallOs,
} from "./install"

const OSES: InstallOs[] = ["windows", "macos", "linux"]

/*
 * The hosts the commands and pages may point at: each project's own, as its documentation names it. A command
 * that sends the user to an address not in this list is a catalogue change that someone has to read, not a typo
 * that goes unnoticed.
 */
const OFFICIAL_HOSTS = new Set([
  "claude.ai",
  "code.claude.com",
  "chatgpt.com",
  "github.com",
  "opencode.ai",
  "x.ai",
  "docs.x.ai",
  "antigravity.google",
  "code.kimi.com",
  "pi.dev",
  "hermes-agent.nousresearch.com",
  "freebuff.com",
  "kilo.ai",
  "raw.githubusercontent.com",
  "goose-docs.ai",
  "gh.io",
  "docs.github.com",
  "cursor.com",
  "t3.codes",
])

const urlsIn = (text: string) => text.match(/https?:\/\/[^\s'"|)]+/g) ?? []

describe("the install catalogue", () => {
  test("covers every agent of the catalogue except the terminal, and nothing else", () => {
    expect(installGaps()).toEqual({ unknown: [], missing: [] })
    expect(new Set(INSTALLS.map((entry) => entry.agentId)).size).toBe(INSTALLS.length)
    expect(installFor("terminal")).toBeUndefined()
  })

  test("every entry names the page it was read from and the day it was read", () => {
    for (const entry of INSTALLS) {
      expect([entry.agentId, entry.source]).toEqual([entry.agentId, expect.stringMatching(/^https:\/\//)])
      expect([entry.agentId, entry.page]).toEqual([entry.agentId, expect.stringMatching(/^https:\/\//)])
      expect([entry.agentId, entry.checked]).toEqual([entry.agentId, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)])
      expect(Number.isNaN(Date.parse(entry.checked))).toBe(false)
    }
  })

  test("only the projects' own addresses appear, in the sources, the pages and the commands", () => {
    for (const entry of INSTALLS) {
      const urls = [
        entry.page,
        entry.source,
        ...OSES.flatMap((os) => urlsIn(entry.commands[os]?.line ?? "")),
      ]
      for (const url of urls) expect([entry.agentId, new URL(url).host, OFFICIAL_HOSTS.has(new URL(url).host)]).toEqual([entry.agentId, new URL(url).host, true])
    }
    for (const { page } of Object.values(PREREQUISITES)) expect(page).toMatch(/^https:\/\//)
  })

  test("a command is a single line, asks for no administrator and uses no hidden step", () => {
    for (const entry of INSTALLS)
      for (const os of OSES) {
        const line = entry.commands[os]?.line
        if (!line) continue
        expect([entry.agentId, os, /[\r\n]/.test(line)]).toEqual([entry.agentId, os, false])
        expect([entry.agentId, os, /\bsudo\b|runas|Start-Process[^;]*-Verb|\bsu\b/i.test(line)]).toEqual([entry.agentId, os, false])
        expect([entry.agentId, os, /-WindowStyle\s+Hidden|-w\s+hidden/i.test(line)]).toEqual([entry.agentId, os, false])
      }
  })

  test("a command that names a prerequisite is run by that program, and only a known one is named", () => {
    for (const entry of INSTALLS)
      for (const os of OSES) {
        const command = entry.commands[os]
        if (!command?.requires) continue
        expect(Object.keys(PREREQUISITES)).toContain(command.requires)
        expect([entry.agentId, os, command.line.startsWith(`${command.requires} `)]).toEqual([entry.agentId, os, true])
      }
    // And the other way: a line that starts with one of them says so.
    for (const entry of INSTALLS)
      for (const os of OSES) {
        const command = entry.commands[os]
        const first = command?.line.split(" ")[0]
        if (command && first && first in PREREQUISITES) expect([entry.agentId, os, command.requires]).toEqual([entry.agentId, os, first])
      }
  })

  test("a PowerShell line holds no double quote, which would end the wrapper early", () => {
    for (const entry of INSTALLS)
      for (const os of OSES) {
        const command = entry.commands[os]
        if (command?.shell === "powershell") {
          expect([entry.agentId, command.line.includes('"')]).toEqual([entry.agentId, false])
          expect([entry.agentId, os]).toEqual([entry.agentId, "windows"])
        }
      }
  })

  test("a program the project's installer names differently from ADE's command is offered as a page, not as a button", () => {
    for (const entry of INSTALLS) {
      if (entry.caveat?.kind !== "binary") continue
      expect([entry.agentId, Object.keys(entry.commands)]).toEqual([entry.agentId, []])
      expect(AGENTS.find((agent) => agent.id === entry.agentId)?.command).not.toBe(entry.caveat.provides)
    }
    expect(installFor("prime")?.caveat).toEqual({ kind: "binary", provides: "prime-agent" })
    expect(installFor("ohmypi")?.caveat).toEqual({ kind: "binary", provides: "omp" })
  })

  test("the commands are the ones of the project's page for each system", () => {
    const line = (id: string, os: InstallOs) => commandFor(installFor(id), os)?.line
    expect(line("claude-code", "windows")).toBe("irm https://claude.ai/install.ps1 | iex")
    expect(line("claude-code", "linux")).toBe("curl -fsSL https://claude.ai/install.sh | bash")
    expect(line("codex", "macos")).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | sh")
    expect(line("cline", "windows")).toBe("npm i -g cline")
    expect(line("crush", "windows")).toBe("winget install charmbracelet.crush")
    expect(line("crush", "macos")).toBe("brew install charmbracelet/tap/crush")
    expect(line("copilot", "windows")).toBe("winget install GitHub.Copilot")
    expect(line("agy", "windows")).toBe("irm https://antigravity.google/cli/install.ps1 | iex")
  })

  test("an agent with no command for a system has only its page", () => {
    expect(commandFor(installFor("ragu"), "windows")).toBeUndefined()
    expect(installFor("ragu")?.page).toMatch(/^https:\/\//)
    expect(commandFor(undefined, "linux")).toBeUndefined()
  })
})

describe("what is typed into the terminal", () => {
  test("a PowerShell line is handed to PowerShell by the pane's cmd, and nothing else changes", () => {
    const command = commandFor(installFor("claude-code"), "windows")!
    expect(terminalLine(command)).toBe('powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"')
  })

  test("a line already written for the pane's shell is typed as the catalogue has it", () => {
    for (const [id, os] of [
      ["codex", "windows"],
      ["cline", "windows"],
      ["claude-code", "linux"],
      ["crush", "macos"],
    ] as const) {
      const command = commandFor(installFor(id), os)!
      expect(terminalLine(command)).toBe(command.line)
    }
  })

  test("the line for the system this is run on is the one the catalogue has for it", () => {
    for (const entry of INSTALLS)
      for (const os of OSES) {
        const command = entry.commands[os]
        if (command) expect(terminalLine(command)).toContain(command.line)
      }
  })
})

describe("installOs", () => {
  test("reads the system from the user agent the way the shell choice does", () => {
    expect(installOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows")
    expect(installOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos")
    expect(installOs("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux")
  })
})

describe("missingPrerequisite", () => {
  test("names the program that is not found, and nothing when it is, or when nothing can be asked", async () => {
    const npm = commandFor(installFor("cline"), "linux")!
    expect(await missingPrerequisite(npm, async () => null)).toBe("npm")
    expect(await missingPrerequisite(npm, async () => "C:\\node\\npm.cmd")).toBeUndefined()
    expect(await missingPrerequisite(npm, undefined)).toBeUndefined()
    expect(await missingPrerequisite(npm, async () => Promise.reject(new Error("boom")))).toBe("npm")
    const script = commandFor(installFor("claude-code"), "linux")!
    expect(await missingPrerequisite(script, async () => null)).toBeUndefined()
    expect(await missingPrerequisite(undefined, async () => null)).toBeUndefined()
  })
})
