import { describe, expect, test } from "bun:test"
import type { Worktree } from "./model"
import { deriveBranchName, planRelocation, sanitizeBranchName } from "./relocate"

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

describe("sanitizeBranchName", () => {
  test("replaces whitespace with hyphens", () => {
    expect(sanitizeBranchName("my new feature")).toBe("my-new-feature")
    expect(sanitizeBranchName("task \t name")).toBe("task-name")
  })

  test("removes or replaces illegal git ref characters (~^:?*[\\]@{)", () => {
    expect(sanitizeBranchName("feat~1^2:branch?*test[1]")).toBe("feat-1-2-branch-test-1")
    expect(sanitizeBranchName("branch@{upstream}")).toBe("branch-upstream")
    expect(sanitizeBranchName("path\\to\\ref")).toBe("path-to-ref")
  })

  test("replaces consecutive dots (..)", () => {
    expect(sanitizeBranchName("feat..branch...test")).toBe("feat-branch-test")
  })

  test("collapses consecutive slashes and trims boundary separators", () => {
    expect(sanitizeBranchName("/feature//sub///branch/")).toBe("feature/sub/branch")
    expect(sanitizeBranchName("...---feature.name---...")).toBe("feature.name")
  })

  test("strips .lock suffix", () => {
    expect(sanitizeBranchName("my-branch.lock")).toBe("my-branch")
    expect(sanitizeBranchName("my-branch.LOCK")).toBe("my-branch")
  })

  test("provides fallback for empty or purely invalid strings", () => {
    expect(sanitizeBranchName("")).toBe("relocated-session")
    expect(sanitizeBranchName("   ")).toBe("relocated-session")
    expect(sanitizeBranchName(":::???***")).toBe("relocated-session")
  })
})

describe("deriveBranchName", () => {
  test("prefixes sanitized session ID with session/", () => {
    expect(deriveBranchName("ses-123")).toBe("session/ses-123")
    expect(deriveBranchName("feat: auth flow")).toBe("session/feat-auth-flow")
  })

  test("does not double-prefix if already starting with session/", () => {
    expect(deriveBranchName("session/feat-x")).toBe("session/feat-x")
  })
})

