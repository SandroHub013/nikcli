import { describe, expect, test } from "bun:test"
import type { Worktree } from "./model"
import {
  deriveBranch,
  deriveDirectory,
  isLegalBranch,
  isLegalDirectory,
  planSessionTree,
  sanitizeAgentId,
  sanitizeProjectName,
  sanitizeSessionId,
} from "./session-tree"

function makeTree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: "wt-1",
    projectId: "proj-alpha",
    name: "principale",
    path: "/repo/alpha/main",
    branch: "main",
    ahead: 0,
    behind: 0,
    dirty: 0,
    occupants: [],
    updatedAt: 1000,
    ...overrides,
  }
}

describe("isLegalBranch", () => {
  test("accepts valid branch names", () => {
    expect(isLegalBranch("main")).toBe(true)
    expect(isLegalBranch("master")).toBe(true)
    expect(isLegalBranch("feat/auth-flow")).toBe(true)
    expect(isLegalBranch("ade/agy/session-123")).toBe(true)
    expect(isLegalBranch("fix_issue_42")).toBe(true)
    expect(isLegalBranch("v1.0.0-rc1")).toBe(true)
    expect(isLegalBranch("teams/team-a/feat/sub-task")).toBe(true)
  })

  test("rejects empty or whitespace-only names", () => {
    expect(isLegalBranch("")).toBe(false)
    expect(isLegalBranch("   ")).toBe(false)
    expect(isLegalBranch("\t")).toBe(false)
    expect(isLegalBranch("\n")).toBe(false)
  })

  test("rejects branches with internal whitespace", () => {
    expect(isLegalBranch("feat auth")).toBe(false)
    expect(isLegalBranch("feat\tauth")).toBe(false)
    expect(isLegalBranch("feat\nauth")).toBe(false)
  })

  test("rejects branches containing control characters", () => {
    expect(isLegalBranch("feat\x00branch")).toBe(false)
    expect(isLegalBranch("feat\x1fbranch")).toBe(false)
    expect(isLegalBranch("feat\x7fbranch")).toBe(false)
  })

  test("rejects branches containing illegal git ref characters (~^:?*[\\])", () => {
    expect(isLegalBranch("feat~1")).toBe(false)
    expect(isLegalBranch("feat^2")).toBe(false)
    expect(isLegalBranch("feat:login")).toBe(false)
    expect(isLegalBranch("feat?query")).toBe(false)
    expect(isLegalBranch("feat*star")).toBe(false)
    expect(isLegalBranch("feat[bracket")).toBe(false)
    expect(isLegalBranch("feat\\slash")).toBe(false)
  })

  test("rejects branches containing @{ or single @", () => {
    expect(isLegalBranch("@{upstream}")).toBe(false)
    expect(isLegalBranch("feat@{1}")).toBe(false)
    expect(isLegalBranch("@")).toBe(false)
  })

  test("rejects branches containing consecutive dots (..)", () => {
    expect(isLegalBranch("feat..branch")).toBe(false)
    expect(isLegalBranch("feat/sub..task")).toBe(false)
  })

  test("rejects branches starting or ending with a slash", () => {
    expect(isLegalBranch("/feat")).toBe(false)
    expect(isLegalBranch("feat/")).toBe(false)
    expect(isLegalBranch("/feat/auth/")).toBe(false)
  })

  test("rejects branches containing consecutive slashes (//)", () => {
    expect(isLegalBranch("feat//auth")).toBe(false)
    expect(isLegalBranch("ade///agy")).toBe(false)
  })

  test("rejects branches ending with .lock", () => {
    expect(isLegalBranch("feat.lock")).toBe(false)
    expect(isLegalBranch("ade/agy/task.lock")).toBe(false)
  })

  test("rejects branches ending with a dot", () => {
    expect(isLegalBranch("feat.")).toBe(false)
    expect(isLegalBranch("ade/agy/task.")).toBe(false)
  })

  test("rejects branch components starting with a dot or ending with .lock", () => {
    expect(isLegalBranch("ade/.hidden/task")).toBe(false)
    expect(isLegalBranch(".main")).toBe(false)
    expect(isLegalBranch("ade/component.lock/task")).toBe(false)
  })
})

