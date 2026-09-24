import { describe, it, expect } from "bun:test"
import { discoverProject, grantedRoots, openProject, rootMissing } from "./project"
import type { Host } from "./shell"

/** Minimal fake Host — only `run` and `pickDirectory` are needed here. */
function fakeHost(overrides: Partial<Host> = {}): Host {
  return {
    probe: async () => null,
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    spawn: async () => ({ kill: () => {}, write: () => {}, resize: () => {} }),
    readDir: async () => [],
    readTextFile: async () => ({ text: "", truncated: false, bytes: 0 }),
    currentDir: async () => "C:/",
    homeDir: async () => "C:/Users/test",
    exists: async () => false,
    pickDirectory: async () => undefined,
    ...overrides,
  }
}

describe("discoverProject", () => {
  it("a remote Space is known by its root, without running git or granting writes", async () => {
    const calls: string[] = []
    const host = fakeHost({
      run: async (cmd) => {
        calls.push(cmd)
        return { code: 0, stdout: "", stderr: "" }
      },
      allowWriteRoot: async (path) => {
        calls.push(`allow ${path}`)
        return true
      },
    })
    const p = await discoverProject(host, "ssh://niko@devbox:2222/srv/app")
    expect(p).toEqual({
      root: "ssh://niko@devbox:2222/srv/app",
      name: "app @ devbox",
      git: false,
      remote: { destination: "niko@devbox", port: 2222, dir: "/srv/app" },
    })
    expect(calls).toEqual([])
  })

  it("returns a git project when rev-parse succeeds", async () => {
    const host = fakeHost({
      run: async (_cmd, args) => {
        if (args.includes("--show-toplevel"))
          return { code: 0, stdout: "C:\\Users\\nik\\repo\n", stderr: "" }
        if (args.includes("--abbrev-ref"))
          return { code: 0, stdout: "main\n", stderr: "" }
        return { code: 1, stdout: "", stderr: "" }
      },
    })
    const p = await discoverProject(host, "C:/Users/nik/repo/sub")
    expect(p.root).toBe("C:/Users/nik/repo")
    expect(p.name).toBe("repo")
    expect(p.branch).toBe("main")
    expect(p.git).toBe(true)
  })

  it("handles detached HEAD", async () => {
    const host = fakeHost({
      run: async (_cmd, args) => {
        if (args.includes("--show-toplevel"))
          return { code: 0, stdout: "C:/repo\n", stderr: "" }
        if (args.includes("--abbrev-ref"))
          return { code: 0, stdout: "HEAD\n", stderr: "" }
        return { code: 1, stdout: "", stderr: "" }
      },
    })
    const p = await discoverProject(host, "C:/repo")
    expect(p.branch).toBeUndefined()
    expect(p.git).toBe(true)
  })

  it("falls back to startDir when not a git repo", async () => {
    const host = fakeHost() // run returns code 1 by default
    const p = await discoverProject(host, "C:\\Users\\nik\\plain-folder")
    expect(p.root).toBe("C:/Users/nik/plain-folder")
    expect(p.name).toBe("plain-folder")
    expect(p.git).toBe(false)
    expect(p.branch).toBeUndefined()
  })
})

describe("openProject", () => {
  it("returns undefined when the user cancels", async () => {
    const host = fakeHost()
    expect(await openProject(host)).toBeUndefined()
  })

  it("discovers the project for the chosen directory", async () => {
    const host = fakeHost({
      pickDirectory: async () => "C:/Users/nik/picked",
      run: async (_cmd, args) => {
        if (args.includes("--show-toplevel"))
          return { code: 0, stdout: "C:/Users/nik/picked\n", stderr: "" }
        if (args.includes("--abbrev-ref"))
          return { code: 0, stdout: "dev\n", stderr: "" }
        return { code: 1, stdout: "", stderr: "" }
      },
    })
    const p = await openProject(host)
    expect(p).toBeDefined()
    expect(p!.root).toBe("C:/Users/nik/picked")
    expect(p!.branch).toBe("dev")
  })
})

describe("grantedRoots (audit 0.7.7, D1-2)", () => {
  it("holds every root granted this session, and only those", async () => {
    await discoverProject(fakeHost(), "C:/granted/one")
    await discoverProject(fakeHost({ run: async () => ({ code: 0, stdout: "C:/granted/two", stderr: "" }) }), "C:/granted/two/sub")
    await discoverProject(fakeHost(), "ssh://niko@devbox/srv/app")
    const roots = grantedRoots()
    expect(roots).toContain("C:/granted/one")
    expect(roots).toContain("C:/granted/two")
    // A remote Space is granted nothing, so it is no root for a link either.
    expect(roots.some((root) => root.startsWith("ssh://"))).toBe(false)
    // A project only remembered (a recent never reopened) never passed through here.
    expect(roots).not.toContain("C:/granted/recent-only")
  })

  it("leaves out a root the host refused", async () => {
    // Rust refuses a home folder or a drive root; opened as a project, it must not make ../.ssh "inside".
    await discoverProject(fakeHost({ allowWriteRoot: async () => false }), "C:/Users/refused-home")
    await discoverProject(fakeHost({ allowWriteRoot: async () => true }), "C:/granted/by-host")
    expect(grantedRoots()).not.toContain("C:/Users/refused-home")
    expect(grantedRoots()).toContain("C:/granted/by-host")
  })
})

describe("rootMissing", () => {
  it("a folder that is gone is missing; one that is there is not", async () => {
    expect(await rootMissing(fakeHost({ exists: async () => false }), "C:/Users/x/nikcli-ade-vecchia")).toBe(true)
    expect(await rootMissing(fakeHost({ exists: async () => true }), "C:/Users/x/nikcli")).toBe(false)
  })

  it("never for a remote Space, an empty root, a host that cannot ask, or a check that fails", async () => {
    const gone = fakeHost({ exists: async () => false })
    expect(await rootMissing(gone, "ssh://user@host/srv/app")).toBe(false)
    expect(await rootMissing(gone, "")).toBe(false)
    expect(await rootMissing({}, "C:/a")).toBe(false)
    expect(await rootMissing(fakeHost({ exists: async () => Promise.reject(new Error("no")) }), "C:/a")).toBe(false)
  })
})