describe("planRelocation", () => {
  describe("guards", () => {
    test("returns undefined for a free tree (libero)", () => {
      const tree = makeTree({ occupants: [] })
      expect(planRelocation({ tree, allTrees: [tree] })).toBeUndefined()
    })

    test("returns undefined for a tree with one working occupant (occupato)", () => {
      const tree = makeTree({
        occupants: [{ sessionId: "s1", agentId: "agy", state: "working" }],
      })
      expect(planRelocation({ tree, allTrees: [tree] })).toBeUndefined()
    })

    test("returns undefined for a tree with one working and one stopped occupant (no conflict)", () => {
      const tree = makeTree({
        occupants: [
          { sessionId: "s1", agentId: "agy", state: "working" },
          { sessionId: "s2", agentId: "kimi", state: "stopped" },
        ],
      })
      expect(planRelocation({ tree, allTrees: [tree] })).toBeUndefined()
    })

    test("returns undefined for a tree with only stopped occupants", () => {
      const tree = makeTree({
        occupants: [
          { sessionId: "s1", agentId: "agy", state: "stopped" },
          { sessionId: "s2", agentId: "kimi", state: "stopped" },
        ],
      })
      expect(planRelocation({ tree, allTrees: [tree] })).toBeUndefined()
    })
  })

  describe("destination tree selection", () => {
    test("relocates into an existing free tree of the SAME project", () => {
      const conflicted = makeTree({
        id: "wt-conflicted",
        projectId: "proj-alpha",
        name: "principale",
        occupants: [
          { sessionId: "s1", agentId: "agy", state: "working" },
          { sessionId: "s2", agentId: "kimi", state: "waiting" },
        ],
      })
      const freeAlpha = makeTree({
        id: "wt-free-alpha",
        projectId: "proj-alpha",
        name: "secondario",
        occupants: [],
      })

      const plan = planRelocation({
        tree: conflicted,
        allTrees: [conflicted, freeAlpha],
      })

      expect(plan).toBeDefined()
      expect(plan?.move.agentId).toBe("kimi")
      expect(plan?.into?.id).toBe("wt-free-alpha")
      expect(plan?.newBranch).toBeUndefined()
      expect(plan?.reason).toContain("secondario")
      expect(plan?.reason).toContain("kimi")
    })

    test("never chooses a free tree from a DIFFERENT project", () => {
      const conflicted = makeTree({
        id: "wt-conflicted",
        projectId: "proj-alpha",
        name: "principale",
        occupants: [
          { sessionId: "s1", agentId: "agy", state: "working" },
          { sessionId: "s2", agentId: "kimi", state: "waiting" },
        ],
      })
      const freeBeta = makeTree({
        id: "wt-free-beta",
        projectId: "proj-beta", // Different project!
        name: "beta-tree",
        occupants: [],
      })

      const plan = planRelocation({
        tree: conflicted,
        allTrees: [conflicted, freeBeta],
      })

      expect(plan).toBeDefined()
      // Free tree from proj-beta must NOT be chosen
      expect(plan?.into).toBeUndefined()
      // Instead, proposes creating a new branch
      expect(plan?.newBranch).toBe("session/s2")
    })

    test("never chooses an occupied or conflicted tree of the same project", () => {
      const conflicted = makeTree({
        id: "wt-1",
        projectId: "proj-alpha",
        occupants: [
          { sessionId: "s1", agentId: "agy", state: "working" },
          { sessionId: "s2", agentId: "kimi", state: "working" },
        ],
      })
      const occupiedSameProject = makeTree({
        id: "wt-2",
        projectId: "proj-alpha",
        occupants: [{ sessionId: "s3", agentId: "claude", state: "working" }],
      })
      const conflictedSameProject = makeTree({
        id: "wt-3",
        projectId: "proj-alpha",
        occupants: [
          { sessionId: "s4", agentId: "agy", state: "working" },
          { sessionId: "s5", agentId: "kimi", state: "working" },
        ],
      })

      const plan = planRelocation({
        tree: conflicted,
        allTrees: [conflicted, occupiedSameProject, conflictedSameProject],
      })

      expect(plan).toBeDefined()
      expect(plan?.into).toBeUndefined()
      expect(plan?.newBranch).toBeDefined()
    })

    test("prefers a clean free tree over a dirty free tree", () => {
      const conflicted = makeTree({
        id: "wt-conf",
        projectId: "proj-alpha",
        occupants: [
          { sessionId: "s1", agentId: "agy", state: "working" },
          { sessionId: "s2", agentId: "kimi", state: "waiting" },
        ],
      })
      const dirtyFree = makeTree({
        id: "wt-dirty",
        projectId: "proj-alpha",
        name: "dirty-tree",
        dirty: 3,
        occupants: [],
        updatedAt: 5000,
      })
      const cleanFree = makeTree({
        id: "wt-clean",
        projectId: "proj-alpha",
        name: "clean-tree",
        dirty: 0,
        occupants: [],
        updatedAt: 1000,
      })

      const plan = planRelocation({
        tree: conflicted,
        allTrees: [conflicted, dirtyFree, cleanFree],
      })

      expect(plan?.into?.id).toBe("wt-clean")
    })
  })

  describe("occupant to move selection", () => {
    test("prefers moving a waiting occupant over a working occupant", () => {
      const conflicted = makeTree({
        occupants: [
          { sessionId: "s-work", agentId: "agy", state: "working" },
          { sessionId: "s-wait", agentId: "kimi", state: "waiting" },
        ],
      })

      const plan = planRelocation({
        tree: conflicted,
        allTrees: [conflicted],
      })

      expect(plan?.move.sessionId).toBe("s-wait")
      expect(plan?.move.agentId).toBe("kimi")
    })

    test("if all occupants are working, picks the last occupant (latest joiner)", () => {
      const conflicted = makeTree({
        occupants: [
          { sessionId: "s-first", agentId: "agy", state: "working" },
          { sessionId: "s-second", agentId: "kimi", state: "working" },
        ],
      })

      const plan = planRelocation({
        tree: conflicted,
        allTrees: [conflicted],
      })

      expect(plan?.move.sessionId).toBe("s-second")
      expect(plan?.move.agentId).toBe("kimi")
    })

    test("ignores stopped occupants when selecting who to move in a conflict", () => {
      const conflicted = makeTree({
        occupants: [
          { sessionId: "s-stop", agentId: "claude", state: "stopped" },
          { sessionId: "s-work", agentId: "agy", state: "working" },
          { sessionId: "s-wait", agentId: "kimi", state: "waiting" },
        ],
      })

      const plan = planRelocation({
        tree: conflicted,
        allTrees: [conflicted],
      })

      // The conflict is between s-work and s-wait; s-wait is preferred because it is waiting
      expect(plan?.move.sessionId).toBe("s-wait")
    })
  })

  describe("new branch proposal when no free tree exists", () => {
    test("proposes sanitized branch name from moved session ID", () => {
      const conflicted = makeTree({
        projectId: "proj-alpha",
        name: "principale",
        occupants: [
          { sessionId: "s1", agentId: "agy", state: "working" },
          { sessionId: "feature/login flow~2", agentId: "kimi", state: "waiting" },
        ],
      })

      const plan = planRelocation({
        tree: conflicted,
        allTrees: [conflicted],
      })

      expect(plan?.into).toBeUndefined()
      expect(plan?.newBranch).toBe("session/feature/login-flow-2")
      expect(plan?.reason).toContain("session/feature/login-flow-2")
      expect(plan?.reason).toContain("kimi")
    })
  })
})