describe("isLegalDirectory", () => {
  test("accepts valid directory names", () => {
    expect(isLegalDirectory("my-project")).toBe(true)
    expect(isLegalDirectory("ade-agy-session-123")).toBe(true)
    expect(isLegalDirectory("project_v2-build")).toBe(true)
    expect(isLegalDirectory("nikcli-kimi-s456")).toBe(true)
  })

  test("rejects empty or whitespace-only names", () => {
    expect(isLegalDirectory("")).toBe(false)
    expect(isLegalDirectory("   ")).toBe(false)
  })

  test("rejects directory names exceeding 255 characters", () => {
    const longName = "a".repeat(256)
    expect(isLegalDirectory(longName)).toBe(false)
    expect(isLegalDirectory("a".repeat(255))).toBe(true)
  })

  test("rejects directory names containing Windows forbidden characters (<>:\"/\\|?*)", () => {
    expect(isLegalDirectory("dir<name")).toBe(false)
    expect(isLegalDirectory("dir>name")).toBe(false)
    expect(isLegalDirectory("dir:name")).toBe(false)
    expect(isLegalDirectory("dir\"name")).toBe(false)
    expect(isLegalDirectory("dir/name")).toBe(false)
    expect(isLegalDirectory("dir\\name")).toBe(false)
    expect(isLegalDirectory("dir|name")).toBe(false)
    expect(isLegalDirectory("dir?name")).toBe(false)
    expect(isLegalDirectory("dir*name")).toBe(false)
  })

  test("rejects directory names containing control characters", () => {
    expect(isLegalDirectory("dir\x00name")).toBe(false)
    expect(isLegalDirectory("dir\x1fname")).toBe(false)
    expect(isLegalDirectory("dir\x7fname")).toBe(false)
  })

  test("rejects directory names ending with a dot or space", () => {
    expect(isLegalDirectory("dirname.")).toBe(false)
    expect(isLegalDirectory("dirname ")).toBe(false)
    expect(isLegalDirectory("dirname..")).toBe(false)
  })

  test("rejects . and .. directory names", () => {
    expect(isLegalDirectory(".")).toBe(false)
    expect(isLegalDirectory("..")).toBe(false)
  })

  test("rejects Windows reserved device names (case-insensitive)", () => {
    expect(isLegalDirectory("CON")).toBe(false)
    expect(isLegalDirectory("con")).toBe(false)
    expect(isLegalDirectory("PRN")).toBe(false)
    expect(isLegalDirectory("AUX")).toBe(false)
    expect(isLegalDirectory("NUL")).toBe(false)
    expect(isLegalDirectory("COM1")).toBe(false)
    expect(isLegalDirectory("com9")).toBe(false)
    expect(isLegalDirectory("LPT1")).toBe(false)
    expect(isLegalDirectory("lpt9")).toBe(false)
    expect(isLegalDirectory("CON.txt")).toBe(false)
    expect(isLegalDirectory("aux.tar.gz")).toBe(false)
  })
})

