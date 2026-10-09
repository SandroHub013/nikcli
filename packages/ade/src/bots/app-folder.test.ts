import { describe, expect, test } from "bun:test"
import { appFolderName, dotFolderName, folderExists, type Exists } from "./app-folder"
import { agentDir, agentDirs, agentHome, globalConfigDir, globalConfigName, projectConfigDir } from "./ragu"
import { projectOfBotPath } from "./store"
import { authCandidates } from "../host/openrouter-key-sync"
import { discoverPlugins, type DiscoveryIO } from "../plugin/discovery"
import { walkProject } from "../search/walk"
import type { DirEntry, Host } from "../host/shell"

/*
 * Rule B, as the CLI applies it (`packages/util/src/app-folder.ts`): a user's folder is the ragu one if it
 * exists, else the nikcli one, and never a copy. ADE reads the same folders the CLI reads.
 */
const on = (...present: string[]): Exists => async (path) => present.includes(path.replace(/\\/g, "/"))

describe("rule B in ADE", () => {
  test("the ragu folder when it exists, else the nikcli one, else the old name", async () => {
    expect(await dotFolderName("/p", on("/p/.ragu", "/p/.nikcli"))).toBe(".ragu")
    expect(await dotFolderName("/p/", on("/p/.ragu"))).toBe(".ragu")
    expect(await dotFolderName("/p", on("/p/.nikcli"))).toBe(".nikcli")
    expect(await dotFolderName("/p", on())).toBe(".nikcli")
    expect(await appFolderName("C:/Users/x/AppData/Roaming", on("C:/Users/x/AppData/Roaming/ragu"))).toBe("ragu")
    expect(await appFolderName("C:/Users/x/AppData/Roaming", on())).toBe("nikcli")
  })

  test("a check that fails is a folder that is not there", async () => {
    const broken: Exists = () => Promise.reject(new Error("EACCES"))
    expect(await dotFolderName("/p", broken)).toBe(".nikcli")
    expect(await folderExists(undefined)("/p")).toBe(false)
    expect(await folderExists(async () => [])("/p")).toBe(true)
    expect(await folderExists(() => Promise.reject(new Error("ENOENT")))("/p")).toBe(false)
  })

  test("a project's bots: .ragu when it is there, .nikcli otherwise", async () => {
    expect(agentHome("/p", "project", ".ragu")).toBe("/p/.ragu")
    expect(agentDir("/p", "project", ".ragu")).toBe("/p/.ragu/agent")
    expect(agentDirs("/p", "project", ".ragu")).toEqual(["/p/.ragu/agent", "/p/.ragu/agents"])
    expect(await projectConfigDir("/p", on("/p/.ragu", "/p/.nikcli"))).toBe(".ragu")
    expect(await projectConfigDir("/p", on("/p/.nikcli"))).toBe(".nikcli")
  })

  test("the global folder: AppData/Roaming/ragu or ~/.config/ragu when there", async () => {
    expect(globalConfigDir("C:/Users/x", "windows", "ragu")).toBe("C:/Users/x/AppData/Roaming/ragu")
    expect(globalConfigDir("/home/x", "posix", "ragu")).toBe("/home/x/.config/ragu")
    expect(await globalConfigName("C:/Users/x", "windows", on("C:/Users/x/AppData/Roaming/ragu"))).toBe("ragu")
    expect(await globalConfigName("/home/x", "posix", on("/home/x/.config/nikcli"))).toBe("nikcli")
  })

  test("a bot's project, from a path under either folder", () => {
    expect(projectOfBotPath("C:/p/.ragu/agent/b.md")).toBe("C:/p")
    expect(projectOfBotPath("C:\\p\\.RAGU\\agents\\sub\\b.md")).toBe("C:\\p")
    expect(projectOfBotPath("C:/p/.nikcli/agent/b.md")).toBe("C:/p")
  })

  test("auth.json: the ragu folder before the nikcli one, in each place", () => {
    const all = authCandidates("C:/Users/x")
    for (const where of ["AppData/Local", "AppData/Roaming"]) {
      const ragu = all.indexOf(`C:/Users/x/${where}/ragu/auth.json`)
      const nikcli = all.indexOf(`C:/Users/x/${where}/nikcli/auth.json`)
      expect([where, ragu >= 0 && ragu < nikcli]).toEqual([where, true])
    }
    const posix = authCandidates("/home/x")
    expect(posix.indexOf("/home/x/.local/share/ragu/auth.json")).toBeLessThan(
      posix.indexOf("/home/x/.local/share/nikcli/auth.json"),
    )
  })

  test("the project's plugins: .ragu/tui.json when .ragu is there", async () => {
    const table: Record<string, string> = {
      "C:/p/.ragu/tui.json": JSON.stringify({ plugin: ["./nuovo.js"] }),
      "C:/p/.nikcli/tui.json": JSON.stringify({ plugin: ["./vecchio.js"] }),
      "C:/p/nuovo.js": "",
      "C:/p/vecchio.js": "",
    }
    const disk = (files: Record<string, string>): DiscoveryIO => ({
      async exists(path) {
        const p = path.replace(/\\/g, "/")
        return p in files || Object.keys(files).some((file) => file.startsWith(`${p}/`))
      },
      async readTextFile(path) {
        const text = files[path.replace(/\\/g, "/")]
        if (text === undefined) throw new Error(`ENOENT ${path}`)
        return { text }
      },
    })
    const both = await discoverPlugins("C:/p", disk(table))
    expect(both.resolved.map((plugin) => plugin.spec)).toEqual(["./nuovo.js"])
    const { ["C:/p/.ragu/tui.json"]: _gone, ...old } = table
    const onlyOld = await discoverPlugins("C:/p", disk(old))
    expect(onlyOld.resolved.map((plugin) => plugin.spec)).toEqual(["./vecchio.js"])
  })

  test("search walks into .ragu as it does into .nikcli", async () => {
    const entry = (path: string, is_dir: boolean): DirEntry => ({
      name: path.split("/").pop()!,
      path,
      is_dir,
      size: 0,
      modified_ms: 0,
    })
    const fs: Record<string, DirEntry[]> = {
      "C:/repo": [entry("C:/repo/.ragu", true), entry("C:/repo/.nikcli", true), entry("C:/repo/.cache", true)],
      "C:/repo/.ragu": [entry("C:/repo/.ragu/ragu.json", false)],
      "C:/repo/.nikcli": [entry("C:/repo/.nikcli/nikcli.json", false)],
      "C:/repo/.cache": [entry("C:/repo/.cache/x", false)],
    }
    const host = {
      readDir: async (path: string) => {
        const found = fs[path.replace(/\\/g, "/")]
        if (!found) throw new Error("ENOENT")
        return found
      },
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
    } as unknown as Host
    const result = await walkProject({ host, root: "C:/repo" })
    expect(result.files).toEqual(["C:/repo/.nikcli/nikcli.json", "C:/repo/.ragu/ragu.json"])
  })
})
