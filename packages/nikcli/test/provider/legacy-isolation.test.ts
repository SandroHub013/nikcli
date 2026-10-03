import { describe, expect, it } from "bun:test"
import { Glob } from "bun"
import path from "path"

/**
 * The AI SDK is imported in one place, `src/provider/legacy/`. Everything else gets what it needs from
 * `@/provider/legacy/ai-sdk`, so dropping the SDK later means replacing that file's exports instead of
 * hunting through the session, tool and provider code. This is what keeps it true.
 */
const SDK =
  /(?:from|import\()\s*["'](?:ai|@ai-sdk\/[^"']+|@openrouter\/ai-sdk-provider|@gitlab\/gitlab-ai-provider)["']/

async function offenders(root: string, skip: (file: string) => boolean = () => false) {
  const found: string[] = []
  for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    if (skip(file)) continue
    if (SDK.test(await Bun.file(path.join(root, file)).text())) found.push(file)
  }
  return found
}

describe("AI SDK isolation", () => {
  it("is imported only under src/provider/legacy", async () => {
    const root = path.resolve(import.meta.dir, "../../src")
    expect(await offenders(root, (file) => file.startsWith(`provider${path.sep}legacy${path.sep}`))).toEqual([])
  })

  it("is no dependency of @nikcli-ai/llm", async () => {
    const llm = path.resolve(import.meta.dir, "../../../llm")
    const pkg = await Bun.file(path.join(llm, "package.json")).json()
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain("ai")
    expect(await offenders(path.join(llm, "src"))).toEqual([])
  })
})