describe("sanitization helpers", () => {
  test("sanitizeAgentId cleans invalid characters and lowercases", () => {
    expect(sanitizeAgentId("AGY")).toBe("agy")
    expect(sanitizeAgentId("Claude 3.5 Sonnet")).toBe("claude-3-5-sonnet")
    expect(sanitizeAgentId("agent/v2")).toBe("agent-v2")
    expect(sanitizeAgentId("")).toBe("agent")
    expect(sanitizeAgentId("   ")).toBe("agent")
    expect(sanitizeAgentId("---")).toBe("agent")
  })

  test("sanitizeSessionId cleans illegal ref/file characters and removes .lock", () => {
    expect(sanitizeSessionId("ses 123")).toBe("ses-123")
    expect(sanitizeSessionId("feat/login~1^2:test?*")).toBe("feat-login-1-2-test")
    expect(sanitizeSessionId("session..name")).toBe("session-name")
    expect(sanitizeSessionId("session.lock")).toBe("session")
    expect(sanitizeSessionId("session.LOCK")).toBe("session")
    expect(sanitizeSessionId("")).toBe("session")
    expect(sanitizeSessionId("...---...")).toBe("session")
  })

  test("sanitizeProjectName extracts basename from POSIX and Windows paths", () => {
    expect(sanitizeProjectName("/home/user/repos/my-app", "proj-1")).toBe("my-app")
    expect(sanitizeProjectName("C:\\Users\\dev\\Favorites\\nikcli", "proj-2")).toBe("nikcli")
    expect(sanitizeProjectName("", "proj-custom")).toBe("proj-custom")
    expect(sanitizeProjectName("", "")).toBe("project")
  })

  test("deriveBranch produces legal branch names", () => {
    const branch = deriveBranch("agy", "ses-101")
    expect(branch).toBe("ade/agy/ses-101")
    expect(isLegalBranch(branch)).toBe(true)
  })

  test("deriveDirectory produces legal directory names", () => {
    const dir = deriveDirectory("/repo/my-app", "p1", "agy", "ses-101")
    expect(dir).toBe("my-app-agy-ses-101")
    expect(isLegalDirectory(dir)).toBe(true)
  })
})

