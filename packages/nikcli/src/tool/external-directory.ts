import path from "path"
import type { Tool } from "./tool"
import { Instance } from "../project/instance"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

/**
 * Whether `target` sits outside the project — the question
 * `assertExternalDirectory` asks before it asks anything. Answered without the
 * permission prompt, for callers that only want to word an error better.
 */
export function isExternalPath(target: string): boolean {
  return !Instance.containsPath(target)
}

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  if (!target) return

  if (options?.bypass) return

  if (Instance.containsPath(target)) return

  const kind = options?.kind ?? "file"
  const parentDir = kind === "directory" ? target : path.dirname(target)
  const glob = path.join(parentDir, "*")

  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: target,
      parentDir,
    },
  })
}

/**
 * Whether a tool's `path` argument means "the project": absent, empty, ".", or a bare "/" or "\".
 *
 * A model that wants to see the project often writes `path: "/"` for "the root". `path.resolve`
 * takes that literally, as the root of the disk, and `tree` or `glob` then list the whole drive
 * into the context. Read as the project root it is what the model meant.
 */
export function isProjectRootAlias(value: string | undefined): boolean {
  const trimmed = value?.trim()
  return !trimmed || trimmed === "." || trimmed === "/" || trimmed === "\\"
}
