import { describe, expect, test } from "bun:test"
import { planSnapshot } from "./snapshot"

describe("planSnapshot pure planning", () => {
  test("throwaway index path sits in .git and never equals the repository index", () => {
    const plan = planSnapshot({
      projectPath: "/repo/my-project",
      baseCommit: "main",
    })

    expect(plan.indexPath).toBe("/repo/my-project/.git/ade-snapshot-index")
    expect(plan.indexPath).not.toBe("/repo/my-project/.git/index")
    expect(plan.indexPath.endsWith("/.git/index")).toBe(false)
  })

  test("env carries GIT_INDEX_FILE and nothing else", () => {
    const plan = planSnapshot({
      projectPath: "/repo/my-project",
      baseCommit: "HEAD",
    })

    expect(Object.keys(plan.env)).toEqual(["GIT_INDEX_FILE"])
    expect(plan.env.GIT_INDEX_FILE).toBe(plan.indexPath)
  })

  test("stageArgs stages all changes while explicitly excluding .ade-trees", () => {
    const plan = planSnapshot({
      projectPath: "/repo/my-project",
      baseCommit: "HEAD",
    })

    expect(plan.stageArgs).toContain("add")
    expect(plan.stageArgs).toContain("-A")
    expect(plan.stageArgs).toContain(":!.ade-trees")
  })

  test("writeTreeArgs requests write-tree", () => {
    const plan = planSnapshot({
      projectPath: "/repo/my-project",
      baseCommit: "HEAD",
    })

    expect(plan.writeTreeArgs).toEqual(["write-tree"])
  })

  test("commitArgs parents the snapshot commit on the given base commit", () => {
    const plan = planSnapshot({
      projectPath: "/repo/my-project",
      baseCommit: "feat/some-branch",
    })

    const args = plan.commitArgs("abc123tree")
    expect(args[0]).toBe("commit-tree")
    expect(args[1]).toBe("abc123tree")
    expect(args).toContain("-p")
    const parentIndex = args.indexOf("-p")
    expect(args[parentIndex + 1]).toBe("feat/some-branch")
    expect(args).toContain("-m")
  })

  test("normalizes Windows backslashes and trailing slashes", () => {
    const planWithBackslashes = planSnapshot({
      projectPath: "C:\\Users\\dev\\project\\",
      baseCommit: "main",
    })

    expect(planWithBackslashes.indexPath).toBe("C:/Users/dev/project/.git/ade-snapshot-index")
    expect(planWithBackslashes.env.GIT_INDEX_FILE).toBe("C:/Users/dev/project/.git/ade-snapshot-index")

    const planWithTrailingSlash = planSnapshot({
      projectPath: "/home/user/code/repo///",
      baseCommit: "main",
    })

    expect(planWithTrailingSlash.indexPath).toBe("/home/user/code/repo/.git/ade-snapshot-index")
  })

  test("is pure and deterministic", () => {
    const plan1 = planSnapshot({ projectPath: "/repo/test", baseCommit: "c1" })
    const plan2 = planSnapshot({ projectPath: "/repo/test", baseCommit: "c1" })

    expect(plan1.indexPath).toBe(plan2.indexPath)
    expect(plan1.stageArgs).toEqual(plan2.stageArgs)
    expect(plan1.writeTreeArgs).toEqual(plan2.writeTreeArgs)
    expect(plan1.commitArgs("t1")).toEqual(plan2.commitArgs("t1"))
  })
})