describe("planSessionTree", () => {
  const baseInput = {
    projectId: "proj-alpha",
    projectPath: "/repos/alpha",
    trees: [] as Worktree[],
    sessionId: "ses-100",
    agentId: "agy",
    baseBranch: "main",
  }

  describe("worktree reuse rules", () => {
    test("reuses an existing free and clean tree of the same project", () => {
      const freeClean = makeTree({
        id: "wt-free",
        projectId: "proj-alpha",
        name: "libero-1",
        branch: "ade/agy/prev",
        dirty: 0,
        occupants: [],
      })

      const plan = planSessionTree({
        ...baseInput,
        trees: [freeClean],
      })

      expect(plan.reuse).toBeDefined()
      expect(plan.reuse?.id).toBe("wt-free")
      expect(plan.branch).toBeUndefined()
      expect(plan.directory).toBeUndefined()
      expect(plan.reason).toContain("libero-1")
      expect(plan.reason).toContain("agy")
    })

    test("reuses a free tree with stopped occupants (stopped occupants do not hold tree)", () => {
      const treeWithStopped = makeTree({
        id: "wt-stopped",
        projectId: "proj-alpha",
        name: "stopped-tree",
        branch: "ade/claude/old-1",
        dirty: 0,
        occupants: [
          { sessionId: "old-1", agentId: "claude", state: "stopped" },
          { sessionId: "old-2", agentId: "kimi", state: "stopped" },
        ],
      })

      const plan = planSessionTree({
        ...baseInput,
        trees: [treeWithStopped],
      })

      expect(plan.reuse).toBeDefined()
      expect(plan.reuse?.id).toBe("wt-stopped")
      expect(plan.branch).toBeUndefined()
      expect(plan.directory).toBeUndefined()
    })

    test("does NOT reuse a dirty free tree, even when free", () => {
      const dirtyFree = makeTree({
        id: "wt-dirty",
        projectId: "proj-alpha",
        name: "dirty-tree",
        dirty: 3, // uncommitted edits!
        occupants: [],
      })

      const plan = planSessionTree({
        ...baseInput,
        trees: [dirtyFree],
      })

      expect(plan.reuse).toBeUndefined()
      expect(plan.branch).toBeDefined()
      expect(plan.directory).toBeDefined()
      expect(isLegalBranch(plan.branch!)).toBe(true)
      expect(isLegalDirectory(plan.directory!)).toBe(true)
    })

    test("does NOT reuse an occupied tree (working or waiting)", () => {
      const workingOccupied = makeTree({
        id: "wt-working",
        projectId: "proj-alpha",
        dirty: 0,
        occupants: [{ sessionId: "s-other", agentId: "kimi", state: "working" }],
      })
      const waitingOccupied = makeTree({
        id: "wt-waiting",
        projectId: "proj-alpha",
        dirty: 0,
        occupants: [{ sessionId: "s-other2", agentId: "claude", state: "waiting" }],
      })

      const plan1 = planSessionTree({
        ...baseInput,
        trees: [workingOccupied],
      })
      expect(plan1.reuse).toBeUndefined()
      expect(plan1.branch).toBeDefined()

      const plan2 = planSessionTree({
        ...baseInput,
        trees: [waitingOccupied],
      })
      expect(plan2.reuse).toBeUndefined()
      expect(plan2.branch).toBeDefined()
    })

    test("does NOT reuse a conflicted tree (multiple active occupants)", () => {
      const conflicted = makeTree({
        id: "wt-conflict",
        projectId: "proj-alpha",
        dirty: 0,
        occupants: [
          { sessionId: "s1", agentId: "agy", state: "working" },
          { sessionId: "s2", agentId: "kimi", state: "working" },
        ],
      })

      const plan = planSessionTree({
        ...baseInput,
        trees: [conflicted],
      })

      expect(plan.reuse).toBeUndefined()
      expect(plan.branch).toBeDefined()
      expect(plan.directory).toBeDefined()
    })

    test("does NOT reuse a tree of another project", () => {
      const otherProjectTree = makeTree({
        id: "wt-other-proj",
        projectId: "proj-beta", // Different project!
        dirty: 0,
        occupants: [],
      })

      const plan = planSessionTree({
        ...baseInput,
        trees: [otherProjectTree],
      })

      expect(plan.reuse).toBeUndefined()
      expect(plan.branch).toBeDefined()
      expect(plan.directory).toBeDefined()
    })

    test("when multiple free clean trees exist, prefers most recently updated", () => {
      const olderClean = makeTree({
        id: "wt-older",
        projectId: "proj-alpha",
        name: "older",
        branch: "ade/agy/older",
        dirty: 0,
        occupants: [],
        updatedAt: 1000,
      })
      const newerClean = makeTree({
        id: "wt-newer",
        projectId: "proj-alpha",
        name: "newer",
        branch: "ade/agy/newer",
        dirty: 0,
        occupants: [],
        updatedAt: 5000,
      })

      const plan = planSessionTree({
        ...baseInput,
        trees: [olderClean, newerClean],
      })

      expect(plan.reuse?.id).toBe("wt-newer")
    })
  })

  describe("new worktree creation and naming", () => {
    test("plans a new tree when no trees exist", () => {
      const plan = planSessionTree({
        ...baseInput,
        trees: [],
      })

      expect(plan.reuse).toBeUndefined()
      expect(plan.branch).toBe("ade/agy/ses-100")
      expect(plan.directory).toBe("alpha-agy-ses-100")
      expect(plan.reason).toContain("alpha-agy-ses-100")
      expect(plan.reason).toContain("ade/agy/ses-100")
      expect(plan.reason).toContain("main")
    })

    test("two different sessions produce different branch and directory names (no collision)", () => {
      const plan1 = planSessionTree({
        ...baseInput,
        sessionId: "session-alpha-1",
      })
      const plan2 = planSessionTree({
        ...baseInput,
        sessionId: "session-alpha-2",
      })

      expect(plan1.branch).not.toBe(plan2.branch)
      expect(plan1.directory).not.toBe(plan2.directory)
    })

    test("every generated branch and directory name passes legality checks", () => {
      const sessionIds = [
        "s1",
        "ses-4558c32f-b10f-4198-a47c-834530e48b1b",
        "feature-test_123",
        "task.subtask.item",
        "normal-session",
      ]

      for (const sid of sessionIds) {
        const plan = planSessionTree({
          ...baseInput,
          sessionId: sid,
        })

        expect(isLegalBranch(plan.branch!)).toBe(true)
        expect(isLegalDirectory(plan.directory!)).toBe(true)
      }
    })

    test("names built from agentId or sessionId containing spaces, dots, and slashes still come out legal", () => {
      const weirdInputs = [
        { agentId: "Claude 3.5 Sonnet", sessionId: "feature/login flow..v1" },
        { agentId: "agy/v2:special", sessionId: "fix: bug #123?*~^" },
        { agentId: "kimi [pro]", sessionId: "task\\subtask\\name.lock" },
        { agentId: "  agent  ", sessionId: "  ...session...  " },
        { agentId: "CON", sessionId: "PRN" },
      ]

      for (const { agentId, sessionId } of weirdInputs) {
        const plan = planSessionTree({
          ...baseInput,
          agentId,
          sessionId,
        })

        expect(plan.branch).toBeDefined()
        expect(plan.directory).toBeDefined()
        expect(isLegalBranch(plan.branch!)).toBe(true)
        expect(isLegalDirectory(plan.directory!)).toBe(true)
      }
    })

    test("handles Windows projectPath with backslashes correctly", () => {
      const plan = planSessionTree({
        ...baseInput,
        projectPath: "C:\\Users\\39349\\Favorites\\nikcli",
        sessionId: "ses-win",
        agentId: "agy",
      })

      expect(plan.directory).toBe("nikcli-agy-ses-win")
      expect(isLegalDirectory(plan.directory!)).toBe(true)
    })
  })
})

