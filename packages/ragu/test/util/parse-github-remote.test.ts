import { describe, expect, it } from "bun:test"
import { parseGitHubRemote } from "@/util/repository"

describe("parseGitHubRemote", () => {
  it("parses https URL with and without .git", () => {
    expect(parseGitHubRemote("https://github.com/foo/bar")).toEqual({ owner: "foo", repo: "bar" })
    expect(parseGitHubRemote("https://github.com/foo/bar.git")).toEqual({ owner: "foo", repo: "bar" })
  })

  it("parses git@ and ssh styles", () => {
    expect(parseGitHubRemote("git@github.com:acme/widget.git")).toEqual({ owner: "acme", repo: "widget" })
    expect(parseGitHubRemote("ssh://git@github.com/acme/widget")).toEqual({ owner: "acme", repo: "widget" })
  })

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRemote("https://gitlab.com/a/b")).toBeNull()
    expect(parseGitHubRemote("not a url")).toBeNull()
  })
})
