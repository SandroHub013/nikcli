import { describe, expect, test } from "bun:test"
import { compareUrl, createPullRequest, toRepo } from "./create-pr"

/**
 * The pull request flow hands the user off to github.com with a prefilled form,
 * so the URL is the whole contract — a wrong branch or an unescaped title sends
 * them to a broken compare page. The repos endpoint is untyped, so the shape
 * normalisation is asserted too.
 */

const REPO = {
  owner: "nikomatt69",
  repo: "nikcli",
  fullName: "nikomatt69/nikcli",
  defaultBranch: "live-main",
}

describe("compareUrl", () => {
  const build = (overrides: Partial<Parameters<typeof compareUrl>[0]> = {}) =>
    new URL(
      compareUrl({
        repo: REPO,
        base: "live-main",
        head: "feat/tabs",
        title: "Rework tabs",
        body: "Body text",
        draft: false,
        ...overrides,
      }),
    )

  test("targets the repository's compare view", () => {
    const url = build()
    expect(url.origin).toBe("https://github.com")
    expect(url.pathname).toBe("/nikomatt69/nikcli/compare/live-main...feat%2Ftabs")
  })

  test("expands the form so the user lands on the editor, not the diff", () => {
    expect(build().searchParams.get("expand")).toBe("1")
  })

  test("carries title and body", () => {
    const url = build()
    expect(url.searchParams.get("title")).toBe("Rework tabs")
    expect(url.searchParams.get("body")).toBe("Body text")
  })

  test("marks a draft only when asked", () => {
    expect(build({ draft: false }).searchParams.get("draft")).toBeNull()
    expect(build({ draft: true }).searchParams.get("draft")).toBe("1")
  })

  test("omits empty title and body rather than sending blanks", () => {
    const url = build({ title: "", body: "" })
    expect(url.searchParams.get("title")).toBeNull()
    expect(url.searchParams.get("body")).toBeNull()
  })

  test("escapes branch names containing slashes and spaces", () => {
    const url = build({ base: "release/2026 Q1", head: "fix/a b" })
    expect(url.pathname).toBe("/nikomatt69/nikcli/compare/release%2F2026%20Q1...fix%2Fa%20b")
  })

  test("escapes a title containing characters that would break the query", () => {
    const url = build({ title: "fix: a&b =c #1" })
    expect(url.searchParams.get("title")).toBe("fix: a&b =c #1")
  })
})

describe("toRepo", () => {
  test("reads the GitHub REST shape", () => {
    expect(
      toRepo({
        name: "nikcli",
        full_name: "nikomatt69/nikcli",
        owner: { login: "nikomatt69" },
        default_branch: "live-main",
        html_url: "https://github.com/nikomatt69/nikcli",
        private: false,
      }),
    ).toEqual({
      owner: "nikomatt69",
      repo: "nikcli",
      fullName: "nikomatt69/nikcli",
      defaultBranch: "live-main",
      htmlUrl: "https://github.com/nikomatt69/nikcli",
      private: false,
    })
  })

  test("reads a flattened camelCase shape", () => {
    expect(toRepo({ owner: "acme", repo: "widgets", defaultBranch: "trunk" })).toMatchObject({
      owner: "acme",
      repo: "widgets",
      fullName: "acme/widgets",
      defaultBranch: "trunk",
    })
  })

  test("falls back to main when no default branch is reported", () => {
    expect(toRepo({ owner: "acme", repo: "widgets" })?.defaultBranch).toBe("main")
  })

  test("rejects entries without an owner or a name", () => {
    expect(toRepo({ name: "orphan" })).toBeUndefined()
    expect(toRepo({ owner: { login: "acme" } })).toBeUndefined()
    expect(toRepo(null)).toBeUndefined()
    expect(toRepo("nikcli")).toBeUndefined()
  })
})

describe("createPullRequest", () => {
  test("creates through the API when connected", async () => {
    let calledWith: any
    const result = await createPullRequest({
      connected: true,
      repo: REPO,
      base: "live-main",
      head: "feat/tabs",
      title: "Rework tabs",
      body: "Body text",
      draft: true,
      createApi: async (params) => {
        calledWith = params
        return {
          number: 42,
          html_url: "https://github.com/nikomatt69/nikcli/pull/42",
          title: "Rework tabs",
        }
      },
    })

    expect(calledWith).toEqual({
      owner: "nikomatt69",
      repo: "nikcli",
      title: "Rework tabs",
      head: "feat/tabs",
      base: "live-main",
      body: "Body text",
      draft: true,
    })
    expect(result).toEqual({
      type: "created",
      pr: {
        number: 42,
        html_url: "https://github.com/nikomatt69/nikcli/pull/42",
        title: "Rework tabs",
      },
    })
  })

  test("falls back to compareUrl when not connected", async () => {
    let called = false
    const result = await createPullRequest({
      connected: false,
      repo: REPO,
      base: "live-main",
      head: "feat/tabs",
      title: "Rework tabs",
      body: "Body text",
      draft: false,
      createApi: async () => {
        called = true
        throw new Error("Should not be called")
      },
    })

    expect(called).toBe(false)
    expect(result.type).toBe("compare")
    if (result.type === "compare") {
      const url = new URL(result.url)
      expect(url.origin).toBe("https://github.com")
      expect(url.pathname).toBe("/nikomatt69/nikcli/compare/live-main...feat%2Ftabs")
    }
  })

  test("falls back to compareUrl when createApi is not provided", async () => {
    const result = await createPullRequest({
      connected: true,
      repo: REPO,
      base: "live-main",
      head: "feat/tabs",
      title: "Rework tabs",
      body: "Body text",
      draft: false,
    })

    expect(result.type).toBe("compare")
  })

  test("propagates API errors so caller can handle failure and fallback", async () => {
    const promise = createPullRequest({
      connected: true,
      repo: REPO,
      base: "live-main",
      head: "feat/tabs",
      title: "Rework tabs",
      body: "Body text",
      draft: true,
      createApi: async () => {
        throw new Error("GitHub API error: 422 - Draft pull requests are not supported")
      },
    })

    await expect(promise).rejects.toThrow("Draft pull requests are not supported")
  })
})