/*
 * Regression: run against the real repository, planSessionTree chose
 * `nikcli-herdr-win` — a developer's own worktree on the branch of an open pull
 * request — as a session sandbox, because it was free and clean. Free and clean
 * is not the same as available, and an agent let loose in someone's feature
 * branch is the worst failure this module can have.
 */
describe("reuse never takes a tree ADE did not create", () => {
  function tree(name: string, branch: string): Worktree {
    return {
      id: `wt-${name}`,
      projectId: "nikcli",
      name,
      path: `C:/repo/${name}`,
      branch,
      ahead: 0,
      behind: 0,
      dirty: 0,
      occupants: [],
      updatedAt: 1000,
    }
  }

  const base = {
    projectId: "nikcli",
    projectPath: "C:/repo/nikcli",
    sessionId: "s-1",
    agentId: "agy",
    baseBranch: "HEAD",
  }

  test("a developer's clean idle worktree is left alone", () => {
    const plan = planSessionTree({ ...base, trees: [tree("nikcli-herdr-win", "fix/herdr-bridge-windows-pipe")] })

    expect(plan.reuse).toBeUndefined()
    expect(plan.branch).toBe("ade/agy/s-1")
  })

  test("a tree ADE created is still reused", () => {
    const mine = tree("ade-agy-vecchia", "ade/agy/vecchia")
    const plan = planSessionTree({ ...base, trees: [mine] })

    expect(plan.reuse).toBe(mine)
  })

  test("a branch merely starting with the letters ade is not ADE's", () => {
    const plan = planSessionTree({ ...base, trees: [tree("adempimenti", "adempimenti/fatture")] })

    expect(plan.reuse).toBeUndefined()
  })

  test("ADE's own tree is skipped when it is dirty, as before", () => {
    const dirty = { ...tree("ade-agy-sporca", "ade/agy/sporca"), dirty: 3 }
    const plan = planSessionTree({ ...base, trees: [dirty] })

    expect(plan.reuse).toBeUndefined()
  })
})
