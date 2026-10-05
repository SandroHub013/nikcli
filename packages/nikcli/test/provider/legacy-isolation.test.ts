import { describe, expect, it } from "bun:test"
import { Glob } from "bun"
import path from "path"

/**
 * nikcli reaches providers through `@nikcli-ai/llm` alone. The AI SDK (`ai`, `@ai-sdk/*` and the other
 * provider SDKs built on it) is neither imported nor a dependency, so it cannot creep back in through a
 * convenient helper. Sessions, tools and plugins describe prompts and tools with `@/session/llm/types`.
 */
const SDK =
  /(?:from|import\()\s*["'](?:ai|@ai-sdk\/[^"']+|@openrouter\/ai-sdk-provider|@gitlab\/gitlab-ai-provider)["']/

async function offenders(root: string) {
  const found: string[] = []
  for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    if (SDK.test(await Bun.file(path.join(root, file)).text())) found.push(file)
  }
  return found
}

describe("AI SDK is gone", () => {
  it("is not imported by nikcli", async () => {
    expect(await offenders(path.resolve(import.meta.dir, "../../src"))).toEqual([])
  })

  it("is not imported by @nikcli-ai/llm", async () => {
    expect(await offenders(path.resolve(import.meta.dir, "../../../llm/src"))).toEqual([])
  })

  it("is not a dependency of nikcli or @nikcli-ai/llm", async () => {
    for (const pkg of ["../../package.json", "../../../llm/package.json"]) {
      const json = await Bun.file(path.resolve(import.meta.dir, pkg)).json()
      const names = Object.keys({ ...json.dependencies, ...json.devDependencies })
      expect(
        names.filter((name) => name === "ai" || name.startsWith("@ai-sdk/") || name.includes("ai-sdk-provider")),
      ).toEqual([])
    }
  })
})
